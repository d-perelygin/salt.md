package server

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// What a version changed, in words the interface can read back.
//
// A revision is a STATE; "what changed" is the difference between it and the
// revision before it. That is what turns a list of timestamps into a history:
// "Status: in progress → done" explains the version, and a row of times does
// not. The diff is computed once, when the snapshot is written, against the
// previous snapshot — the one the interface shows underneath it — and stored
// with the revision, so reading the list never has to parse 50 documents.
//
// Values are rendered as the collection shows them: a select is its option's
// name, a person a name, a checklist its progress. A relation is a count:
// naming rows the reader may not be allowed to see would leak through a
// screenshot of a history dialog.
type revisionChange struct {
	Kind string `json:"kind"` // title | content | prop
	// Prop is set for a property: its id, name and stored type, so the
	// interface can format a date the way it formats every other date.
	Prop string `json:"prop,omitempty"`
	Name string `json:"name,omitempty"`
	Type string `json:"type,omitempty"`
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
}

// revisionState is one page as a snapshot holds it.
type revisionState struct {
	title   string
	content string
	props   string
	icon    string
	cover   string
	// full marks a snapshot that captured properties and appearance, not just
	// a document. Revisions written before that existed restore content and
	// title only — restoring an empty props object over a live row would wipe
	// every column it has.
	full bool
}

func (s *Server) revisionChanges(pageID string, prev, now revisionState) string {
	changes := []revisionChange{}
	if !jsonEqual(prev.title, now.title) {
		changes = append(changes, revisionChange{
			Kind: "title",
			From: clipText(prev.title, 80),
			To:   clipText(now.title, 80),
		})
	}
	if !jsonEqual(prev.content, now.content) {
		changes = append(changes, revisionChange{Kind: "content"})
	}
	// Legacy snapshots never saw properties; their absence is not a change.
	if prev.full {
		changes = append(changes, s.propChanges(pageID, prev.props, now.props)...)
	}
	if len(changes) == 0 {
		return ""
	}
	b, err := json.Marshal(changes)
	if err != nil {
		return ""
	}
	return string(b)
}

// propChanges lists the stored properties that differ between two states.
func (s *Server) propChanges(pageID, before, after string) []revisionChange {
	var parentID string
	if s.db.QueryRow(`SELECT COALESCE(parent_id, '') FROM pages WHERE id = ?`, pageID).Scan(&parentID) != nil || parentID == "" {
		return nil
	}
	var schemaJSON string
	if s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, parentID).Scan(&schemaJSON) != nil {
		return nil
	}
	defs := parseSchema(schemaJSON)
	var oldProps, newProps map[string]json.RawMessage
	json.Unmarshal([]byte(before), &oldProps)
	json.Unmarshal([]byte(after), &newProps)
	names := map[string]string{}
	out := []revisionChange{}
	for _, def := range defs {
		switch def.Type {
		case "rollup", "formula", "backrelation", "lastActivity":
			continue // computed: nothing was stored, nothing changed
		}
		o, n := oldProps[def.ID], newProps[def.ID]
		if jsonEqual(string(o), string(n)) {
			continue
		}
		out = append(out, revisionChange{
			Kind: "prop",
			Prop: def.ID,
			Name: def.Name,
			Type: def.Type,
			From: s.propDisplay(def, o, names),
			To:   s.propDisplay(def, n, names),
		})
	}
	return out
}

// propDisplay renders one stored value the way the property's own cell would.
// Empty is genuinely empty: "is empty" is a state a change can move into.
func (s *Server) propDisplay(def propDef, raw json.RawMessage, names map[string]string) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return clipText(string(raw), 80)
	}
	switch def.Type {
	case "select":
		return clipText(optionLabel(def, plainText(v)), 80)
	case "multiselect":
		out := []string{}
		for _, id := range stringList(v) {
			if label := optionLabel(def, id); label != "" {
				out = append(out, label)
			}
		}
		return clipText(strings.Join(out, ", "), 80)
	case "person":
		out := []string{}
		for _, id := range stringList(v) {
			if name := s.lookupUserName(id, names); name != "" {
				out = append(out, name)
			}
		}
		return clipText(strings.Join(out, ", "), 80)
	case "checkbox":
		if b, ok := v.(bool); ok && b {
			return "✓"
		}
		return ""
	case "checklist":
		done, total := checklistProgress(v)
		if total == 0 {
			return ""
		}
		return strconv.Itoa(done) + "/" + strconv.Itoa(total)
	case "number":
		if n, ok := toNumber(v); ok {
			return strconv.FormatFloat(n, 'g', -1, 64)
		}
		return ""
	case "relation":
		// A count, not names: a history dialog is readable by anyone who can
		// read this row, and the linked rows are a separate permission.
		if n := len(stringList(v)); n > 0 {
			return fmt.Sprintf("%d", n)
		}
		return ""
	}
	// date, text, url, and a type this build does not know.
	return clipText(plainText(v), 80)
}

func clipText(s string, max int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "…"
}

// pageExcerpt is the first stretch of a document's text, for the one-line
// preview of a version: enough to recognise the state, never a whole page.
func pageExcerpt(content string, max int) string {
	var v any
	if json.Unmarshal([]byte(content), &v) != nil {
		return ""
	}
	var b strings.Builder
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case map[string]any:
			if txt, ok := t["text"].(string); ok {
				b.WriteString(txt)
				b.WriteString(" ")
			}
			for _, v := range t {
				walk(v)
			}
		case []any:
			for _, v := range t {
				walk(v)
			}
		}
	}
	walk(v)
	return clipText(strings.Join(strings.Fields(b.String()), " "), max)
}
