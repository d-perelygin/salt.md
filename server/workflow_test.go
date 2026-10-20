package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The workflow guard: a status move the rules forbid is a 409, an allowed one
// applies its auto-actions in the same write.

func workflowFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	s := testServer(t)
	_, cookie := signedIn(t, s, "workflow@example.com")
	var ws string
	if err := s.db.QueryRow(`SELECT id FROM workspaces LIMIT 1`).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	col := newID()
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, created_at, updated_at)
		VALUES (?, NULL, ?, 'Process', 'collection', '{}', ?, ?)`, col, ws, now(), now()); err != nil {
		t.Fatal(err)
	}
	schema := `[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]},{"id":"closed","name":"Closed","type":"date"}]`
	if _, err := s.db.Exec(`INSERT INTO collections (page_id, schema, views) VALUES (?, ?, '[]')`, col, schema); err != nil {
		t.Fatal(err)
	}
	row := newID()
	props, _ := json.Marshal(map[string]any{"status": "a"})
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
		VALUES (?, ?, ?, 'Row', 'row', ?, 0, ?, ?)`, row, col, ws, string(props), now(), now()); err != nil {
		t.Fatal(err)
	}
	return s, cookie, row
}

func putWorkflow(t *testing.T, s *Server, cookie, col, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/collections/"+col, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	s.ServeHTTP(rec, req)
	return rec
}

func patchStatus(t *testing.T, s *Server, cookie, row, status string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/api/pages/"+row, strings.NewReader(`{"propsPatch":{"status":"`+status+`"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	s.ServeHTTP(rec, req)
	return rec
}

