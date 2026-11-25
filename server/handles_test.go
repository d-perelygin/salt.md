package server

import (
	"encoding/json"
	"strings"
	"testing"
)

// A handle is assigned once, from the email, and never derived from the
// display name: renaming an account must not touch a single line of code.
func TestHandlesAreStableAndUnique(t *testing.T) {
	s := testServer(t)
	first := newID()
	second := newID()
	for _, u := range []struct{ id, email, name string }{
		{first, "d.perelygin@example.test", "Даниил"},
		{second, "d-perelygin@other.test", "Someone Else"},
	} {
		if _, err := s.db.Exec(`INSERT INTO users (id, email, name, color, password_hash, is_admin, created_at)
			VALUES (?, ?, ?, '#000000', '', 0, ?)`, u.id, u.email, u.name, now()); err != nil {
			t.Fatalf("insert user: %v", err)
		}
	}
	if err := assignUserHandles(s.db); err != nil {
		t.Fatalf("assign handles: %v", err)
	}
	handle := func(id string) string {
		var h string
		s.db.QueryRow(`SELECT handle FROM users WHERE id = ?`, id).Scan(&h)
		return h
	}
	if h := handle(first); h != "d-perelygin" {
		t.Errorf("first handle: %q", h)
	}
	if h := handle(second); h != "d-perelygin-2" {
		t.Errorf("a colliding handle was not suffixed: %q", h)
	}
	// A rename changes the name and nothing else.
	s.db.Exec(`UPDATE users SET name = 'Д. Перелыгин' WHERE id = ?`, first)
	if err := assignUserHandles(s.db); err != nil {
		t.Fatalf("re-run: %v", err)
	}
	if h := handle(first); h != "d-perelygin" {
		t.Errorf("the handle followed the name: %q", h)
	}
}

func codeWorkflowSource(t *testing.T, s *Server, pageID string) string {
	t.Helper()
	var raw string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, pageID).Scan(&raw)
	cfg := parseWorkflow(raw)
	if cfg == nil || len(cfg.Code) == 0 {
		t.Fatalf("no code block stored: %s", raw)
	}
	return cfg.Code[0].Source
}

// Stored code that still names a person by display name is rewritten to the
// handle form once, and keeps compiling afterwards.
func TestProcessCodeIsMigratedToHandles(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "ada@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow",
		`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	src := "rule \"Ship\":\n  when \"New\" becomes \"Done\"\n  do:\n    set \"Owner\" = \"Test\"\n"
	wf := map[string]any{"statusPropId": "st", "rules": []any{}, "code": []any{map[string]any{"id": "b1", "name": "Main", "source": src, "rules": []any{}}}}
	body, _ := json.Marshal(map[string]any{
		"schema":   json.RawMessage(`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`),
		"workflow": wf,
	})
	if rec := requestAs(t, s, cookie, "PUT", "/api/collections/"+col, string(body)); rec.Code != 200 {
		t.Fatalf("seed: %d %s", rec.Code, rec.Body.String())
	}

	if err := migrateProcessHandles(s.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	got := codeWorkflowSource(t, s, col)
	if !strings.Contains(got, `set "Owner" = @ada`) {
		t.Fatalf("the name was not rewritten to the handle: %q", got)
	}
	if strings.Contains(got, `"Test"`) {
		t.Fatalf("the display name survived: %q", got)
	}
	// The rewritten block still compiles and resolves to the same person.
	cfg := parseWorkflow(mustWorkflowRaw(t, s, col))
	if err := validateWorkflowCode(cfg, parseSchemaProps(mustSchemaRaw(t, s, col)), s.codeMembersOf(col)); err != nil {
		t.Fatalf("migrated code no longer compiles: %v", err)
	}
	// Idempotent: a second pass changes nothing.
	if err := migrateProcessHandles(s.db); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if again := codeWorkflowSource(t, s, col); again != got {
		t.Fatalf("migration is not idempotent: %q", again)
	}
}

func mustWorkflowRaw(t *testing.T, s *Server, pageID string) string {
	t.Helper()
	var raw string
	s.db.QueryRow(`SELECT workflow FROM collections WHERE page_id = ?`, pageID).Scan(&raw)
	return raw
}

func mustSchemaRaw(t *testing.T, s *Server, pageID string) string {
	t.Helper()
	var raw string
	s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, pageID).Scan(&raw)
	return raw
}

// A rename used to rewrite the person's name in every process that mentioned
// them. With a handle in the code there is nothing to rewrite, and no version
// appears in the database's history.
func TestRenamingAMemberLeavesHandleCodeAlone(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "ada@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow",
		`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	src := "rule \"Ship\":\n  when \"New\" becomes \"Done\"\n  do:\n    set \"Owner\" = @ada\n"
	wf := map[string]any{"statusPropId": "st", "rules": []any{}, "code": []any{map[string]any{"id": "b1", "name": "Main", "source": src, "rules": []any{}}}}
	body, _ := json.Marshal(map[string]any{
		"schema":   json.RawMessage(`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`),
		"workflow": wf,
	})
	if rec := requestAs(t, s, cookie, "PUT", "/api/collections/"+col, string(body)); rec.Code != 200 {
		t.Fatalf("seed: %d %s", rec.Code, rec.Body.String())
	}
	before := len(collectionRevisionList(t, s, cookie, col))
	s.rewriteMemberInCode(uid, "Test", "Tester", uid, "Test")
	if got := codeWorkflowSource(t, s, col); got != src {
		t.Fatalf("a rename touched handle code: %q", got)
	}
	if after := len(collectionRevisionList(t, s, cookie, col)); after != before {
		t.Fatalf("a rename wrote %d structure versions", after-before)
	}
}

func TestUnknownHandleIsRefused(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "ada@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	col := s.makeCollection(t, ws, uid, "Flow",
		`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`)
	src := "rule \"Ship\":\n  when \"New\" becomes \"Done\"\n  do:\n    set \"Owner\" = @nobody\n"
	wf := map[string]any{"statusPropId": "st", "rules": []any{}, "code": []any{map[string]any{"id": "b1", "name": "Main", "source": src, "rules": []any{}}}}
	body, _ := json.Marshal(map[string]any{
		"schema":   json.RawMessage(`[{"id":"st","name":"Status","type":"select","options":[{"id":"s1","name":"New"},{"id":"s2","name":"Done"}]},{"id":"own","name":"Owner","type":"person"}]`),
		"workflow": wf,
	})
	rec := requestAs(t, s, cookie, "PUT", "/api/collections/"+col, string(body))
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "unknown handle @nobody") {
		t.Fatalf("unknown handle: %d %s", rec.Code, rec.Body.String())
	}
}
