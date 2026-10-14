package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Calendar subscriptions: named, per-scope, read-only iCalendar feeds of the
// date-typed properties the owner can read. Each subscription is a row in
// ics_feeds with its OWN token and a FIXED scope (everything, one workspace,
// one collection, or one saved view following its filters and date property).
// Calendar apps (Apple/Google/Outlook) poll GET /ics/{token}.ics; no login,
// the token IS the credential (like a share link).
//
// A token fixes its scope: holding one link never grants more than that link
// was made for, and query parameters on a feed URL are ignored rather than
// honoured. Scope and token never change after creation — a link that widens
// after sharing would not be a boundary; recreate it instead. The dialog
// shows every link for copying at any time. Every serving request re-checks
// what the owner may read (visible workspaces, then no forbidden private ancestor); an
// unreadable scope yields an empty calendar rather than an error, so a
// collection that gets moved or made private does not leave a broken
// subscription in somebody's calendar app. A view that is gone or unreadable
// yields an empty calendar, same as above.
//
// A deactivated or deleted account's feeds stop working at once (revoked with
// the account, like its sessions and API tokens).
//
// Feed quality notes: every timed event carries a DTEND (one hour after the
// start — an event with a start and no end renders as an invisible dot in
// most calendar apps), every all-day event carries a DTEND of the next day,
// and every event carries a URL back to its page (base + "/p/<id>"). Lines
// are folded at 75 octets per RFC 5545. The calendar advertises
// REFRESH-INTERVAL/X-PUBLISHED-TTL of five minutes so clients re-poll
// promptly, and the feed covers the subscriber's history window (a personal
// choice, 90 days by default) plus everything upcoming, capped at
// icsMaxEvents — a whole-account feed over years of rows must stay light
// enough for a phone to sync. The interval is a hint Apple honors down to
// about five minutes; Google and Outlook poll subscribed calendars on their
// own slower schedule whatever it says.

// How often calendar apps are asked to re-poll the feed.
const icsRefreshInterval = "PT5M"

// How far back a feed reaches by default. Everything upcoming is always
// included. Each user may pick their own window (or none at all) —
// icsPastDaysOf reads that choice.
const icsDefaultPastDays = 90

// icsPastDaysOptions are the windows the dialog offers, in days; 0 means
// the whole history.
var icsPastDaysOptions = []int{30, 90, 365, 0}

// Upper bound on events in one feed response.
const icsMaxEvents = 5000

// icsNewToken mints one credential-grade feed token.
func icsNewToken() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// icsFeedLinks builds the two subscription addresses for one raw token.
func icsFeedLinks(r *http.Request, s *Server, tok string) (url, webcal string) {
	base := s.publicShareBase(r)
	host := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	return base + "/ics/" + tok + ".ics",
		"webcal://" + host + "/ics/" + tok + ".ics"
}

