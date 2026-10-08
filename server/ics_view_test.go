package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// A view-scoped feed carries only what its view shows, and says which view it
// came from. The legacy collection scope keeps the old shape: every row, and
// the property name in the summary.

func icsViewFixture(t *testing.T) (*Server, string, string, string) {
	t.Helper()
	s := testServer(t)
	uid, _ := signedIn(t, s, "icsview@example.com")
	var ws string
	if err := s.db.QueryRow(`SELECT id FROM workspaces LIMIT 1`).Scan(&ws); err != nil {
		t.Fatal(err)
	}

	col := newID()
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, created_at, updated_at)
		VALUES (?, NULL, ?, 'Tasks', 'collection', '{}', ?, ?)`, col, ws, now(), now()); err != nil {
		t.Fatal(err)
	}
	schema := `[{"id":"status","name":"Status","type":"select"},{"id":"due","name":"Due","type":"date"}]`
	views := `[
		{"id":"active","name":"Active","type":"table","filters":[{"property":"status","op":"is","value":"doing"}]},
		{"id":"cal","name":"Calendar","type":"calendar","dateProp":"due"}
	]`
	if _, err := s.db.Exec(`INSERT INTO collections (page_id, schema, views) VALUES (?, ?, ?)`, col, schema, views); err != nil {
		t.Fatal(err)
	}
	rows := []struct{ title, status, due string }{
		{"One", "doing", "2026-04-10"},
		{"Two", "doing", "2026-04-11"},
		{"Three", "done", "2026-04-12"},
	}
	for i, r := range rows {
		props, _ := json.Marshal(map[string]any{"status": r.status, "due": r.due})
		if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'row', ?, ?, ?, ?)`,
			newID(), col, ws, r.title, string(props), i, now(), now()); err != nil {
			t.Fatal(err)
		}
	}
	return s, uid, col, s.icsToken(uid)
}

func icsGet(t *testing.T, s *Server, target string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
	if rec.Code != 200 {
		t.Fatalf("GET %s: status %d", target, rec.Code)
	}
	return rec.Body.String()
}

// The filtered view's feed holds only the matching rows, and the description
// names the view it came from.
func TestICSViewFeedFollowsFilters(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col+"&view=active")
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 2 {
		t.Errorf("view feed has %d events, want 2 — the done row must not cross", n)
	}
	if strings.Contains(body, "Three") {
		t.Errorf("view feed contains the filtered-out row")
	}
	if !strings.Contains(body, "DESCRIPTION:Tasks / Active") {
		t.Errorf("view feed does not name its view:\n%s", body)
	}
	if !strings.Contains(body, "X-WR-CALNAME:salt.md · Tasks · Active") {
		t.Errorf("calendar name does not name its view:\n%s", body)
	}
}

// A view with a date property produces one clean event per row, no suffix.
func TestICSViewFeedUsesDateProp(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col+"&view=cal")
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 3 {
		t.Errorf("calendar-view feed has %d events, want 3", n)
	}
	if !strings.Contains(body, "SUMMARY:One\r\n") {
		t.Errorf("single-prop view feed keeps the (Due) suffix:\n%s", body)
	}
}

// Without a view nothing moves: every row, suffixed summaries, plain
// collection description.
func TestICSCollectionFeedUnchanged(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col)
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 3 {
		t.Errorf("collection feed has %d events, want 3", n)
	}
	if !strings.Contains(body, "SUMMARY:One (Due)") {
		t.Errorf("collection feed lost its summary shape:\n%s", body)
	}
	if !strings.Contains(body, "DESCRIPTION:Tasks\r\n") {
		t.Errorf("collection feed description changed:\n%s", body)
	}
}

// A view that is gone leaves an empty calendar, not an error — same bargain
// as an unreadable collection.
func TestICSUnknownViewIsEmpty(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col+"&view=nope")
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 0 {
		t.Errorf("unknown-view feed has %d events, want an empty calendar", n)
	}
}

// The scope list offers each saved view of a dated collection.
func TestICSInfoListsViews(t *testing.T) {
	s, uid, col, _ := icsViewFixture(t)
	var userID string
	s.db.QueryRow(`SELECT id FROM users WHERE email = ?`, "icsview@example.com").Scan(&userID)
	if userID != uid {
		t.Fatalf("fixture user mismatch")
	}
	tok, err := s.createSession(uid)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/ics", nil)
	req.Header.Set("Cookie", sessionCookie+"="+tok)
	s.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET /api/ics: status %d", rec.Code)
	}
	var info struct {
		Scopes []struct {
			ID     string `json:"id"`
			ViewID string `json:"viewId"`
			Kind   string `json:"kind"`
			Name   string `json:"name"`
		} `json:"scopes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, sc := range info.Scopes {
		if sc.Kind == "view" && sc.ID == col {
			seen[sc.ViewID] = sc.Name
		}
	}
	if seen["active"] != "Tasks / Active" {
		t.Errorf("view scope for 'active' missing or misnamed: %v", seen)
	}
	if seen["cal"] != "Tasks / Calendar" {
		t.Errorf("view scope for 'cal' missing or misnamed: %v", seen)
	}
}