func rowProps(t *testing.T, s *Server, row string) map[string]any {
	t.Helper()
	var raw string
	if err := s.db.QueryRow(`SELECT props FROM pages WHERE id = ?`, row).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// makeRow inserts a row straight into the DB, bypassing guards — setup only.
func makeRow(t *testing.T, s *Server, col, status string) string {
	t.Helper()
	var ws string
	if err := s.db.QueryRow(`SELECT workspace_id FROM pages WHERE id = ?`, col).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	id := newID()
	props, _ := json.Marshal(map[string]any{"status": status})
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
		VALUES (?, ?, ?, 'Row', 'row', ?, 0, ?, ?)`, id, col, ws, string(props), now(), now()); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestWorkflowValidation(t *testing.T) {
	schema := parseSchemaProps(`[{"id":"status","type":"select","options":[{"id":"a"},{"id":"b"}]},{"id":"list","type":"checklist"},{"id":"d","type":"date"}]`)
	good := &workflowConfig{StatusPropID: "status", Rules: []workflowRule{
		{ID: "r1", When: workflowWhen{Type: "status_to", To: "b"}, Do: []workflowAction{{Type: "set_today", Prop: "d"}}},
		{ID: "r2", When: workflowWhen{Type: "status_to", To: "a"}}, // pure guard: no actions, still enforced
	}}
	if err := validateWorkflow(good, schema); err != nil {
		t.Fatalf("good workflow rejected: %v", err)
	}
	for name, cfg := range map[string]*workflowConfig{
		"unknown status":  {StatusPropID: "nope", Rules: []workflowRule{{When: workflowWhen{Type: "status_to", To: "b"}, Do: []workflowAction{{Type: "set_today", Prop: "d"}}}}},
		"unknown option":  {StatusPropID: "status", Rules: []workflowRule{{When: workflowWhen{Type: "status_to", To: "z"}, Do: []workflowAction{{Type: "set_today", Prop: "d"}}}}},
		"bad action":      {StatusPropID: "status", Rules: []workflowRule{{When: workflowWhen{Type: "status_to", To: "b"}, Do: []workflowAction{{Type: "explode"}}}}},
		"bad date target": {StatusPropID: "status", Rules: []workflowRule{{When: workflowWhen{Type: "status_to", To: "b"}, Do: []workflowAction{{Type: "set_today", Prop: "status"}}}}},
		"ask unknown":     {StatusPropID: "status", Rules: []workflowRule{{When: workflowWhen{Type: "status_to", To: "b"}, Do: []workflowAction{{Type: "require_prop", Prop: "nope", Mode: "if_empty"}}}}},
		"ask bad mode":    {StatusPropID: "status", Rules: []workflowRule{{When: workflowWhen{Type: "status_to", To: "b"}, Do: []workflowAction{{Type: "require_comment", Mode: "sometimes"}}}}},
	} {
		if err := validateWorkflow(cfg, schema); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		}
	}
}

func TestWorkflowGuardEndToEnd(t *testing.T) {
	s, cookie, row := workflowFixture(t)
	var col string
	if err := s.db.QueryRow(`SELECT parent_id FROM pages WHERE id = ?`, row).Scan(&col); err != nil {
		t.Fatal(err)
	}
	wf := `{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"c"},"allowFrom":["b"],"do":[{"type":"set_today","prop":"closed"}]}]}}`
	if rec := putWorkflow(t, s, cookie, col, wf); rec.Code != 200 {
		t.Fatalf("PUT workflow: %d %s", rec.Code, rec.Body.String())
	}

	// a -> c is not in the allow-list: refused, status untouched.
	if rec := patchStatus(t, s, cookie, row, "c"); rec.Code != 409 {
		t.Fatalf("forbidden move: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
	if got := rowProps(t, s, row)["status"]; got != "a" {
		t.Fatalf("refused move changed status to %v", got)
	}

	// a -> b is unrestricted (no rule targets b): allowed.
	if rec := patchStatus(t, s, cookie, row, "b"); rec.Code != 200 {
		t.Fatalf("free move: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	// b -> c is allowed AND stamps the date in the same write.
	if rec := patchStatus(t, s, cookie, row, "c"); rec.Code != 200 {
		t.Fatalf("allowed move: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	m := rowProps(t, s, row)
	if m["status"] != "c" {
		t.Fatalf("status = %v, want c", m["status"])
	}
	if m["closed"] == nil || m["closed"] == "" {
		t.Fatalf("set_today action did not stamp the date: %v", m)
	}
}

func TestWorkflowRelativeDateResolvesAtFireTime(t *testing.T) {
	s, cookie, row := workflowFixture(t)
	var col string
	if err := s.db.QueryRow(`SELECT parent_id FROM pages WHERE id = ?`, row).Scan(&col); err != nil {
		t.Fatal(err)
	}
	// A relative word in a set_prop is resolved when the rule fires, not when
	// it is saved: the stored day is absolute.
	wf := `{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"b"},"do":[{"type":"set_prop","prop":"closed","value":"today+7d"}]}]}}`
	if rec := putWorkflow(t, s, cookie, col, wf); rec.Code != 200 {
		t.Fatalf("PUT workflow: %d %s", rec.Code, rec.Body.String())
	}
	if rec := patchStatus(t, s, cookie, row, "b"); rec.Code != 200 {
		t.Fatalf("move: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	got, _ := rowProps(t, s, row)["closed"].(string)
	want, ok := resolveSmartDate("today+7d", time.Now().UTC())
	if !ok || got != want {
		t.Fatalf("closed = %q, want resolved %q", got, want)
	}
}

func patchProps(t *testing.T, s *Server, cookie, row, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/api/pages/"+row, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	s.ServeHTTP(rec, req)
	return rec
}

func createRow(t *testing.T, s *Server, cookie, col, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/pages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	s.ServeHTTP(rec, req)
	return rec
}

// Creation rules fire when a row arrives: a direct create and a move under
// the collection both run them. Asked-for fields must travel with the
// write; automatic steps fold into the stored row.
func TestWorkflowCreationEndToEnd(t *testing.T) {
	s, cookie, row := workflowFixture(t)
	var col string
	if err := s.db.QueryRow(`SELECT parent_id FROM pages WHERE id = ?`, row).Scan(&col); err != nil {
		t.Fatal(err)
	}
	wf := `{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"created"},"do":[{"type":"require_prop","prop":"closed","mode":"if_empty"},{"type":"require_comment","mode":"always"}]}]}}`
	if rec := putWorkflow(t, s, cookie, col, wf); rec.Code != 200 {
		t.Fatalf("PUT workflow: %d %s", rec.Code, rec.Body.String())
	}
	// No date in the create: refused, naming the field. Comments cannot be
	// carried by a create, so their step never blocks the API.
	if rec := createRow(t, s, cookie, col, `{"parentId":"`+col+`","title":"R1","type":"row","props":{"status":"a"}}`); rec.Code != 409 {
		t.Fatalf("bare create: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	} else if !strings.Contains(rec.Body.String(), "Closed") {
		t.Fatalf("refusal does not name the field: %s", rec.Body.String())
	}
	var createdID string
	if rec := createRow(t, s, cookie, col, `{"parentId":"`+col+`","title":"R2","type":"row","props":{"status":"a","closed":"2026-10-20"}}`); rec.Code != 200 {
		t.Fatalf("answered create: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	} else {
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		createdID, _ = out["id"].(string)
	}
	if got := rowProps(t, s, createdID)["closed"]; got != "2026-10-20" {
		t.Fatalf("closed = %v, want the answered date", got)
	}

	// Automatic steps on creation: stamp the date without being asked.
	wfAuto := `{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"created"},"do":[{"type":"set_today","prop":"closed"}]}]}}`
	if rec := putWorkflow(t, s, cookie, col, wfAuto); rec.Code != 200 {
		t.Fatalf("PUT workflow: %d %s", rec.Code, rec.Body.String())
	}
	var autoID string
	if rec := createRow(t, s, cookie, col, `{"parentId":"`+col+`","title":"R3","type":"doc","props":{}}`); rec.Code != 200 {
		t.Fatalf("auto create: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	} else {
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		autoID, _ = out["id"].(string)
	}
	if got := rowProps(t, s, autoID)["closed"]; got == nil || got == "" {
		t.Fatalf("set_today on creation did not stamp the date")
	}

	// Arrival through reparenting runs the same creation rules: the row is
	// new to the collection either way.
	var strayID string
	if rec := createRow(t, s, cookie, col, `{"parentId":null,"title":"Stray","type":"doc","props":{}}`); rec.Code != 200 {
		t.Fatalf("stray create: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	} else {
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		strayID, _ = out["id"].(string)
	}
	if rec := patchProps(t, s, cookie, strayID, `{"parentId":"`+col+`"}`); rec.Code != 200 {
		t.Fatalf("arrival: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := rowProps(t, s, strayID)["closed"]; got == nil || got == "" {
		t.Fatalf("set_today on arrival did not stamp the date")
	}
}

// A require step is a requirement for the API too: without the value the
// move is refused naming the field; with it in the same write it lands.
func TestWorkflowRequirePropEndToEnd(t *testing.T) {
	s, cookie, row := workflowFixture(t)
	var col string
	if err := s.db.QueryRow(`SELECT parent_id FROM pages WHERE id = ?`, row).Scan(&col); err != nil {
		t.Fatal(err)
	}
	wf := `{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"b"},"do":[{"type":"require_prop","prop":"closed","mode":"if_empty"},{"type":"require_comment","mode":"always"}]}]}}`
	if rec := putWorkflow(t, s, cookie, col, wf); rec.Code != 200 {
		t.Fatalf("PUT workflow: %d %s", rec.Code, rec.Body.String())
	}
	if rec := patchStatus(t, s, cookie, row, "b"); rec.Code != 409 {
		t.Fatalf("bare move: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
	if rec := patchProps(t, s, cookie, row, `{"propsPatch":{"status":"b","closed":"2026-10-20"}}`); rec.Code != 200 {
		t.Fatalf("answered move: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := rowProps(t, s, row)["status"]; got != "b" {
		t.Fatalf("status = %v, want b", got)
	}
}

// Two rules on one status combine with OR: each guards only its own gate,
// a foreign gate never blocks another road in. When several matching rules
// write one field, the last rule in the list wins.
func TestWorkflowOrSemantics(t *testing.T) {
	s, cookie, _ := workflowFixture(t)
	var col string
	if err := s.db.QueryRow(`SELECT page_id FROM collections LIMIT 1`).Scan(&col); err != nil {
		t.Fatal(err)
	}
	put := func(wf string) {
		t.Helper()
		if rec := putWorkflow(t, s, cookie, col, wf); rec.Code != 200 {
			t.Fatalf("PUT workflow: %d %s", rec.Code, rec.Body.String())
		}
	}
	// Two gates into c: from a (writes X) and from b (writes Y).
	put(`{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"c"},"allowFrom":["a"],"do":[{"type":"set_prop","prop":"closed","value":"2026-01-01"}]},{"id":"r2","when":{"type":"status_to","to":"c"},"allowFrom":["b"],"do":[{"type":"set_prop","prop":"closed","value":"2026-02-02"}]}]}}`)
	rowA := makeRow(t, s, col, "a")
	if rec := patchStatus(t, s, cookie, rowA, "c"); rec.Code != 200 {
		t.Fatalf("a->c: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := rowProps(t, s, rowA)["closed"]; got != "2026-01-01" {
		t.Fatalf("a->c wrote %v, want r1's value", got)
	}
	rowB := makeRow(t, s, col, "b")
	if rec := patchStatus(t, s, cookie, rowB, "c"); rec.Code != 200 {
		t.Fatalf("b->c: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := rowProps(t, s, rowB)["closed"]; got != "2026-02-02" {
		t.Fatalf("b->c wrote %v, want r2's value", got)
	}

	// The gate stays closed for sources no rule names.
	put(`{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"c"},"allowFrom":["a"],"do":[]}]}}`)
	rowB2 := makeRow(t, s, col, "b")
	if rec := patchStatus(t, s, cookie, rowB2, "c"); rec.Code != 409 {
		t.Fatalf("b->c with only from-a allowed: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	}

	// A failing require on a NON-matching rule does not block the move;
	// a failing require on the matching one does.
	put(`{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"c"},"allowFrom":["a"],"do":[]},{"id":"r2","when":{"type":"status_to","to":"c"},"allowFrom":["b"],"do":[{"type":"require_prop","prop":"closed","mode":"if_empty"}]}]}}`)
	rowA2 := makeRow(t, s, col, "a")
	if rec := patchStatus(t, s, cookie, rowA2, "c"); rec.Code != 200 {
		t.Fatalf("a->c with failing require on foreign rule: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	rowB3 := makeRow(t, s, col, "b")
	if rec := patchStatus(t, s, cookie, rowB3, "c"); rec.Code != 409 {
		t.Fatalf("b->c missing the required field: got %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
	if rec := patchProps(t, s, cookie, rowB3, `{"propsPatch":{"status":"c","closed":"2026-10-20"}}`); rec.Code != 200 {
		t.Fatalf("answered b->c: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	// Two matching rules writing one field: the last one wins.
	put(`{"schema":[{"id":"status","name":"Status","type":"select","options":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]},{"id":"closed","name":"Closed","type":"date"}],"views":[],"workflow":{"statusPropId":"status","rules":[{"id":"r1","when":{"type":"status_to","to":"c"},"allowFrom":["a"],"do":[{"type":"set_prop","prop":"closed","value":"2026-01-01"}]},{"id":"r2","when":{"type":"status_to","to":"c"},"allowFrom":["a"],"do":[{"type":"set_prop","prop":"closed","value":"2026-12-31"}]}]}}`)
	rowA3 := makeRow(t, s, col, "a")
	if rec := patchStatus(t, s, cookie, rowA3, "c"); rec.Code != 200 {
		t.Fatalf("conflicting move: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if got := rowProps(t, s, rowA3)["closed"]; got != "2026-12-31" {
		t.Fatalf("conflict resolved to %v, want the last rule's value", got)
	}
}
