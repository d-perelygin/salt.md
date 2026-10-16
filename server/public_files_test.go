package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Public file URLs and the public document view, through the real router.

// mintDocShare mints a read-share for a document page and returns the token.
func mintDocShare(t *testing.T, s *Server, cookie, pageID, body string) string {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/pages/"+pageID+"/share", strings.NewReader(body))
	r.Header.Set("Cookie", cookie)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("mint share: %d %s", rec.Code, rec.Body.String())
	}
	var minted struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil || minted.Token == "" {
		t.Fatalf("mint share gave no token: %s", rec.Body.String())
	}
	return minted.Token
}

// putFile drops bytes into the instance's files directory under name.
func putFile(t *testing.T, s *Server, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(s.dataDir, "files", name), []byte(body), 0o644); err != nil {
		t.Fatalf("write file %s: %v", name, err)
	}
}

var pubFileURLRef = regexp.MustCompile(`/public/[0-9a-f]+/files/[A-Za-z0-9._%+-]+\?exp=\d+&amp;sig=[0-9a-f]+`)

// pubFileURLs extracts the signed file URLs from a public page body.
func pubFileURLs(t *testing.T, body string) []string {
	t.Helper()
	raw := pubFileURLRef.FindAllString(body, -1)
	out := make([]string, 0, len(raw))
	for _, u := range raw {
		out = append(out, strings.ReplaceAll(u, "&amp;", "&"))
	}
	return out
}

func anonGet(s *Server, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	return rec
}

// A shared document serves its uploads to anonymous readers through signed
// URLs — and stops pointing at the login-walled /files/ behind them.
func TestPublicDocServesItsFiles(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "pubfiles@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	img := newID() + ".png"
	putFile(t, s, img, "fake-png-bytes")
	doc := s.makePage(t, ws, uid, "", "Pic doc", "{}")
	content := `[{"type":"image","props":{"url":"/files/` + img + `","name":"pic.png"}}]`
	if _, err := s.db.Exec(`UPDATE pages SET content = ? WHERE id = ?`, content, doc); err != nil {
		t.Fatal(err)
	}
	token := mintDocShare(t, s, cookie, doc, `{}`)

	rec := anonGet(s, "/public/"+token)
	if rec.Code != http.StatusOK {
		t.Fatalf("public doc: %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, `src="/files/`) || strings.Contains(body, `href="/files/`) {
		t.Error("public HTML still points at the authenticated /files/")
	}
	urls := pubFileURLs(t, body)
	if len(urls) != 1 {
		t.Fatalf("want 1 signed file URL, got %d in %s", len(urls), body)
	}
	frec := anonGet(s, urls[0])
	if frec.Code != http.StatusOK {
		t.Fatalf("signed file: %d %s", frec.Code, frec.Body.String())
	}
	if frec.Body.String() != "fake-png-bytes" {
		t.Errorf("signed file body = %q, want the upload", frec.Body.String())
	}
	if csp := frec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") {
		t.Errorf("signed file misses the sandbox CSP: %q", csp)
	}
}

// Tampered, expired and out-of-scope file URLs open nothing.
func TestPublicFileGate(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "pubgate@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	img := newID() + ".png"
	putFile(t, s, img, "img-bytes")
	other := newID() + ".png"
	putFile(t, s, other, "stranger-bytes")
	doc := s.makePage(t, ws, uid, "", "Gate doc", "{}")
	if _, err := s.db.Exec(`UPDATE pages SET content = ? WHERE id = ?`,
		`[{"type":"image","props":{"url":"/files/`+img+`","name":"pic.png"}}]`, doc); err != nil {
		t.Fatal(err)
	}
	token := mintDocShare(t, s, cookie, doc, `{}`)

	rec := anonGet(s, "/public/"+token)
	urls := pubFileURLs(t, rec.Body.String())
	if len(urls) != 1 {
		t.Fatalf("want 1 signed file URL, got %d", len(urls))
	}
	good := urls[0]
	if rec := anonGet(s, good); rec.Code != http.StatusOK {
		t.Fatalf("good URL: %d, want 200", rec.Code)
	}
	if rec := anonGet(s, good+"tampered"); rec.Code != http.StatusForbidden {
		t.Errorf("tampered sig: %d, want 403", rec.Code)
	}
	if rec := anonGet(s, strings.Split(good, "?")[0]); rec.Code != http.StatusForbidden {
		t.Errorf("missing sig: %d, want 403", rec.Code)
	}
	// An upload nobody's page references is not reachable through the share.
	key, _, found := s.shareFileScope(token)
	if !found {
		t.Fatal("no file scope for the share")
	}
	stranger := "/" + strings.TrimPrefix(mintShareFileURL(key, token, other, ""), "/")
	stranger = strings.ReplaceAll(stranger, "&amp;", "&")
	if rec := anonGet(s, stranger); rec.Code != http.StatusNotFound {
		t.Errorf("unreferenced file: %d, want 404", rec.Code)
	}
	// A forged expiry in the past dies at the gate.
	past := time.Now().Add(-time.Hour).Unix()
	old := "/public/" + token + "/files/" + img + "?exp=" + itoa(int(past)) + "&sig=" + signShareFile(key, token, img, past)
	if rec := anonGet(s, old); rec.Code != http.StatusForbidden {
		t.Errorf("expired URL: %d, want 403", rec.Code)
	}
	// An unknown token is a missing page, not a forbidden one.
	if rec := anonGet(s, "/public/"+newID()+newID()+"/files/"+img+"?exp=9999999999&sig=aa"); rec.Code != http.StatusNotFound {
		t.Errorf("unknown token: %d, want 404", rec.Code)
	}
}

