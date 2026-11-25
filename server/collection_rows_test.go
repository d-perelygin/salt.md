package server

import (
	"testing"
	"time"
)

// Multiple sort keys apply in order, like SQL ORDER BY: the first decides,
// the next breaks its ties. A single key keeps working unchanged.
func TestCollectionRowsMultiSort(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "multisort@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	u := &user{ID: uid}
	col := s.makeCollection(t, ws, uid, "Tasks",
		`[{"id":"pri","name":"Priority","type":"number"},{"id":"name","name":"Name","type":"text"}]`)
	s.makeRow(t, ws, uid, col, "b-low", `{"pri":1,"name":"b"}`)
	s.makeRow(t, ws, uid, col, "a-low", `{"pri":1,"name":"a"}`)
	s.makeRow(t, ws, uid, col, "c-high", `{"pri":2,"name":"c"}`)

	titles := func(sort string) []string {
		t.Helper()
		list, _, err := s.collectionRowsQuery(u, col, nil, nil, sort, 100, 0, time.Now())
		if err != nil {
			t.Fatalf("query %q: %v", sort, err)
		}
		var out []string
		for _, r := range list {
			title, _ := r["title"].(string)
			out = append(out, title)
		}
		return out
	}
	eq := func(got []string, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	}

	// One key, both directions — the old behaviour, unchanged.
	eq(titles("pri:desc"), "c-high", "b-low", "a-low")
	eq(titles("pri:asc"), "b-low", "a-low", "c-high")
	// Two keys: priority decides, name breaks the tie.
	eq(titles("pri:desc,name:asc"), "c-high", "a-low", "b-low")
	eq(titles("pri:asc,name:desc"), "b-low", "a-low", "c-high")
	// Unknown properties are ignored, not fatal; the known key still applies.
	eq(titles("nope:desc,pri:asc"), "b-low", "a-low", "c-high")
	// System properties compose with columns.
	eq(titles("pri:desc,created:asc"), "c-high", "b-low", "a-low")
}
