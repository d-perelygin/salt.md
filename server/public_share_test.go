package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func shareFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	s := testServer(t)
	u, _ := signedIn(t, s, "public-test@example.com")
	ws := makeWorkspace(t, s, u)
	seedPage(t, s, "shared-page", "", ws, u, "private", `[{"type":"image","props":{"url":"/files/shared.png","name":"Public image"}},{"type":"file","props":{"url":"/files/report.pdf","name":"Report"}},{"type":"paragraph","content":[{"type":"link","href":"/files/inline.txt","content":[{"type":"text","text":"Inline download"}]}]}]`)
	seedPage(t, s, "child-page", "shared-page", ws, u, "private", `[{"type":"image","props":{"url":"/files/child.png"}}]`)
	seedPage(t, s, "other-private", "", ws, u, "private", `[{"type":"file","props":{"url":"/files/private.txt"}}]`)
	for _, name := range []string{"shared.png", "report.pdf", "inline.txt", "child.png", "private.txt", "unattached.txt", "icon.png", "cover.png"} {
		seedFile(t, s, name, "fixture:"+name)
	}
	s.db.Exec(`UPDATE pages SET icon='/files/icon.png',cover='/files/cover.png' WHERE id='shared-page'`)
	token := strings.Repeat("a", 36)
	if _, err := s.db.Exec(`INSERT INTO share_links(token_hash,page_id,created_at) VALUES(?,'shared-page',?)`, tokenHash(token), now()); err != nil {
		t.Fatal(err)
	}
	return s, token, u
}
func publicRequest(s *Server, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}
func TestPublicFilesStayInsideLiveShare(t *testing.T) {
	s, token, _ := shareFixture(t)
	base := "/public/" + token
	for _, name := range []string{"shared.png", "report.pdf", "inline.txt", "icon.png", "cover.png"} {
		r := publicRequest(s, "GET", base+"/files/"+name, "", nil)
		if r.Code != 200 || r.Body.String() != "fixture:"+name {
			t.Fatalf("allowed %s: %d %s", name, r.Code, r.Body.String())
		}
		if r.Header().Get("Cache-Control") != "private, no-store" || !strings.Contains(r.Header().Get("Content-Security-Policy"), "sandbox") || r.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("unsafe upload headers")
		}
	}
	for _, name := range []string{"child.png", "private.txt", "unattached.txt", "missing.png", "%2e%2e", "%2fprivate.txt", "%252e%252e"} {
		if r := publicRequest(s, "GET", base+"/files/"+name, "", nil); r.Code == 200 {
			t.Fatalf("leaked %s", name)
		}
	}
	if r := publicRequest(s, "GET", "/files/shared.png", "", nil); r.Code != 401 {
		t.Fatalf("global files opened: %d", r.Code)
	}
	if r := publicRequest(s, "GET", "/public/invalid/files/shared.png", "", nil); r.Code != 404 {
		t.Fatalf("invalid share %d", r.Code)
	}
	// Inline attachments work; HEAD/range still go through the same scope guard.
	if r := publicRequest(s, "HEAD", base+"/files/shared.png", "", nil); r.Code != 200 || r.Body.Len() != 0 {
		t.Fatal("HEAD failed")
	}
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", map[string]string{"Range": "bytes=0-6"}); r.Code != 206 || r.Body.String() != "fixture" {
		t.Fatal("range failed")
	}
	s.db.Exec(`UPDATE pages SET content='[]',icon='',cover='' WHERE id='shared-page'`)
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", nil); r.Code != 404 {
		t.Fatal("removed block still shared")
	}
	s.db.Exec(`UPDATE pages SET content='[{"type":"image","props":{"url":"/files/shared.png"}}]' WHERE id='shared-page'`)
	s.db.Exec(`UPDATE pages SET trashed_at=? WHERE id='shared-page'`, now())
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", nil); r.Code != 404 {
		t.Fatal("trashed file shared")
	}
	s.db.Exec(`UPDATE pages SET trashed_at=NULL WHERE id='shared-page'`)
	s.db.Exec(`UPDATE share_links SET expires_at=? WHERE token_hash=?`, time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), tokenHash(token))
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", nil); r.Code != 404 {
		t.Fatal("expired share serves file")
	}
	s.db.Exec(`INSERT INTO share_links(token_hash,page_id,created_at) VALUES(?,'shared-page',?)`, tokenHash(token), now())
	s.db.Exec(`DELETE FROM share_links WHERE token_hash=?`, tokenHash(token))
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", nil); r.Code != 404 {
		t.Fatal("revoked share serves file")
	}
}
func TestPublicFilesRejectSymlinksOutsideUploadRoot(t *testing.T) {
	s, token, _ := shareFixture(t)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	os.WriteFile(outside, []byte("outside secret"), 0600)
	if err := os.Symlink(outside, filepath.Join(s.dataDir, "files", "escape.txt")); err != nil {
		t.Fatal(err)
	}
	s.db.Exec(`UPDATE pages SET content='[{"type":"file","props":{"url":"/files/escape.txt"}}]' WHERE id='shared-page'`)
	if r := publicRequest(s, "GET", "/public/"+token+"/files/escape.txt", "", nil); r.Code != 404 {
		t.Fatal("symlink escape exposed")
	}
}
func TestPasswordShareFilesRequirePageGrant(t *testing.T) {
	s, token, _ := shareFixture(t)
	base := "/public/" + token
	s.db.Exec(`UPDATE share_links SET password_hash=? WHERE token_hash=?`, tokenHash(token+":fixture-password"), tokenHash(token))
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", nil); r.Code != 404 {
		t.Fatal("password bypass")
	}
	wrong := publicRequest(s, "POST", base, "pw=wrong", map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if wrong.Code != 403 || len(wrong.Result().Cookies()) != 0 {
		t.Fatal("wrong password created grant")
	}
	form := url.Values{"pw": {"fixture-password"}}.Encode()
	r := publicRequest(s, "POST", base, form, map[string]string{"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-Proto": "https"})
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	cookies := r.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("no asset grant")
	}
	c := cookies[0]
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != base || c.MaxAge != 3600 || strings.Contains(c.Value, "fixture-password") {
		t.Fatal("unsafe cookie")
	}
	hdr := map[string]string{"Cookie": c.Name + "=" + c.Value}
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", hdr); r.Code != 200 {
		t.Fatalf("grant cannot load image %d", r.Code)
	}
	if r := publicRequest(s, "GET", base, "", hdr); r.Code != 200 || strings.Contains(r.Body.String(), "share-password") {
		t.Fatal("grant cannot reload page")
	}
	if r := publicRequest(s, "GET", base+"/files/private.txt", "", hdr); r.Code != 404 {
		t.Fatal("grant widened page scope")
	}
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", map[string]string{"Cookie": c.Name + "=" + c.Value + "bad"}); r.Code != 404 {
		t.Fatal("tampered grant accepted")
	}
	expiry := "1"
	badCookie := publicGrantCookie + "=" + expiry + "." + publicGrantMAC(token, expiry, s.publicGrantKey(token))
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", map[string]string{"Cookie": badCookie}); r.Code != 404 {
		t.Fatal("expired grant accepted")
	}
	other := strings.Repeat("b", 36)
	s.db.Exec(`INSERT INTO share_links(token_hash,page_id,created_at,password_hash) VALUES(?,'shared-page',?,?)`, tokenHash(other), now(), s.publicGrantKey(token))
	if r := publicRequest(s, "GET", "/public/"+other+"/files/shared.png", "", hdr); r.Code != 404 {
		t.Fatal("cross-token grant accepted")
	}
	s.db.Exec(`UPDATE share_links SET password_hash=? WHERE token_hash=?`, tokenHash(token+":changed-password"), tokenHash(token))
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", hdr); r.Code != 404 {
		t.Fatal("cookie survives password change")
	}
	s.db.Exec(`DELETE FROM share_links WHERE token_hash=?`, tokenHash(token))
	if r := publicRequest(s, "GET", base+"/files/shared.png", "", hdr); r.Code != 404 {
		t.Fatal("grant survives revoke")
	}
}
// The reader the fork ships is the document renderer with signed file URLs —
// not upstream's themed HTML shell. What both must guarantee is the same: no
// comments, no print furniture, no room for a global /files/ URL, and scripts
// that answer only to the response's own nonce.
func TestPublicReaderHidesPrintCommentsAndGlobalFiles(t *testing.T) {
	s, token, u := shareFixture(t)
	s.db.Exec(`INSERT INTO comments(id,page_id,author_id,body,created_at) VALUES('private-comment','shared-page',?,'COMMENT-MUST-NOT-LEAK',?)`, u, now())
	r := publicRequest(s, "GET", "/public/"+token, "", nil)
	h := r.Body.String()
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	for _, want := range []string{"/public/" + token + "/files/shared.png", "/public/" + token + "/files/inline.txt"} {
		if !strings.Contains(h, want) {
			t.Fatalf("missing %s", want)
		}
	}
	for _, bad := range []string{"COMMENT-MUST-NOT-LEAK", "child.png", "private.txt", "src=\"/files/", "href=\"/files/"} {
		if strings.Contains(h, bad) {
			t.Fatalf("public reader exposed %s", bad)
		}
	}
	if !strings.Contains(r.Header().Get("Content-Security-Policy"), "script-src 'nonce-") || r.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("public document guards missing")
	}
	api := publicRequest(s, "GET", "/api/public/"+token, "", nil)
	var payload map[string]any
	json.Unmarshal(api.Body.Bytes(), &payload)
	if !strings.Contains(string(api.Body.Bytes()), "/public/"+token+"/files/") {
		t.Fatal("JSON uses locked global files")
	}
}

