package server

import (
	"strings"
	"testing"
)

// The safety net around the tools that take something away: a replace must not
// throw the previous body out with the bathwater, deletion and trashing ask
// first, and every answer says which workspace it is talking about.

func TestReplaceContentKeepsEveryPreviousState(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "replace-safety@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Doc", `{}`)

	// Three overwrites in a row, well inside the two-minute throttle that used
	// to keep only the state from before the FIRST one. The first one lands on
	// an empty page: there is nothing to back up, and the answer says so by
	// staying short.
	for i, md := range []string{"alpha body", "beta body", "gamma body"} {
		out, err := callTool(t, s, u, "write_content",
			`{"page_id":"`+page+`","markdown":"`+md+`","mode":"replace"}`)
		if err != nil {
			t.Fatalf("replace %q: %v", md, err)
		}
		if i > 0 && !strings.Contains(out, "revision") {
			t.Errorf("the answer does not name the backup: %s", out)
		}
	}
	for _, want := range []string{"alpha body", "beta body"} {
		var n int
		s.db.QueryRow(`SELECT COUNT(*) FROM page_revisions WHERE page_id = ? AND content LIKE ?`, page, "%"+want+"%").Scan(&n)
		if n == 0 {
			t.Fatalf("%q was lost: no revision holds it after the overwrite", want)
		}
	}
}

func TestRevisionsBaselineAndRestoreOriginal(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "restore-original@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Doc", `{}`)

	for _, md := range []string{"one", "two", "three"} {
		if _, err := callTool(t, s, u, "write_content",
			`{"page_id":"`+page+`","markdown":"`+md+`","mode":"replace"}`); err != nil {
			t.Fatalf("replace %q: %v", md, err)
		}
	}
	list, err := callTool(t, s, u, "revisions", `{"page_id":"`+page+`"}`)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !strings.Contains(list, `"baseline":true`) {
		t.Errorf("the list does not mark the oldest surviving state: %s", list)
	}
	if !strings.Contains(list, `"oldest_revision_id"`) {
		t.Errorf("the list does not name the oldest revision: %s", list)
	}
	if _, err := callTool(t, s, u, "revisions", `{"page_id":"`+page+`","action":"restore_original"}`); err != nil {
		t.Fatalf("restore_original: %v", err)
	}
	out, err := callTool(t, s, u, "get_page", `{"page_id":"`+page+`"}`)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(out, "one") || strings.Contains(out, "three") {
		t.Fatalf("restore_original did not return to the first state: %s", out)
	}
}

func TestPageAndSearchNameTheirWorkspace(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "workspace-labels@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws1 := s.firstWorkspaceOf(t, uid)
	ws2 := newID()
	if _, err := s.db.Exec(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Second Space', ?)`, ws2, now()); err != nil {
		t.Fatalf("second workspace: %v", err)
	}
	if _, err := s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')`, ws2, uid); err != nil {
		t.Fatalf("membership: %v", err)
	}
	mark := "zebraword"
	if _, err := callTool(t, s, u, "create_page",
		`{"title":"Same name","workspace_id":"`+ws2+`","markdown":"`+mark+`"}`); err != nil {
		t.Fatalf("create page: %v", err)
	}
	page := s.makePage(t, ws1, uid, "", "Same name", `{}`) // same title, other workspace
	if _, err := callTool(t, s, u, "write_content", `{"page_id":"`+page+`","markdown":"`+mark+`"}`); err != nil {
		t.Fatalf("write: %v", err)
	}

	out, err := callTool(t, s, u, "get_page", `{"page_id":"`+page+`"}`)
	if err != nil {
		t.Fatalf("get_page: %v", err)
	}
	if !strings.Contains(out, "Workspace:") || !strings.Contains(out, ws1) {
		t.Errorf("get_page does not name the workspace: %s", out)
	}

	hits, err := callTool(t, s, u, "search", `{"query":"`+mark+`"}`)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if !strings.Contains(hits, "Second Space") {
		t.Errorf("a hit does not name its workspace: %s", hits)
	}
	scoped, err := callTool(t, s, u, "search", `{"query":"`+mark+`","workspace_id":"`+ws1+`"}`)
	if err != nil {
		t.Fatalf("scoped search: %v", err)
	}
	if strings.Contains(scoped, "Second Space") {
		t.Errorf("workspace_id did not narrow the search: %s", scoped)
	}
}

