package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Calendar subscription (Welle 22): a stable per-user token grants a read-only
// iCalendar feed of every date-typed property across the collections the user
// can read. Calendar apps (Apple/Google/Outlook) poll GET /ics/{token}.ics; no
// login, the token IS the credential (like a share link).
//
// W120: the feed takes a SCOPE — everything (as before), one workspace, or one
// collection. One token still, because the token is the identity: narrowing is
// a view on what that person may read, never a way to see more. Every scope
// therefore runs through the same two checks (visible workspaces, then no
// forbidden private ancestor); an id the subscriber cannot read yields an empty
// calendar rather than an error, so a collection that gets moved or made
// private does not leave a broken subscription in somebody's calendar app.
//
// A collection scope can narrow further to one SAVED VIEW
// (?collection=<id>&view=<viewID>): the feed then follows the view's filters
// and its date property, so "only what this view shows" is subscribable. A
// view that is gone or unreadable yields an empty calendar, same as above.
//
// Why in the URL and not one token per scope: a calendar app remembers a URL
// and nothing else. Rotating the token then has to invalidate every feed at
// once — which is exactly what people expect from "revoke my calendar links".
//
// Feed quality notes: every timed event carries a DTEND (one hour after the
// start — an event with a start and no end renders as an invisible dot in
// most calendar apps), every all-day event carries a DTEND of the next day,
// and every event carries a URL back to its page (base + "/p/<id>"). Lines
// are folded at 75 octets per RFC 5545. The calendar advertises
// REFRESH-INTERVAL/X-PUBLISHED-TTL of half an hour so clients re-poll
// promptly, and the feed covers the subscriber's history window (a personal
// choice, 90 days by default) plus everything upcoming, capped at
// icsMaxEvents — a whole-account feed over years of rows must stay light
// enough for a phone to sync.

// How often calendar apps are asked to re-poll the feed.
const icsRefreshInterval = "PT30M"

// How far back a feed reaches by default. Everything upcoming is always
// included. Each user may pick their own window (or none at all) —
// icsPastDaysOf reads that choice.
const icsDefaultPastDays = 90

// icsPastDaysOptions are the windows the dialog offers, in days; 0 means
// the whole history.
var icsPastDaysOptions = []int{30, 90, 365, 0}

// Upper bound on events in one feed response.
const icsMaxEvents = 5000

func (s *Server) icsToken(userID string) string {
	tok := s.setting("ics_token_"+userID, "")
	if tok == "" {
		tok = icsNewToken()
		s.setSetting("ics_token_"+userID, tok)
	}
	return tok
}

