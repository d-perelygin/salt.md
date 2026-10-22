package server

import (
	"encoding/json"
	"strings"
	"testing"
)

// Agents build processes through get/add/remove_workflow_rule, and their
// writes run the same gates a browser drag does.

func workflowCol(t *testing.T, s *Server, uid string) string {
	t.Helper()
	var ws string
	if err := s.db.QueryRow(`SELECT id FROM workspaces LIMIT 1`).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	col := newID()
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, created_at, updated_at)
		VALUES (?, NULL, ?, 'Process', 'collection', '{}', ?, ?)`, col, ws, now(), now()); err != nil {
		t.Fatal(err)
	}
	schema := `[{"id":"status","name":"Status","type":"select","options":[{"id":"todo","name":"To do"},{"id":"doing","name":"In progress"},{"id":"done","name":"Done"}]},{"id":"owner","name":"Owner","type":"person"},{"id":"due","name":"Due","type":"date"},{"id":"steps","name":"Steps","type":"checklist"}]`
	if _, err := s.db.Exec(`INSERT INTO collections (page_id, schema, views, workflow) VALUES (?, ?, '[]', '')`, col, schema); err != nil {
		t.Fatal(err)
	}
	return col
}

func workflowRow(t *testing.T, s *Server, uid, col, status string) string {
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

func TestWorkflowToolsRoundTrip(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "wftools@example.test")
	u := &user{ID: uid, Name: "Test"}
	col := workflowCol(t, s, uid)

	out, err := callTool(t, s, u, "get_workflow", `{"page_id":"`+col+`"}`)
	if err != nil {
		t.Fatalf("get empty: %v", err)
	}
	if !strings.Contains(out, "no process") || !strings.Contains(out, "status_candidates") {
		t.Fatalf("empty process should invite creation: %s", out)
	}

	// Unknown action shape is refused before anything is stored.
	if _, err := callTool(t, s, u, "add_workflow_rule", `{"page_id":"`+col+`","status_property":"status","when":{"type":"status_to","to":"Done"},"actions":[{"action":"frobnicate"}]}`); err == nil {
		t.Fatal("unknown action should be refused")
	}
	// A dead status option names what exists.
	if _, err := callTool(t, s, u, "add_workflow_rule", `{"page_id":"`+col+`","status_property":"status","when":{"type":"status_to","to":"Shipped"},"actions":[]}`); err == nil || !strings.Contains(err.Error(), "To do") {
		t.Fatalf("dead option should list what exists, got %v", err)
	}
	// First rule without a status property is refused.
	if _, err := callTool(t, s, u, "add_workflow_rule", `{"page_id":"`+col+`","when":{"type":"created"},"actions":[]}`); err == nil || !strings.Contains(err.Error(), "status_property") {
		t.Fatalf("first rule needs status_property, got %v", err)
	}

	out, err = callTool(t, s, u, "add_workflow_rule", `{"page_id":"`+col+`","status_property":"status","when":{"type":"status_to","to":"Done"},"allow_from":["To do"],"actions":[{"action":"set","property":"due","value":"2026-01-01"},{"action":"ask","property":"owner","mode":"if_empty"}]}`)
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	var added struct {
		RuleID  string `json:"rule_id"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(out), &added); err != nil || added.RuleID == "" {
		t.Fatalf("add should return rule_id: %s (%v)", out, err)
	}
	if !strings.Contains(added.Summary, "Done") || !strings.Contains(added.Summary, "To do") {
		t.Fatalf("summary should read in names: %s", added.Summary)
	}

	out, err = callTool(t, s, u, "get_workflow", `{"page_id":"`+col+`"}`)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !strings.Contains(out, added.RuleID) || !strings.Contains(out, "if empty") {
		t.Fatalf("get should show the rule: %s", out)
	}

	if _, err := callTool(t, s, u, "remove_workflow_rule", `{"page_id":"`+col+`","rule_id":"nope"}`); err == nil {
		t.Fatal("removing an unknown rule should fail")
	}
	out, err = callTool(t, s, u, "remove_workflow_rule", `{"page_id":"`+col+`","rule_id":"`+added.RuleID+`"}`)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	out, err = callTool(t, s, u, "get_workflow", `{"page_id":"`+col+`"}`)
	if err != nil {
		t.Fatalf("get after remove: %v", err)
	}
	if strings.Contains(out, added.RuleID) {
		t.Fatalf("rule should be gone: %s", out)
	}
}

func TestWorkflowAgentMoveGuard(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "wfmove@example.test")
	u := &user{ID: uid, Name: "Test"}
	col := workflowCol(t, s, uid)

	add := `{"page_id":"` + col + `","status_property":"status","when":{"type":"status_to","to":"done"},"allow_from":["doing"],"actions":[{"action":"set","property":"due","value":"2026-01-01"}]}`
	if _, err := callTool(t, s, u, "add_workflow_rule", add); err != nil {
		t.Fatalf("add: %v", err)
	}
	// A status the gate does not name is refused with the reason.
	row := workflowRow(t, s, uid, col, "todo")
	if _, err := callTool(t, s, u, "set_properties", `{"page_id":"`+row+`","properties":{"status":"done"}}`); err == nil || !strings.Contains(err.Error(), "cannot move") {
		t.Fatalf("guarded move should be refused with a reason, got %v", err)
	}
	if got := rowProps(t, s, row)["status"]; got != "todo" {
		t.Fatalf("refused move must not land, status=%v", got)
	}
	// The allowed road applies the automatic step in the same write.
	row2 := workflowRow(t, s, uid, col, "doing")
	if _, err := callTool(t, s, u, "set_properties", `{"page_id":"`+row2+`","properties":{"status":"done"}}`); err != nil {
		t.Fatalf("allowed move: %v", err)
	}
	if got := rowProps(t, s, row2)["due"]; got != "2026-01-01" {
		t.Fatalf("auto step should fold in, due=%v", got)
	}
}

func TestWorkflowAgentCreateRules(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "wfcreate@example.test")
	u := &user{ID: uid, Name: "Test"}
	col := workflowCol(t, s, uid)

	add := `{"page_id":"` + col + `","status_property":"status","when":{"type":"created"},"actions":[{"action":"assign_me","property":"owner"},{"action":"ask","property":"due","mode":"if_empty"}]}`
	if _, err := callTool(t, s, u, "add_workflow_rule", add); err != nil {
		t.Fatalf("add: %v", err)
	}
	// A row missing the asked-for field is refused before it exists.
	if _, err := callTool(t, s, u, "create_rows", `{"page_id":"`+col+`","rows":[{"title":"Bare"}]}`); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("bare create should be refused with a reason, got %v", err)
	}
	// Answering it creates the row with the automatic step folded in.
	out, err := callTool(t, s, u, "create_rows", `{"page_id":"`+col+`","rows":[{"title":"Ready","properties":{"due":"2026-02-02"}}]}`)
	if err != nil {
		t.Fatalf("answered create: %v", err)
	}
	var created struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal([]byte(out), &created); err != nil || len(created.IDs) != 1 {
		t.Fatalf("create should return one id: %s (%v)", out, err)
	}
	props := rowProps(t, s, created.IDs[0])
	if props["due"] != "2026-02-02" {
		t.Fatalf("answered field should land, due=%v", props["due"])
	}
	owner, _ := props["owner"].([]any)
	if len(owner) != 1 || owner[0] != uid {
		t.Fatalf("creation auto-step should assign the mover, owner=%v", props["owner"])
	}
}
