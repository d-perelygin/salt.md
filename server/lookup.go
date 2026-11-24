package server

import (
	"fmt"
	"strconv"
	"strings"
)

// Lookups: the rollup functions that carry a VALUE across a relation instead of
// a number. A sum tells you what the linked rows are worth; a lookup tells you
// what they say — the status of a reel, the scale of a company, the client a
// deal belongs to.
//
// The alternative would be a second property type ("lookup") with its own
// config, its own validation and its own place in every picker. This is the
// same wiring a numeric rollup already has: Via relation, Of property, a
// condition, and one more choice under Calculate. Only what happens to the
// value differs, so it lives here rather than in the shape of the definition.
//
// Values are resolved to text on the SERVER, because the collection being read
// does not carry the target collection's schema: without it an option id
// cannot be turned into the option's name, and a column of "prop-2" strings is
// worse than no column at all.

const (
	// A lookup is a cell, not a document. An "all values" rollup over hundreds
	// of rows would otherwise put the whole table in one column.
	lookupMaxValues = 50
	lookupMaxLen    = 1000
)

// isLookupAgg reports whether a rollup function returns a value rather than a
// number.
func isLookupAgg(agg string) bool {
	switch agg {
	case "first", "all", "unique":
		return true
	}
	return false
}

// mergeLookup folds the values of the related rows into the cell. Empty values
// never participate: a row without a status must not blank out or displace the
// one that has it, which is what "the status of the linked reel" means.
func mergeLookup(agg string, vals []string) string {
	switch agg {
	case "first":
		if len(vals) == 0 {
			return ""
		}
		return vals[0]
	case "unique":
		seen := make(map[string]bool, len(vals))
		uniq := make([]string, 0, len(vals))
		for _, v := range vals {
			if seen[v] {
				continue
			}
			seen[v] = true
			uniq = append(uniq, v)
		}
		vals = uniq
	}
	if len(vals) > lookupMaxValues {
		vals = vals[:lookupMaxValues]
	}
	out := strings.Join(vals, ", ")
	if len(out) > lookupMaxLen {
		out = out[:lookupMaxLen] + "…"
	}
	return out
}

// lookupValues renders one property of a related row as the values it holds.
// A list rather than one string, because a multi-select is several values and
// "all values" has to be able to say each of them once: joining per row first
// turned ["еда","IT"] and ["еда"] into "еда, IT, еда", and no amount of
// deduplication afterwards could see through that.
//
// What counts as "the value" is per type: a select is the option's name rather
// than its id, a person is a name rather than a user id, and a checklist is its
// progress. An id the schema no longer knows is returned as stored rather than
// dropped — the row does hold something, and an unexplained blank is worse.
func (s *Server) lookupValues(def propDef, props map[string]any, names map[string]string) []string {
	v := props[def.ID]
	switch def.Type {
	case "select":
		if label := optionLabel(def, plainText(v)); label != "" {
			return []string{label}
		}
		return nil
	case "multiselect":
		var out []string
		for _, id := range stringList(v) {
			if label := optionLabel(def, id); label != "" {
				out = append(out, label)
			}
		}
		return out
	case "person":
		var out []string
		for _, id := range stringList(v) {
			if name := s.lookupUserName(id, names); name != "" {
				out = append(out, name)
			}
		}
		return out
	case "checkbox":
		if b, ok := v.(bool); ok && b {
			return []string{"✓"}
		}
		return nil
	case "checklist":
		done, total := checklistProgress(v)
		if total == 0 {
			return nil
		}
		return []string{strconv.Itoa(done) + "/" + strconv.Itoa(total)}
	case "number":
		if n, ok := toNumber(v); ok {
			return []string{strconv.FormatFloat(n, 'g', -1, 64)}
		}
		return nil
	}
	// date/text/url, and a type this build does not know (an older row, a newer
	// client): show what is stored rather than a silent empty.
	if text := plainText(v); text != "" {
		return []string{text}
	}
	return nil
}

// optionLabel turns a stored option id into the name the interface shows. An
// id no longer in the schema is returned as it is: the row does hold something,
// and hiding it would read as "no value".
func optionLabel(def propDef, id string) string {
	if id == "" {
		return ""
	}
	for _, o := range def.Options {
		if o.ID == id {
			return o.Name
		}
	}
	return id
}

// stringList reads a value that may be a list of ids or a single id. Person and
// multi-select properties store lists, but rows written before that (and by
// hand) hold a bare string.
func stringList(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	case string:
		if t != "" {
			return []string{t}
		}
	}
	return nil
}

// checklistProgress counts ticked items out of the total, which is what the
// checklist property itself shows.
func checklistProgress(v any) (done, total int) {
	list, _ := v.([]any)
	for _, x := range list {
		item, _ := x.(map[string]any)
		if item == nil {
			continue
		}
		total++
		if b, _ := item["done"].(bool); b {
			done++
		}
	}
	return done, total
}

// plainText renders a scalar for a cell. Numbers lose their Go formatting
// noise ("5e+06") and keep the decimal point when they have one.
func plainText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(t)
	case bool:
		if t {
			return "✓"
		}
		return ""
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(t), 'f', -1, 32)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	}
	// A shape nobody expected still shows something readable instead of
	// vanishing from the column.
	return strings.TrimSpace(fmt.Sprint(v))
}

// lookupUserName resolves a user id once per query. A person property stores
// ids; a lookup has to show names or it shows nothing worth reading.
func (s *Server) lookupUserName(id string, cache map[string]string) string {
	if id == "" {
		return ""
	}
	if name, ok := cache[id]; ok {
		return name
	}
	var name string
	if err := s.db.QueryRow(`SELECT name FROM users WHERE id = ?`, id).Scan(&name); err != nil {
		name = ""
	}
	cache[id] = name
	return name
}

// rollupTargetDefs loads the schema of the collection a rollup reaches, once
// per query, indexed by property id. An empty or unknown collection yields an
// empty map: a lookup whose relation points nowhere reads blank, which is the
// same answer a numeric rollup gives as 0.
func (s *Server) rollupTargetDefs(colID string, cache map[string]map[string]propDef) map[string]propDef {
	if colID == "" {
		return nil
	}
	if defs, ok := cache[colID]; ok {
		return defs
	}
	defs := map[string]propDef{}
	var raw string
	if s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, colID).Scan(&raw) == nil {
		for _, d := range parseSchema(raw) {
			defs[d.ID] = d
		}
	}
	cache[colID] = defs
	return defs
}
