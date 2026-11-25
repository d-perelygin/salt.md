package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Security review regression tests for deploy/server (c8b8e1c).
// Each test asserts the expected SAFE invariant; on unpatched HEAD c8b8e1c,
// failing assertions confirm the corresponding vulnerability from
// deploy_server_code_review.md, and will turn green once fixed.

func secCall(s *Server, method, path, cookie, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// BUG-01: Instance LLM API key must NOT be sent to a user-supplied custom baseUrl,
// and API tokens must NOT be allowed to modify /api/ai/settings (missing sessionOnly).
func TestSecurity_BUG01_InstanceKeyNotSentToCustomBaseURL(t *testing.T) {
	s := testServer(t)
	_, adminCookie := signedIn(t, s, "admin-bug01@example.test")
	memberID, memberCookie := signedIn(t, s, "member-bug01@example.test")

	const instanceKey = "sk-instance-secret-key-9999"
	// Admin saves an instance key (ai_allow_instance_key auto-enables to "1").
	if rec := secCall(s, "PUT", "/api/settings", adminCookie, `{"aiInstanceKey":"`+instanceKey+`"}`); rec.Code != 200 {
		t.Fatalf("admin PUT /api/settings: %d %s", rec.Code, rec.Body.String())
	}

	var mu sync.Mutex
	var gotAuth string
	capture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotAuth = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer capture.Close()

	// Member sets custom baseUrl and empty apiKey.
	if rec := secCall(s, "PUT", "/api/ai/settings", memberCookie, `{"baseUrl":"`+capture.URL+`","apiKey":""}`); rec.Code != 200 {
		t.Fatalf("member PUT /api/ai/settings: %d %s", rec.Code, rec.Body.String())
	}

	// Member triggers /api/ai/generate — instance key must NEVER be forwarded to custom baseUrl.
	_ = secCall(s, "POST", "/api/ai/generate", memberCookie, `{"prompt":"hello"}`)

	mu.Lock()
	leakedAuth := gotAuth
	mu.Unlock()
	if strings.Contains(leakedAuth, instanceKey) {
		t.Errorf("CONFIRMED BUG-01: instance API key was sent to user-controlled baseUrl %s (Authorization: %q)", capture.URL, leakedAuth)
	}

	// Also verify API write token cannot mutate /api/ai/settings (sessionOnly required).
	tok := "bug01-write-token"
	if _, err := s.db.Exec(`INSERT INTO api_tokens (id, user_id, name, token_hash, scope, created_at) VALUES (?, ?, 'ci', ?, 'write', ?)`,
		newID(), memberID, tokenHash(tok), now()); err != nil {
		t.Fatalf("insert token: %v", err)
	}
	req := httptest.NewRequest("PUT", "/api/ai/settings", strings.NewReader(`{"baseUrl":"https://example.invalid"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusUnauthorized {
		t.Errorf("CONFIRMED BUG-01 (sessionOnly): API token mutated /api/ai/settings with HTTP %d", rec.Code)
	}
}

// BUG-02: AI baseUrl must block loopback/private targets, refuse redirects (303 POST->GET),
// and not echo raw internal >=400 error bodies.
func TestSecurity_BUG02_AIBaseURLBlocksLoopbackAndRedirects(t *testing.T) {
	s := testServer(t)
	_, _ = signedIn(t, s, "admin-bug02@example.test")
	_, memberCookie := signedIn(t, s, "member-bug02@example.test")

	var internalHit bool
	var internalMethod string
	internalTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		internalHit = true
		internalMethod = r.Method
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("INTERNAL_SECRET_STATUS_BODY"))
	}))
	defer internalTarget.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, internalTarget.URL+"/internal-admin", http.StatusSeeOther)
	}))
	defer redirector.Close()

	// Member points baseUrl at loopback redirector with dummy apiKey.
	if rec := secCall(s, "PUT", "/api/ai/settings", memberCookie, `{"baseUrl":"`+redirector.URL+`","apiKey":"dummy"}`); rec.Code != 200 {
		t.Fatalf("PUT /api/ai/settings: %d %s", rec.Code, rec.Body.String())
	}

	rec := secCall(s, "POST", "/api/ai/generate", memberCookie, `{"prompt":"ping"}`)
	if internalHit {
		t.Errorf("CONFIRMED BUG-02: server contacted loopback baseUrl and followed 303 redirect as %s to %s", internalMethod, internalTarget.URL)
	}
	if strings.Contains(rec.Body.String(), "INTERNAL_SECRET_STATUS_BODY") {
		t.Errorf("CONFIRMED BUG-02: raw internal HTTP 400 body echoed back to caller: %s", rec.Body.String())
	}
}

// BUG-03: AI endpoints must enforce page read ACL (canReadReq) on pageId and
// thread ownership (ai_threads.user_id == u.ID) on threadId.
func TestSecurity_BUG03_AIEnforcesPageAndThreadACL(t *testing.T) {
	s := testServer(t)
	aliceID, _ := signedIn(t, s, "alice-bug03@example.test")
	_, bobCookie := signedIn(t, s, "bob-bug03@example.test")

	aliceWS := makeNamedWorkspace(t, s, aliceID, "AlicePrivateWS")
	secretContent := `[{"type":"paragraph","content":[{"type":"text","text":"TOP_SECRET_ALICE_DATA_42","styles":{}}]}]`
	secretPage := s.makePage(t, aliceWS, aliceID, "", "Alice Secret Page Title", secretContent)
	restrict(t, s, secretPage)

	// Alice also has a private AI thread with secret conversation history.
	aliceThread := newID()
	s.db.Exec(`INSERT INTO ai_threads (id, user_id, workspace_id, page_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
		aliceThread, aliceID, aliceWS, secretPage, "Alice Thread", now(), now())
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, created_at) VALUES (?,?,?,?,?)`,
		newID(), aliceThread, "user", "ALICE_PRIVATE_CHAT_HISTORY_99", now())

	var mu sync.Mutex
	var capturedBodies []string
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		capturedBodies = append(capturedBodies, string(b))
		mu.Unlock()
		if strings.Contains(r.URL.Path, "chat/completions") {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))
			return
		}
		w.WriteHeader(200)
	}))
	defer llm.Close()

	if rec := secCall(s, "PUT", "/api/ai/settings", bobCookie, `{"baseUrl":"`+llm.URL+`","apiKey":"bob-key","format":"chat"}`); rec.Code != 200 {
		t.Fatalf("bob PUT /api/ai/settings: %d", rec.Code)
	}

	// Subtest A: Bob passes Alice's private pageId to POST /api/ai/generate.
	t.Run("pageId_IDOR_generate", func(t *testing.T) {
		rec := secCall(s, "POST", "/api/ai/generate", bobCookie, `{"pageId":"`+secretPage+`","includePage":true,"prompt":"summarize"}`)
		mu.Lock()
		joined := strings.Join(capturedBodies, "\n")
		mu.Unlock()
		if strings.Contains(joined, "TOP_SECRET_ALICE_DATA_42") || strings.Contains(joined, "Alice Secret Page Title") {
			t.Errorf("CONFIRMED BUG-03 (pageId): /api/ai/generate sent Alice's private page content/title to Bob's LLM endpoint (status %d)", rec.Code)
		}
	})

	// Subtest B: Bob passes Alice's threadId to POST /api/ai/runs.
	t.Run("threadId_IDOR_runs", func(t *testing.T) {
		mu.Lock()
		capturedBodies = nil
		mu.Unlock()

		rec := secCall(s, "POST", "/api/ai/runs", bobCookie, `{"threadId":"`+aliceThread+`","task":"repeat above"}`)
		// Give background goroutine a moment to hit our local mock LLM.
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			n := len(capturedBodies)
			mu.Unlock()
			if n > 0 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		mu.Lock()
		joined := strings.Join(capturedBodies, "\n")
		mu.Unlock()

		if rec.Code == 200 {
			t.Errorf("CONFIRMED BUG-03 (threadId): Bob created AI run in Alice's thread (HTTP 200: %s)", rec.Body.String())
		}
		if strings.Contains(joined, "ALICE_PRIVATE_CHAT_HISTORY_99") {
			t.Errorf("CONFIRMED BUG-03 (threadId): Alice's private thread history was injected into Bob's run prompt")
		}
	})

	// Subtest C: Bob creates a thread pointing to Alice's secret pageId and reads its title via GET /api/ai/threads.
	t.Run("pageId_title_leak_threads", func(t *testing.T) {
		_ = secCall(s, "POST", "/api/ai/threads", bobCookie, `{"pageId":"`+secretPage+`","title":"probe"}`)
		rec := secCall(s, "GET", "/api/ai/threads", bobCookie, "")
		if strings.Contains(rec.Body.String(), "Alice Secret Page Title") {
			t.Errorf("CONFIRMED BUG-03 (thread pageId): GET /api/ai/threads leaked Alice's private page title: %s", rec.Body.String())
		}
	})
}

// BUG-04: Creating child pages inside a restricted parent via POST /api/pages
// must NOT lock out granted collaborators or the non-admin parent owner.
func TestSecurity_BUG04_RestrictedChildAccessibleToCollaboratorsAndOwner(t *testing.T) {
	s := testServer(t)
	ownerID, _ := signedIn(t, s, "owner-bug04@example.test")
	aliceID, aliceCookie := signedIn(t, s, "alice-bug04@example.test")
	bobID, bobCookie := signedIn(t, s, "bob-bug04@example.test")

	ws := makeNamedWorkspace(t, s, ownerID, "SharedWS")
	s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')`, ws, aliceID)
	s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')`, ws, bobID)

	// Non-admin member Alice creates parent P, restricts it, and grants Bob edit access.
	parentID := s.makePage(t, ws, aliceID, "", "Restricted Folder", "[]")
	restrict(t, s, parentID)
	grant(t, s, parentID, bobID, grantEdit)

	// 1) Alice creates child C via HTTP POST /api/pages -> Bob (granted editor on P) must see C.
	recC := secCall(s, "POST", "/api/pages", aliceCookie, `{"parentId":"`+parentID+`","title":"Child By Alice","workspaceId":"`+ws+`"}`)
	if recC.Code != 200 && recC.Code != 201 {
		t.Fatalf("Alice create child C: %d %s", recC.Code, recC.Body.String())
	}
	var cResp struct{ ID string }
	json.Unmarshal(recC.Body.Bytes(), &cResp)
	if recBob := secCall(s, "GET", "/api/pages/"+cResp.ID, bobCookie, ""); recBob.Code != 200 {
		t.Errorf("CONFIRMED BUG-04: collaborator Bob (edit grant on parent) got HTTP %d reading Alice's child page %s", recBob.Code, cResp.ID)
	}

	// 2) Bob creates child D via HTTP POST /api/pages -> parent owner Alice must see D.
	recD := secCall(s, "POST", "/api/pages", bobCookie, `{"parentId":"`+parentID+`","title":"Child By Bob","workspaceId":"`+ws+`"}`)
	if recD.Code != 200 && recD.Code != 201 {
		t.Fatalf("Bob create child D: %d %s", recD.Code, recD.Body.String())
	}
	var dResp struct{ ID string }
	json.Unmarshal(recD.Body.Bytes(), &dResp)
	if recAlice := secCall(s, "GET", "/api/pages/"+dResp.ID, aliceCookie, ""); recAlice.Code != 200 {
		t.Errorf("CONFIRMED BUG-04: parent owner Alice got HTTP %d reading Bob's child page %s inside her own restricted folder", recAlice.Code, dResp.ID)
	}
}

// BUG-05: GET /api/export/{id}?format=txt (and md) must NOT leak restricted rows
// of a collection to ungranted workspace members.
func TestSecurity_BUG05_PlainTextExportHidesRestrictedRows(t *testing.T) {
	s := testServer(t)
	ws, _, ids, cookies := accessFixture(t, s)
	alice := ids["alice-pa@example.test"]
	bobCookie := cookies["bob-pa@example.test"]

	// Open collection in shared workspace.
	dbID := s.makePage(t, ws, alice, "", "Shared DB", "[]")
	s.db.Exec(`UPDATE pages SET type = 'collection' WHERE id = ?`, dbID)
	if err := s.createDefaultCollection(dbID); err != nil {
		t.Fatalf("createDefaultCollection: %v", err)
	}

	// One open row, one restricted row (Alice only).
	s.makePage(t, ws, alice, dbID, "Public Row Visible", "[]")
	secretRow := s.makePage(t, ws, alice, dbID, "CONFIDENTIAL_RESTRICTED_ROW_777", "[]")
	restrict(t, s, secretRow)

	// Sanity check: Bob cannot read the restricted row directly.
	if rec := secCall(s, "GET", "/api/pages/"+secretRow, bobCookie, ""); rec.Code == 200 {
		t.Fatalf("sanity failed: Bob should not directly read restricted row")
	}

	// Plain-text export must not leak the restricted row.
	recTxt := secCall(s, "GET", "/api/export/"+dbID+"?format=txt", bobCookie, "")
	if recTxt.Code != 200 {
		t.Fatalf("export txt status: %d %s", recTxt.Code, recTxt.Body.String())
	}
	if strings.Contains(recTxt.Body.String(), "CONFIDENTIAL_RESTRICTED_ROW_777") {
		t.Errorf("CONFIRMED BUG-05: ?format=txt export leaked restricted row to ungranted member:\n%s", recTxt.Body.String())
	}

	// Markdown export has the same privateRowRule bypass.
	recMd := secCall(s, "GET", "/api/export/"+dbID+"?format=md", bobCookie, "")
	if strings.Contains(recMd.Body.String(), "CONFIDENTIAL_RESTRICTED_ROW_777") {
		t.Errorf("CONFIRMED BUG-05 (md): ?format=md export leaked restricted row to ungranted member")
	}
}

// BUG-06 (backend half): PATCH /api/pages/{id} persists raw javascript: URLs in
// bookmark props AND SPA serves no Content-Security-Policy header.
func TestSecurity_BUG06_UnsafeURLPersistedAndNoSPACSP(t *testing.T) {
	s := testServer(t)
	aliceID, aliceCookie := signedIn(t, s, "alice-bug06@example.test")
	ws := makeNamedWorkspace(t, s, aliceID, "WS06")
	pid := s.makePage(t, ws, aliceID, "", "Bookmark Page", "[]")

	payload := `{"content":[{"type":"bookmark","props":{"url":"javascript:void(0)","title":"Click"}}]}`
	recPatch := secCall(s, "PATCH", "/api/pages/"+pid, aliceCookie, payload)
	recGet := secCall(s, "GET", "/api/pages/"+pid, aliceCookie, "")
	if recPatch.Code == 200 && strings.Contains(recGet.Body.String(), "javascript:void(0)") {
		t.Errorf("CONFIRMED BUG-06 (storage): PATCH /api/pages persisted raw javascript: URL in bookmark block props")
	}

	// Check whether API/SPA responses set a Content-Security-Policy header.
	recRoot := secCall(s, "GET", "/", aliceCookie, "")
	if recRoot.Header().Get("Content-Security-Policy") == "" {
		t.Errorf("CONFIRMED BUG-06 (CSP): root SPA response has no Content-Security-Policy header to block javascript: execution")
	}
}

// BUG-09: PUT /api/ai/settings must reject malformed baseUrl; otherwise
// http.NewRequestWithContext returns nil,err and runAIBackground panics unrecovered.
func TestSecurity_BUG09_MalformedAIBaseURLRejected(t *testing.T) {
	s := testServer(t)
	_, cookie := signedIn(t, s, "user-bug09@example.test")

	badURL := "http://[::1"
	rec := secCall(s, "PUT", "/api/ai/settings", cookie, `{"baseUrl":"`+badURL+`","apiKey":"x"}`)
	if rec.Code == 200 {
		// Verify that the normalized URL makes http.NewRequestWithContext return nil, err
		// (which ai.go:885-886 and 1813-1814 ignore before dereferencing req.Header.Set).
		norm := normalizeAIBaseURL(badURL)
		req, err := http.NewRequestWithContext(context.Background(), "POST", norm+"/chat/completions", nil)
		if req == nil && err != nil {
			t.Errorf("CONFIRMED BUG-09: PUT /api/ai/settings stored malformed baseUrl %q (HTTP 200), causing http.NewRequestWithContext -> (nil, %v) -> unrecovered nil-pointer panic in runAIBackground", badURL, err)
		}
	}
}

// BUG-10: Disabling AI for a user must block ALL /api/ai/* endpoints and MCP ai_* tools.
func TestSecurity_BUG10_AIDisableBlocksAllEndpointsAndMCP(t *testing.T) {
	s := testServer(t)
	_, adminCookie := signedIn(t, s, "admin-bug10@example.test")
	bobID, bobCookie := signedIn(t, s, "bob-bug10@example.test")

	// Seed a thread and a waiting_user run for Bob before AI is disabled.
	tid := newID()
	runID := newID()
	s.db.Exec(`INSERT INTO ai_threads (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`, tid, bobID, "Bob Thread", now(), now())
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, created_at) VALUES (?,?,?,?,?)`, newID(), tid, "user", "hi", now())
	s.db.Exec(`INSERT INTO ai_runs (id, user_id, thread_id, status, task, started_at) VALUES (?,?,?,?,?,?)`, runID, bobID, tid, "waiting_user", "task", now())

	// Admin disables AI for Bob.
	if rec := secCall(s, "PATCH", "/api/users/"+bobID, adminCookie, `{"aiDisabled":true}`); rec.Code != 200 {
		t.Fatalf("disable Bob AI: %d %s", rec.Code, rec.Body.String())
	}

	checks := []struct {
		method, path, body string
	}{
		{"GET", "/api/ai/threads/" + tid + "/messages", ""},
		{"PATCH", "/api/ai/threads/" + tid, `{"title":"Renamed while disabled"}`},
		{"GET", "/api/ai/runs/" + runID, ""},
		{"POST", "/api/ai/runs/" + runID + "/answer", `{"answer":"continue"}`},
		{"POST", "/api/ai/runs/" + runID + "/approve", `{"approved":true}`},
	}
	for _, c := range checks {
		rec := secCall(s, c.method, c.path, bobCookie, c.body)
		if rec.Code != http.StatusForbidden {
			t.Errorf("CONFIRMED BUG-10: disabled user got HTTP %d on %s %s (want 403)", rec.Code, c.method, c.path)
		}
	}

	// MCP ai_thread_messages also bypasses aiEnabledForUser.
	bobUser := s.userByID(bobID)
	if out, err := s.mcpAIThreadMessages(bobUser, tid, 10); err == nil {
		t.Errorf("CONFIRMED BUG-10 (MCP): disabled user succeeded calling mcpAIThreadMessages: %s", out)
	}
}

// BUG-11: Junior admin must NOT be able to disable the owner's AI or disable their own AI.
func TestSecurity_BUG11_AdminCannotDisableOwnerOrSelfAI(t *testing.T) {
	s := testServer(t)
	ownerID, _ := signedIn(t, s, "owner-bug11@example.test")
	admin2ID, admin2Cookie := signedIn(t, s, "admin2-bug11@example.test")

	// Promote admin2 to non-owner admin.
	s.db.Exec(`UPDATE users SET is_admin = 1 WHERE id = ?`, admin2ID)
	if org := s.defaultOrg(); org != "" {
		s.db.Exec(`INSERT OR REPLACE INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`, org, admin2ID, now())
	}

	// 1) Junior admin tries to disable owner's AI.
	recOwner := secCall(s, "PATCH", "/api/users/"+ownerID, admin2Cookie, `{"aiDisabled":true}`)
	if recOwner.Code != http.StatusForbidden || s.userByID(ownerID).AIDisabled {
		t.Errorf("CONFIRMED BUG-11 (owner): junior admin disabled owner's AI (status=%d, owner.AIDisabled=%v)", recOwner.Code, s.userByID(ownerID).AIDisabled)
	}

	// 2) Junior admin disables their own AI (self-lockout).
	recSelf := secCall(s, "PATCH", "/api/users/"+admin2ID, admin2Cookie, `{"aiDisabled":true}`)
	if recSelf.Code != http.StatusForbidden || s.userByID(admin2ID).AIDisabled {
		t.Errorf("CONFIRMED BUG-11 (self-lockout): admin disabled their own AI (status=%d, admin2.AIDisabled=%v)", recSelf.Code, s.userByID(admin2ID).AIDisabled)
	}
}

// BUG-13: Invalid AI_PROXY_URL must not fail-open to direct egress, and valid
// AI_PROXY_URL must reuse a cached Transport rather than leaking a fresh one per call.
func TestSecurity_BUG13_AIProxyTransportAndFailClosed(t *testing.T) {
	t.Run("invalid_proxy_fails_open", func(t *testing.T) {
		t.Setenv("AI_PROXY_URL", "://bad-proxy-url")
		c := aiHTTPClient()
		if c.Transport == nil {
			t.Errorf("CONFIRMED BUG-13: invalid AI_PROXY_URL silently fell back to nil Transport (http.DefaultTransport, direct egress)")
		}
	})

	t.Run("valid_proxy_leaks_new_transport_per_call", func(t *testing.T) {
		t.Setenv("AI_PROXY_URL", "http://127.0.0.1:8888")
		c1 := aiHTTPClient()
		c2 := aiHTTPClient()
		if c1.Transport != c2.Transport {
			t.Errorf("CONFIRMED BUG-13: aiHTTPClient allocates a new *http.Transport on every call (%p != %p) with IdleConnTimeout=0", c1.Transport, c2.Transport)
		}
	})
}

// BUG-43: ai_allow_instance_key default must agree between Admin UI and resolveAIConfig,
// and rotating aiInstanceKey without aiAllowInstanceKey must not re-enable sharing.
func TestSecurity_BUG43_InstanceKeyDefaultAndRotationPolicy(t *testing.T) {
	s := testServer(t)
	_, adminCookie := signedIn(t, s, "admin-bug43@example.test")
	memberID, _ := signedIn(t, s, "member-bug43@example.test")

	// Seed encrypted instance key directly without setting ai_allow_instance_key.
	encKey, err := s.aiEncKey()
	if err != nil {
		t.Fatalf("aiEncKey: %v", err)
	}
	enc, err := encryptSecret("sk-test-default", encKey)
	if err != nil {
		t.Fatalf("encryptSecret: %v", err)
	}
	s.setSetting("ai_instance_key_enc", enc)

	uiAllows, _ := s.aiAdminSettings()["aiAllowInstanceKey"].(bool)
	_, _, _, _, gotKey, _, _ := s.resolveAIConfig(s.userByID(memberID))
	if !uiAllows && gotKey != "" {
		t.Errorf("CONFIRMED BUG-43 (default mismatch): Admin UI reports aiAllowInstanceKey=%v while resolveAIConfig hands instance key to non-admin", uiAllows)
	}

	// Explicitly disable sharing, then rotate key via partial PUT omitting aiAllowInstanceKey.
	if rec := secCall(s, "PUT", "/api/settings", adminCookie, `{"aiAllowInstanceKey":false}`); rec.Code != 200 {
		t.Fatalf("disable allow instance key: %d", rec.Code)
	}
	if rec := secCall(s, "PUT", "/api/settings", adminCookie, `{"aiInstanceKey":"sk-rotated-key"}`); rec.Code != 200 {
		t.Fatalf("rotate key: %d", rec.Code)
	}
	if s.setting("ai_allow_instance_key", "0") != "0" {
		t.Errorf("CONFIRMED BUG-43 (rotation): rotating aiInstanceKey silently flipped ai_allow_instance_key from '0' back to %q", s.setting("ai_allow_instance_key", ""))
	}
}

// BUG-47: POST /api/ai/attachments must enforce max_upload_mb limit and verify threadId ownership.
func TestSecurity_BUG47_AIAttachmentEnforcesLimitAndThreadOwnership(t *testing.T) {
	s := testServer(t)
	aliceID, _ := signedIn(t, s, "alice-bug47@example.test")
	_, bobCookie := signedIn(t, s, "bob-bug47@example.test")

	s.setSetting("max_upload_mb", "1")
	aliceThread := newID()
	s.db.Exec(`INSERT INTO ai_threads (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`, aliceThread, aliceID, "Alice Thread", now(), now())

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("threadId", aliceThread)
	fw, _ := mw.CreateFormFile("file", "oversized.txt")
	// 2 MiB > max_upload_mb (1 MiB) — tiny for test RAM, proves limit is ignored.
	fw.Write(bytes.Repeat([]byte("A"), 2<<20))
	mw.Close()

	req := httptest.NewRequest("POST", "/api/ai/attachments", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Cookie", bobCookie)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code == 200 {
		t.Errorf("CONFIRMED BUG-47 (no size limit): POST /api/ai/attachments accepted 2 MiB file despite max_upload_mb=1 (HTTP 200)")
	}
	var count int
	s.db.QueryRow(`SELECT COUNT(*) FROM ai_attachments WHERE thread_id = ?`, aliceThread).Scan(&count)
	if count > 0 {
		t.Errorf("CONFIRMED BUG-47 (foreign threadId): Bob inserted %d attachment(s) into Alice's thread %s", count, aliceThread)
	}
}

// BUG-48: Plain-text export must cap nesting depth / indentation width to prevent OOM amplification.
func TestSecurity_BUG48_PlainTextExportCapsNestingAmplification(t *testing.T) {
	const depth = 500
	var sb strings.Builder
	for i := 0; i < depth; i++ {
		sb.WriteString(`[{"type":"paragraph","children":`)
	}
	sb.WriteString(`[{"type":"divider"}]`)
	for i := 0; i < depth; i++ {
		sb.WriteString(`}]`)
	}

	p := &page{
		pageMeta: pageMeta{Title: "Deep"},
		Content:  json.RawMessage(sb.String()),
	}
	txt := pagePlainText(p)
	// Without a depth/indent cap, the divider at depth 500 gets 1000 leading spaces.
	const maxSafeIndent = 128
	if strings.Contains(txt, strings.Repeat(" ", maxSafeIndent)+"---") {
		t.Errorf("CONFIRMED BUG-48: renderPlainBlocks emitted >=%d leading spaces (depth=%d -> %d spaces) with no depth/indent cap", maxSafeIndent, depth, depth*2)
	}
}
