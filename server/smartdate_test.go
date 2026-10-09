package server

import (
	"encoding/json"
	"testing"
	"time"
)

// Relative days resolve against the day the query runs on, so a saved view
// reading "after today-1M" is still right next month.

func smartDay(t *testing.T, now time.Time, s string) string {
	t.Helper()
	day, ok := resolveSmartDate(s, now)
	if !ok {
		t.Fatalf("%q did not resolve", s)
	}
	return day
}

func TestResolveSmartDate(t *testing.T) {
	now := time.Date(2026, 10, 9, 15, 4, 0, 0, time.UTC) // a Friday
	cases := []struct{ in, want string }{
		{"today", "2026-10-09"},
		{"yesterday", "2026-10-08"},
		{"tomorrow", "2026-10-10"},
		{"today+0d", "2026-10-09"},
		{"today+7d", "2026-10-16"},
		{"today-7d", "2026-10-02"},
		{"today-30", "2026-09-09"}, // the unit defaults to days
		{"today-1w", "2026-10-02"},
		{"today+2w", "2026-10-23"},
		{"today-1m", "2026-09-09"},
		{"today+1m", "2026-11-09"},
		{"today-1y", "2025-10-09"},
		{"today+1y", "2027-10-09"},
		{"yesterday-7d", "2026-10-01"},
		// Case and spacing are forgiven: people type "Today - 1M".
		{"TODAY", "2026-10-09"},
		{"Today - 1M", "2026-09-09"},
	}
	for _, c := range cases {
		if got := smartDay(t, now, c.in); got != c.want {
			t.Errorf("%q resolved to %s, want %s", c.in, got, c.want)
		}
	}
}

func TestResolveSmartDateMonthClamp(t *testing.T) {
	cases := []struct {
		now        time.Time
		in, want string
	}{
		// March 31 minus a month is February 28, not March 3.
		{time.Date(2026, 3, 31, 12, 0, 0, 0, time.UTC), "today-1m", "2026-02-28"},
		// Leap years keep their extra day.
		{time.Date(2024, 3, 31, 12, 0, 0, 0, time.UTC), "today-1m", "2024-02-29"},
		{time.Date(2026, 1, 31, 12, 0, 0, 0, time.UTC), "today+1m", "2026-02-28"},
		{time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC), "today+1m", "2026-11-30"},
		// Across a year boundary.
		{time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC), "today-1m", "2025-12-15"},
		{time.Date(2025, 12, 15, 12, 0, 0, 0, time.UTC), "today+2m", "2026-02-15"},
	}
	for _, c := range cases {
		if got := smartDay(t, c.now, c.in); got != c.want {
			t.Errorf("%q on %s resolved to %s, want %s", c.in, c.now.Format("2006-01-02"), got, c.want)
		}
	}
}

func TestResolveSmartDateRejects(t *testing.T) {
	for _, in := range []string{
		"", "someday", "2026-10-09", // a plain date is not a word
		"today-", "today-1x", "today7d", "today+1.5d",
		"today-10000d", // capped rather than overflowed
		"next friday",
	} {
		if day, ok := resolveSmartDate(in, time.Now()); ok {
			t.Errorf("%q resolved to %s, want rejection", in, day)
		}
	}
}

// A relative day in a real query: rows dated around today, filtered with
// words. The fixture dates are computed from now, so this holds whenever it
// runs — except across a midnight boundary mid-test, which is accepted.
func TestSmartDateFilterEndToEnd(t *testing.T) {
	s := testServer(t)
	_, _ = signedIn(t, s, "smartdate@example.com")
	var ws string
	if err := s.db.QueryRow(`SELECT id FROM workspaces LIMIT 1`).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	col := newID()
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, created_at, updated_at)
		VALUES (?, NULL, ?, 'Smart', 'collection', '{}', ?, ?)`, col, ws, now(), now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO collections (page_id, schema, views) VALUES (?, ?, '[]')`, col,
		`[{"id":"datum","name":"Datum","type":"date"}]`); err != nil {
		t.Fatal(err)
	}
	today := time.Now()
	days := map[string]int{"old": -40, "recent": -10, "now": 0, "soon": 5}
	for name, off := range days {
		day := today.AddDate(0, 0, off).Format("2006-01-02")
		props, _ := json.Marshal(map[string]any{"datum": day})
		if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'row', ?, 0, ?, ?)`,
			newID(), col, ws, name, string(props), now(), now()); err != nil {
			t.Fatal(err)
		}
	}
	// "in the last month": recent and now, but not old or soon.
	if n := count(t, s, col, rowFilter{Prop: "datum", Op: "between", Value: "today-1M", Value2: "today"}); n != 2 {
		t.Errorf("between today-1M and today returned %d, want 2", n)
	}
	// "upcoming": soon only.
	if n := count(t, s, col, rowFilter{Prop: "datum", Op: "gt", Value: "today"}); n != 1 {
		t.Errorf("after today returned %d, want 1", n)
	}
	// "older than a week": old and recent.
	if n := count(t, s, col, rowFilter{Prop: "datum", Op: "lt", Value: "today-1w"}); n != 2 {
		t.Errorf("before today-1w returned %d, want 2", n)
	}
	// Exact match on a word: the row dated today.
	if n := count(t, s, col, rowFilter{Prop: "datum", Op: "is", Value: "today"}); n != 1 {
		t.Errorf("is today returned %d, want 1", n)
	}
}
