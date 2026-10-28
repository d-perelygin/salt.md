package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Approval policy: read-only tools never ask, destructive ones ask on
// "review", everything that writes asks on "always", nothing asks on "skip".
func TestToolNeedsApproval(t *testing.T) {
	cases := []struct {
		tool, mode string
		want       bool
	}{
		{"search", "always", false},
		{"get_page", "review", false},
		{"query_rows", "skip", false},
		{"create_page", "always", true},
		{"create_page", "review", false},
		{"create_page", "skip", false},
		{"delete_comment", "review", true},
		{"set_trashed", "review", true},
		{"set_sharing", "review", true},
		{"propose_workspace_rules", "review", true},
		{"update_schema", "review", true},
		{"workspace", "review", true},
		{"update_page", "review", false},
		{"update_page", "always", true},
		{"unknown_future_tool", "review", false},
		{"unknown_future_tool", "always", true},
	}
	for _, c := range cases {
		if got := toolNeedsApproval(c.tool, c.mode); got != c.want {
			t.Errorf("toolNeedsApproval(%q, %q) = %v, want %v", c.tool, c.mode, got, c.want)
		}
	}
}

// The Artifacts panel is fed from tool results: only created pages count,
// errors never do, and repeats collapse to one entry.
func TestAIRecordArtifacts(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "artifacts@example.com")
	run := newID()
	if _, err := s.db.Exec(`INSERT INTO ai_runs (id, user_id, thread_id, status, started_at) VALUES (?, ?, 't', 'running', ?)`, run, uid, now()); err != nil {
		t.Fatalf("insert run: %v", err)
	}

	s.aiRecordArtifacts(run, "create_page", `Created page "A" with id abcdef0123456789abcdef0123456789 (path: /p/abcdef0123456789abcdef0123456789)`)
	s.aiRecordArtifacts(run, "list", `["a", "b"]`)
	s.aiRecordArtifacts(run, "create_page", `error: boom`)
	s.aiRecordArtifacts(run, "duplicate_page", `Created page 0123456789abcdef0123456789abcdef from template ffffffffffffffffffffffffffffffff`)
	s.aiRecordArtifacts(run, "create_page", `Created page "A again" with id abcdef0123456789abcdef0123456789 (path: /p/abcdef0123456789abcdef0123456789)`)

	var raw string
	s.db.QueryRow(`SELECT artifacts FROM ai_runs WHERE id = ?`, run).Scan(&raw)
	var got []string
	json.Unmarshal([]byte(raw), &got)
	want := []string{"abcdef0123456789abcdef0123456789", "0123456789abcdef0123456789abcdef"}
	if len(got) != len(want) {
		t.Fatalf("artifacts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("artifacts = %v, want %v", got, want)
		}
	}
}

// Thread rename + read marking + the list fields that drive the unread dot.
func TestAIThreadRenameAndRead(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "ai@example.com")
	tid := newID()
	s.db.Exec(`INSERT INTO ai_threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, 'Old', ?, ?)`,
		tid, uid, now(), now())
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', 'hi', ?)`,
		newID(), tid, now())
	hdr := map[string]string{"Cookie": cookie}
	call := func(method, url, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		s.ServeHTTP(rec, req)
		return rec
	}

	if rec := call("PATCH", "/api/ai/threads/"+tid, `{"title":""}`); rec.Code != 400 {
		t.Errorf("rename to empty: got %d, want 400", rec.Code)
	}
	if rec := call("PATCH", "/api/ai/threads/"+tid, `{"title":"New name"}`); rec.Code != 200 {
		t.Fatalf("rename: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if rec := call("GET", "/api/ai/threads", ""); rec.Code != 200 {
		t.Fatalf("list: got %d", rec.Code)
	} else {
		var out []struct {
			ID         string `json:"id"`
			Title      string `json:"title"`
			LastRole   string `json:"lastRole"`
			LastReadAt string `json:"lastReadAt"`
			HasRuns    bool   `json:"hasRuns"`
		}
		json.Unmarshal(rec.Body.Bytes(), &out)
		if len(out) != 1 || out[0].Title != "New name" {
			t.Fatalf("list after rename = %+v, want renamed thread", out)
		}
		if out[0].LastRole != "assistant" {
			t.Errorf("lastRole = %q, want assistant (drives the unread dot)", out[0].LastRole)
		}
		if out[0].LastReadAt != "" {
			t.Errorf("lastReadAt = %q, want empty before reading", out[0].LastReadAt)
		}
	}
	if rec := call("POST", "/api/ai/threads/"+tid+"/read", "{}"); rec.Code != 200 {
		t.Fatalf("mark read: got %d", rec.Code)
	}
	var lastRead string
	s.db.QueryRow(`SELECT last_read_at FROM ai_threads WHERE id = ?`, tid).Scan(&lastRead)
	if lastRead == "" {
		t.Errorf("last_read_at still empty after mark-read")
	}
	if rec := call("PATCH", "/api/ai/threads/does-not-exist", `{"title":"x"}`); rec.Code != 404 {
		t.Errorf("rename of missing thread: got %d, want 404", rec.Code)
	}
	_ = http.StatusOK
}

