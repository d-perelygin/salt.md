package server

import (
	"encoding/json"
	"testing"
	"time"
)

// A version is a state; "what changed" is the difference from the version
// above it. The list is only a history if it says that — a column of
// timestamps tells nobody why the status is what it is.
func TestRevisionRecordsPropertyChanges(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "history-props@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	col := s.makeCollection(t, ws, uid, "Tasks", `[
		{"id":"status","name":"Status","type":"select","options":[
			{"id":"todo","name":"To do"},{"id":"done","name":"Done"}]},
		{"id":"note","name":"Note","type":"text"}]`)
	row := s.makeRow(t, ws, uid, col, "Post", `{"status":"todo"}`)
	// A row inserted straight into the database has no creation snapshot;
	// give it the baseline the HTTP create would have written.
	if s.snapshotRevisionForced(row, uid, "Ada") == "" {
		t.Fatalf("baseline snapshot was not written")
	}

	rec := doReq(t, s, "PATCH", "/api/pages/"+row, cookie, `{"propsPatch":{"status":"done"}}`)
	if rec.Code != 200 {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}

	revs := s.revisionsJSON(t, row, cookie)
	if len(revs) != 2 {
		t.Fatalf("want a creation version and the change, got %d", len(revs))
	}
	latest := revs[0]
	var prop *revisionChange
	for i := range latest.Changes {
		if latest.Changes[i].Kind == "prop" && latest.Changes[i].Prop == "status" {
			prop = &latest.Changes[i]
		}
	}
	if prop == nil {
		t.Fatalf("the property change is missing: %#v", latest.Changes)
	}
	if prop.Name != "Status" || prop.From != "To do" || prop.To != "Done" {
		t.Errorf("change reads %q: %q → %q, want the option NAMES", prop.Name, prop.From, prop.To)
	}
	// A version holds the row itself, not just a document.
	var props string
	if err := s.db.QueryRow(`SELECT props FROM page_revisions WHERE id = ?`, latest.ID).Scan(&props); err != nil {
		t.Fatalf("revision props: %v", err)
	}
	if !json.Valid([]byte(props)) || props == "{}" {
		t.Errorf("the version stored no properties: %q", props)
	}
}

// Restoring a version restores the row's properties with it.
func TestRevisionRestoreBringsPropertiesBack(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "history-restore@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	col := s.makeCollection(t, ws, uid, "Tasks", `[
		{"id":"status","name":"Status","type":"select","options":[
			{"id":"todo","name":"To do"},{"id":"done","name":"Done"}]}]`)
	row := s.makeRow(t, ws, uid, col, "Post", `{"status":"todo"}`)
	base := s.snapshotRevisionForced(row, uid, "Ada")

	if rec := doReq(t, s, "PATCH", "/api/pages/"+row, cookie, `{"propsPatch":{"status":"done"}}`); rec.Code != 200 {
		t.Fatalf("patch: %d", rec.Code)
	}
	if got := readProps(t, s, row)["status"]; got != "done" {
		t.Fatalf("setup: status is %v", got)
	}

	if rec := doReq(t, s, "POST", "/api/pages/"+row+"/revisions/"+base+"/restore", cookie, ""); rec.Code != 200 {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body)
	}
	if got := readProps(t, s, row)["status"]; got != "todo" {
		t.Errorf("status after restore is %v, want todo", got)
	}
	// The restore is itself undoable: the state it replaced is in the list.
	if revs := s.revisionsJSON(t, row, cookie); revs[0].Changes == nil {
		t.Errorf("no pre-restore version was recorded")
	}
}

// A version written before properties were captured restores title and content
// only. Restoring its empty props over a live row would wipe every column.
func TestRevisionRestoreLeavesLegacyPropsAlone(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "history-legacy@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	col := s.makeCollection(t, ws, uid, "Tasks", `[
		{"id":"status","name":"Status","type":"select","options":[
			{"id":"todo","name":"To do"},{"id":"done","name":"Done"}]}]`)
	row := s.makeRow(t, ws, uid, col, "Post", `{"status":"done"}`)
	if _, err := s.db.Exec(`INSERT INTO page_revisions
		(id, page_id, created_at, author_id, author_name, title, content, props, icon, cover, changes, full)
		VALUES ('legacy', ?, ?, ?, 'Ada', 'Old title', '[]', '{}', '', '', '', 0)`,
		row, time.Now().Add(-time.Hour).Format(time.RFC3339Nano), uid); err != nil {
		t.Fatalf("legacy revision: %v", err)
	}

	if rec := doReq(t, s, "POST", "/api/pages/"+row+"/revisions/legacy/restore", cookie, ""); rec.Code != 200 {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body)
	}
	if got := readProps(t, s, row)["status"]; got != "done" {
		t.Errorf("a legacy restore wiped the row's properties: %v", got)
	}
}

// Copy writes a version into a new page beside the original — the other half
// of what a version list is for.
func TestRevisionCopyCreatesAPage(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "history-copy@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	col := s.makeCollection(t, ws, uid, "Tasks", `[
		{"id":"status","name":"Status","type":"select","options":[
			{"id":"todo","name":"To do"},{"id":"done","name":"Done"}]}]`)
	row := s.makeRow(t, ws, uid, col, "Post", `{"status":"todo"}`)
	base := s.snapshotRevisionForced(row, uid, "Ada")
	if rec := doReq(t, s, "PATCH", "/api/pages/"+row, cookie, `{"propsPatch":{"status":"done"}}`); rec.Code != 200 {
		t.Fatalf("patch: %d", rec.Code)
	}

	rec := doReq(t, s, "POST", "/api/pages/"+row+"/revisions/"+base+"/copy", cookie, "")
	if rec.Code != 200 {
		t.Fatalf("copy: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		ID       string `json:"id"`
		ParentID string `json:"parentId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.ID == "" {
		t.Fatalf("copy answer: %s", rec.Body)
	}
	if out.ParentID != col {
		t.Errorf("the copy landed in %q, want the same database %q", out.ParentID, col)
	}
	if got := readProps(t, s, out.ID)["status"]; got != "todo" {
		t.Errorf("the copy holds status %v, want the version's todo", got)
	}
	if got := s.pageTitle(out.ID); got != "Post" {
		t.Errorf("the copy is titled %q", got)
	}
}

