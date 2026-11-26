package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Relations are stored as row ids in a JSON array on the row that points. So
// deleting the row that is pointed AT is not a write on that row at all: the
// ids live in other rows, possibly in other collections and other workspaces.
//
// Trash is the reversible case, and it stays reversible: the ids are left
// alone, the chip reads the row's title with an "in the trash" mark, and
// restoring the row brings the link back by itself. Rewriting other rows here
// would make restoring a lie.
//
// Permanent deletion is the irreversible case. The id can never name anything
// again, no picker will ever list it, and a chip could not even be removed by
// hand. So the delete counts the links first — the interface says how many
// before it asks — and clears them in the same transaction as the delete.

// relationRef is one stored link found in another row: which row holds it,
// which of its properties, and how many of the ids being deleted it names.
type relationRef struct {
	PageID string
	Title  string
	PropID string
	Links  int

	// props is the row's stored property JSON as it was read, so the cleanup
	// can rewrite it without a second read (and without racing a write).
	props string
}

// relationRefsTo finds every relation value, in every live collection, that
// names one of ids. The SQL LIKE is only a filter to keep the scan small — ids
// are 32 random hex characters, so a false positive is a row that happens to
// hold the same text, and the JSON pass below is what actually decides.
func (s *Server) relationRefsTo(q querier, ids []string) ([]relationRef, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id != "" {
			want[id] = true
		}
	}
	if len(want) == 0 {
		return nil, nil
	}

	// Which collections have relations at all, and through which properties.
	type collection struct {
		id     string
		schema []propDef
	}
	var cols []collection
	rows, err := q.Query(`SELECT c.page_id, c.schema FROM collections c
		JOIN pages p ON p.id = c.page_id WHERE p.trashed_at IS NULL`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, schema string
		if rows.Scan(&id, &schema) == nil {
			cols = append(cols, collection{id: id, schema: parseSchema(schema)})
		}
	}
	rows.Close()

	var out []relationRef
	for _, c := range cols {
		var relProps []string
		for _, d := range c.schema {
			if d.Type == "relation" {
				relProps = append(relProps, d.ID)
			}
		}
		if len(relProps) == 0 {
			continue
		}

		// Candidate rows: children of this collection whose properties mention
		// one of the ids. Chunked, because a subtree can hold many ids and one
		// SQL statement has a limit on variables.
		seen := map[string]bool{}
		chunk := make([]string, 0, 8)
		flush := func() error {
			if len(chunk) == 0 {
				return nil
			}
			args := []any{c.id}
			likes := make([]string, 0, len(chunk))
			for _, id := range chunk {
				likes = append(likes, "props LIKE ?")
				args = append(args, "%\""+id+"\"%")
			}
			q2 := `SELECT id, title, props FROM pages
				WHERE parent_id = ? AND trashed_at IS NULL AND (` + strings.Join(likes, " OR ") + `)`
			cand, err := q.Query(q2, args...)
			if err != nil {
				return err
			}
			defer cand.Close()
			for cand.Next() {
				var pageID, title, props string
				if cand.Scan(&pageID, &title, &props) != nil || seen[pageID] {
					continue
				}
				seen[pageID] = true
				var pm map[string]any
				if json.Unmarshal([]byte(props), &pm) != nil || pm == nil {
					continue
				}
				for _, pid := range relProps {
					n := 0
					for _, target := range relationIDs(pm[pid]) {
						if want[target] {
							n++
						}
					}
					if n > 0 {
						out = append(out, relationRef{PageID: pageID, Title: title, PropID: pid, Links: n, props: props})
					}
				}
			}
			chunk = chunk[:0]
			return nil
		}
		for id := range want {
			chunk = append(chunk, id)
			if len(chunk) == 8 {
				if err := flush(); err != nil {
					return out, err
				}
			}
		}
		if err := flush(); err != nil {
			return out, err
		}
	}
	return out, nil
}

// countRelationRefs answers the question the confirmation asks: how many links,
// and across how many rows. Links stored on rows that are themselves going away
// do not count — nobody loses anything there.
func countRelationRefs(refs []relationRef, going map[string]bool) (links, rows int) {
	seen := map[string]bool{}
	for _, r := range refs {
		if going[r.PageID] {
			continue
		}
		links += r.Links
		if !seen[r.PageID] {
			seen[r.PageID] = true
			rows++
		}
	}
	return links, rows
}

// clearRelationRefs removes ids from the stored relations that point at them,
// in the same transaction as the delete. It returns the number of links removed
// and the rows it rewrote (for the audit trail and the live update).
//
// Only relation properties are touched. A multi-select value could in principle
// hold the same text, and silently editing somebody's tags because an id
// collided would be much worse than a link left behind.
func clearRelationRefs(q querier, refs []relationRef, ids map[string]bool) (links int, rows int, changed []string, err error) {
	byPage := map[string][]string{}
	for _, r := range refs {
		if ids[r.PageID] {
			continue
		}
		byPage[r.PageID] = append(byPage[r.PageID], r.PropID)
	}
	for pageID, propIDs := range byPage {
		var raw string
		// Re-read inside the transaction: the scan above only proves the link
		// WAS there, and the row may have changed in between.
		if err := q.QueryRow(`SELECT COALESCE(props, '{}') FROM pages WHERE id = ? AND trashed_at IS NULL`, pageID).Scan(&raw); err != nil {
			continue
		}
		props := map[string]any{}
		if json.Unmarshal([]byte(raw), &props) != nil || props == nil {
			continue
		}
		touched := false
		for _, pid := range propIDs {
			list := relationIDs(props[pid])
			if len(list) == 0 {
				continue
			}
			kept := make([]any, 0, len(list))
			removed := false
			for _, target := range list {
				if ids[target] {
					links++
					removed = true
					continue
				}
				kept = append(kept, target)
			}
			if !removed {
				continue
			}
			touched = true
			if len(kept) == 0 {
				delete(props, pid)
			} else {
				props[pid] = kept
			}
		}
		if !touched {
			continue
		}
		body, merr := json.Marshal(props)
		if merr != nil {
			continue
		}
		if _, uerr := q.Exec(`UPDATE pages SET props = ?, updated_at = ? WHERE id = ?`, string(body), now(), pageID); uerr != nil {
			continue
		}
		rows++
		changed = append(changed, pageID)
	}
	return links, rows, changed, nil
}

