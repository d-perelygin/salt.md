package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func doReq(t *testing.T, s *Server, method, path, cookie, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *strings.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Cookie", cookie)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func readProps(t *testing.T, s *Server, id string) map[string]any {
	t.Helper()
	var raw string
	if err := s.db.QueryRow(`SELECT props FROM pages WHERE id = ?`, id).Scan(&raw); err != nil {
		t.Fatalf("props of %s: %v", id, err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("props json: %v", err)
	}
	return m
}

// The whole point of the split: a trashed row is still a row. Its ids stay in
// the relations that point at it, the picker stops listing it, and restoring
// brings the link back without anybody re-linking anything. Deleting it for
// good is different — that id can never name a row again, so the links are
// cleared, and the dialog is told how many before it asks.
func TestPermanentDeleteClearsRelationLinksAndTrashKeepsThem(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "refs@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"scale","name":"Scale","type":"select","options":[{"id":"big","name":"Крупный"}]}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"n","name":"Companies","type":"rollup","rollupRelation":"company","rollupAgg":"count"}]`)

	company := s.makeRow(t, ws, uid, companies, "Acme", `{"scale":"big"}`)
	sponsor := s.makeRow(t, ws, uid, sponsors, "Sponsor", `{"company":["`+company+`"]}`)

	// Before anything: one link, in one row, and the dialog can say so.
	rec := doReq(t, s, "GET", "/api/pages/"+company+"/references", cookie, "")
	if rec.Code != 200 {
		t.Fatalf("references: %d %s", rec.Code, rec.Body)
	}
	var refs struct {
		Links int `json:"links"`
		Rows  int `json:"rows"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &refs); err != nil {
		t.Fatalf("references body: %v", err)
	}
	if refs.Links != 1 || refs.Rows != 1 {
		t.Fatalf("references say %d link(s) in %d row(s), want 1/1", refs.Links, refs.Rows)
	}

	// Trash: the link lives on, so a restore can bring it back.
	if rec := doReq(t, s, "DELETE", "/api/pages/"+company, cookie, ""); rec.Code != 200 {
		t.Fatalf("trash: %d %s", rec.Code, rec.Body)
	}
	if got := relationIDs(readProps(t, s, sponsor)["company"]); len(got) != 1 || got[0] != company {
		t.Fatalf("trashing dropped the relation id: %v", got)
	}
	// And the interface is told the link is still there, in the trash.
	if rec := doReq(t, s, "GET", "/api/pages/"+company+"/references", cookie, ""); rec.Code != 200 {
		t.Fatalf("references while trashed: %d", rec.Code)
	}

	// Restore: nothing to repair, the id never moved.
	if rec := doReq(t, s, "POST", "/api/pages/"+company+"/restore", cookie, ""); rec.Code != 200 {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body)
	}
	if got := relationIDs(readProps(t, s, sponsor)["company"]); len(got) != 1 {
		t.Fatalf("restore lost the relation: %v", got)
	}

	// Delete forever: the link goes with it.
	if rec := doReq(t, s, "DELETE", "/api/pages/"+company, cookie, ""); rec.Code != 200 {
		t.Fatalf("trash again: %d", rec.Code)
	}
	rec = doReq(t, s, "DELETE", "/api/pages/"+company+"?permanent=1", cookie, "")
	if rec.Code != 200 {
		t.Fatalf("permanent delete: %d %s", rec.Code, rec.Body)
	}
	props := readProps(t, s, sponsor)
	if got := relationIDs(props["company"]); len(got) != 0 {
		t.Fatalf("the sponsor still points at a row that is gone forever: %v", got)
	}
	if _, ok := props["company"]; ok {
		t.Errorf("the empty relation key was left behind: %v", props["company"])
	}

	// The cleanup is in the log: a write to a row nobody clicked has to be
	// explainable afterwards.
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'relation_cleanup'`).Scan(&n); err != nil {
		t.Fatalf("audit: %v", err)
	}
	if n == 0 {
		t.Error("no audit entry for the relation cleanup")
	}

	// A second row of the same collection is untouched: the cleanup edits the
	// relations that name the row, not the collection.
	other := s.makeRow(t, ws, uid, sponsors, "Other", `{"company":["kept-id"]}`)
	// (a made-up id is not one of the deleted ones and must survive)
	if got := relationIDs(readProps(t, s, other)["company"]); len(got) != 1 || got[0] != "kept-id" {
		t.Errorf("cleanup touched an unrelated relation: %v", got)
	}
}

// The resolve endpoint is what lets a chip say "Acme · in the trash" instead of
// printing 32 hex characters. Permissions still apply: a row the caller cannot
// read does not come back, and neither does an id that no longer exists.
func TestResolvePagesNamesTrashedRowsAndHidesTheRest(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "resolve@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	live := s.makePage(t, ws, uid, "", "Live row", `{}`)
	gone := s.makePage(t, ws, uid, "", "Gone row", `{}`)
	if _, err := s.db.Exec(`UPDATE pages SET trashed_at = ? WHERE id = ?`, now(), gone); err != nil {
		t.Fatalf("trash: %v", err)
	}
	body := fmt.Sprintf(`{"ids":["%s","%s","does-not-exist"]}`, live, gone)
	rec := doReq(t, s, "POST", "/api/pages/resolve", cookie, body)
	if rec.Code != 200 {
		t.Fatalf("resolve: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Pages []struct {
			ID      string `json:"id"`
			Title   string `json:"title"`
			Trashed bool   `json:"trashed"`
		} `json:"pages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("resolve body: %v", err)
	}
	seen := map[string]bool{}
	for _, p := range out.Pages {
		seen[p.ID] = true
		switch p.ID {
		case live:
			if p.Trashed {
				t.Error("a live row came back as trashed")
			}
		case gone:
			if !p.Trashed {
				t.Error("a trashed row came back as live — the chip cannot say «in the trash»")
			}
			if p.Title != "Gone row" {
				t.Errorf("trashed row lost its title: %q", p.Title)
			}
		case "does-not-exist":
			t.Error("a nonexistent id was resolved")
		}
	}
	if !seen[live] || !seen[gone] {
		t.Fatalf("resolve answered %v, want both real rows", seen)
	}
	if len(out.Pages) != 2 {
		t.Errorf("resolve returned %d pages, want 2 (the missing id stays absent)", len(out.Pages))
	}
}