// A no-op save must not grow the list with a copy of the version above it.
func TestRevisionSkipsUnchangedState(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "history-noop@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Notes", `[{"id":"note","name":"Note","type":"text"}]`)
	row := s.makeRow(t, ws, uid, col, "Row", `{"note":"same"}`)

	if id := s.snapshotRevisionForced(row, uid, "Ada"); id == "" {
		t.Fatalf("baseline was not written")
	}
	if id := s.snapshotRevisionForced(row, uid, "Ada"); id != "" {
		t.Errorf("an unchanged state was stored as a new version")
	}
}

func (s *Server) revisionsJSON(t *testing.T, pageID, cookie string) []struct {
	ID         string           `json:"id"`
	CreatedAt  string           `json:"createdAt"`
	AuthorName string           `json:"authorName"`
	Title      string           `json:"title"`
	Changes    []revisionChange `json:"changes"`
	Excerpt    string           `json:"excerpt"`
} {
	t.Helper()
	rec := doReq(t, s, "GET", "/api/pages/"+pageID+"/revisions", cookie, "")
	if rec.Code != 200 {
		t.Fatalf("revisions: %d %s", rec.Code, rec.Body)
	}
	var out []struct {
		ID         string           `json:"id"`
		CreatedAt  string           `json:"createdAt"`
		AuthorName string           `json:"authorName"`
		Title      string           `json:"title"`
		Changes    []revisionChange `json:"changes"`
		Excerpt    string           `json:"excerpt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("revisions answer: %v", err)
	}
	return out
}
