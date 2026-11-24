package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// The field report of an agent working a real workspace, point by point. Each
// test is the evidence for one paragraph of that report: two workspaces with
// the same titles must be distinguishable, a replace must be undoable from its
// own answer, and a file attached to a page must be readable as text.

func TestListPagesNamesEachPagesWorkspace(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "list-workspaces@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws1 := s.firstWorkspaceOf(t, uid)
	var name1 string
	if err := s.db.QueryRow(`SELECT name FROM workspaces WHERE id = ?`, ws1).Scan(&name1); err != nil {
		t.Fatalf("workspace name: %v", err)
	}
	ws2 := newID()
	if _, err := s.db.Exec(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Спонсоры ХХБ26', ?)`, ws2, now()); err != nil {
		t.Fatalf("second workspace: %v", err)
	}
	if _, err := s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')`, ws2, uid); err != nil {
		t.Fatalf("membership: %v", err)
	}
	// The same title in both spaces, plus a child of the same title: the tree
	// alone cannot tell these apart, the heading must.
	root1 := s.makePage(t, ws1, uid, "", "Процесс работы", `{}`)
	child1 := s.makePage(t, ws1, uid, root1, "Процесс работы", `{}`)
	root2 := s.makePage(t, ws2, uid, "", "Процесс работы", `{}`)

	out, err := callTool(t, s, u, "list", `{"kind":"pages"}`)
	if err != nil {
		t.Fatalf("list pages: %v", err)
	}
	head1 := fmt.Sprintf("Workspace %q (workspace_id: %s)", name1, ws1)
	head2 := fmt.Sprintf("Workspace %q (workspace_id: %s)", "Спонсоры ХХБ26", ws2)
	for _, want := range []string{head1, head2, root1, child1, root2} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if n := strings.Count(out, root1); n != 1 {
		t.Errorf("page %s appears %d times, want once", root1, n)
	}
	if n := strings.Count(out, root2); n != 1 {
		t.Errorf("page %s appears %d times, want once", root2, n)
	}
	// The block order between workspaces is not part of the contract; which
	// block a page lands in is. Cut the answer at the headings and check each
	// page is inside its own section and not in the other one.
	section := func(head string) string {
		at := strings.Index(out, head)
		if at < 0 {
			t.Fatalf("heading %q is missing", head)
		}
		rest := out[at+len(head):]
		if next := strings.Index(rest, "Workspace \""); next >= 0 {
			rest = rest[:next]
		}
		return rest
	}
	sec1, sec2 := section(head1), section(head2)
	if !strings.Contains(sec1, root1) || !strings.Contains(sec1, child1) {
		t.Errorf("the first workspace's section does not hold its own pages:\n%s", sec1)
	}
	if strings.Contains(sec1, root2) {
		t.Errorf("the first workspace's section carries the other workspace's page:\n%s", sec1)
	}
	if !strings.Contains(sec2, root2) || strings.Contains(sec2, root1) {
		t.Errorf("the second workspace's section is wrong:\n%s", sec2)
	}

	// Narrowing to one workspace leaves one block, with one tree.
	scoped, err := callTool(t, s, u, "list", `{"kind":"pages","workspace_id":"`+ws2+`"}`)
	if err != nil {
		t.Fatalf("scoped list: %v", err)
	}
	if !strings.Contains(scoped, head2) || strings.Contains(scoped, head1) {
		t.Errorf("workspace_id did not narrow the tree:\n%s", scoped)
	}
	if !strings.Contains(scoped, root2) || strings.Contains(scoped, root1) {
		t.Errorf("the scoped tree carries the other workspace's pages:\n%s", scoped)
	}
}

var revisionIDIn = regexp.MustCompile(`revision ([0-9a-f]{8,})`)

// The replace answer names the revision that undoes it, and restoring that id
// puts the previous text back — the report's "replace is destructive without a
// backup", answered end to end rather than by counting rows.
func TestReplaceAnswerNamesTheRevisionThatUndoesIt(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "replace-undo@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Doc", `{}`)

	if _, err := callTool(t, s, u, "write_content", `{"page_id":"`+page+`","markdown":"alpha body","mode":"replace"}`); err != nil {
		t.Fatalf("first replace: %v", err)
	}
	out, err := callTool(t, s, u, "write_content", `{"page_id":"`+page+`","markdown":"beta body","mode":"replace"}`)
	if err != nil {
		t.Fatalf("second replace: %v", err)
	}
	m := revisionIDIn.FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("the answer does not name a revision to go back to: %s", out)
	}
	revID := m[1]

	old, err := callTool(t, s, u, "revisions", `{"page_id":"`+page+`","action":"get","revision_id":"`+revID+`"}`)
	if err != nil {
		t.Fatalf("get backup revision: %v", err)
	}
	if !strings.Contains(old, "alpha body") {
		t.Fatalf("the named revision is not the state before the overwrite: %s", old)
	}
	if _, err := callTool(t, s, u, "revisions", `{"page_id":"`+page+`","action":"restore","revision_id":"`+revID+`"}`); err != nil {
		t.Fatalf("restore: %v", err)
	}
	back, err := callTool(t, s, u, "get_page", `{"page_id":"`+page+`"}`)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(back, "alpha body") || strings.Contains(back, "beta body") {
		t.Fatalf("restore did not bring the previous text back: %s", back)
	}
}

