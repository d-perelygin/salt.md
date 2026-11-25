package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// A database's structure keeps its own history: columns, views and process.
// These tests pin the promises that make it useful — a removed column can
// come back with its values, the reader's column widths are not part of the
// shape, a burst of typing leaves one version, and a restore that would break
// the process is refused instead of applied.

func collectionRevisionList(t *testing.T, s *Server, cookie, pageID string) []map[string]any {
	t.Helper()
	rec := requestAs(t, s, cookie, "GET", "/api/pages/"+pageID+"/revisions", "")
	if rec.Code != 200 {
		t.Fatalf("list revisions: %d %s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("revisions JSON: %v (%s)", err, rec.Body.String())
	}
	return list
}

func revisionChanges(item map[string]any) []map[string]any {
	raw, _ := item["changes"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, c := range raw {
		if m, ok := c.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func hasChange(item map[string]any, kind, id string) bool {
	for _, c := range revisionChanges(item) {
		if c["kind"] == kind && (id == "" || c["id"] == id) {
			return true
		}
	}
	return false
}

func putCollection(t *testing.T, s *Server, cookie, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	return requestAs(t, s, cookie, "PUT", "/api/collections/"+id, body)
}

func TestCollectionStructureHistoryRecordsEdits(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks",
		`[{"id":"status","name":"Status","type":"select","options":[{"id":"todo","name":"To do"}]}]`)

	rec := putCollection(t, s, cookie, col, `{"schema":[
		{"id":"status","name":"Status","type":"select","options":[{"id":"todo","name":"To do"}]},
		{"id":"due","name":"Due","type":"date"}]}`)
	if rec.Code != 200 {
		t.Fatalf("save schema: %d %s", rec.Code, rec.Body.String())
	}

	list := collectionRevisionList(t, s, cookie, col)
	// The state before the first recorded edit is kept, so the new column has
	// something to be compared with.
	if len(list) != 2 {
		t.Fatalf("versions: %d, want 2 (baseline + edit): %v", len(list), list)
	}
	if list[0]["kind"] != "collection" {
		t.Errorf("kind: %v", list[0]["kind"])
	}
	if !hasChange(list[0], "column_added", "due") {
		t.Errorf("the newest version does not say the column was added: %v", revisionChanges(list[0]))
	}
	if list[1]["authorName"] != "" {
		t.Errorf("the baseline should have no author: %v", list[1]["authorName"])
	}
}

func TestCollectionRestoreBringsAColumnAndItsValuesBack(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Deals",
		`[{"id":"a","name":"Name","type":"text"},{"id":"b","name":"Budget","type":"number"}]`)
	row := s.makeRow(t, ws, uid, col, "Acme", `{"b":42}`)

	// Remove the column. The values deliberately stay in the row (that is what
	// makes a removal curable), and the history says what happened.
	if rec := putCollection(t, s, cookie, col, `{"schema":[{"id":"a","name":"Name","type":"text"}]}`); rec.Code != 200 {
		t.Fatalf("remove column: %d %s", rec.Code, rec.Body.String())
	}
	list := collectionRevisionList(t, s, cookie, col)
	if !hasChange(list[0], "column_removed", "b") {
		t.Fatalf("removal not recorded: %v", revisionChanges(list[0]))
	}
	baseline := list[len(list)-1]["id"].(string)

	rec := requestAs(t, s, cookie, "POST", "/api/pages/"+col+"/revisions/"+baseline+"/restore",
		`{"scope":"property","itemId":"b"}`)
	if rec.Code != 200 {
		t.Fatalf("restore column: %d %s", rec.Code, rec.Body.String())
	}
	var schema string
	s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, col).Scan(&schema)
	if !strings.Contains(schema, `"b"`) || !strings.Contains(schema, "Budget") {
		t.Fatalf("column did not come back: %s", schema)
	}
	var props string
	s.db.QueryRow(`SELECT props FROM pages WHERE id = ?`, row).Scan(&props)
	if !strings.Contains(props, `"b":42`) {
		t.Fatalf("the value did not survive the removal: %s", props)
	}
	// The restore is itself a version, so it can be read and undone.
	if list := collectionRevisionList(t, s, cookie, col); !hasChange(list[0], "column_added", "b") {
		t.Fatalf("the restore is not in the history: %v", revisionChanges(list[0]))
	}
}

// A width is the reader's layout, not the database's shape: changing only
// widths writes no version, and restoring an old view keeps today's widths.
func TestCollectionHistoryIgnoresColumnWidths(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Board", `[{"id":"a","name":"Name","type":"text"}]`)

	v1 := `{"views":[{"id":"t","name":"Table","type":"table","colWidths":{"a":100}}]}`
	if rec := putCollection(t, s, cookie, col, v1); rec.Code != 200 {
		t.Fatalf("first views: %d %s", rec.Code, rec.Body.String())
	}
	before := len(collectionRevisionList(t, s, cookie, col))
	v2 := `{"views":[{"id":"t","name":"Table","type":"table","colWidths":{"a":300}}]}`
	if rec := putCollection(t, s, cookie, col, v2); rec.Code != 200 {
		t.Fatalf("width change: %d %s", rec.Code, rec.Body.String())
	}
	if after := len(collectionRevisionList(t, s, cookie, col)); after != before {
		t.Fatalf("a width-only save wrote a version: %d → %d", before, after)
	}

	// A real change makes a version; restoring the FIRST one must not put the
	// old width back.
	if rec := putCollection(t, s, cookie, col, `{"views":[{"id":"t","name":"Everything","type":"table","colWidths":{"a":300}}]}`); rec.Code != 200 {
		t.Fatalf("rename view: %d %s", rec.Code, rec.Body.String())
	}
	list := collectionRevisionList(t, s, cookie, col)
	first := list[len(list)-2]["id"].(string) // the state that introduced the view
	rec := requestAs(t, s, cookie, "POST", "/api/pages/"+col+"/revisions/"+first+"/restore", `{"scope":"views"}`)
	if rec.Code != 200 {
		t.Fatalf("restore views: %d %s", rec.Code, rec.Body.String())
	}
	var views string
	s.db.QueryRow(`SELECT views FROM collections WHERE page_id = ?`, col).Scan(&views)
	if !strings.Contains(views, `"a":300`) {
		t.Fatalf("the restore reverted the reader's column width: %s", views)
	}
	// A width must not leak into the store, not even through a restore.
	var leaked int
	s.db.QueryRow(`SELECT COUNT(*) FROM collection_revisions WHERE page_id = ? AND views LIKE '%colWidths%'`, col).Scan(&leaked)
	if leaked != 0 {
		t.Fatalf("%d revisions kept a column width", leaked)
	}
	// Restoring the same state again is a no-op, not a version.
	n := len(collectionRevisionList(t, s, cookie, col))
	again := requestAs(t, s, cookie, "POST", "/api/pages/"+col+"/revisions/"+first+"/restore", `{"scope":"views"}`)
	if again.Code != 200 {
		t.Fatalf("second restore: %d %s", again.Code, again.Body.String())
	}
	if got := len(collectionRevisionList(t, s, cookie, col)); got != n {
		t.Fatalf("an unchanged restore wrote %d versions", got-n)
	}
}

// Typing a name letter by letter is one version, the way the page editor's
// two-minute window makes twenty minutes of typing ten versions.
func TestCollectionHistoryThrottlesEditingBursts(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks", `[{"id":"a","name":"One","type":"text"}]`)

	if rec := putCollection(t, s, cookie, col, `{"schema":[{"id":"a","name":"Two","type":"text"}]}`); rec.Code != 200 {
		t.Fatalf("rename: %d", rec.Code)
	}
	n := len(collectionRevisionList(t, s, cookie, col))
	if rec := putCollection(t, s, cookie, col, `{"schema":[{"id":"a","name":"Three","type":"text"}]}`); rec.Code != 200 {
		t.Fatalf("second rename: %d", rec.Code)
	}
	if got := len(collectionRevisionList(t, s, cookie, col)); got != n {
		t.Fatalf("a burst of renames wrote %d versions, want %d", got-n, 0)
	}
	// Adding a column is a deliberate act and is never held back.
	if rec := putCollection(t, s, cookie, col, `{"schema":[{"id":"a","name":"Three","type":"text"},{"id":"b","name":"B","type":"text"}]}`); rec.Code != 200 {
		t.Fatalf("add column: %d", rec.Code)
	}
	list := collectionRevisionList(t, s, cookie, col)
	if !hasChange(list[0], "column_added", "b") {
		t.Fatalf("an added column was throttled: %v", revisionChanges(list[0]))
	}
}

func TestCollectionHistoryIsBlindToRowValues(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks", `[{"id":"a","name":"Note","type":"text"}]`)
	row := s.makeRow(t, ws, uid, col, "One", `{}`)
	n := len(collectionRevisionList(t, s, cookie, col))

	if _, err := callTool(t, s, &user{ID: uid, Name: "Ada"}, "set_properties",
		`{"page_id":"`+row+`","properties":{"a":"hello"}}`); err != nil {
		t.Fatalf("set_properties: %v", err)
	}
	if got := len(collectionRevisionList(t, s, cookie, col)); got != n {
		t.Fatalf("a row value wrote %d structure versions", got-n)
	}
}

func TestCollectionHistoryNamesTheAgentThatChangedIt(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks", `[{"id":"a","name":"One","type":"text"}]`)
	u := &user{ID: uid, Name: "Ada"}

	if _, err := callTool(t, s, u, "update_schema",
		`{"page_id":"`+col+`","properties":[{"name":"Two","type":"text"}]}`); err != nil {
		t.Fatalf("update_schema: %v", err)
	}
	out, err := s.mcpCollectionHistory(col, 5)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if !strings.Contains(out, `"author":"Ada"`) {
		t.Fatalf("the agent's name is not on the version: %s", out)
	}
}

// Restoring a process that names an option the schema no longer has would
// leave the database broken. Refused, with nothing written.
// Order is part of the structure, but a single drag must read as one change:
// inserting or moving a column shifts every index below it, and a history that
// says eight columns moved is a history nobody reads.
func TestCollectionHistoryRecordsOrderAsOneDrag(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks",
		`[{"id":"a","name":"A","type":"text"},{"id":"b","name":"B","type":"text"},{"id":"c","name":"C","type":"text"}]`)

	if rec := putCollection(t, s, cookie, col,
		`{"schema":[{"id":"c","name":"C","type":"text"},{"id":"a","name":"A","type":"text"},{"id":"b","name":"B","type":"text"}]}`); rec.Code != 200 {
		t.Fatalf("reorder: %d %s", rec.Code, rec.Body.String())
	}
	list := collectionRevisionList(t, s, cookie, col)
	moves := []map[string]any{}
	for _, c := range revisionChanges(list[0]) {
		if c["kind"] == "column_moved" {
			moves = append(moves, c)
		}
	}
	if len(moves) != 1 || moves[0]["id"] != "c" || moves[0]["from"] != "3" || moves[0]["to"] != "1" {
		t.Fatalf("one drag read as: %v", moves)
	}

	// Inserting at the top is not a move of everything below it.
	if rec := putCollection(t, s, cookie, col,
		`{"schema":[{"id":"z","name":"Z","type":"text"},{"id":"c","name":"C","type":"text"},{"id":"a","name":"A","type":"text"},{"id":"b","name":"B","type":"text"}]}`); rec.Code != 200 {
		t.Fatalf("insert: %d %s", rec.Code, rec.Body.String())
	}
	list = collectionRevisionList(t, s, cookie, col)
	for _, c := range revisionChanges(list[0]) {
		if c["kind"] == "column_moved" {
			t.Fatalf("an insertion reported a move: %v", c)
		}
	}
}