// handleICSPrefs stores the caller's calendar preferences: history window
// and the dialog's last scope pick (so it survives across devices).
func (s *Server) handleICSPrefs(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	var body struct {
		PastDays *int    `json:"pastDays"`
		Scope    *string `json:"scope"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	out := map[string]any{}
	if body.PastDays != nil {
		if !icsValidDays(*body.PastDays) {
			httpError(w, 400, "unknown history window")
			return
		}
		s.setSetting("ics_past_days_"+uid, strconv.Itoa(*body.PastDays))
		out["pastDays"] = *body.PastDays
	}
	if body.Scope != nil {
		// Stored raw and validated on read against the live scope list: a
		// deleted collection simply stops matching and the dialog falls
		// back to Everything.
		kind := *body.Scope
		if i := strings.Index(kind, ":"); i >= 0 {
			kind = kind[:i]
		}
		switch kind {
		case "", "all", "workspace", "collection", "view":
			s.setSetting("ics_scope_"+uid, *body.Scope)
			out["scope"] = *body.Scope
		default:
			httpError(w, 400, "unknown scope")
			return
		}
	}
	if len(out) == 0 {
		httpError(w, 400, "nothing to store")
		return
	}
	writeJSON(w, out)
}

// icsFeed is one named subscription row.
// dateProp narrows a collection feed to one date property ("" carries every
// date); view feeds follow their view instead and ignore it.
type icsFeed struct {
	id, kind, refID, viewID, name, token, created, dateProp string
	pastDays                                               int
}

// icsValidDays reports whether n is an offerable history window (0 keeps
// everything).
func icsValidDays(n int) bool {
	for _, allowed := range icsPastDaysOptions {
		if n == allowed {
			return true
		}
	}
	return false
}

// icsValidateScope checks that uid may subscribe to a scope today and returns
// its display name. A scope that is unreadable cannot be made into a link.
func (s *Server) icsValidateScope(uid, kind, refID, viewID string) (string, bool) {
	switch kind {
	case "all":
		return "", true
	case "workspace":
		for _, w := range s.visibleWorkspaces(uid) {
			if w == refID {
				var nm string
				s.db.QueryRow(`SELECT name FROM workspaces WHERE id = ?`, refID).Scan(&nm)
				return nm, true
			}
		}
		return "", false
	case "collection":
		if refID == "" || !s.canRead(uid, refID) {
			return "", false
		}
		var title string
		s.db.QueryRow(`SELECT title FROM pages WHERE id = ? AND trashed_at IS NULL`, refID).Scan(&title)
		if title == "" {
			title = "Untitled"
		}
		return title, true
	case "view":
		if refID == "" || viewID == "" || !s.canRead(uid, refID) {
			return "", false
		}
		var title string
		s.db.QueryRow(`SELECT title FROM pages WHERE id = ? AND trashed_at IS NULL`, refID).Scan(&title)
		if title == "" {
			title = "Untitled"
		}
		viewName, _, _, _, _, found := s.icsViewDetail(refID, viewID)
		if !found {
			return "", false
		}
		return title + " / " + viewName, true
	default:
		return "", false
	}
}

// icsFeedJSON renders one subscription for the dialog, with its links and a
// live preview of what it currently holds.
func (s *Server) icsFeedJSON(r *http.Request, uid string, f icsFeed) map[string]any {
	events, _ := s.icsEventsFor(uid, wsOf(f.kind, f.refID), colOf(f.kind, f.refID), viewOf(f.kind, f.viewID), f.dateProp, f.pastDays)
	n, nt, nd := icsPreview(events)
	if len(nd) == 8 {
		nd = nd[0:4] + "-" + nd[4:6] + "-" + nd[6:8]
	}
	u, w := icsFeedLinks(r, s, f.token)
	out := map[string]any{
		"id": f.id, "kind": f.kind, "refId": f.refID, "viewId": f.viewID,
		"name": f.name, "url": u, "webcal": w, "createdAt": f.created,
		"count": n, "nextTitle": nt, "nextDay": nd, "pastDays": f.pastDays,
	}
	if f.dateProp != "" {
		out["dateProp"] = f.dateProp
		if nm := s.icsDatePropName(f.refID, f.dateProp); nm != "" {
			out["datePropName"] = nm
		}
	}
	return out
}

// icsDatePropName resolves a collection's date property to its display name,
// for feed cards. Unknown collections or props yield nothing.
func (s *Server) icsDatePropName(colID, propID string) string {
	var schemaJSON string
	if err := s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON); err != nil {
		return ""
	}
	var defs []propDef
	if json.Unmarshal([]byte(schemaJSON), &defs) != nil {
		return ""
	}
	for _, d := range defs {
		if d.ID == propID && d.Type == "date" {
			return d.Name
		}
	}
	return ""
}

// icsDateProps lists a collection's date properties for the subscription
// dialog's date picker.
func (s *Server) icsDateProps(colID string) []map[string]string {
	var schemaJSON string
	if err := s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON); err != nil {
		return nil
	}
	var defs []propDef
	if json.Unmarshal([]byte(schemaJSON), &defs) != nil {
		return nil
	}
	var out []map[string]string
	for _, d := range defs {
		if d.Type == "date" {
			out = append(out, map[string]string{"id": d.ID, "name": d.Name})
		}
	}
	return out
}

// handleICSFeedsCreate mints one named subscription: a link with its own
// token, scoped to exactly what the body names. Revoking it later touches
// nothing else.
func (s *Server) handleICSFeedsCreate(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	var body struct {
		Kind     string `json:"kind"`
		RefID    string `json:"refId"`
		ViewID   string `json:"viewId"`
		Name     string `json:"name"`
		DateProp string `json:"dateProp"`
		PastDays *int   `json:"pastDays"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if body.Kind == "" {
		body.Kind = "all"
	}
	scopeName, ok := s.icsValidateScope(uid, body.Kind, body.RefID, body.ViewID)
	if !ok {
		httpError(w, 400, "that scope cannot be subscribed to")
		return
	}
	// A date filter narrows a collection feed to one date property, so one
	// collection with two dates becomes two subscriptions with two colors.
	// View feeds follow their view instead; anything else cannot be narrowed.
	dateProp := ""
	if body.DateProp != "" {
		if body.Kind != "collection" {
			httpError(w, 400, "a date filter is only for collection subscriptions")
			return
		}
		if s.icsDatePropName(body.RefID, body.DateProp) == "" {
			httpError(w, 400, "that is not a date property of the collection")
			return
		}
		dateProp = body.DateProp
	}
	pastDays := s.icsPastDaysOf(uid)
	if body.PastDays != nil {
		if !icsValidDays(*body.PastDays) {
			httpError(w, 400, "unknown history window")
			return
		}
		pastDays = *body.PastDays
	}
	var existing int
	s.db.QueryRow(`SELECT COUNT(*) FROM ics_feeds WHERE user_id = ?`, uid).Scan(&existing)
	if existing >= 20 {
		httpError(w, 400, "too many calendar subscriptions (20)")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = scopeName
	}
	if name == "" {
		name = "Everything"
	}
	f := icsFeed{id: newID(), kind: body.Kind, refID: body.RefID, viewID: body.ViewID, name: name, created: now(), dateProp: dateProp, pastDays: pastDays}
	raw, err := icsNewToken()
	if err != nil {
		httpError(w, 500, "cannot create subscription")
		return
	}
	f.token = raw
	if _, err := s.db.Exec(`INSERT INTO ics_feeds (id, user_id, token, kind, ref_id, view_id, name, date_prop, past_days, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.id, uid, f.token, f.kind, f.refID, f.viewID, f.name, f.dateProp, f.pastDays, f.created); err != nil {
		httpError(w, 500, "cannot create subscription")
		return
	}
	writeJSON(w, s.icsFeedJSON(r, uid, f))
}

// handleICSFeedUpdate renames a subscription and/or changes its history
// window. Scope and token never change: a link that widens after sharing
// would not be a boundary.
func (s *Server) handleICSFeedUpdate(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	var body struct {
		Name     *string `json:"name"`
		PastDays *int    `json:"pastDays"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if body.Name == nil && body.PastDays == nil {
		httpError(w, 400, "nothing to change")
		return
	}
	var f icsFeed
	if err := s.db.QueryRow(`SELECT id, kind, ref_id, view_id, name, token, date_prop, past_days, created_at FROM ics_feeds WHERE id = ? AND user_id = ?`,
		r.PathValue("id"), uid).Scan(&f.id, &f.kind, &f.refID, &f.viewID, &f.name, &f.token, &f.dateProp, &f.pastDays, &f.created); err != nil {
		httpError(w, 404, "not found")
		return
	}
	if body.Name != nil {
		if strings.TrimSpace(*body.Name) == "" {
			httpError(w, 400, "name is required")
			return
		}
		f.name = strings.TrimSpace(*body.Name)
	}
	if body.PastDays != nil {
		if !icsValidDays(*body.PastDays) {
			httpError(w, 400, "unknown history window")
			return
		}
		f.pastDays = *body.PastDays
	}
	if _, err := s.db.Exec(`UPDATE ics_feeds SET name = ?, past_days = ? WHERE id = ? AND user_id = ?`,
		f.name, f.pastDays, f.id, uid); err != nil {
		httpError(w, 500, "cannot update subscription")
		return
	}
	writeJSON(w, s.icsFeedJSON(r, uid, f))
}

// handleICSFeedDelete revokes one named subscription. The link stops working
// at once; every other subscription keeps working.
func (s *Server) handleICSFeedDelete(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	res, err := s.db.Exec(`DELETE FROM ics_feeds WHERE id = ? AND user_id = ?`, r.PathValue("id"), uid)
	if err != nil {
		httpError(w, 500, "cannot revoke subscription")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpError(w, 404, "not found")
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// icsListFeeds returns the caller's named subscriptions, oldest first.
func (s *Server) icsListFeeds(uid string) []icsFeed {
	rows, err := s.db.Query(`SELECT id, kind, ref_id, view_id, name, token, date_prop, past_days, created_at FROM ics_feeds WHERE user_id = ? ORDER BY created_at`, uid)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []icsFeed
	for rows.Next() {
		var f icsFeed
		if rows.Scan(&f.id, &f.kind, &f.refID, &f.viewID, &f.name, &f.token, &f.dateProp, &f.pastDays, &f.created) == nil {
			out = append(out, f)
		}
	}
	return out
}

// wsOf/colOf/viewOf map a scope back to feed query parameters: only the
// matching kind contributes its id, everything else scopes to nothing.
func wsOf(kind, id string) string {
	if kind == "workspace" {
		return id
	}
	return ""
}

func colOf(kind, id string) string {
	if kind == "collection" || kind == "view" {
		return id
	}
	return ""
}

func viewOf(kind, viewID string) string {
	if kind == "view" {
		return viewID
	}
	return ""
}

// handleICSInfo returns the scopes the caller may subscribe to and their
// named subscriptions. With ?rotate=1 every subscription of the caller is
// revoked at once — that is what "revoke my calendar links" means now that
// each link carries its own token.
func (s *Server) handleICSInfo(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	if r.URL.Query().Get("rotate") == "1" {
		s.db.Exec(`DELETE FROM ics_feeds WHERE user_id = ?`, uid)
	}

	// The scopes on offer: the whole account, each workspace, each
	// collection that actually HAS a date property, and each saved view of
	// those collections. A view feed follows the view's filters and its date
	// property; offering a calendar for a collection without dates would hand
	// out a permanently empty feed.
	type scope struct {
		ID     string `json:"id"`
		ViewID string `json:"viewId,omitempty"`
		Kind   string `json:"kind"` // all | workspace | collection | view
		Name   string `json:"name"`
		// Date properties of a collection, for the dialog's date picker: a
		// feed can narrow to one of them. Other scopes carry none.
		Dates []map[string]string `json:"dates,omitempty"`
		// Preview for the subscription dialog: how many events this
		// scope currently holds and the nearest upcoming one.
		Count     int    `json:"count"`
		NextTitle string `json:"nextTitle,omitempty"`
		NextDay   string `json:"nextDay,omitempty"` // YYYY-MM-DD
	}
	newScope := func(kind, id, viewID, name string) scope {
		events, _ := s.icsEventsFor(uid, wsOf(kind, id), colOf(kind, id), viewOf(kind, viewID), "", s.icsPastDaysOf(uid))
		n, nt, nd := icsPreview(events)
		if len(nd) == 8 {
			nd = nd[0:4] + "-" + nd[4:6] + "-" + nd[6:8]
		}
		sc := scope{ID: id, ViewID: viewID, Kind: kind, Name: name, Count: n, NextTitle: nt, NextDay: nd}
		if kind == "collection" {
			sc.Dates = s.icsDateProps(id)
		}
		return sc
	}
	// Scope descriptors first: previews run their own queries, and the pool
	// is a single connection, so no cursor may be open when they run.
	type desc struct{ kind, id, viewID, name string }
	var descs []desc

	ws := s.visibleWorkspaces(uid)
	if len(ws) > 0 {
		wargs := make([]any, len(ws))
		for i, v := range ws {
			wargs[i] = v
		}
		wrows, err := s.db.Query(`SELECT id, name FROM workspaces WHERE id IN (`+placeholders(len(ws))+`) ORDER BY name`, wargs...)
		if err == nil {
			for wrows.Next() {
				var id, nm string
				if wrows.Scan(&id, &nm) == nil {
					descs = append(descs, desc{"workspace", id, "", nm})
				}
			}
			wrows.Close()
		}
		crows, err := s.db.Query(`SELECT c.page_id, c.schema, c.views, p.title, p.workspace_id FROM collections c
			JOIN pages p ON p.id = c.page_id
			WHERE p.trashed_at IS NULL AND p.workspace_id IN (`+placeholders(len(ws))+`)
			ORDER BY p.title`, wargs...)
		if err == nil {
			type cand struct{ id, schema, views, title, ws string }
			var cands []cand
			for crows.Next() {
				var c cand
				if crows.Scan(&c.id, &c.schema, &c.views, &c.title, &c.ws) == nil {
					cands = append(cands, c)
				}
			}
			crows.Close() // drain before the per-row permission checks (single conn)
			for _, c := range cands {
				var defs []propDef
				json.Unmarshal([]byte(c.schema), &defs)
				hasDate := false
				for _, d := range defs {
					if d.Type == "date" {
						hasDate = true
						break
					}
				}
				if !hasDate || !s.canRead(uid, c.id) {
					continue
				}
				title := c.title
				if title == "" {
					title = "Untitled"
				}
				descs = append(descs, desc{"collection", c.id, "", title})
				for _, v := range icsViewList(c.views) {
					descs = append(descs, desc{
						"view", c.id, v.id, title + " / " + v.name,
					})
				}
			}
		}
	}

	scopes := []scope{newScope("all", "", "", "")}
	for _, d := range descs {
		scopes = append(scopes, newScope(d.kind, d.id, d.viewID, d.name))
	}

	feeds := make([]map[string]any, 0)
	for _, f := range s.icsListFeeds(uid) {
		feeds = append(feeds, s.icsFeedJSON(r, uid, f))
	}

	writeJSON(w, map[string]any{
		"scopes": scopes,
		"feeds":  feeds,
		// The subscriber's history window in days (0 keeps everything), and
		// the dialog's last scope pick ("" falls back to Everything).
		"pastDays": s.icsPastDaysOf(uid),
		"scope":    s.setting("ics_scope_"+uid, ""),
	})
}

func icsEscape(s string) string {
	r := strings.NewReplacer("\\", "\\\\", ";", "\\;", ",", "\\,", "\n", "\\n", "\r", "")
	return r.Replace(s)
}

// icsFold folds one logical content line at 75 octets per RFC 5545: the
// first segment is 75 octets, every continuation is a space plus 74 octets.
// Escaped values are ASCII in practice; the split is on bytes, which is
// what the limit counts.
func icsFold(line string) string {
	const first = 75
	const rest = 74
	if len(line) <= first {
		return line
	}
	var b strings.Builder
	b.WriteString(line[:first])
	line = line[first:]
	for len(line) > 0 {
		b.WriteString("\r\n ")
		if len(line) <= rest {
			b.WriteString(line)
			break
		}
		b.WriteString(line[:rest])
		line = line[rest:]
	}
	return b.String()
}

// icsWrite appends one folded content line (with CRLF) to a feed body.
func icsWrite(b *strings.Builder, line string) {
	b.WriteString(icsFold(line) + "\r\n")
}

// icsDay parses a stored date value into a YYYYMMDD day, whether it carries
// a time, and the time as HHMMSS when it does. Accepts "2026-07-18",
// "2026-07-18T14:30", and longer timed forms ("2026-07-18T14:30:05",
// trailing Z or numeric offsets are ignored — the feed keeps floating
// local time on purpose, so 14:30 reads as 14:30 wherever it is opened).
func icsDay(v string) (day string, hm string, timed bool, ok bool) {
	if len(v) < 10 || v[4] != '-' || v[7] != '-' {
		return "", "", false, false
	}
	for _, i := range []int{0, 1, 2, 3, 5, 6, 8, 9} {
		if v[i] < '0' || v[i] > '9' {
			return "", "", false, false
		}
	}
	day = v[0:4] + v[5:7] + v[8:10]
	if len(v) >= 16 && v[10] == 'T' &&
		v[11] >= '0' && v[11] <= '9' && v[12] >= '0' && v[12] <= '9' &&
		v[13] == ':' && v[14] >= '0' && v[14] <= '9' && v[15] >= '0' && v[15] <= '9' {
		hm = string([]byte{v[11], v[12], v[14], v[15]}) + "00"
		return day, hm, true, true
	}
	return day, "", false, true
}

// icsDateRange formats a stored date value as a DTSTART/DTEND pair. Timed
// values get a one-hour duration; all-day values end the next day. The
// boolean reports whether the value held a date at all.
func icsDateRange(v string) (start, end string, ok bool) {
	day, hm, timed, ok := icsDay(v)
	if !ok {
		return "", "", false
	}
	if !timed {
		t, err := time.Parse("20060102", day)
		if err != nil {
			return "", "", false
		}
		return "DTSTART;VALUE=DATE:" + day,
			"DTEND;VALUE=DATE:" + t.Add(24*time.Hour).Format("20060102"),
			true
	}
	t, err := time.Parse("20060102T150405", day+"T"+hm)
	if err != nil {
		return "", "", false
	}
	return "DTSTART:" + day + "T" + hm,
		"DTEND:" + t.Add(time.Hour).Format("20060102T150405"),
		true
}

// icsDate formats a stored date value as an all-day (VALUE=DATE) or timed field.
// Kept for callers that only need the start; new code prefers icsDateRange.
func icsDate(prop, v string) string {
	start, _, ok := icsDateRange(v)
	if !ok {
		return ""
	}
	if strings.HasPrefix(start, "DTSTART;") {
		return prop + ";VALUE=DATE:" + strings.TrimPrefix(start, "DTSTART;VALUE=DATE:")
	}
	return prop + ":" + strings.TrimPrefix(start, "DTSTART:")
}

// icsPastDaysOf returns the subscriber's history window in days (0 means
// everything). Unknown stored values fall back to the default rather than
// widening or emptying the feed by accident.
func (s *Server) icsPastDaysOf(userID string) int {
	var days int
	if _, err := fmt.Sscanf(s.setting("ics_past_days_"+userID, ""), "%d", &days); err != nil {
		return icsDefaultPastDays
	}
	if !icsValidDays(days) {
		return icsDefaultPastDays
	}
	return days
}

// icsCutoffDay is the oldest YYYYMMDD day a feed still carries ("" keeps
// everything).
func icsCutoffDay(pastDays int) string {
	if pastDays <= 0 {
		return ""
	}
	return time.Now().Add(-time.Duration(pastDays) * 24 * time.Hour).Format("20060102")
}

// icsViewRef is the identity of one saved view for the scope list.
type icsViewRef struct{ id, name string }

// icsViewList parses the stored views JSON into id/name pairs. Malformed
// storage yields no scopes rather than a broken feed.
func icsViewList(viewsJSON string) []icsViewRef {
	var views []map[string]any
	if json.Unmarshal([]byte(viewsJSON), &views) != nil {
		return nil
	}
	out := make([]icsViewRef, 0, len(views))
	for _, v := range views {
		id, _ := v["id"].(string)
		name, _ := v["name"].(string)
		if id == "" {
			continue
		}
		if name == "" {
			name = id
		}
		out = append(out, icsViewRef{id: id, name: name})
	}
	return out
}

// icsViewDetail resolves one saved view of a collection for a view-scoped
// feed: its display name, its date property (only when it still names a
// date-typed prop — a stale view falls back to every date prop), its end
// property for range bars (same rule; without one every event stays a point,
// like in the calendar view itself), and its filters as rowFilters for
// collectionRowsQuery. Not finding the view is not an error: the feed renders
// empty, same as an unreadable collection.
func (s *Server) icsViewDetail(colID, viewID string) (viewName, dateProp, datePropName, endProp string, filters []rowFilter, found bool) {
	var schemaJSON, viewsJSON string
	if err := s.db.QueryRow(`SELECT schema, views FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON, &viewsJSON); err != nil {
		return "", "", "", "", nil, false
	}
	var propType, propName map[string]string
	propType = map[string]string{}
	propName = map[string]string{}
	var defs []propDef
	if json.Unmarshal([]byte(schemaJSON), &defs) == nil {
		for _, d := range defs {
			propType[d.ID] = d.Type
			propName[d.ID] = d.Name
		}
	}
	var views []map[string]any
	if json.Unmarshal([]byte(viewsJSON), &views) != nil {
		return "", "", "", "", nil, false
	}
	for _, v := range views {
		id, _ := v["id"].(string)
		if id != viewID {
			continue
		}
		name, _ := v["name"].(string)
		if name == "" {
			name = id
		}
		if dp, _ := v["dateProp"].(string); dp != "" && propType[dp] == "date" {
			dateProp, datePropName = dp, propName[dp]
		}
		if ep, _ := v["endDateProp"].(string); ep != "" && ep != dateProp && propType[ep] == "date" {
			endProp = ep
		}
		if raw, ok := v["filters"].([]any); ok {
			filters = icsViewFilters(raw)
		}
		return name, dateProp, datePropName, endProp, filters, true
	}
	return "", "", "", "", nil, false
}

// icsViewFilters converts stored view filters ({property, op, value, values,
// value2}) into rowFilters. Unknown shapes are skipped, never fatal: a view
// edited by a newer client must narrow the feed, not break it.
func icsViewFilters(raw []any) []rowFilter {
	out := make([]rowFilter, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		prop, _ := m["property"].(string)
		if !safePropID(prop) {
			continue
		}
		op, _ := m["op"].(string)
		f := rowFilter{Prop: prop, Op: op}
		switch v := m["value"].(type) {
		case string:
			f.Value = v
		case float64:
			f.Value = strconv.FormatFloat(v, 'f', -1, 64)
		case bool:
			if v {
				f.Value = "true"
			} else {
				f.Value = "false"
			}
		case []any:
			for _, e := range v {
				if s, ok := e.(string); ok {
					f.Values = append(f.Values, s)
				}
			}
		}
		if vs, ok := m["values"].([]any); ok {
			for _, e := range vs {
				if s, ok := e.(string); ok {
					f.Values = append(f.Values, s)
				}
			}
		}
		if v2, ok := m["value2"].(string); ok {
			f.Value2 = v2
		}
		out = append(out, f)
	}
	return out
}

// icsEvent is one rendered calendar entry: DTSTART/DTEND pair, a stable UID,
// and a pageID pointing back at the row in salt.md.
type icsEvent struct {
	uid, title, desc, pageID string
	start, end               string
	day                      string // YYYYMMDD, for the archive cutoff and previews
}

// icsEventsFor gathers the events one feed scope carries: the collections in
// scope the subscriber may read, each row's date values from icsPastDays ago
// onward (everything upcoming is always included), at most icsMaxEvents. A
// view scope follows the view's filters and date property, drawing one bar
// per row when the view names an end property; a collection scope with a
// date filter carries only that property. An unknown view or an unreadable
// scope yields no events rather than an error.
func (s *Server) icsEventsFor(userID, scopeWS, scopeCol, scopeView, feedDateProp string, pastDays int) ([]icsEvent, string) {
	ws := s.visibleWorkspaces(userID)
	if scopeWS != "" {
		only := ws[:0]
		for _, w := range ws {
			if w == scopeWS {
				only = append(only, w)
			}
		}
		ws = only
	}

	viewScoped := scopeCol != "" && scopeView != ""
	var viewName, viewDateProp, viewEndProp string
	var viewFilters []rowFilter
	viewFound := false
	if viewScoped {
		viewName, viewDateProp, _, viewEndProp, viewFilters, viewFound = s.icsViewDetail(scopeCol, scopeView)
	}

	name := "salt.md"
	if scopeCol != "" {
		var title string
		s.db.QueryRow(`SELECT title FROM pages WHERE id = ?`, scopeCol).Scan(&title)
		if title != "" {
			name = "salt.md · " + title
			if viewScoped && viewFound && viewName != "" {
				name += " · " + viewName
			}
		}
	} else if scopeWS != "" {
		var title string
		s.db.QueryRow(`SELECT name FROM workspaces WHERE id = ?`, scopeWS).Scan(&title)
		if title != "" {
			name = "salt.md · " + title
		}
	}

	var out []icsEvent
	if len(ws) == 0 {
		return out, name
	}
	cutoff := icsCutoffDay(pastDays)
	feedUser := s.userByID(userID)

	wargs := make([]any, len(ws))
	for i, v := range ws {
		wargs[i] = v
	}
	q := `SELECT c.page_id, c.schema, p.title, p.workspace_id FROM collections c
		JOIN pages p ON p.id = c.page_id
		WHERE p.trashed_at IS NULL AND p.workspace_id IN (` + placeholders(len(ws)) + `)`
	if scopeCol != "" {
		q += ` AND c.page_id = ?`
		wargs = append(wargs, scopeCol)
	}
	crows, err := s.db.Query(q, wargs...)
	if err != nil {
		return out, name
	}
	type coll struct{ id, schema, title, ws string }
	var colls []coll
	for crows.Next() {
		var c coll
		if crows.Scan(&c.id, &c.schema, &c.title, &c.ws) == nil {
			colls = append(colls, c)
		}
	}
	crows.Close() // drain before per-collection row queries (single conn)

	readable := colls[:0]
	for _, c := range colls {
		if s.canRead(userID, c.id) {
			readable = append(readable, c)
		}
	}
	colls = readable

	added := 0
	add := func(pageID, title, desc, pid string, v string) {
		if added >= icsMaxEvents {
			return
		}
		day, _, _, ok := icsDay(v)
		if !ok || day < cutoff {
			return
		}
		start, end, ok := icsDateRange(v)
		if !ok {
			return
		}
		if title == "" {
			title = "Untitled"
		}
		out = append(out, icsEvent{
			uid: pageID + "-" + pid + "@salt.md", title: title,
			desc: desc, pageID: pageID, start: start, end: end, day: day,
		})
		added++
	}
	// addRange draws one bar from the start value to the end value — the same
	// bargain the calendar view strikes: a range that ends where it starts,
	// or an end that never parses, is not a range, and the start stays a
	// point event.
	addRange := func(pageID, title, desc, pid1, pid2, v1, v2 string) {
		if added >= icsMaxEvents {
			return
		}
		day1, _, _, ok1 := icsDay(v1)
		day2, _, _, ok2 := icsDay(v2)
		if !ok1 || !ok2 || day1 < cutoff || day2 <= day1 {
			if ok1 {
				add(pageID, title, desc, pid1, v1)
			}
			return
		}
		start, _, ok := icsDateRange(v1)
		if !ok {
			return
		}
		_, end, ok := icsDateRange(v2)
		if !ok {
			add(pageID, title, desc, pid1, v1)
			return
		}
		if title == "" {
			title = "Untitled"
		}
		out = append(out, icsEvent{
			uid: pageID + "-" + pid1 + "-" + pid2 + "@salt.md", title: title,
			desc: desc, pageID: pageID, start: start, end: end, day: day1,
		})
		added++
	}

	for _, c := range colls {
		if added >= icsMaxEvents {
			break
		}
		dateProps := map[string]string{} // id -> name
		var defs []propDef
		json.Unmarshal([]byte(c.schema), &defs)
		for _, d := range defs {
			if d.Type == "date" {
				dateProps[d.ID] = d.Name
			}
		}
		if len(dateProps) == 0 {
			continue
		}
		desc := c.title
		singlePID, endPID := "", ""
		type row struct {
			id, title string
			pm        map[string]any
		}
		var rowsData []row
		if viewScoped {
			// A view the subscriber cannot resolve contributes nothing.
			if c.id != scopeCol || !viewFound || feedUser == nil {
				continue
			}
			if viewDateProp != "" {
				if _, ok := dateProps[viewDateProp]; ok {
					dateProps = map[string]string{viewDateProp: dateProps[viewDateProp]}
					singlePID = viewDateProp
					endPID = viewEndProp
				}
			}
			if viewName != "" {
				desc = c.title + " / " + viewName
			}
			// The view's filters, through the same query the row list
			// uses — what the view shows is what the feed carries.
			// A flat filter list is one group (groups are ORed).
			for offset := 0; ; {
				list, total, err := s.collectionRowsQuery(feedUser, c.id, [][]rowFilter{viewFilters}, "", 500, offset, time.Time{})
				if err != nil {
					break
				}
				for _, item := range list {
					id, _ := item["id"].(string)
					title, _ := item["title"].(string)
					pm, _ := item["props"].(map[string]any)
					if pm == nil {
						pm = map[string]any{}
					}
					rowsData = append(rowsData, row{id: id, title: title, pm: pm})
				}
				if len(rowsData) >= total || len(list) == 0 {
					break
				}
				offset += len(list)
			}
		} else {
			// A collection feed with a date filter carries only that
			// property. A stale filter (prop gone or retyped) falls back to
			// every date prop, like a stale view date.
			if scopeCol != "" && c.id == scopeCol && feedDateProp != "" {
				if _, ok := dateProps[feedDateProp]; ok {
					dateProps = map[string]string{feedDateProp: dateProps[feedDateProp]}
					singlePID = feedDateProp
				}
			}
			rrows, err := s.db.Query(`SELECT id, title, props FROM pages WHERE parent_id = ? AND trashed_at IS NULL LIMIT 5000`, c.id)
			if err != nil {
				continue
			}
			for rrows.Next() {
				var id, title, props string
				if rrows.Scan(&id, &title, &props) == nil {
					var pm map[string]any
					json.Unmarshal([]byte(props), &pm)
					rowsData = append(rowsData, row{id: id, title: title, pm: pm})
				}
			}
			rrows.Close()
		}
		if singlePID != "" {
			for _, rw := range rowsData {
				if v, _ := rw.pm[singlePID].(string); v != "" {
					if endPID != "" {
						if v2, _ := rw.pm[endPID].(string); v2 != "" {
							addRange(rw.id, rw.title, desc, singlePID, endPID, v, v2)
							continue
						}
					}
					add(rw.id, rw.title, desc, singlePID, v)
				}
			}
			continue
		}
		for _, rw := range rowsData {
			// Only rows with several filled date properties keep a
			// "(Property)" suffix — otherwise every summary is just
			// the row title.
			filled := 0
			for pid := range dateProps {
				if v, _ := rw.pm[pid].(string); v != "" {
					if _, _, _, ok := icsDay(v); ok {
						filled++
					}
				}
			}
			for pid, pname := range dateProps {
				v, _ := rw.pm[pid].(string)
				if v == "" {
					continue
				}
				title := rw.title
				if title == "" {
					title = "Untitled"
				}
				if filled > 1 {
					title += " (" + pname + ")"
				}
				add(rw.id, title, desc, pid, v)
			}
		}
	}
	return out, name
}

// icsPreview summarizes a scope for the subscription dialog: how many events
// it currently holds and the nearest upcoming one (title and YYYY-MM-DD).
func icsPreview(events []icsEvent) (count int, nextTitle, nextDay string) {
	if len(events) == 0 {
		return 0, "", ""
	}
	today := time.Now().Format("20060102")
	best := ""
	for _, e := range events {
		if e.day >= today && (best == "" || e.day < best) {
			best = e.day
			nextDay = e.day
			nextTitle = e.title
		}
	}
	if best == "" {
		for _, e := range events {
			if e.day > best {
				best = e.day
				nextDay = e.day
				nextTitle = e.title
			}
		}
	}
	return len(events), nextTitle, nextDay
}

func (s *Server) handleICSFeed(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSuffix(r.PathValue("token"), ".ics")
	// Guessing gets cut off once an address has burned through its budget of
	// WRONG tokens — the same bargain API tokens strike in currentUser. Only
	// failures pay in, so calendar apps polling a good link are unaffected.
	if s.tokenRate.exhausted(s.clientIP(r)) {
		httpError(w, 429, "too many requests, slow down")
		return
	}
	// The token fixes the scope: holding one link never grants more than that
	// link was made for, and query parameters are ignored, not honoured.
	var userID, feedKind, feedRef, feedView, feedDateProp string
	var feedWindow int
	if err := s.db.QueryRow(`SELECT user_id, kind, ref_id, view_id, date_prop, past_days FROM ics_feeds WHERE token = ?`, token).
		Scan(&userID, &feedKind, &feedRef, &feedView, &feedDateProp, &feedWindow); err != nil {
		s.tokenRate.allow(s.clientIP(r))
		httpError(w, 404, "not found")
		return
	}
	// A deactivated or deleted account's feeds stop at once, like its
	// sessions and API tokens. Answered as missing: the feed's existence is
	// not something to confirm to a stranger.
	if u := s.userByID(userID); u == nil || u.Disabled {
		httpError(w, 404, "not found")
		return
	}

	events, name := s.icsEventsFor(userID, wsOf(feedKind, feedRef), colOf(feedKind, feedRef), viewOf(feedKind, feedView), feedDateProp, feedWindow)
	base := s.publicShareBase(r)

	var b strings.Builder
	icsWrite(&b, "BEGIN:VCALENDAR")
	icsWrite(&b, "VERSION:2.0")
	icsWrite(&b, "PRODID:-//salt.md//Calendar//EN")
	icsWrite(&b, "CALSCALE:GREGORIAN")
	icsWrite(&b, "METHOD:PUBLISH")
	icsWrite(&b, "X-WR-CALNAME:"+icsEscape(name))
	icsWrite(&b, "X-PUBLISHED-TTL:"+icsRefreshInterval)
	icsWrite(&b, "REFRESH-INTERVAL;VALUE=DURATION:"+icsRefreshInterval)

	stamp := time.Now().UTC().Format("20060102T150405Z")
	for _, e := range events {
		icsWrite(&b, "BEGIN:VEVENT")
		icsWrite(&b, "UID:"+e.uid)
		icsWrite(&b, "DTSTAMP:"+stamp)
		icsWrite(&b, e.start)
		icsWrite(&b, e.end)
		icsWrite(&b, "SUMMARY:"+icsEscape(e.title))
		// The backlink lives in the description too, not only in the URL
		// property: plenty of clients show one and hide the other, and a
		// forwarded event keeps its way back either way.
		desc := e.desc
		if base != "" {
			desc += "\n" + base + "/p/" + e.pageID
		}
		icsWrite(&b, "DESCRIPTION:"+icsEscape(desc))
		if base != "" {
			icsWrite(&b, "URL:"+base+"/p/"+e.pageID)
		}
		icsWrite(&b, "END:VEVENT")
	}
	icsWrite(&b, "END:VCALENDAR")

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="salt.ics"`)
	w.Header().Set("Cache-Control", "private, max-age=300")
	fmt.Fprint(w, b.String())
}
