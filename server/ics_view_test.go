package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// futureDate is a YYYY-MM-DD day n days from today, so fixtures stay inside
// the feed's recent-history window whatever day the suite runs.
func futureDate(n int) string {
	return time.Now().AddDate(0, 0, n).Format("2006-01-02")
}

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
		{"One", "doing", futureDate(5)},
		{"Two", "doing", futureDate(6)},
		{"Three", "done", futureDate(7)},
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

// Without a view nothing moves: every row, plain summaries (a single date
// property needs no suffix), plain collection description.
func TestICSCollectionFeedUnchanged(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col)
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 3 {
		t.Errorf("collection feed has %d events, want 3", n)
	}
	if !strings.Contains(body, "SUMMARY:One\r\n") {
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

// Every event carries an end and a link back to its row: timed events get a
// one-hour duration, all-day events end the next day.
func TestICSFeedEventHasEndAndURL(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col)
	if !strings.Contains(body, "DTSTART;VALUE=DATE:") {
		t.Errorf("all-day event lost its start:\n%s", body)
	}
	if !strings.Contains(body, "DTEND;VALUE=DATE:") {
		t.Errorf("all-day event has no end:\n%s", body)
	}
	if !strings.Contains(body, "URL:") || !strings.Contains(body, "/p/") {
		t.Errorf("event has no backlink to its page:\n%s", body)
	}
}

// Timed values keep their clock time and gain a one-hour end.
func TestICSFeedTimedEventHasDuration(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	var ws string
	if err := s.db.QueryRow(`SELECT workspace_id FROM pages WHERE id = ?`, col).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	props, _ := json.Marshal(map[string]any{"status": "doing", "due": futureDate(5) + "T14:30"})
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
		VALUES (?, ?, ?, 'Timed', 'row', ?, 9, ?, ?)`, newID(), col, ws, string(props), now(), now()); err != nil {
		t.Fatal(err)
	}
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col)
	if !strings.Contains(body, "DTSTART:") || !strings.Contains(body, "T143000") {
		t.Errorf("timed event lost its clock time:\n%s", body)
	}
	if !strings.Contains(body, "DTEND:") || !strings.Contains(body, "T153000") {
		t.Errorf("timed event has no one-hour end:\n%s", body)
	}
}

// The calendar tells clients when to re-poll instead of leaving it to each
// app's default (up to a day on some providers).
func TestICSFeedAdvertisesRefresh(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col)
	if !strings.Contains(body, "REFRESH-INTERVAL;VALUE=DURATION:PT30M") {
		t.Errorf("feed does not advertise a refresh interval:\n%s", body)
	}
	if !strings.Contains(body, "X-PUBLISHED-TTL:PT30M") {
		t.Errorf("feed does not advertise a TTL:\n%s", body)
	}
}

// Ancient history stays out of the feed: rows older than the window do not
// sync onto phones.
func TestICSFeedSkipsOldEvents(t *testing.T) {
	s, _, col, tok := icsViewFixture(t)
	var ws string
	if err := s.db.QueryRow(`SELECT workspace_id FROM pages WHERE id = ?`, col).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	props, _ := json.Marshal(map[string]any{"status": "doing", "due": "2019-01-01"})
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
		VALUES (?, ?, ?, 'Ancient', 'row', ?, 9, ?, ?)`, newID(), col, ws, string(props), now(), now()); err != nil {
		t.Fatal(err)
	}
	body := icsGet(t, s, "/ics/"+tok+".ics?collection="+col)
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 3 {
		t.Errorf("feed has %d events, want 3 — the ancient row must not cross", n)
	}
	if strings.Contains(body, "Ancient") {
		t.Errorf("feed contains the out-of-window row")
	}
}

