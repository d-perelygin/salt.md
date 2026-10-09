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

func (s *Server) icsToken(userID string) string {
	tok := s.setting("ics_token_"+userID, "")
	if tok == "" {
		b := make([]byte, 18)
		rand.Read(b)
		tok = hex.EncodeToString(b)
		s.setSetting("ics_token_"+userID, tok)
	}
	return tok
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
	}
	scopes := []scope{{ID: "", Kind: "all", Name: "", Links: feed("")}}

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
					scopes = append(scopes, scope{ID: id, Kind: "workspace", Name: nm, Links: feed("?workspace=" + id)})
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
				scopes = append(scopes, scope{ID: c.id, Kind: "collection", Name: title, Links: feed("?collection=" + url.QueryEscape(c.id))})
				for _, v := range icsViewList(c.views) {
					scopes = append(scopes, scope{
						ID: c.id, ViewID: v.id, Kind: "view", Name: title + " / " + v.name,
						Links: feed("?collection=" + url.QueryEscape(c.id) + "&view=" + url.QueryEscape(v.id)),
					})
				}
			}
		}
	}

	writeJSON(w, map[string]any{
		// The unscoped pair stays at the top level: older clients read exactly
		// these two fields.
		"url":    base + "/ics/" + tok + ".ics",
		"webcal": "webcal://" + host + "/ics/" + tok + ".ics",
		"scopes": scopes,
	})
}

func icsEscape(s string) string {
	r := strings.NewReplacer("\\", "\\\\", ";", "\\;", ",", "\\,", "\n", "\\n", "\r", "")
	return r.Replace(s)
}

// icsDate formats a stored date value as an all-day (VALUE=DATE) or timed field.
// Accepts "2026-07-18" and "2026-07-18T14:30".
func icsDate(prop, v string) string {
	if len(v) >= 10 && v[4] == '-' && v[7] == '-' {
		day := strings.ReplaceAll(v[:10], "-", "")
		if len(v) >= 16 && v[10] == 'T' {
			hm := strings.ReplaceAll(v[11:16], ":", "")
			return prop + ":" + day + "T" + hm + "00"
		}
		return prop + ";VALUE=DATE:" + day
	}
	return ""
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

func (s *Server) handleICSFeed(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSuffix(r.PathValue("token"), ".ics")
	// Reverse-lookup the owning user (small instance; linear scan of the few
	// ics_token_* settings rows).
	var userID string
	rows, err := s.db.Query(`SELECT key FROM app_settings WHERE key LIKE 'ics_token_%' AND value = ?`, token)
	if err == nil {
		if rows.Next() {
			var key string
			rows.Scan(&key)
			userID = strings.TrimPrefix(key, "ics_token_")
		}
		rows.Close()
	}
	if userID == "" {
		httpError(w, 404, "not found")
		return
	}

	ws := s.visibleWorkspaces(userID)
	// Scope. A workspace the subscriber is not a member of simply drops out of
	// `ws` below, so a guessed id cannot widen the feed.
	scopeWS := r.URL.Query().Get("workspace")
	scopeCol := r.URL.Query().Get("collection")
	scopeView := r.URL.Query().Get("view")
	if scopeWS != "" {
		only := ws[:0]
		for _, w := range ws {
			if w == scopeWS {
				only = append(only, w)
			}
		}
		ws = only
	}

	// A view scope resolves to one saved view: its name (for the calendar
	// name and the event description), its single date property when it still
	// names a date-typed one, and its filters. An unknown view yields an empty
	// calendar rather than an error, same as an unreadable collection.
	viewScoped := scopeCol != "" && scopeView != ""
	var viewName, viewDateProp string
	var viewFilters []rowFilter
	viewFound := false
	if viewScoped {
		viewName, viewDateProp, _, viewFilters, viewFound = s.icsViewDetail(scopeCol, scopeView)
	}

	var b strings.Builder
	name := "salt.md"
	if scopeCol != "" {
		// The calendar's NAME is what the subscriber sees in their app, so it
		// says which collection or workspace this feed is — three feeds called
		// "salt.md" would be indistinguishable there.
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
	b.WriteString("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//salt.md//Calendar//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:" + icsEscape(name) + "\r\n")

	// The feed user for filtered (view) queries: the same permission model as
	// the row list, so a view feed shows exactly what its view shows.
	feedUser := s.userByID(userID)

	if len(ws) > 0 {
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
		// Every collection in scope + its date-typed props.
		crows, err := s.db.Query(q, wargs...)
		if err == nil {
			type coll struct{ id, schema, title, ws string }
			var colls []coll
			for crows.Next() {
				var c coll
				if crows.Scan(&c.id, &c.schema, &c.title, &c.ws) == nil {
					colls = append(colls, c)
				}
			}
			crows.Close() // drain before per-collection row queries (single conn)

			// Drop collections in private or restricted subtrees the subscriber
			// can't read — membership alone is not enough (same rule
			// handleListPages applies).
			readable := colls[:0]
			for _, c := range colls {
				if s.canRead(userID, c.id) {
					readable = append(readable, c)
				}
			}
			colls = readable

			stamp := time.Now().UTC().Format("20060102T150405Z")
			for _, c := range colls {
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
				single := false // one date property: no "(Due)" suffix needed
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
							single = true
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
					rrows, err := s.db.Query(`SELECT id, title, props FROM pages WHERE parent_id = ? AND trashed_at IS NULL`, c.id)
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
				for _, rw := range rowsData {
					for pid, pname := range dateProps {
						v, _ := rw.pm[pid].(string)
						dt := icsDate("DTSTART", v)
						if dt == "" {
							continue
						}
						title := rw.title
						if title == "" {
							title = "Untitled"
						}
						b.WriteString("BEGIN:VEVENT\r\n")
						b.WriteString("UID:" + rw.id + "-" + pid + "@salt.md\r\n")
						b.WriteString("DTSTAMP:" + stamp + "\r\n")
						b.WriteString(dt + "\r\n")
						if single {
							b.WriteString("SUMMARY:" + icsEscape(title) + "\r\n")
						} else {
							b.WriteString("SUMMARY:" + icsEscape(title) + " (" + icsEscape(pname) + ")\r\n")
						}
						b.WriteString("DESCRIPTION:" + icsEscape(desc) + "\r\n")
						b.WriteString("END:VEVENT\r\n")
					}
				}
			}
		}
	}
	b.WriteString("END:VCALENDAR\r\n")

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="salt.ics"`)
	fmt.Fprint(w, b.String())
}
