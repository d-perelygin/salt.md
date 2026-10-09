package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// Public collection sharing: read-only JSON for anonymous readers of
// /public/{token} when the shared page is a collection.
//
// Three endpoints (all unauthenticated, token IS the credential):
//
//	GET /api/public/c/{token}            — title/icon/cover/schema + visible views
//	GET /api/public/c/{token}/rows       — rows for one view (viewId, limit, offset)
//	GET /api/public/c/{token}/row/{rowId} — single row detail (only with allow_detail)
//
// Password-protected links send the password in X-Share-Password (same as
// handlePublicPage). Views travelling in share_links.options narrow what the
// reader sees: allowed_views (empty = all) and allow_detail.
//
// Sharing a collection shares the display names (title/icon) of directly
// linked rows: relation chips and relation-grouped board columns need them,
// and an anonymous reader cannot resolve them itself. Titles only — never
// content — and only for genuine relation properties.

func publicPassword(r *http.Request) string {
	if pw := r.Header.Get("X-Share-Password"); pw != "" {
		return pw
	}
	return r.URL.Query().Get("pw")
}

// resolveCollectionShare validates the token and returns the collection page
// plus its share options. needPW reports a password is required but missing/wrong.
func (s *Server) resolveCollectionShare(token, password string) (colID string, opts shareOptions, needPW bool, found bool) {
	pageID, need, ok, found := s.resolveShare(token, password)
	if !found {
		return "", shareOptions{}, false, false
	}
	if need && !ok {
		return "", shareOptions{}, true, true
	}
	var raw sql.NullString
	if err := s.db.QueryRow(`SELECT options FROM share_links WHERE page_id = ? AND mode != 'form'`, pageID).Scan(&raw); err == nil && raw.Valid {
		opts = decodeShareOptions(raw.String)
	}
	return pageID, opts, false, true
}