// A file on the page — not in the chat — is readable as text through
// read_page_file, and the office formats go through the same extractor.
func TestReadPageFileReadsOfficeAndWeb(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "page-file-formats@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)

	files := []struct {
		name    string
		data    []byte
		display string
		want    string
	}{
		{"doc.docx", docxFixture(t), "Договор", "Договор с подрядчиком"},
		{"sheet.xlsx", xlsxFixture(t), "Смета", "Рилс"},
		{"page.html", []byte(`<h1>Заголовок</h1><p>Текст &amp; ещё</p>`), "Страница", "Заголовок"},
		{"notes.rtf", []byte(`{\rtf1 Hello \b bold\b0  world.}`), "Заметки", "bold world"},
	}
	var blocks []string
	for _, f := range files {
		seedFile(t, s, f.name, string(f.data))
		blocks = append(blocks, fmt.Sprintf(`{"type":"file","props":{"url":"/files/%s","name":%q}}`, f.name, f.display))
	}
	seedPage(t, s, "format-page", "", ws, uid, "workspace", "["+strings.Join(blocks, ",")+"]")

	listed, err := callTool(t, s, u, "read_page_file", `{"page_id":"format-page"}`)
	if err != nil {
		t.Fatalf("list page files: %v", err)
	}
	for _, f := range files {
		if !strings.Contains(listed, f.name) {
			t.Errorf("%s is missing from the listing: %s", f.name, listed)
		}
		out, err := callTool(t, s, u, "read_page_file", `{"page_id":"format-page","file_name":"`+f.name+`"}`)
		if err != nil {
			t.Fatalf("read %s: %v", f.name, err)
		}
		if !strings.Contains(out, f.want) {
			t.Errorf("%s: %q is missing from the text: %s", f.name, f.want, out)
		}
	}
}

// The chat's + goes through the same extractor, over HTTP: a format the picker
// accepts must come back with text, not "unsupported".
func TestChatAttachmentExtractsOfficeAndWeb(t *testing.T) {
	s := testServer(t)
	_, cookie := signedIn(t, s, "chat-formats@example.test")
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"sample.docx", docxFixture(t), "Договор с подрядчиком"},
		{"sample.xlsx", xlsxFixture(t), "Рилс"},
		{"page.html", []byte(`<h1>Заголовок</h1><p>Текст &amp; ещё</p>`), "Заголовок"},
		{"data.yaml", []byte("name: отчёт\n"), "отчёт"},
		{"notes.rtf", []byte(`{\rtf1 Hello \b bold\b0  world.}`), "bold world"},
	}
	for _, c := range cases {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		fw, err := mw.CreateFormFile("file", c.name)
		if err != nil {
			t.Fatalf("%s: form: %v", c.name, err)
		}
		if _, err := fw.Write(c.data); err != nil {
			t.Fatalf("%s: write: %v", c.name, err)
		}
		if err := mw.Close(); err != nil {
			t.Fatalf("%s: close: %v", c.name, err)
		}
		req := httptest.NewRequest("POST", "/api/ai/attachments", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Cookie", cookie)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s: status %d: %s", c.name, rec.Code, rec.Body.String())
		}
		var out struct {
			Status string `json:"status"`
			Text   string `json:"text"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s: decode: %v", c.name, err)
		}
		if out.Status != "done" {
			t.Errorf("%s: status %q, want done", c.name, out.Status)
		}
		if !strings.Contains(out.Text, c.want) {
			t.Errorf("%s: %q is missing from the extracted text: %q", c.name, c.want, out.Text)
		}
	}
}

// An empty page is not something to protect: it trashes and restores without
// the confirmation prompt, so the safety net stays about real content.
func TestTrashOfAnEmptyPageNeedsNoConfirm(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "empty-trash@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Empty", `{}`)
	if _, err := callTool(t, s, u, "set_trashed", `{"page_id":"`+page+`","trashed":true}`); err != nil {
		t.Fatalf("trashing an empty page asked for confirmation: %v", err)
	}
	if _, err := callTool(t, s, u, "set_trashed", `{"page_id":"`+page+`","trashed":false}`); err != nil {
		t.Fatalf("restoring asks for confirmation: %v", err)
	}
}