// ask_user is an in-app tool: present in the agent's private list, absent
// from the MCP catalogue, and refused over mcpCall instead of hanging.
func TestAskUserNotOverMCP(t *testing.T) {
	for _, tool := range mcpTools {
		if tool["name"] == "ask_user" {
			t.Fatalf("ask_user must not be in the MCP catalogue")
		}
	}
	if len(aiAgentExtraTools) != 1 || aiAgentExtraTools[0]["name"] != "ask_user" {
		t.Fatalf("aiAgentExtraTools should hold exactly the ask_user tool")
	}
	s := testServer(t)
	uid, _ := signedIn(t, s, "askq@example.com")
	if _, err := s.mcpCall(&user{ID: uid}, "ask_user", json.RawMessage(`{"question":"Q?","options":[{"label":"A"}]}`), ""); err == nil {
		t.Fatalf("mcpCall(ask_user) should fail, not hang or run")
	}
}

// ask_user with broken arguments fails fast with an error result, without
// pausing the run for an answer that could never arrive.
func TestAiAskUserInvalidArgs(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "askq2@example.com")
	for _, raw := range []string{
		`{"options":[]}`,
		`{"question":"Which language?","options":[{"label":"Only one"}]}`,
		`{"question":"Which page and language?","options":[{"label":"Into which language?"},{"label":"Current page"}]}`,
	} {
		msg, ok := s.aiAskUser(context.Background(), &user{ID: uid}, newID(), newID(), raw)
		if !ok {
			t.Fatalf("invalid ask_user args (%s) should return ok=true with an error result", raw)
		}
		if !strings.HasPrefix(msg, "error:") {
			t.Fatalf("invalid ask_user args (%s) returned %q, want an error: result", raw, msg)
		}
	}
}

// The answer endpoint stores the reply for a run that is waiting on a
// question, and refuses anything else.
func TestHandleAnswerAIRun(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "askq3@example.com")
	other, _ := signedIn(t, s, "askq4@example.com")
	_ = other
	run := newID()
	s.db.Exec(`INSERT INTO ai_runs (id, user_id, thread_id, status, pending_tool, pending_args, started_at) VALUES (?, ?, 't', 'waiting_user', 'ask_user', '{}', ?)`,
		run, uid, now())
	call := func(cookie, method, url, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", cookie)
		s.ServeHTTP(rec, req)
		return rec
	}
	if rec := call(cookie, "POST", "/api/ai/runs/"+run+"/answer", `{}`); rec.Code != 400 {
		t.Errorf("empty answer: got %d, want 400", rec.Code)
	}
	if rec := call("sess=bad", "POST", "/api/ai/runs/"+run+"/answer", `{"answer":"A"}`); rec.Code != 401 {
		t.Errorf("stranger: got %d, want 401", rec.Code)
	}
	if rec := call(cookie, "POST", "/api/ai/runs/"+run+"/answer", `{"answer":"Blue, because calm"}`); rec.Code != 200 {
		t.Fatalf("answer: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var got string
	s.db.QueryRow(`SELECT pending_answer FROM ai_runs WHERE id = ?`, run).Scan(&got)
	if got != "Blue, because calm" {
		t.Fatalf("pending_answer = %q, want the reply", got)
	}
	s.db.Exec(`UPDATE ai_runs SET status='running' WHERE id = ?`, run)
	if rec := call(cookie, "POST", "/api/ai/runs/"+run+"/answer", `{"answer":"late"}`); rec.Code != 409 {
		t.Errorf("answer when not waiting: got %d, want 409", rec.Code)
	}
}

// The run events stream exposes the pending question so the browser can
// render the ask_user card without a socket of its own.
func TestRunEventsExposePendingQuestion(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "askq5@example.com")
	run := newID()
	s.db.Exec(`INSERT INTO ai_runs (id, user_id, thread_id, status, pending_tool, pending_args, started_at, finished_at) VALUES (?, ?, 't', 'completed', 'ask_user', '{"question":"Q?"}', ?, ?)`,
		run, uid, now(), now())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/ai/runs/"+run+"/events", nil)
	req.Header.Set("Cookie", cookie)
	s.ServeHTTP(rec, req)
	body := rec.Body.String()
	if !strings.Contains(body, `"pendingTool":"ask_user"`) {
		t.Fatalf("events should expose the pending tool, got:\n%s", body)
	}
	if !strings.Contains(body, `Q?`) {
		t.Fatalf("events should expose the pending args, got:\n%s", body)
	}
}