// relationRefCount is the read the interface does before asking "delete
// forever": what will lose a link, in numbers it can say out loud.
func (s *Server) relationRefCount(pageID string) (links, rows int, err error) {
	ids, err := subtreeIDs(s.db, pageID)
	if err != nil {
		return 0, 0, err
	}
	going := make(map[string]bool, len(ids))
	for _, id := range ids {
		going[id] = true
	}
	refs, err := s.relationRefsTo(s.db, ids)
	if err != nil {
		return 0, 0, err
	}
	links, rows = countRelationRefs(refs, going)
	return links, rows, nil
}

// handlePageReferences reports the links a permanent delete would clear. The
// dialog needs it before the delete, and the same question is worth asking
// separately when somebody wonders what still points at a row.
func (s *Server) handlePageReferences(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canReadReq(r, id) {
		httpError(w, 404, "page not found")
		return
	}
	links, rows, err := s.relationRefCount(id)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]any{"links": links, "rows": rows})
}

// purgeSubtree clears the links pointing into ids and deletes the pages. It is
// the permanent half of both callers: the interface's "delete forever" and the
// retention sweep. Shared so there is one place that knows a link outlives a
// row only as long as the row can come back.
func (s *Server) purgeSubtree(q querier, ids []string) (links, rows int, changed []string, err error) {
	going := make(map[string]bool, len(ids))
	for _, id := range ids {
		going[id] = true
	}
	refs, err := s.relationRefsTo(q, ids)
	if err != nil {
		return 0, 0, nil, err
	}
	links, rows, changed, err = clearRelationRefs(q, refs, going)
	return links, rows, changed, err
}

// purgeTrashed runs the retention sweep: every trashed page older than the
// cutoff goes for good, and with it every link into it. Its subtree goes too
// (the cascade), so the links into the children are cleared as well.
func (s *Server) purgeTrashed(roots []string) {
	if len(roots) == 0 {
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	var ids []string
	for _, root := range roots {
		sub, err := subtreeIDs(tx, root)
		if err != nil {
			continue
		}
		ids = append(ids, sub...)
	}
	if len(ids) == 0 {
		return
	}
	links, rows, changed, err := s.purgeSubtree(tx, ids)
	if err != nil {
		return
	}
	args := make([]any, len(roots))
	for i, id := range roots {
		args[i] = id
	}
	// The search index is virtual tables with no foreign keys, so the cascade
	// that removes the pages does not reach it. Their rows used to outlive the
	// pages for good: invisible to search (every hit joins pages) but growing
	// with each sweep.
	idArgs := make([]any, len(ids))
	for i, id := range ids {
		idArgs[i] = id
	}
	if _, err := tx.Exec(`DELETE FROM pages_fts WHERE id IN (`+placeholders(len(ids))+`)`, idArgs...); err != nil {
		return
	}
	if _, err := tx.Exec(`DELETE FROM chunks_fts WHERE chunk_id IN
		(SELECT id FROM page_chunks WHERE page_id IN (`+placeholders(len(ids))+`))`, idArgs...); err != nil {
		return
	}
	if _, err := tx.Exec(`DELETE FROM page_chunks WHERE page_id IN (`+placeholders(len(ids))+`)`, idArgs...); err != nil {
		return
	}
	if _, err := tx.Exec(`DELETE FROM pages WHERE id IN (`+placeholders(len(roots))+`)`, args...); err != nil {
		return
	}
	if err := tx.Commit(); err != nil {
		return
	}
	for _, pageID := range changed {
		s.rowChanged(pageID)
	}
	if links > 0 {
		s.audit("system", "", "Retention", "relation_cleanup", "", "",
			fmt.Sprintf("cleared %d relation link(s) in %d row(s) while purging %d trashed page(s)", links, rows, len(roots)))
	}
}

// handleResolvePages answers "what are these ids?" for a relation cell whose
// picker list does not hold them. The list is the live rows of the target
// collection — first 500, and none from the trash — so an id outside it used to
// be printed raw. Here it gets a title, and whether it is in the trash: a link
// to a trashed row is still a link, but the cell says so instead of showing a
// hex string nobody can act on.
//
// Only rows the caller may read come back. An id that is gone (permanently
// deleted, or never existed) is simply absent, which is the honest answer and
// keeps the endpoint from being a way to probe for page ids.
func (s *Server) handleResolvePages(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		httpError(w, 400, "invalid body")
		return
	}
	if len(body.IDs) > 200 {
		body.IDs = body.IDs[:200]
	}
	out := []map[string]any{}
	seen := map[string]bool{}
	for _, id := range body.IDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if !s.canReadReq(r, id) {
			continue
		}
		var title, icon string
		var trashed sql.NullString
		if err := s.db.QueryRow(`SELECT title, icon, trashed_at FROM pages WHERE id = ?`, id).
			Scan(&title, &icon, &trashed); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "title": title, "icon": icon, "trashed": trashed.Valid,
		})
	}
	writeJSON(w, map[string]any{"pages": out})
}
