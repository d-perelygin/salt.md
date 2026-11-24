package server

import "encoding/json"

// Editing a lookup where it is read.
//
// A lookup is a value carried across a relation: the contact of a sponsor's
// company, the status of a reel's client. It is computed, so the interface has
// always shown it read-only — even though the value itself lives in a perfectly
// ordinary field of another row, one keystroke away.
//
// A lookup cell is edited where it is read, but never blindly:
//
//   - ONE record behind the value: the cell edits it in place, next to a button
//     that opens that record;
//   - SEVERAL records: the cell opens a small list, one block per record — its
//     title, a button to open it, and the field to change. Each write lands in
//     its own record, so a join never has to be edited as a string;
//   - nothing shown and several records could hold the value: the same list,
//     with the fields empty.
//
// What the interface gets is the list of records the value comes from and may
// be written to. It never gets a record the caller cannot write, because a
// lookup must not become a way around permission, and it never gets one whose
// field has no editor or whose move a workflow governs:
//
//   - text, number, url, date, checkbox, select, multi-select, person;
//   - not a checklist (the cell reads "2/5"), a relation, or a computed field;
//   - not a record in the trash (it is not read either);
//   - not the workflow status of the target collection: a status moves through
//     a dialog that collects the fields the move requires, and a cell in
//     another database would slip past it.

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

// lookupMaxSources caps the list behind one cell. A lookup over fifty rows is a
// report, not a field: the cell shows the values, and editing stops naming them
// at a number a person can still read.
const lookupMaxSources = 20

// lookupSource is one record behind a lookup cell: which record, what it is
// called, and the raw value its field holds (a select stores an id, a date a
// day — the cell shows rendered text that cannot be parsed back reliably).
type lookupSource struct {
	Page  string `json:"page"`
	Title string `json:"title"`
	Value any    `json:"value"`
}

// lookupCell computes a lookup's text and, when it can be edited where it is
// read, the records behind it. The second return is nil when there is nothing
// to offer, and the cell stays as read-only as it always was.
func (s *Server) lookupCell(u *user, ru propDef, collectionID string, target propDef, ok bool, related []relatedRow, names map[string]string) (string, map[string]any) {
	if !ok {
		return "", nil
	}
	vals := make([]string, 0, len(related))
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
		vals = append(vals, got...)
	}
	text := mergeLookup(ru.RollupAgg, vals)

	if !editableLookupTargets[target.Type] {
		return text, nil
	}
	// A status with rules behind it moves through a dialog. Writing it from
	// here would skip the answers that dialog collects, so a lookup never
	// offers one — the same move is one click away in its own table.
	if s.isWorkflowStatus(collectionID, ru.RollupTarget) {
		return text, nil
	}

	// The records the cell edits: the ones that put a value there, or — when
	// nothing is shown — every record that could hold it. "First value" shows
	// one record's value, so it edits that record and not the others behind
	// the cell.
	behind := contributors
	if ru.RollupAgg == "first" && len(behind) > 1 {
		behind = behind[:1]
	}
	if len(behind) == 0 {
		behind = candidates
	}
	sources := make([]lookupSource, 0, len(behind))
	for _, r := range behind {
		if !s.canWrite(u.ID, r.id) || !s.credentialMayEnter(u, s.pageWorkspace(r.id)) {
			continue
		}
		sources = append(sources, lookupSource{Page: r.id, Title: r.title, Value: r.props[ru.RollupTarget]})
		if len(sources) == lookupMaxSources {
			break
		}
	}
	if len(sources) == 0 {
		return text, nil
	}
	return text, map[string]any{
		"prop":       ru.RollupTarget,
		"collection": collectionID,
		"type":       target.Type,
		"sources":    sources,
	}
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
