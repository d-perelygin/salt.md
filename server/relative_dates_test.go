package server

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// A person who answers "Today" means this day, once. The workflow field offers
// Exact/Relative as an input convenience, but the row is data: a cell can only
// draw a day, the calendar can only place a day, and "today" would quietly name
// a different day tomorrow. Every path that writes properties has to land on a
// date.
func TestDateWritesResolveRelativeDays(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "relative-dates@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	col := s.makeCollection(t, ws, uid, "Plan", `[
		{"id":"when","name":"When","type":"date"},
		{"id":"note","name":"Note","type":"text"}]`)

	want := time.Now().Format("2006-01-02")
	want7 := time.Now().AddDate(0, 0, 7).Format("2006-01-02")

	// 1. The interface's property patch: a date is resolved, a text property
	// that happens to say the same word is not.
	row := s.makeRow(t, ws, uid, col, "Post", `{}`)
	rec := doReq(t, s, "PATCH", "/api/pages/"+row, cookie,
		`{"propsPatch":{"when":"today","note":"today"}}`)
	if rec.Code != 200 {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}
	props := readProps(t, s, row)
	if props["when"] != want {
		t.Errorf("date property stored %#v, want the day %q", props["when"], want)
	}
	if props["note"] != "today" {
		t.Errorf("a text property must keep the word: %#v", props["note"])
	}

	// Offsets use the same grammar the dialog previews.
	if rec := doReq(t, s, "PATCH", "/api/pages/"+row, cookie,
		`{"propsPatch":{"when":"today+7d"}}`); rec.Code != 200 {
		t.Fatalf("patch offset: %d", rec.Code)
	}
	if got := readProps(t, s, row)["when"]; got != want7 {
		t.Errorf("today+7d stored %#v, want %q", got, want7)
	}

	// 2. A row created with its properties already in place.
	rec = doReq(t, s, "POST", "/api/pages", cookie,
		`{"parentId":"`+col+`","title":"Tomorrow","props":{"when":"tomorrow"}}`)
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("create answer: %s", rec.Body)
	}
	wantTomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	if got := readProps(t, s, created.ID)["when"]; got != wantTomorrow {
		t.Errorf("a row created with 'tomorrow' stored %#v, want %q", got, wantTomorrow)
	}

	// 3. An agent writing through MCP, which normalises in its own place.
	agentRow := s.makeRow(t, ws, uid, col, "Agent", `{}`)
	if _, err := callTool(t, s, u, "set_properties",
		fmt.Sprintf(`{"page_id":"%s","properties":{"when":"today"}}`, agentRow)); err != nil {
		t.Fatalf("set_properties: %v", err)
	}
	if got := readProps(t, s, agentRow)["when"]; got != want {
		t.Errorf("an agent's 'today' stored %#v, want %q", got, want)
	}
}

// Rows written before the write paths resolved the word are repaired once, at
// startup, and only in date properties.
func TestRelativeDateMigrationRepairsStoredWords(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "relative-dates-migrate@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	col := s.makeCollection(t, ws, uid, "Plan", `[
		{"id":"when","name":"When","type":"date"},
		{"id":"note","name":"Note","type":"text"}]`)
	row := s.makeRow(t, ws, uid, col, "Legacy", `{"when":"today","note":"today"}`)

	// openDB stamped the marker on a database that had nothing to repair; drop
	// it so this exercises the pass itself.
	if _, err := s.db.Exec(`DELETE FROM schema_meta WHERE key = 'relative_dates'`); err != nil {
		t.Fatalf("marker: %v", err)
	}
	if err := migrateRelativeDates(s.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	want := time.Now().Format("2006-01-02")
	props := readProps(t, s, row)
	if props["when"] != want {
		t.Errorf("stored word was not repaired: %#v, want %q", props["when"], want)
	}
	if props["note"] != "today" {
		t.Errorf("the repair touched a text property: %#v", props["note"])
	}

	// Once: the marker means a word that reappears (a hand-written row, an old
	// binary) is not silently rewritten on every boot.
	if _, err := s.db.Exec(`UPDATE pages SET props = '{"when":"today"}' WHERE id = ?`, row); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if err := migrateRelativeDates(s.db); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if got := readProps(t, s, row)["when"]; got != "today" {
		t.Errorf("the migration ran twice: %#v", got)
	}
}