func TestCollectionRestoreRefusesToBreakTheProcess(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks",
		`[{"id":"status","name":"Status","type":"select","options":[{"id":"todo","name":"To do"},{"id":"done","name":"Done"}]}]`)

	wf := `{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"done"}}]}`
	sch := `[{"id":"status","name":"Status","type":"select","options":[{"id":"todo","name":"To do"},{"id":"done","name":"Done"}]}]`
	if rec := putCollection(t, s, cookie, col, `{"schema":`+sch+`,"workflow":`+wf+`}`); rec.Code != 200 {
		t.Fatalf("save workflow: %d %s", rec.Code, rec.Body.String())
	}
	list := collectionRevisionList(t, s, cookie, col)
	withRule := list[0]["id"].(string)

	// The option goes away; the stored process still names it.
	if rec := putCollection(t, s, cookie, col,
		`{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"todo","name":"To do"}]}]}`); rec.Code != 200 {
		t.Fatalf("remove option: %d %s", rec.Code, rec.Body.String())
	}
	var beforeWorkflow, stored string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&beforeWorkflow)
	rec := requestAs(t, s, cookie, "POST", "/api/pages/"+col+"/revisions/"+withRule+"/restore", `{"scope":"workflow"}`)
	if rec.Code != 409 {
		t.Fatalf("restoring a process that names a missing option: %d %s", rec.Code, rec.Body.String())
	}
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, col).Scan(&stored)
	if stored != beforeWorkflow {
		t.Fatalf("the refused restore changed the stored process: %s", stored)
	}
}