// Changing the share password rotates the file URLs: page copies saved
// under the old secret stop opening uploads, and the password itself never
// appears in the HTML.
func TestPublicFilePasswordRotation(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "pubrot@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	img := newID() + ".png"
	putFile(t, s, img, "secret-bytes")
	doc := s.makePage(t, ws, uid, "", "Rot doc", "{}")
	if _, err := s.db.Exec(`UPDATE pages SET content = ? WHERE id = ?`,
		`[{"type":"image","props":{"url":"/files/`+img+`","name":"pic.png"}}]`, doc); err != nil {
		t.Fatal(err)
	}
	token := mintDocShare(t, s, cookie, doc, `{"password":"first"}`)

	if rec := anonGet(s, "/public/"+token); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), "pwform") {
		t.Fatalf("no password: %d, want the gate", rec.Code)
	}
	rec := anonGet(s, "/public/"+token+"?pw=first")
	if rec.Code != http.StatusOK {
		t.Fatalf("right ?pw=: %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "first") && strings.Contains(rec.Body.String(), "?pw=") {
		t.Error("the password leaks into the rendered page")
	}
	old := pubFileURLs(t, rec.Body.String())
	if len(old) != 1 {
		t.Fatalf("want 1 signed file URL, got %d", len(old))
	}
	if rec := anonGet(s, old[0]); rec.Code != http.StatusOK {
		t.Fatalf("file under first password: %d, want 200", rec.Code)
	}

	patch := httptest.NewRequest("PATCH", "/api/pages/"+doc+"/share", strings.NewReader(`{"password":"second"}`))
	patch.Header.Set("Cookie", cookie)
	prec := httptest.NewRecorder()
	s.ServeHTTP(prec, patch)
	if prec.Code != http.StatusOK {
		t.Fatalf("rotate password: %d %s", prec.Code, prec.Body.String())
	}
	if rec := anonGet(s, old[0]); rec.Code != http.StatusForbidden {
		t.Errorf("old file URL after rotation: %d, want 403", rec.Code)
	}
	rec = anonGet(s, "/public/"+token+"?pw=second")
	fresh := pubFileURLs(t, rec.Body.String())
	if len(fresh) != 1 {
		t.Fatalf("want 1 fresh file URL, got %d", len(fresh))
	}
	if rec := anonGet(s, fresh[0]); rec.Code != http.StatusOK {
		t.Errorf("file under second password: %d, want 200", rec.Code)
	}
	// Unsharing revokes the page and its uploads together.
	un := httptest.NewRequest("DELETE", "/api/pages/"+doc+"/share", nil)
	un.Header.Set("Cookie", cookie)
	urec := httptest.NewRecorder()
	s.ServeHTTP(urec, un)
	if urec.Code != http.StatusOK {
		t.Fatalf("unshare: %d", urec.Code)
	}
	if rec := anonGet(s, "/public/"+token+"?pw=second"); rec.Code != http.StatusNotFound {
		t.Errorf("page after unshare: %d, want 404", rec.Code)
	}
	if rec := anonGet(s, fresh[0]); rec.Code != http.StatusNotFound {
		t.Errorf("file after unshare: %d, want 404", rec.Code)
	}
}

