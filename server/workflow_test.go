package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
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

func patchProps(t *testing.T, s *Server, cookie, row, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/api/pages/"+row, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	s.ServeHTTP(rec, req)
	return rec
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