func TestDestructiveToolsAskFirst(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "confirm@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)

	// A view: refused once with what would be lost, then allowed.
	db := s.makeCollection(t, ws, uid, "DB", `[]`)
	if _, err := s.db.Exec(`UPDATE collections SET views = ? WHERE page_id = ?`,
		`[{"id":"v1","name":"One","type":"table"},{"id":"v2","name":"Two","type":"board"}]`, db); err != nil {
		t.Fatalf("views: %v", err)
	}
	if _, err := callTool(t, s, u, "delete_view", `{"page_id":"`+db+`","view_id":"v2"}`); err == nil {
		t.Fatal("delete_view deleted a view without confirm")
	}
	if _, err := callTool(t, s, u, "delete_view", `{"page_id":"`+db+`","view_id":"v2","confirm":true}`); err != nil {
		t.Fatalf("delete_view with confirm: %v", err)
	}

	// A comment: same rule.
	if _, err := s.db.Exec(`INSERT INTO comments (id, page_id, author_id, author_name, body, created_at) VALUES ('c1', ?, ?, 'Test', 'hello', ?)`,
		db, uid, now()); err != nil {
		t.Fatalf("comment: %v", err)
	}
	if _, err := callTool(t, s, u, "delete_comment", `{"comment_id":"c1"}`); err == nil {
		t.Fatal("delete_comment deleted a comment without confirm")
	}
	if _, err := callTool(t, s, u, "delete_comment", `{"comment_id":"c1","confirm":true}`); err != nil {
		t.Fatalf("delete_comment with confirm: %v", err)
	}

	// A page that still holds something: trashing takes the subtree with it.
	parent := s.makePage(t, ws, uid, "", "Parent", `{}`)
	if _, err := callTool(t, s, u, "write_content", `{"page_id":"`+parent+`","markdown":"valuable text"}`); err != nil {
		t.Fatalf("write: %v", err)
	}
	s.makePage(t, ws, uid, parent, "Child", `{}`)
	if _, err := callTool(t, s, u, "set_trashed", `{"page_id":"`+parent+`","trashed":true}`); err == nil {
		t.Fatal("set_trashed swept a non-empty subtree without confirm")
	}
	if _, err := callTool(t, s, u, "set_trashed", `{"page_id":"`+parent+`","trashed":true,"confirm":true}`); err != nil {
		t.Fatalf("set_trashed with confirm: %v", err)
	}
}

func TestExtractFileTextFormats(t *testing.T) {
	cases := []struct {
		name string
		ext  string
		in   string
		want string
		not  string
	}{
		{"yaml", ".yaml", "title: hello\nlist:\n  - one\n", "title: hello", ""},
		{"tsv", ".tsv", "a\tb\n1\t2\n", "a\tb", ""},
		{"log", ".log", "2026-01-01 started\n", "started", ""},
		{"html", ".html", `<html><head><style>p{color:red}</style></head><body><h1>Hello &amp; bye</h1><p>First</p><p>Second</p><script>alert(1)</script></body></html>`, "Hello & bye", "color:red"},
		{"rtf", ".rtf", `{\rtf1\ansi Hello \b bold\b0  world.\par Next line.}`, "Hello bold world.", `\rtf1`},
	}
	for _, c := range cases {
		got := extractFileText([]byte(c.in), "", c.ext)
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: %q does not contain %q", c.name, got, c.want)
		}
		if c.not != "" && strings.Contains(got, c.not) {
			t.Errorf("%s: %q still contains %q", c.name, got, c.not)
		}
	}
	if got := extractFileText([]byte{0x89, 0x50, 0x4e, 0x47}, "", ".png"); got != "" {
		t.Errorf("a binary format produced text: %q", got)
	}
	if !strings.Contains(extractFileText([]byte("<p>x</p>"), "", ".htm"), "x") {
		t.Error(".htm is not read as HTML")
	}
}