// The history window is personal: narrowing it drops older rows from the
// feed, widening it brings them back.
func TestICSFeedHistoryWindowPref(t *testing.T) {
	s, uid, col, tok := icsViewFixture(t)
	var ws string
	if err := s.db.QueryRow(`SELECT workspace_id FROM pages WHERE id = ?`, col).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	old := time.Now().AddDate(0, 0, -60).Format("2006-01-02")
	props, _ := json.Marshal(map[string]any{"status": "doing", "due": old})
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
		VALUES (?, ?, ?, 'Oldie', 'row', ?, 9, ?, ?)`, newID(), col, ws, string(props), now(), now()); err != nil {
		t.Fatal(err)
	}
	path := "/ics/" + tok + ".ics?collection=" + col
	body := icsGet(t, s, path)
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 4 || !strings.Contains(body, "Oldie") {
		t.Fatalf("default window has %d events, want 4 with Oldie", n)
	}
	if rec := icsAPI(t, s, uid, "POST", "/api/ics/prefs", `{"pastDays":30}`); rec.Code != 200 {
		t.Fatalf("POST prefs: status %d: %s", rec.Code, rec.Body.String())
	}
	narrow := icsGet(t, s, path)
	if n := strings.Count(narrow, "BEGIN:VEVENT"); n != 3 || strings.Contains(narrow, "Oldie") {
		t.Errorf("narrow window has %d events, want 3 without Oldie", n)
	}
	if rec := icsAPI(t, s, uid, "POST", "/api/ics/prefs", `{"pastDays":365}`); rec.Code != 200 {
		t.Fatalf("POST prefs: status %d: %s", rec.Code, rec.Body.String())
	}
	wide := icsGet(t, s, path)
	if n := strings.Count(wide, "BEGIN:VEVENT"); n != 4 || !strings.Contains(wide, "Oldie") {
		t.Errorf("wide window has %d events, want 4 with Oldie", n)
	}
	if rec := icsAPI(t, s, uid, "POST", "/api/ics/prefs", `{"pastDays":45}`); rec.Code != 400 {
		t.Errorf("unknown window: status %d, want 400", rec.Code)
	}
}

// Rows with several filled date properties keep a "(Property)" suffix so
// the two events stay distinguishable; single-date rows stay clean.
func TestICSFeedSuffixOnlyForSeveralDates(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "icsmulti@example.com")
	var ws string
	if err := s.db.QueryRow(`SELECT id FROM workspaces LIMIT 1`).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	col := newID()
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, created_at, updated_at)
		VALUES (?, NULL, ?, 'Multi', 'collection', '{}', ?, ?)`, col, ws, now(), now()); err != nil {
		t.Fatal(err)
	}
	schema := `[{"id":"start","name":"Start","type":"date"},{"id":"due","name":"Due","type":"date"}]`
	if _, err := s.db.Exec(`INSERT INTO collections (page_id, schema, views) VALUES (?, '[]', '[]')`, col); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE collections SET schema = ? WHERE page_id = ?`, schema, col); err != nil {
		t.Fatal(err)
	}
	props, _ := json.Marshal(map[string]any{"start": futureDate(5), "due": futureDate(6)})
	if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, props, position, created_at, updated_at)
		VALUES (?, ?, ?, 'Trip', 'row', ?, 0, ?, ?)`, newID(), col, ws, string(props), now(), now()); err != nil {
		t.Fatal(err)
	}
	_ = uid
	body := icsGet(t, s, "/ics/"+s.icsToken(uid)+".ics?collection="+col)
	if !strings.Contains(body, "SUMMARY:Trip (Start)") || !strings.Contains(body, "SUMMARY:Trip (Due)") {
		t.Errorf("multi-date row lost its disambiguating suffixes:\n%s", body)
	}
}

// Long titles fold at 75 octets per RFC 5545 instead of arriving as one
// overlong line that calendar apps truncate.
func TestICSFoldLongLines(t *testing.T) {
	line := "SUMMARY:" + strings.Repeat("a", 200)
	folded := icsFold(line)
	for _, part := range strings.Split(folded, "\r\n") {
		if len(part) > 75 {
			t.Errorf("folded segment is %d octets, want at most 75", len(part))
		}
	}
	if !strings.Contains(folded, "\r\n ") {
		t.Errorf("long line was not folded:\n%s", folded)
	}
}