func (s *Server) handlePublicCollection(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	colID, opts, needPW, found := s.resolveCollectionShare(token, publicPassword(r))
	if !found {
		httpError(w, 404, "not found")
		return
	}
	if needPW {
		httpError(w, 403, "password required")
		return
	}
	p, err := s.getPage(colID)
	if err != nil || p.Trashed {
		httpError(w, 404, "not found")
		return
	}
	if p.Type != "collection" {
		httpError(w, 404, "not a collection")
		return
	}
	var schemaJSON, viewsJSON string
	if err := s.db.QueryRow(`SELECT schema, views FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON, &viewsJSON); err != nil {
		httpError(w, 404, "not a collection")
		return
	}
	var views []map[string]any
	if json.Unmarshal([]byte(viewsJSON), &views) != nil {
		views = []map[string]any{}
	}
	if len(opts.AllowedViews) > 0 {
		allow := map[string]bool{}
		for _, id := range opts.AllowedViews {
			allow[id] = true
		}
		kept := []map[string]any{}
		for _, v := range views {
			if id, _ := v["id"].(string); allow[id] {
				kept = append(kept, v)
			}
		}
		views = kept
	}
	// A form-only view lets anyone ADD rows — never expose it publicly.
	visible := []map[string]any{}
	for _, v := range views {
		if t, _ := v["type"].(string); t != "form" {
			visible = append(visible, v)
		}
	}
	var schema any
	if json.Unmarshal([]byte(schemaJSON), &schema) != nil {
		schema = []any{}
	}
	writeJSON(w, map[string]any{
		"title":       p.Title,
		"icon":        p.Icon,
		"cover":       p.Cover,
		"description": p.Description,
		"type":        p.Type,
		"schema":      schema,
		"views":       visible,
		"allowDetail": opts.AllowDetail,
		"needPassword": false,
	})
}

// publicCollectionView loads the stored views and returns the one the reader
// asked for (or the first visible one). The second return is false when the
// requested view is not shared.
func (s *Server) publicCollectionView(colID string, opts shareOptions, viewID string) (map[string]any, bool) {
	var viewsJSON string
	if err := s.db.QueryRow(`SELECT views FROM collections WHERE page_id = ?`, colID).Scan(&viewsJSON); err != nil {
		return nil, false
	}
	var views []map[string]any
	if json.Unmarshal([]byte(viewsJSON), &views) != nil {
		return nil, false
	}
	allow := map[string]bool{}
	for _, id := range opts.AllowedViews {
		allow[id] = true
	}
	visible := []map[string]any{}
	for _, v := range views {
		id, _ := v["id"].(string)
		t, _ := v["type"].(string)
		if t == "form" {
			continue
		}
		if len(allow) > 0 && !allow[id] {
			continue
		}
		visible = append(visible, v)
	}
	if len(visible) == 0 {
		return nil, false
	}
	if viewID == "" {
		return visible[0], true
	}
	for _, v := range visible {
		if id, _ := v["id"].(string); id == viewID {
			return v, true
		}
	}
	return nil, false
}

func (s *Server) handlePublicCollectionRows(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	colID, opts, needPW, found := s.resolveCollectionShare(token, publicPassword(r))
	if !found {
		httpError(w, 404, "not found")
		return
	}
	if needPW {
		httpError(w, 403, "password required")
		return
	}
	q := r.URL.Query()
	view, ok := s.publicCollectionView(colID, opts, q.Get("viewId"))
	if !ok {
		httpError(w, 404, "view not shared")
		return
	}
	limit := 100
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	offset := 0
	if v, err := strconv.Atoi(q.Get("offset")); err == nil && v >= 0 {
		offset = v
	}
	// The view's own filters/sort apply server-side — the reader sees what the
	// owner configured, and cannot change it.
	var groups [][]rowFilter
	if fraw, _ := json.Marshal(view["filters"]); len(fraw) > 2 {
		var conds []filterJSON
		if json.Unmarshal(fraw, &conds) == nil {
			g := []rowFilter{}
			for _, c := range conds {
				if c.Property == "" {
					continue
				}
				g = append(g, c.rowFilter())
			}
			if len(g) > 0 {
				groups = [][]rowFilter{g}
			}
		}
	}
	sortParam := ""
	if sraw, _ := json.Marshal(view["sort"]); len(sraw) > 2 {
		var so struct {
			Property string `json:"property"`
			Dir      string `json:"dir"`
		}
		if json.Unmarshal(sraw, &so) == nil && so.Property != "" && safePropID(so.Property) {
			d := "asc"
			if strings.EqualFold(so.Dir, "desc") {
				d = "desc"
			}
			sortParam = so.Property + ":" + d
		}
	}
	where := []string{"parent_id = ?", "trashed_at IS NULL", "(visibility IS NULL OR visibility != 'private')"}
	args := []any{colID}
	ors := []string{}
	for _, g := range groups {
		ands := []string{}
		for _, f := range g {
			cond, cargs := f.where()
			if cond == "" {
				continue
			}
			ands = append(ands, cond)
			args = append(args, cargs...)
		}
		if len(ands) > 0 {
			ors = append(ors, "("+strings.Join(ands, " AND ")+")")
		}
	}
	if len(ors) > 0 {
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	whereSQL := strings.Join(where, " AND ")
	orderSQL := "position, created_at"
	if sortParam != "" {
		propID, dir, _ := strings.Cut(sortParam, ":")
		if safePropID(propID) {
			d := "ASC"
			if strings.EqualFold(dir, "desc") {
				d = "DESC"
			}
			orderSQL = "json_extract(props, '$." + propID + "') " + d + ", position"
		}
	}
	// Relation properties whose ids are resolved to display names below. Loaded
	// here — before the rows cursor opens — because the pool holds a single
	// connection: any query issued while the cursor is open deadlocks.
	// Only genuine relation properties contribute ids: a select option, a text
	// value or anything else that happens to equal a page id must never pull
	// that page's title into the answer.
	relProps := []string{}
	{
		var schemaJSON string
		if err := s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON); err == nil {
			for _, d := range parseSchema(schemaJSON) {
				if d.Type == "relation" {
					relProps = append(relProps, d.ID)
				}
			}
		}
	}
	var total int
	s.db.QueryRow(`SELECT COUNT(*) FROM pages WHERE `+whereSQL, args...).Scan(&total)
	rows, err := s.db.Query(`SELECT id, title, icon, cover, position, props, tags FROM pages WHERE `+whereSQL+` ORDER BY `+orderSQL+` LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	relIDs := map[string]bool{}
	for rows.Next() {
		var id, title, icon, cover, props, tags string
		var position float64
		if rows.Scan(&id, &title, &icon, &cover, &position, &props, &tags) != nil {
			continue
		}
		var pm map[string]any
		if json.Unmarshal([]byte(props), &pm) != nil || pm == nil {
			pm = map[string]any{}
		}
		for _, pid := range relProps {
			switch t := pm[pid].(type) {
			case []any:
				for _, item := range t {
					if s, ok := item.(string); ok && s != "" {
						relIDs[s] = true
					}
				}
			case string:
				if t != "" {
					relIDs[t] = true
				}
			}
		}
		tagList := []string{}
		if tags != "" {
			json.Unmarshal([]byte(tags), &tagList)
		}
		list = append(list, map[string]any{
			"id": id, "title": title, "icon": icon, "cover": cover,
			"position": position, "props": pm, "tags": tagList,
		})
	}
	rows.Close() // drain first, then resolve (one DB connection — see handleGraph)
	if err := rows.Err(); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	// Resolve relation ids to titles (read-only display names). Titles only —
	// never content — and only for ids that actually exist. Linked-row names
	// are part of the share by design (see the header comment).
	related := map[string]map[string]string{}
	if len(relIDs) > 0 {
		ids := make([]string, 0, len(relIDs))
		for id := range relIDs {
			ids = append(ids, id)
		}
		for i := 0; i < len(ids); i += 100 {
			j := i + 100
			if j > len(ids) {
				j = len(ids)
			}
			chunk := ids[i:j]
			args := make([]any, len(chunk))
			for k, v := range chunk {
				args[k] = v
			}
			ph := strings.TrimSuffix(strings.Repeat("?, ", len(chunk)), ", ")
			rws, err := s.db.Query(`SELECT id, title, icon FROM pages WHERE id IN (`+ph+`) AND trashed_at IS NULL`, args...)
			if err != nil {
				continue
			}
			for rws.Next() {
				var id, title, icon string
				if rws.Scan(&id, &title, &icon) == nil {
					related[id] = map[string]string{"title": title, "icon": icon}
				}
			}
			rws.Close()
		}
	}
	writeJSON(w, map[string]any{"rows": list, "total": total, "offset": offset, "limit": limit, "related": related})
}

func (s *Server) handlePublicCollectionRow(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	rowID := r.PathValue("rowId")
	colID, opts, needPW, found := s.resolveCollectionShare(token, publicPassword(r))
	if !found {
		httpError(w, 404, "not found")
		return
	}
	if needPW {
		httpError(w, 403, "password required")
		return
	}
	if !opts.AllowDetail {
		httpError(w, 403, "row detail is not shared")
		return
	}
	var parentID, title, icon, cover, content, props, tags string
	var trashed sql.NullString
	err := s.db.QueryRow(`SELECT parent_id, title, icon, cover, content, props, tags, trashed_at FROM pages WHERE id = ?`, rowID).
		Scan(&parentID, &title, &icon, &cover, &content, &props, &tags, &trashed)
	if err != nil || parentID != colID || (trashed.Valid && trashed.String != "") {
		httpError(w, 404, "not found")
		return
	}
	var pm any
	if json.Unmarshal([]byte(props), &pm) != nil {
		pm = map[string]any{}
	}
	writeJSON(w, map[string]any{
		"id": rowID, "title": title, "icon": icon, "cover": cover,
		"content": content, "props": pm, "tags": tags,
	})
}