func TestPublicCollectionDoesNotExposePrivateChildren(t *testing.T) {
	s, token, _ := shareFixture(t)
	s.db.Exec(`UPDATE pages SET type='collection' WHERE id='shared-page'`)
	s.db.Exec(`UPDATE pages SET title='PRIVATE-CHILD-TITLE',props='{"secret":"PRIVATE-CHILD-PROP"}',content='[{"type":"paragraph","content":[{"type":"text","text":"PRIVATE-CHILD-BODY"}]}]' WHERE id='child-page'`)
	r := publicRequest(s, "GET", "/public/"+token, "", nil)
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	for _, bad := range []string{"PRIVATE-CHILD-TITLE", "PRIVATE-CHILD-PROP", "PRIVATE-CHILD-BODY"} {
		if strings.Contains(r.Body.String(), bad) {
			t.Fatal("collection leaked", bad)
		}
	}
}

// The fast rejection must not grant text-only mentions or change JSON's
// last-key-wins semantics, and encoded upload URLs must still work.
func TestPublicAssetFastPathPreservesReferenceAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, content string
		want          bool
	}{
		{"plain", `[{"props":{"url":"/files/a.png"}}]`, true},
		{"absent", `[{"props":{"url":"/files/b.png"}}]`, false},
		{"text", `[{"content":[{"text":"/files/a.png"}]}]`, false},
		{"duplicate", `[{"props":{"url":"/files/a.png","url":"/files/b.png"}}]`, false},
		{"escaped", `[{"props":{"url":"\/files\/a.png"}}]`, true},
		{"unicode", `[{"props":{"url":"/files/\u0061.png"}}]`, true},
		{"encoded", `[{"props":{"url":"/files/%61.png"}}]`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &page{Content: json.RawMessage(tc.content)}
			if got := publicPageReferencesFile(p, "a.png"); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPublicAssetsSharePasswordBudgetWithHTMLAndJSON(t *testing.T) {
	s, token, _ := shareFixture(t)
	s.db.Exec(`UPDATE share_links SET password_hash=? WHERE token_hash=?`, tokenHash(token+":correct"), tokenHash(token))
	request := func(path, password, ip string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.RemoteAddr = ip + ":40000"
		r.Header.Set("X-Share-Password", password)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("public response is cacheable")
		}
		return w.Code
	}
	asset := "/public/" + token + "/files/shared.png"
	for i := 0; i < 8; i++ {
		request(asset, "wrong", "203.0.113.5")
	}
	if request(asset, "correct", "203.0.113.5") != 429 || request("/api/public/"+token, "correct", "203.0.113.5") != 429 {
		t.Fatal("asset guesses bypass the shared password budget")
	}
	if request(asset, "correct", "198.51.100.2") != 200 {
		t.Fatal("another visitor was locked out")
	}
	other := strings.Repeat("c", 36)
	s.db.Exec(`INSERT INTO share_links(token_hash,page_id,created_at,password_hash) VALUES(?,'shared-page',?,?)`, tokenHash(other), now(), tokenHash(other+":correct"))
	if request("/public/"+other+"/files/shared.png", "correct", "203.0.113.5") != 200 {
		t.Fatal("another link was locked out")
	}
}