// icsNewToken mints one credential-grade feed token (like icsToken's, but
// standalone — each named subscription carries its own).
func icsNewToken() string {
	b := make([]byte, 18)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// icsFeedLinks builds the two subscription addresses for one token.
func icsFeedLinks(r *http.Request, s *Server, tok, query string) (url, webcal string) {
	base := s.publicShareBase(r)
	host := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	return base + "/ics/" + tok + ".ics" + query,
		"webcal://" + host + "/ics/" + tok + ".ics" + query
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
		ok := false
		for _, allowed := range icsPastDaysOptions {
			if *body.PastDays == allowed {
				ok = true
				break
			}
		}
		if !ok {
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
type icsFeed struct {
	id, kind, refID, viewID, name, token, created string
}

// icsScopeQuery renders the feed query string for a scope triple.
func icsScopeQuery(kind, refID, viewID string) string {
	switch kind {
	case "workspace":
		return "?workspace=" + refID
	case "collection":
		return "?collection=" + url.QueryEscape(refID)
	case "view":
		return "?collection=" + url.QueryEscape(refID) + "&view=" + url.QueryEscape(viewID)
	default:
		return ""
	}
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
		viewName, _, _, _, found := s.icsViewDetail(refID, viewID)
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
	events, _ := s.icsEventsFor(uid, wsOf(f.kind, f.refID), colOf(f.kind, f.refID), viewOf(f.kind, f.viewID))
	n, nt, nd := icsPreview(events)
	if len(nd) == 8 {
		nd = nd[0:4] + "-" + nd[4:6] + "-" + nd[6:8]
	}
	u, w := icsFeedLinks(r, s, f.token, icsScopeQuery(f.kind, f.refID, f.viewID))
	return map[string]any{
		"id": f.id, "kind": f.kind, "refId": f.refID, "viewId": f.viewID,
		"name": f.name, "url": u, "webcal": w, "createdAt": f.created,
		"count": n, "nextTitle": nt, "nextDay": nd,
	}
}

// handleICSFeedsCreate mints one named subscription: a link with its own
// token, scoped to exactly what the body names. Revoking it later touches
// nothing else.
func (s *Server) handleICSFeedsCreate(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	var body struct {
		Kind   string `json:"kind"`
		RefID  string `json:"refId"`
		ViewID string `json:"viewId"`
		Name   string `json:"name"`
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
	f := icsFeed{id: newID(), kind: body.Kind, refID: body.RefID, viewID: body.ViewID, name: name, token: icsNewToken(), created: now()}
	if _, err := s.db.Exec(`INSERT INTO ics_feeds (id, user_id, token, kind, ref_id, view_id, name, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, f.id, uid, f.token, f.kind, f.refID, f.viewID, f.name, f.created); err != nil {
		httpError(w, 500, "cannot create subscription")
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
	rows, err := s.db.Query(`SELECT id, kind, ref_id, view_id, name, token, created_at FROM ics_feeds WHERE user_id = ? ORDER BY created_at`, uid)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []icsFeed
	for rows.Next() {
		var f icsFeed
		if rows.Scan(&f.id, &f.kind, &f.refID, &f.viewID, &f.name, &f.token, &f.created) == nil {
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

// handleICSInfo returns the caller's subscription URL (rotating on request).
func (s *Server) handleICSInfo(w http.ResponseWriter, r *http.Request) {
	uid := requestUser(r).ID
	if r.URL.Query().Get("rotate") == "1" {
		s.setSetting("ics_token_"+uid, "")
	}
	tok := s.icsToken(uid)
	// External calendar apps subscribe to this URL — use the public base
	// (Domain/Tunnel) so the feed also works outside the LAN.
	base := s.publicShareBase(r)
	host := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	feed := func(query string) map[string]string {
		return map[string]string{
			"url":    base + "/ics/" + tok + ".ics" + query,
			"webcal": "webcal://" + host + "/ics/" + tok + ".ics" + query,
		}
	}

	// The scopes on offer: the whole account, each workspace, each
	// collection that actually HAS a date property, and each saved view of
	// those collections. A view feed follows the view's filters and its date
	// property; offering a calendar for a collection without dates would hand
	// out a permanently empty feed.
	type scope struct {
		ID     string            `json:"id"`
		ViewID string            `json:"viewId,omitempty"`
		Kind   string            `json:"kind"` // all | workspace | collection | view
		Name   string            `json:"name"`
		Links  map[string]string `json:"links"`
		// Preview for the subscription dialog: how many events this
		// scope currently holds and the nearest upcoming one.
		Count     int    `json:"count"`
		NextTitle string `json:"nextTitle,omitempty"`
		NextDay   string `json:"nextDay,omitempty"` // YYYY-MM-DD
	}
	newScope := func(kind, id, viewID, name, query string) scope {
		events, _ := s.icsEventsFor(uid, wsOf(kind, id), colOf(kind, id), viewOf(kind, viewID))
		n, nt, nd := icsPreview(events)
		if len(nd) == 8 {
			nd = nd[0:4] + "-" + nd[4:6] + "-" + nd[6:8]
		}
		return scope{ID: id, ViewID: viewID, Kind: kind, Name: name, Links: feed(query), Count: n, NextTitle: nt, NextDay: nd}
	}
	// Scope descriptors first: previews run their own queries, and the pool
	// is a single connection, so no cursor may be open when they run.
	type desc struct{ kind, id, viewID, name, query string }
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
					descs = append(descs, desc{"workspace", id, "", nm, "?workspace=" + id})
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
				descs = append(descs, desc{"collection", c.id, "", title, "?collection=" + url.QueryEscape(c.id)})
				for _, v := range icsViewList(c.views) {
					descs = append(descs, desc{
						"view", c.id, v.id, title + " / " + v.name,
						"?collection=" + url.QueryEscape(c.id) + "&view=" + url.QueryEscape(v.id),
					})
				}
			}
		}
	}

	scopes := []scope{newScope("all", "", "", "", "")}
	for _, d := range descs {
		scopes = append(scopes, newScope(d.kind, d.id, d.viewID, d.name, d.query))
	}

	feeds := make([]map[string]any, 0)
	for _, f := range s.icsListFeeds(uid) {
		feeds = append(feeds, s.icsFeedJSON(r, uid, f))
	}

	writeJSON(w, map[string]any{
		// The unscoped pair stays at the top level: older clients read exactly
		// these two fields.
		"url":    base + "/ics/" + tok + ".ics",
		"webcal": "webcal://" + host + "/ics/" + tok + ".ics",
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
	for _, allowed := range icsPastDaysOptions {
		if days == allowed {
			return days
		}
	}
	return icsDefaultPastDays
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
// date-typed prop — a stale view falls back to every date prop), and its
// filters as rowFilters for collectionRowsQuery. Not finding the view is not
// an error: the feed renders empty, same as an unreadable collection.
func (s *Server) icsViewDetail(colID, viewID string) (viewName, dateProp, datePropName string, filters []rowFilter, found bool) {
	var schemaJSON, viewsJSON string
	if err := s.db.QueryRow(`SELECT schema, views FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON, &viewsJSON); err != nil {
		return "", "", "", nil, false
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
		return "", "", "", nil, false
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
		if raw, ok := v["filters"].([]any); ok {
			filters = icsViewFilters(raw)
		}
		return name, dateProp, datePropName, filters, true
	}
	return "", "", "", nil, false
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
// view scope follows the view's filters and date property; an unknown view
// or an unreadable scope yields no events rather than an error.
func (s *Server) icsEventsFor(userID, scopeWS, scopeCol, scopeView string) ([]icsEvent, string) {
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
	var viewName, viewDateProp string
	var viewFilters []rowFilter
	viewFound := false
	if viewScoped {
		viewName, viewDateProp, _, viewFilters, viewFound = s.icsViewDetail(scopeCol, scopeView)
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
	cutoff := icsCutoffDay(s.icsPastDaysOf(userID))
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
		singlePID := ""
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
				}
			}
			if viewName != "" {
				desc = c.title + " / " + viewName
			}
			// The view's filters, through the same query the row list
			// uses — what the view shows is what the feed carries.
			// A flat filter list is one group (groups are ORed).
			for offset := 0; ; {
				list, total, err := s.collectionRowsQuery(feedUser, c.id, [][]rowFilter{viewFilters}, "", 500, offset)
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
	// A named subscription first: its token fixes the scope, so query
	// parameters cannot widen it — holding one link never grants more than
	// that link was made for.
	var userID, feedKind, feedRef, feedView string
	var f icsFeed
	if err := s.db.QueryRow(`SELECT user_id, kind, ref_id, view_id FROM ics_feeds WHERE token = ?`, token).
		Scan(&userID, &feedKind, &feedRef, &feedView); err == nil {
		f = icsFeed{kind: feedKind, refID: feedRef, viewID: feedView}
	} else {
		// Reverse-lookup the owning user (small instance; linear scan of the
		// few ics_token_* settings rows).
		rows, err := s.db.Query(`SELECT key FROM app_settings WHERE key LIKE 'ics_token_%' AND value = ?`, token)
		if err == nil {
			if rows.Next() {
				var key string
				rows.Scan(&key)
				userID = strings.TrimPrefix(key, "ics_token_")
			}
			rows.Close()
		}
	}
	if userID == "" {
		httpError(w, 404, "not found")
		return
	}

	scopeWS := r.URL.Query().Get("workspace")
	scopeCol := r.URL.Query().Get("collection")
	scopeView := r.URL.Query().Get("view")
	if f.kind != "" {
		// Named links are fixed-scope: the URL carries no query, and any
		// query a holder appends is ignored rather than honoured.
		scopeWS, scopeCol, scopeView = wsOf(f.kind, f.refID), colOf(f.kind, f.refID), viewOf(f.kind, f.viewID)
	}

	events, name := s.icsEventsFor(userID, scopeWS, scopeCol, scopeView)
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
		icsWrite(&b, "DESCRIPTION:"+icsEscape(e.desc))
		if base != "" {
			icsWrite(&b, "URL:"+base+"/p/"+e.pageID)
		}
		icsWrite(&b, "END:VEVENT")
	}
	icsWrite(&b, "END:VCALENDAR")

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="salt.ics"`)
	w.Header().Set("Cache-Control", "private, max-age=1800")
	fmt.Fprint(w, b.String())
}