func TestICSDateRangeShapes(t *testing.T) {
	start, end, ok := icsDateRange("2026-07-18")
	if !ok || start != "DTSTART;VALUE=DATE:20260718" || end != "DTEND;VALUE=DATE:20260719" {
		t.Errorf("all-day range = %q %q, want next-day end", start, end)
	}
	start, end, ok = icsDateRange("2026-07-18T14:30")
	if !ok || start != "DTSTART:20260718T143000" || end != "DTEND:20260718T153000" {
		t.Errorf("timed range = %q %q, want one-hour duration", start, end)
	}
	if _, _, ok = icsDateRange("not a date"); ok {
		t.Errorf("garbage date parsed as a range")
	}
}

// icsAPI performs an authenticated API call against the test server.
func icsAPI(t *testing.T, s *Server, uid, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	tok, err := s.createSession(uid)
	if err != nil {
		t.Fatal(err)
	}
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Cookie", sessionCookie+"="+tok)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func icsFeedPath(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	if u.RawQuery != "" {
		return u.Path + "?" + u.RawQuery
	}
	return u.Path
}

// A named subscription is a link with its own token, scoped to exactly what
// it was made for.
func TestICSNamedFeedRoundTrip(t *testing.T) {
	s, uid, col, _ := icsViewFixture(t)
	rec := icsAPI(t, s, uid, "POST", "/api/ics/feeds",
		`{"kind":"collection","refId":"`+col+`","name":"Team"}`)
	if rec.Code != 200 {
		t.Fatalf("POST /api/ics/feeds: status %d: %s", rec.Code, rec.Body.String())
	}
	var feed struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		URL   string `json:"url"`
		Count int    `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &feed); err != nil {
		t.Fatal(err)
	}
	if feed.Name != "Team" || feed.Count != 3 {
		t.Errorf("feed = %+v, want name Team with 3 events", feed)
	}
	body := icsGet(t, s, icsFeedPath(t, feed.URL))
	if n := strings.Count(body, "BEGIN:VEVENT"); n != 3 {
		t.Errorf("named feed has %d events, want 3", n)
	}
	// Query parameters cannot widen a named link: appended scope is ignored.
	wide := icsGet(t, s, icsFeedPath(t, feed.URL)+"?collection="+col+"&view=nope")
	if n := strings.Count(wide, "BEGIN:VEVENT"); n != 3 {
		t.Errorf("named feed with query has %d events, want its own 3", n)
	}
	// The info endpoint lists it.
	info := icsAPI(t, s, uid, "GET", "/api/ics", "")
	var parsed struct {
		Feeds []struct {
			ID string `json:"id"`
		} `json:"feeds"`
	}
	if err := json.Unmarshal(info.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Feeds) != 1 || parsed.Feeds[0].ID != feed.ID {
		t.Errorf("info feeds = %+v, want the one created feed", parsed.Feeds)
	}
	// Revoking kills exactly this link.
	del := icsAPI(t, s, uid, "DELETE", "/api/ics/feeds/"+feed.ID, "")
	if del.Code != 200 {
		t.Fatalf("DELETE feed: status %d", del.Code)
	}
	rec404 := httptest.NewRecorder()
	s.ServeHTTP(rec404, httptest.NewRequest("GET", icsFeedPath(t, feed.URL), nil))
	if rec404.Code != http.StatusNotFound {
		t.Errorf("revoked feed: status %d, want 404", rec404.Code)
	}
}

// Scopes that are unreadable or unknown cannot be made into links.
func TestICSNamedFeedValidation(t *testing.T) {
	s, uid, _, _ := icsViewFixture(t)
	for _, body := range []string{
		`{"kind":"nope"}`,
		`{"kind":"collection","refId":"missing"}`,
		`{"kind":"workspace","refId":"missing"}`,
		`{"kind":"view","refId":"missing","viewId":"x"}`,
	} {
		if rec := icsAPI(t, s, uid, "POST", "/api/ics/feeds", body); rec.Code != 400 {
			t.Errorf("POST %s: status %d, want 400", body, rec.Code)
		}
	}
}
