package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"time"
)

// A date property holds a calendar day. A relative word ("today", "today+7d")
// belongs to a filter or to the moment a rule fires, where being relative is
// the point: "after today-1M" must still mean a month back tomorrow.
//
// A row is different. The workflow's date field offers Exact/Relative as an
// input convenience, and through that path the word itself was written into the
// property. Nothing could show it: a date cell renders a calendar day, the
// calendar cannot place "today" on a day column, sorting put it after every
// real date, and it silently named a different day each morning. A person
// answering "today" means this day, once.
//
// So the write paths resolve the word here, and one migration repairs the rows
// written before they did.

// resolveDatePatch rewrites every date property in a patch whose value is a
// relative day. Everything else, including text that happens to read "today",
// is left alone: only a date property has a day to name.
func resolveDatePatch(schema []map[string]any, patch map[string]json.RawMessage, now time.Time) {
	dateIDs := map[string]bool{}
	for _, p := range schema {
		id, _ := p["id"].(string)
		if id == "" {
			continue
		}
		if t, _ := p["type"].(string); t == "date" {
			dateIDs[id] = true
		}
	}
	for prop, raw := range patch {
		if !dateIDs[prop] {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			continue
		}
		if day, ok := resolveSmartDate(s, now); ok {
			if b, err := json.Marshal(day); err == nil {
				patch[prop] = b
			}
		}
	}
}

// mentionsRelativeDay is a cheap gate in front of the schema read: an ordinary
// property write never contains one of these words, and loading a collection's
// schema for every keystroke-sized patch would be work for nothing. A false
// positive (a text cell that says "today") only costs the read.
func mentionsRelativeDay(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	low := bytes.ToLower(raw)
	for _, word := range []string{`"today`, `"yesterday`, `"tomorrow`} {
		if bytes.Contains(low, []byte(word)) {
			return true
		}
	}
	return false
}

// migrateRelativeDates repairs date properties that still hold a filter word.
// Once, guarded by a marker: after this build the write paths resolve the word
// as it arrives, so there is nothing left for it to do.
func migrateRelativeDates(db *sql.DB) error {
	var done string
	if db.QueryRow(`SELECT value FROM schema_meta WHERE key = 'relative_dates'`).Scan(&done) == nil && done != "" {
		return nil
	}
	now := time.Now()

	type collection struct {
		id    string
		dates []string
	}
	var cols []collection
	rows, err := db.Query(`SELECT page_id, schema FROM collections`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, schema string
		if rows.Scan(&id, &schema) != nil {
			continue
		}
		var dates []string
		for _, def := range parseSchema(schema) {
			if def.Type == "date" && safePropID(def.ID) {
				dates = append(dates, def.ID)
			}
		}
		if len(dates) > 0 {
			cols = append(cols, collection{id: id, dates: dates})
		}
	}
	rows.Close()

	type job struct {
		id    string
		props string
		dates []string
	}
	var jobs []job
	for _, c := range cols {
		for _, prop := range c.dates {
			// One property at a time: this runs once, on startup, and the index
			// on parent_id keeps each of these small.
			cand, err := db.Query(`SELECT id, props FROM pages WHERE parent_id = ?
				AND json_type(props, '$."`+prop+`"') = 'text'`, c.id)
			if err != nil {
				continue
			}
			for cand.Next() {
				var id, props string
				if cand.Scan(&id, &props) == nil {
					jobs = append(jobs, job{id: id, props: props, dates: c.dates})
				}
			}
			cand.Close()
		}
	}

	seen := map[string]bool{}
	for _, j := range jobs {
		if seen[j.id] {
			continue
		}
		seen[j.id] = true
		var props map[string]json.RawMessage
		if json.Unmarshal([]byte(j.props), &props) != nil {
			continue
		}
		changed := false
		for _, prop := range j.dates {
			raw, ok := props[prop]
			if !ok {
				continue
			}
			var s string
			if json.Unmarshal(raw, &s) != nil {
				continue
			}
			if day, ok := resolveSmartDate(s, now); ok {
				if b, err := json.Marshal(day); err == nil {
					props[prop] = b
					changed = true
				}
			}
		}
		if !changed {
			continue
		}
		body, err := json.Marshal(props)
		if err != nil {
			continue
		}
		if _, err := db.Exec(`UPDATE pages SET props = ? WHERE id = ?`, string(body), j.id); err != nil {
			return err
		}
	}

	_, err = db.Exec(`INSERT INTO schema_meta (key, value) VALUES ('relative_dates', '1')
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
	return err
}

// resolveRelativeDays applies resolveDatePatch to a page write: the full
// property object, the patch, or both. It reads the parent collection's schema,
// which is why the caller invokes it before opening a transaction.
func (s *Server) resolveRelativeDays(pageID string, full, patch *json.RawMessage) {
	if !mentionsRelativeDay(*full) && !mentionsRelativeDay(*patch) {
		return
	}
	var parentID string
	if s.db.QueryRow(`SELECT COALESCE(parent_id, '') FROM pages WHERE id = ?`, pageID).Scan(&parentID) != nil || parentID == "" {
		return
	}
	schema, _, err := s.loadCollection(parentID)
	if err != nil {
		return
	}
	now := time.Now()
	for _, target := range []*json.RawMessage{full, patch} {
		if len(*target) == 0 {
			continue
		}
		m := map[string]json.RawMessage{}
		if json.Unmarshal(*target, &m) != nil {
			continue
		}
		resolveDatePatch(schema, m, now)
		if b, err := json.Marshal(m); err == nil {
			*target = b
		}
	}
}
