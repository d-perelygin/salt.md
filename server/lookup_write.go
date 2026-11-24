package server

import "encoding/json"

// Editing a lookup where it is read.
//
// A lookup is a value carried across a relation: the contact of a sponsor's
// company, the status of a reel's client. It is computed, so the interface has
// always shown it read-only — even though the value itself lives in a perfectly
// ordinary field of another row, one keystroke away.
//
// The rule here is the smallest one that stays honest at any cardinality: a
// lookup may be edited where it is read when the shown value belongs to exactly
// ONE record. The edit then lands in that record — the same field, the same
// history, the same page.updated, no copy and no second truth.
//
//   - one related row put a value in the cell (however many rows are linked):
//     that row is the source;
//   - nothing is shown and exactly one related row could hold it: that row is
//     the source, because filling the gap has one place to go;
//   - nothing is shown and several rows could hold it: the cell offers them by
//     name ("Fill from …"), because a text box cannot answer "which one".
//   - several rows put values in the cell: read-only. Editing a join of two
//     records has no single target; the cell names each value instead.
//
// Everything below that is not a matter of taste:
//   - a type that has an editor: text, number, url, date, checkbox, select,
//     multi-select, person. A checklist lookup reads "2/5", a relation lookup
//     reads ids, and a derived property cannot be written at all;
//   - write permission on the source record, and the workspace boundary of a
//     narrowed token — a lookup must not become a way around either;
//   - a trashed source is not offered (it is not read either);
//   - the workflow status property of a collection is not offered: editing a
//     status from another table would slip past the dialog that asks for the
//     fields a move requires.

// editableLookupTargets are the property types a lookup may write through: the
// ones the interface knows how to edit in place.
var editableLookupTargets = map[string]bool{
	"text":        true,
	"number":      true,
	"url":         true,
	"date":        true,
	"checkbox":    true,
	"select":      true,
	"multiselect": true,
	"person":      true,
}

// lookupCellValue is one visible value of a lookup and the row it came from.
// The cell renders each of them as its own chip, because the joined string —
// "Иван, +7…, Мария, +7…" — reads as two people who are really four.
type lookupCellValue struct {
	Text  string `json:"text"`
	Page  string `json:"page"`
	Title string `json:"title"`
}

// lookupCell computes a lookup's text and everything the interface needs to
// show it as records rather than a string, and to edit it where that is honest.
// The second return is nil when there is nothing to say beyond the text.
func (s *Server) lookupCell(u *user, ru propDef, collectionID string, target propDef, ok bool, related []relatedRow, names map[string]string) (string, map[string]any) {
	if !ok {
		return "", nil
	}
	vals := make([]string, 0, len(related))
	shown := make([]lookupCellValue, 0, len(related))
	var contributors, candidates []relatedRow
	for _, tr := range related {
		if !matchesRollupWhere(ru, tr.props) {
			continue
		}
		candidates = append(candidates, tr)
		got := s.lookupValues(target, tr.props, names)
		if len(got) == 0 {
			continue
		}
		contributors = append(contributors, tr)
		for _, v := range got {
			vals = append(vals, v)
			shown = append(shown, lookupCellValue{Text: v, Page: tr.id, Title: tr.title})
		}
	}
	text := mergeLookup(ru.RollupAgg, vals)

	// The chips say what the string says: "first" shows one value, "unique"
	// collapses repeats, and both are capped where mergeLookup caps them.
	switch ru.RollupAgg {
	case "first":
		if len(shown) > 1 {
			shown = shown[:1]
		}
	case "unique":
		seen := make(map[string]bool, len(shown))
		uniq := shown[:0]
		for _, v := range shown {
			if seen[v.Text] {
				continue
			}
			seen[v.Text] = true
			uniq = append(uniq, v)
		}
		shown = uniq
	}
	if len(shown) > lookupMaxValues {
		shown = shown[:lookupMaxValues]
	}

	cell := map[string]any{}
	if len(shown) > 0 {
		cell["values"] = shown
	}
	s.describeLookupWrite(u, cell, ru, collectionID, target, contributors, candidates)
	if len(cell) == 0 {
		return text, nil
	}
	return text, cell
}

// describeLookupWrite fills the write half of a lookup cell: which record owns
// the shown value, which property there holds it, and its raw value (a select
// stores an id, a date a day — the cell shows rendered text that cannot be
// parsed back reliably). It writes nothing and never fails: a lookup that
// cannot be offered simply has no write half, and stays read-only.
func (s *Server) describeLookupWrite(u *user, cell map[string]any, ru propDef, collectionID string, target propDef, contributors, candidates []relatedRow) {
	if !editableLookupTargets[target.Type] {
		return
	}
	// A status with rules behind it moves through a dialog. Writing it from
	// here would skip the answers that dialog collects, so a lookup never
	// offers one — the same move is one click away in its own table.
	if s.isWorkflowStatus(collectionID, ru.RollupTarget) {
		return
	}

	// The address of the value travels outside the write half: the fill menu
	// needs it before there is a record to write to.
	cell["prop"] = ru.RollupTarget
	cell["collection"] = collectionID
	cell["type"] = target.Type
	write := map[string]any{}
	writable := func(r relatedRow) bool {
		return s.canWrite(u.ID, r.id) && s.credentialMayEnter(u, s.pageWorkspace(r.id))
	}

	switch {
	case len(contributors) == 1:
		src := contributors[0]
		if !writable(src) {
			return
		}
		write["page"] = src.id
		write["title"] = src.title
		write["value"] = src.props[ru.RollupTarget]
	case len(contributors) == 0 && len(candidates) == 1:
		src := candidates[0]
		if !writable(src) {
			return
		}
		write["page"] = src.id
		write["title"] = src.title
		write["value"] = src.props[ru.RollupTarget]
	case len(contributors) == 0 && len(candidates) > 1:
		// Nothing shown, several records could hold the value. Name them, and
		// let the person pick before typing: a text box must not guess.
		list := make([]map[string]any, 0, len(candidates))
		for _, c := range candidates {
			if !writable(c) {
				continue
			}
			list = append(list, map[string]any{"page": c.id, "title": c.title})
			if len(list) == 20 {
				break
			}
		}
		if len(list) == 0 {
			return
		}
		cell["candidates"] = list
		return
	default:
		// Several rows contributed: the cell is a join, not a field.
		return
	}
	cell["write"] = write
}

// isWorkflowStatus reports whether propID is the status property a workflow on
// this collection drives. A query only for a lookup that reaches a collection
// that has a workflow at all.
func (s *Server) isWorkflowStatus(collectionID, propID string) bool {
	if collectionID == "" || propID == "" {
		return false
	}
	var wf string
	if s.db.QueryRow(`SELECT COALESCE(workflow, '') FROM collections WHERE page_id = ?`, collectionID).Scan(&wf) != nil {
		return false
	}
	if wf == "" || wf == "{}" || wf == "null" {
		return false
	}
	var cfg struct {
		StatusPropID string `json:"statusPropId"`
	}
	if json.Unmarshal([]byte(wf), &cfg) != nil {
		return false
	}
	return cfg.StatusPropID == propID
}