// Creating a run persists the user message immediately so it survives reloads
// and failed runs, and retrying does not create duplicate messages.
func TestCreateAIRunPersistsUserMessage(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "runmsg@example.com")
	_ = uid
	call := func(method, url, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", cookie)
		s.ServeHTTP(rec, req)
		return rec
	}

	// 1. Initial run creation
	rec := call("POST", "/api/ai/runs", `{"task":"Full prompt with context","prompt":"User question"}`)
	if rec.Code != 200 {
		t.Fatalf("create run: got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var res struct {
		ID       string `json:"id"`
		ThreadID string `json:"threadId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal create run response: %v", err)
	}
	if res.ThreadID == "" {
		t.Fatalf("expected non-empty threadId")
	}

	// Verify user message in ai_messages
	var count int
	var role, content string
	s.db.QueryRow(`SELECT COUNT(*), role, content FROM ai_messages WHERE thread_id = ?`, res.ThreadID).Scan(&count, &role, &content)
	if count != 1 {
		t.Fatalf("expected 1 message in thread, got %d", count)
	}
	if role != "user" || content != "User question" {
		t.Fatalf("expected role='user' and content='User question', got role=%q content=%q", role, content)
	}

	// Verify aiThreadHistory with excludeMsgID excludes the user message
	var msgID string
	s.db.QueryRow(`SELECT id FROM ai_messages WHERE thread_id = ?`, res.ThreadID).Scan(&msgID)
	hist := s.aiThreadHistory(res.ThreadID, msgID, 8)
	if len(hist) != 0 {
		t.Fatalf("expected 0 history items when current message is excluded, got %d", len(hist))
	}
	histAll := s.aiThreadHistory(res.ThreadID, "", 8)
	if len(histAll) != 1 || histAll[0][1] != "User question" {
		t.Fatalf("expected 1 history item when not excluded, got %v", histAll)
	}

	// 2. Retry run creation
	recRetry := call("POST", "/api/ai/runs", `{"threadId":"`+res.ThreadID+`","task":"Full prompt with context","retry":true}`)
	if recRetry.Code != 200 {
		t.Fatalf("retry run: got %d (%s), want 200", recRetry.Code, recRetry.Body.String())
	}
	var countAfter int
	s.db.QueryRow(`SELECT COUNT(*) FROM ai_messages WHERE thread_id = ?`, res.ThreadID).Scan(&countAfter)
	if countAfter != 1 {
		t.Fatalf("expected message count to stay 1 after retry, got %d", countAfter)
	}
}

func TestDeleteAIThreadCleansRuns(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "delthread@example.com")
	tid := newID()
	runID := newID()

	s.db.Exec(`INSERT INTO ai_threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, 'Thread to delete', ?, ?)`,
		tid, uid, now(), now())
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'user', 'hello', ?)`,
		newID(), tid, now())
	s.db.Exec(`INSERT INTO ai_runs (id, user_id, thread_id, status, task, started_at) VALUES (?, ?, ?, 'completed', 'some task', ?)`,
		runID, uid, tid, now())
	s.db.Exec(`INSERT INTO ai_steps (id, run_id, thread_id, user_id, kind, title, created_at) VALUES (?, ?, ?, ?, 'thinking', 'thought', ?)`,
		newID(), runID, tid, uid, now())

	req := httptest.NewRequest("DELETE", "/api/ai/threads/"+tid, nil)
	req.Header.Set("Cookie", cookie)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("DELETE thread: got %d, want 200", rec.Code)
	}

	var threadCount, runCount, stepCount int
	s.db.QueryRow(`SELECT COUNT(*) FROM ai_threads WHERE id = ?`, tid).Scan(&threadCount)
	s.db.QueryRow(`SELECT COUNT(*) FROM ai_runs WHERE thread_id = ?`, tid).Scan(&runCount)
	s.db.QueryRow(`SELECT COUNT(*) FROM ai_steps WHERE run_id = ?`, runID).Scan(&stepCount)

	if threadCount != 0 {
		t.Errorf("ai_threads not deleted: got %d, want 0", threadCount)
	}
	if runCount != 0 {
		t.Errorf("ai_runs not deleted for thread: got %d, want 0", runCount)
	}
	if stepCount != 0 {
		t.Errorf("ai_steps not cascade-deleted: got %d, want 0", stepCount)
	}
}