// The public document defaults to the continuous page with a toolbar and an
// outline; ?view=paged keeps the A4 sheets for printing.
func TestPublicDocViewsAndOutline(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "pubview@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	doc := s.makePage(t, ws, uid, "", "Outline doc", "{}")
	content := `[{"type":"heading","props":{"level":2},"content":[{"type":"text","text":"Intro","styles":{}}]},` +
		`{"type":"heading","props":{"level":3},"content":[{"type":"text","text":"Details","styles":{}}]},` +
		`{"type":"heading","props":{"level":2},"content":[{"type":"text","text":"Intro","styles":{}}]},` +
		`{"type":"paragraph","content":[{"type":"text","text":"Body","styles":{}}]}]`
	if _, err := s.db.Exec(`UPDATE pages SET content = ? WHERE id = ?`, content, doc); err != nil {
		t.Fatal(err)
	}
	token := mintDocShare(t, s, cookie, doc, `{}`)

	rec := anonGet(s, "/public/"+token)
	body := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("public doc: %d", rec.Code)
	}
	for _, want := range []string{`pub-continuous`, `pub-dock`, `pub-toggle`, `id="pubtocfab"`, `id="pubtoc"`, `id="pubflow"`, `pubStart("continuous")`, `title="Continuous view"`, `title="Paged view"`, `aria-current="true"`, `print=1`, `SALT_AUTOPRINT=false`} {
		if !strings.Contains(body, want) {
			t.Errorf("continuous view misses %q", want)
		}
	}
	for _, want := range []string{`href="#intro"`, `href="#details"`, `href="#intro-2"`, `toc-l2`, `toc-l3`} {
		if !strings.Contains(body, want) {
			t.Errorf("outline misses %q", want)
		}
	}
	if strings.Contains(body, `onclick="window.print()"`) {
		t.Error("continuous view must print through the paged version (?print=1), not directly")
	}
	// The dock holds one view switch and one printer — a duplicated block
	// once shipped two printers side by side.
	if n := strings.Count(body, `title="Print / Save as PDF"`); n != 1 {
		t.Errorf("dock printers = %d, want exactly 1", n)
	}

	prec := anonGet(s, "/public/"+token+"?view=paged")
	pbody := prec.Body.String()
	if prec.Code != http.StatusOK {
		t.Fatalf("paged view: %d", prec.Code)
	}
	for _, want := range []string{`pub-paged`, `pub-toggle`, `pubStart("paged")`, `window.print()`, `?view=continuous`} {
		if !strings.Contains(pbody, want) {
			t.Errorf("paged view misses %q", want)
		}
	}
	if n := strings.Count(pbody, `title="Print / Save as PDF"`); n != 1 {
		t.Errorf("paged dock printers = %d, want exactly 1", n)
	}
}

// A document without headings gets no outline and no toggle for one.
func TestPublicTocFabVisibleOnNarrowScreens(t *testing.T) {
	// Regression: an outline left open on desktop carries no classes, so at a
	// narrow width the drawer CSS hid both the outline and its button — no
	// way back in. The narrow-screen rules must show the floating button by
	// default (hiding it only behind the open drawer) instead of depending
	// on toc-hidden, which a desktop-open sidebar never sets.
	mobile := pubDocStyle[strings.Index(pubDocStyle, "@media (max-width:1000px)"):]
	if !strings.Contains(mobile, ".pub-fab{display:flex;top:56px}") {
		t.Error("narrow CSS must show the outline button by default, lowered for thumb reach")
	}
	if !strings.Contains(mobile, "body.toc-open .pub-fab{display:none}") {
		t.Error("narrow CSS must hide the outline button behind the open drawer")
	}
	if strings.Contains(pubDocJS, "classList.add('toc-hidden')") {
		t.Error("startup must not force toc-hidden: it would pin desktop shut after widening")
	}
	// The floating button sits low enough to reach by thumb, and the text
	// starts below it: on narrow screens the button ends at 96px (56+40),
	// so the flow needs more than that above it.
	if !strings.Contains(mobile, ".pub-flow{padding:110px 20px 120px}") {
		t.Error("narrow flow must clear the lowered outline button")
	}
}

// The outline chrome: air above the header and a close control big enough
// to hit by thumb.
func TestPublicTocChrome(t *testing.T) {
	if !strings.Contains(pubDocStyle, "padding:28px 16px 40px") {
		t.Error("outline needs top air above its header")
	}
	if !strings.Contains(pubDocStyle, ".pub-ibtn.small{width:40px;height:40px") {
		t.Error("outline close control must be thumb-sized")
	}
}

func TestPublicDocWithoutHeadingsHasNoOutline(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "pubnohead@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	doc := s.makePage(t, ws, uid, "", "Plain doc", "{}")
	if _, err := s.db.Exec(`UPDATE pages SET content = ? WHERE id = ?`,
		`[{"type":"paragraph","content":[{"type":"text","text":"Just text","styles":{}}]}]`, doc); err != nil {
		t.Fatal(err)
	}
	token := mintDocShare(t, s, cookie, doc, `{}`)
	body := anonGet(s, "/public/"+token).Body.String()
	if strings.Contains(body, `id="pubtoc"`) || strings.Contains(body, `id="pubtocfab"`) {
		t.Error("outline rendered for a document without headings")
	}
}

// Slugs stay readable beyond ASCII: a Russian heading anchors in Russian.
func TestSlugHeadingKeepsUnicode(t *testing.T) {
	if got := slugHeading("Привет, мир!"); got != "привет-мир" {
		t.Errorf("slugHeading = %q, want привет-мир", got)
	}
	html, toc := addHeadingIDs(`<h1>Doc</h1><h2>Привет мир</h2><h2>Привет мир</h2>`)
	if len(toc) != 2 || toc[0].ID != "привет-мир" || toc[1].ID != "привет-мир-2" {
		t.Errorf("outline = %+v in %s", toc, html)
	}
	if strings.Contains(html, "<h1>Doc</h1>") {
		t.Error("title h1 got no anchor")
	}
}
