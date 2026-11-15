package server

import (
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// A credential narrowed to some workspaces, and a workspace's own rule for
// agents, are both gates for writing, not only for reading. A handful of write
// paths asked the bare permission (or nothing) and let a token for one
// workspace create pages in another, export it, take back changes in it, and
// write into a workspace closed to agents. And a viewer's content went
// wherever the account's default happened to be, read-only or not.

type scopeFixture struct {
	s                *Server
	owner, cookie    string
	team, other      string
	teamTok, openTok string // narrowed to Team; not narrowed at all
}

func newScopeFixture(t *testing.T) scopeFixture {
	t.Helper()
	s := testServer(t)
	owner, cookie := signedIn(t, s, "owner@example.test")
	f := scopeFixture{s: s, owner: owner, cookie: cookie, team: s.firstWorkspaceOf(t, owner), other: makeWorkspace(t, s, owner)}
	f.teamTok, f.openTok = "token-for-team-only", "token-for-everything"
	for tok, scope := range map[string]string{f.teamTok: f.team, f.openTok: ""} {
		if _, err := s.db.Exec(`INSERT INTO api_tokens (id, user_id, name, token_hash, scope, workspace_scope, created_at)
			VALUES (?, ?, 'agent', ?, 'write', ?, ?)`, newID(), owner, tokenHash(tok), scope, now()); err != nil {
			t.Fatalf("insert token: %v", err)
		}
	}
	return f
}

func (f scopeFixture) bearer(tok, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	f.s.ServeHTTP(rec, req)
	return rec
}

func TestANarrowedTokenCreatesOnlyInItsWorkspaces(t *testing.T) {
	f := newScopeFixture(t)
	inOther := f.s.makePage(t, f.other, f.owner, "", "Elsewhere", `{}`)
	for _, body := range []string{
		`{"title":"x","workspaceId":"` + f.other + `"}`,
		`{"title":"x","parentId":"` + inOther + `"}`,
	} {
		if rec := f.bearer(f.teamTok, "POST", "/api/pages", body); rec.Code != 403 {
			t.Errorf("%s: %d, want 403", body, rec.Code)
		}
	}
	rec := f.bearer(f.teamTok, "POST", "/api/pages", `{"title":"no workspace named"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), f.team) {
		t.Errorf("a page without a workspace should land in the token's own: %d %s", rec.Code, rec.Body.String())
	}

	// A template from a workspace the token was not given, over MCP.
	tpl := f.s.makePage(t, f.other, f.owner, "", "Other's template", `{}`)
	f.s.db.Exec(`UPDATE pages SET is_template = 1 WHERE id = ?`, tpl)
	u := &user{ID: f.owner, TokenKind: tokenKindAPI, TokenScope: "write", TokenWorkspaces: []string{f.team}}
	if out, err := callTool(t, f.s, u, "create_page", `{"template_id":"`+tpl+`"}`); err == nil {
		t.Errorf("a template from another workspace was instantiated: %s", out)
	}
}

func TestANarrowedTokenExportsAndRevertsOnlyItsWorkspaces(t *testing.T) {
	f := newScopeFixture(t)
	if rec := f.bearer(f.teamTok, "GET", "/api/workspaces/"+f.other+"/export", ""); rec.Code != 404 {
		t.Errorf("export of a workspace outside the token: %d, want 404", rec.Code)
	}
	if rec := f.bearer(f.teamTok, "GET", "/api/workspaces/"+f.team+"/export", ""); rec.Code != 200 {
		t.Errorf("export of the token's own workspace: %d", rec.Code)
	}

	col := f.s.makeCollection(t, f.other, f.owner, "Ledger", `[{"id":"note","name":"Note","type":"text"}]`)
	row := f.s.makeRow(t, f.other, f.owner, col, "Entry", `{"note":"after"}`)
	res, err := f.s.db.Exec(`INSERT INTO audit_log (created_at, actor_type, actor_id, actor_name, action, page_id, workspace_id, detail, changes)
		VALUES (?, 'agent', ?, 'agent', 'page.props', ?, ?, '', '{"note":{"from":"before","to":"after"}}')`, now(), f.owner, row, f.other)
	if err != nil {
		t.Fatalf("audit entry: %v", err)
	}
	id, _ := res.LastInsertId()
	if rec := f.bearer(f.teamTok, "POST", "/api/audit/"+strconv.FormatInt(id, 10)+"/revert", ""); rec.Code != 403 {
		t.Errorf("revert in a workspace outside the token: %d %s, want 403", rec.Code, rec.Body.String())
	}
}

func TestAWorkspaceClosedToAgentsIsClosedForWriting(t *testing.T) {
	f := newScopeFixture(t)
	page := f.s.makePage(t, f.team, f.owner, "", "Payroll", `{}`)
	f.s.db.Exec(`UPDATE workspaces SET agent_access = 'closed' WHERE id = ?`, f.team)
	if rec := f.bearer(f.openTok, "GET", "/api/pages/"+page, ""); rec.Code != 404 {
		t.Fatalf("reading: %d, want 404 (the premise)", rec.Code)
	}
	if rec := f.bearer(f.openTok, "PATCH", "/api/pages/"+page, `{"title":"Changed by an agent"}`); rec.Code == 200 {
		t.Error("an agent changed a page in a workspace closed to agents")
	}
	if rec := f.bearer(f.openTok, "POST", "/api/pages", `{"title":"x","workspaceId":"`+f.team+`"}`); rec.Code != 403 {
		t.Errorf("an agent created a page in a workspace closed to agents: %d", rec.Code)
	}
	// Nor over MCP with a token that names no workspaces at all.
	open := &user{ID: f.owner, TokenKind: tokenKindAPI, TokenScope: "write"}
	if out, err := callTool(t, f.s, open, "get_page", `{"page_id":"`+page+`"}`); err == nil {
		t.Errorf("get_page read a page in a workspace closed to agents: %.80s", out)
	}
	if _, err := callTool(t, f.s, open, "write_content", `{"page_id":"`+page+`","markdown":"agent was here"}`); err == nil {
		t.Error("write_content wrote into a workspace closed to agents")
	}
	// Nor can it carry a page in from outside.
	outside := f.s.makePage(t, f.other, f.owner, "", "Notes from elsewhere", `{}`)
	if rec := f.bearer(f.openTok, "PATCH", "/api/pages/"+outside, `{"workspaceId":"`+f.team+`"}`); rec.Code == 200 {
		t.Error("an agent moved a page into a workspace closed to agents")
	}
	// People are not agents.
	rec := requestAs(t, f.s, f.cookie, "PATCH", "/api/pages/"+page, `{"title":"Changed by a person"}`)
	if rec.Code != 200 {
		t.Errorf("the owner in a browser: %d", rec.Code)
	}
}

func TestAViewerCreatesNothingWhereTheyMayOnlyRead(t *testing.T) {
	f := newScopeFixture(t)
	viewer, cookie := signedIn(t, f.s, "viewer@example.test")
	f.s.addMember(t, f.team, viewer, "viewer")
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/api/import", `{"markdown":"# Notes\n\nhello"}`},
		{"POST", "/api/reindex-siblings", `{"workspaceId":"` + f.team + `","ids":[]}`},
		{"PUT", "/api/tag-colors", `{"workspaceId":"` + f.team + `","tag":"urgent","color":"red"}`},
	} {
		if rec := requestAs(t, f.s, cookie, c.method, c.path, c.body); rec.Code != 403 {
			t.Errorf("viewer %s %s: %d %s, want 403", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	u := &user{ID: viewer}
	for _, tool := range []string{"create_page", "create_database"} {
		if out, err := callTool(t, f.s, u, tool, `{"title":"x"}`); err == nil {
			t.Errorf("viewer %s without a workspace created something: %s", tool, out)
		}
	}
	var n int
	f.s.db.QueryRow(`SELECT COUNT(*) FROM pages WHERE owner_id = ?`, viewer).Scan(&n)
	if n != 0 {
		t.Errorf("%d pages owned by the viewer exist", n)
	}
}

// The two agent tools that do not name the page they change: set_properties
// with a list of updates, and delete_comment. Both checked the person's right
// to write and not the credential, so a token narrowed to one workspace, or
// any token in a workspace closed to agents, changed what it may not enter.
func TestToolsThatNameNoPageStillCheckTheCredential(t *testing.T) {
	f := newScopeFixture(t)
	col := f.s.makeCollection(t, f.other, f.owner, "Ledger", `[{"id":"note","name":"Note","type":"text"}]`)
	row := f.s.makeRow(t, f.other, f.owner, col, "Entry", `{"note":"before"}`)
	comment := newID()
	if _, err := f.s.db.Exec(`INSERT INTO comments (id, page_id, block_id, author_id, author_name, body, created_at)
		VALUES (?, ?, '', ?, 'Owner', 'keep me', ?)`, comment, row, f.owner, now()); err != nil {
		t.Fatalf("comment: %v", err)
	}
	note := func() string {
		var props string
		f.s.db.QueryRow(`SELECT props FROM pages WHERE id = ?`, row).Scan(&props)
		return props
	}
	comments := func() int {
		var n int
		f.s.db.QueryRow(`SELECT COUNT(*) FROM comments WHERE id = ?`, comment).Scan(&n)
		return n
	}
	batch := `{"updates":[{"page_id":"` + row + `","properties":{"note":"changed"}}]}`

	narrowed := &user{ID: f.owner, TokenKind: tokenKindAPI, TokenScope: "write", TokenWorkspaces: []string{f.team}}
	if _, err := callTool(t, f.s, narrowed, "set_properties", batch); err == nil || strings.Contains(note(), "changed") {
		t.Errorf("a token narrowed to another workspace wrote the row: %v, %s", err, note())
	}
	if _, err := callTool(t, f.s, narrowed, "delete_comment", `{"comment_id":"`+comment+`"}`); err == nil || comments() != 1 {
		t.Errorf("a token narrowed to another workspace deleted the comment: %v", err)
	}

	f.s.db.Exec(`UPDATE workspaces SET agent_access = 'closed' WHERE id = ?`, f.other)
	open := &user{ID: f.owner, TokenKind: tokenKindAPI, TokenScope: "write"}
	if _, err := callTool(t, f.s, open, "set_properties", batch); err == nil || strings.Contains(note(), "changed") {
		t.Errorf("an agent wrote into a workspace closed to agents: %v, %s", err, note())
	}
	if _, err := callTool(t, f.s, open, "delete_comment", `{"comment_id":"`+comment+`"}`); err == nil || comments() != 1 {
		t.Errorf("an agent deleted a comment in a workspace closed to agents: %v", err)
	}

	// Where the credential may go, the batch works, and lands in the
	// activity log like a single write.
	f.s.db.Exec(`UPDATE workspaces SET agent_access = '' WHERE id = ?`, f.other)
	if _, err := callTool(t, f.s, open, "set_properties", batch); err != nil || !strings.Contains(note(), "changed") {
		t.Fatalf("the batch where the token may write: %v, %s", err, note())
	}
	var logged int
	f.s.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE page_id = ? AND action = 'set_properties'`, row).Scan(&logged)
	if logged == 0 {
		t.Error("a batch write left no entry in the activity log")
	}
}

// Two more that reach past the page they name: the pages linking to a page
// (a link can come from another workspace), and resolving a comment by id
// (the comment can sit on another page than page_id).
func TestBacklinksAndCommentStatesKeepToTheCredential(t *testing.T) {
	f := newScopeFixture(t)
	target := f.s.makePage(t, f.team, f.owner, "", "Shared target", `{}`)
	source := f.s.makePage(t, f.other, f.owner, "", "Secret source", `{}`)
	if _, err := f.s.db.Exec(`INSERT INTO links (source_id, target_id) VALUES (?, ?)`, source, target); err != nil {
		t.Fatalf("link: %v", err)
	}
	comment := newID()
	if _, err := f.s.db.Exec(`INSERT INTO comments (id, page_id, block_id, author_id, author_name, body, created_at)
		VALUES (?, ?, '', ?, 'Owner', 'open question', ?)`, comment, source, f.owner, now()); err != nil {
		t.Fatalf("comment: %v", err)
	}
	resolved := func() bool {
		var at *string
		f.s.db.QueryRow(`SELECT resolved_at FROM comments WHERE id = ?`, comment).Scan(&at)
		return at != nil
	}
	check := func(who string, u *user) {
		t.Helper()
		out, err := callTool(t, f.s, u, "get_links", `{"page_id":"`+target+`"}`)
		if err != nil || strings.Contains(out, "Secret source") || strings.Contains(out, source) {
			t.Errorf("%s: backlinks showed a page it may not enter: %v %s", who, err, out)
		}
		if _, err := callTool(t, f.s, u, "comments",
			`{"page_id":"`+target+`","action":"resolve","comment_id":"`+comment+`"}`); err == nil || resolved() {
			t.Errorf("%s: resolved a comment it may not reach: %v", who, err)
		}
	}
	check("narrowed token", &user{ID: f.owner, TokenKind: tokenKindAPI, TokenScope: "write", TokenWorkspaces: []string{f.team}})
	f.s.db.Exec(`UPDATE workspaces SET agent_access = 'closed' WHERE id = ?`, f.other)
	check("agent in a closed workspace", &user{ID: f.owner, TokenKind: tokenKindAPI, TokenScope: "write"})

	// The person in a browser still sees the link.
	if out, err := callTool(t, f.s, &user{ID: f.owner, Name: "Owner"}, "get_links", `{"page_id":"`+target+`"}`); err != nil || !strings.Contains(out, "Secret source") {
		t.Errorf("the owner lost a backlink: %v %s", err, out)
	}
}