// The agent path: the same structure history over MCP, with scope and item_id.
func TestCollectionHistoryOverMCP(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks",
		`[{"id":"a","name":"Name","type":"text"},{"id":"b","name":"Budget","type":"number"}]`)
	u := &user{ID: uid, Name: "Ada"}
	row := s.makeRow(t, ws, uid, col, "Acme", `{"b":7}`)

	if _, err := callTool(t, s, u, "update_schema",
		`{"page_id":"`+col+`","remove_properties":["b"]}`); err != nil {
		t.Fatalf("update_schema: %v", err)
	}
	out, err := callTool(t, s, u, "revisions", `{"page_id":"`+col+`"}`)
	if err != nil {
		t.Fatalf("revisions list: %v", err)
	}
	if !strings.Contains(out, `"kind":"collection"`) || !strings.Contains(out, "column_removed") {
		t.Fatalf("list does not describe the structure: %s", out)
	}
	var envelope struct {
		Oldest string `json:"oldest_revision_id"`
	}
	// The tool wraps page content in untrusted markers; the payload is the JSON
	// between them.
	body := out
	if i, j := strings.Index(body, "{"), strings.LastIndex(body, "}"); i >= 0 && j > i {
		body = body[i : j+1]
	}
	json.Unmarshal([]byte(body), &envelope)
	oldest := envelope.Oldest
	if oldest == "" {
		t.Fatalf("no baseline in %s", out)
	}

	if _, err := callTool(t, s, u, "revisions",
		`{"page_id":"`+col+`","action":"get","revision_id":"`+oldest+`"}`); err != nil {
		t.Fatalf("revisions get: %v", err)
	}
	if _, err := callTool(t, s, u, "revisions",
		`{"page_id":"`+col+`","action":"restore","revision_id":"`+oldest+`","scope":"property","item_id":"b"}`); err != nil {
		t.Fatalf("revisions restore: %v", err)
	}
	var schema, props string
	s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, col).Scan(&schema)
	s.db.QueryRow(`SELECT props FROM pages WHERE id = ?`, row).Scan(&props)
	if !strings.Contains(schema, `"b"`) || !strings.Contains(props, `"b":7`) {
		t.Fatalf("the column or its value did not come back: schema=%s props=%s", schema, props)
	}
}

func TestCollectionBackfillKeepsABaseline(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "owner@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Tasks", `[{"id":"a","name":"One","type":"text"}]`)
	s.db.Exec(`DELETE FROM collection_revisions WHERE page_id = ?`, col)

	if err := backfillCollectionRevisions(s.db); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	var n int
	var seq int
	var schema string
	s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(seq), -1) FROM collection_revisions WHERE page_id = ?`, col).Scan(&n, &seq)
	s.db.QueryRow(`SELECT schema FROM collection_revisions WHERE page_id = ?`, col).Scan(&schema)
	if n != 1 || seq != 0 {
		t.Fatalf("backfill wrote %d rows, max seq %d", n, seq)
	}
	if !strings.Contains(schema, `"name":"One"`) {
		t.Fatalf("backfill stored the wrong state: %s", schema)
	}
	// Running again adds nothing.
	if err := backfillCollectionRevisions(s.db); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	s.db.QueryRow(`SELECT COUNT(*) FROM collection_revisions WHERE page_id = ?`, col).Scan(&n)
	if n != 1 {
		t.Fatalf("backfill is not idempotent: %d rows", n)
	}
}
