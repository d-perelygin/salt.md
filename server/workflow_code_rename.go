package server

// Token-aware rename propagation for process code.
//
// When a property, an option or a member is renamed, code blocks that name it
// keep working (they run on resolved ids) but their source goes stale. On the
// next save the server rewrites the source at the exact token positions the
// parser recorded, so a column called "Status" never rewrites an option that
// happens to share its name. Blocks that no longer parse are skipped — they
// are already red, and hand-editing broken code is worse than flagging it.

import (
	"strings"
)

// codeSpan is one name occurrence in a code source: where it sits and what
// stored entity it resolved to.
type codeSpan struct {
	line, start, end int
	quote            byte
	kind             string // "prop" | "option" | "member"
	id, propID       string
	text             string // the name as written
}

// codeRename maps one renamed entity to its new name.
type codeRename struct {
	kind       string // "prop" | "option" | "member"
	id, propID string
	from, to   string
}

func spanLine(line, dline int) int {
	if dline != 0 {
		return dline
	}
	return line
}

type spanCollector struct {
	byID    map[string]PropSchema
	status  PropSchema
	members []codeMember
	spans   []codeSpan
}

func (c *spanCollector) propByName(text string) (PropSchema, bool) {
	for _, p := range c.byID {
		if p.Name == text {
			return p, true
		}
	}
	for _, p := range c.byID {
		if p.ID == text {
			return p, true
		}
	}
	return PropSchema{}, false
}

func (c *spanCollector) emitRef(n codeNameRef, kind, id, propID string) {
	if strings.TrimSpace(n.text) == "" {
		return
	}
	c.spans = append(c.spans, codeSpan{
		line: spanLine(n.line, n.dline), start: n.start, end: n.end,
		quote: n.quote, kind: kind, id: id, propID: propID, text: n.text,
	})
}

func (c *spanCollector) emitVal(v codeValue, kind, id, propID string) {
	if v.kind != "str" || strings.TrimSpace(v.text) == "" {
		return
	}
	c.spans = append(c.spans, codeSpan{
		line: spanLine(v.line, v.dline), start: v.start, end: v.end,
		quote: v.quote, kind: kind, id: id, propID: propID, text: v.text,
	})
}

func (c *spanCollector) statusOpt(text string) (string, bool) {
	if c.status.ID == "" {
		return "", false
	}
	for _, o := range c.status.Options {
		if o.Name == text || o.ID == text {
			return o.ID, true
		}
	}
	return "", false
}

func (c *spanCollector) optionOf(prop PropSchema, text string) (string, bool) {
	for _, o := range prop.Options {
		if o.Name == text || o.ID == text {
			return o.ID, true
		}
	}
	return "", false
}

func (c *spanCollector) memberByName(text string) (string, bool) {
	for _, m := range c.members {
		if m.Name == text || m.ID == text {
			return m.ID, true
		}
	}
	return "", false
}

// collectCodeSpans walks a parsed block and records every name occurrence
// that resolved against the schema: properties, options (status included)
// and members. Anything unresolvable is skipped for validation to flag.
func collectCodeSpans(f *codeFile, schema []PropSchema, status PropSchema, members []codeMember) []codeSpan {
	c := &spanCollector{byID: map[string]PropSchema{}, status: status, members: members}
	for _, p := range schema {
		c.byID[p.ID] = p
	}
	for _, r := range f.rules {
		if r.from != nil {
			if id, ok := c.statusOpt(r.from.text); ok {
				c.emitRef(*r.from, "option", id, status.ID)
			}
		}
		if r.to.text != "" {
			if id, ok := c.statusOpt(r.to.text); ok {
				c.emitRef(r.to, "option", id, status.ID)
			}
		}
		for _, a := range r.allowFrom {
			if id, ok := c.statusOpt(a.text); ok {
				c.emitRef(a, "option", id, status.ID)
			}
		}
		if r.checklist != nil {
			if p, ok := c.propByName(r.checklist.text); ok {
				c.emitRef(*r.checklist, "prop", p.ID, "")
			}
		}
		if r.required != nil {
			if p, ok := c.propByName(r.required.text); ok {
				c.emitRef(*r.required, "prop", p.ID, "")
			}
		}
		for _, cond := range r.conds {
			p, ok := c.propByName(cond.prop.text)
			if !ok {
				continue
			}
			c.emitRef(cond.prop, "prop", p.ID, "")
			if p.Type != "select" && p.Type != "multiselect" {
				continue
			}
			for _, v := range cond.vals {
				if id, ok := c.optionOf(p, v.text); ok {
					c.emitVal(v, "option", id, p.ID)
				}
			}
		}
		for _, a := range r.actions {
			switch a.kind {
			case "set":
				p, ok := c.propByName(a.prop.text)
				if !ok {
					continue
				}
				c.emitRef(a.prop, "prop", p.ID, "")
				switch p.Type {
				case "select", "multiselect":
					vals := []codeValue{a.val}
					if a.val.kind == "list" {
						vals = a.val.items
					}
					for _, v := range vals {
						if id, ok := c.optionOf(p, v.text); ok {
							c.emitVal(v, "option", id, p.ID)
						}
					}
				case "person":
					vals := []codeValue{a.val}
					if a.val.kind == "list" {
						vals = a.val.items
					}
					for _, v := range vals {
						if id, ok := c.memberByName(v.text); ok {
							c.emitVal(v, "member", id, "")
						}
					}
				}
			case "assign", "ask", "today":
				if p, ok := c.propByName(a.prop.text); ok {
					c.emitRef(a.prop, "prop", p.ID, "")
				}
			}
		}
	}
	return c.spans
}

// requoteCodeName renders a replacement name with the original quoting: the
// same quote unless the name forces the other one (single quotes have no
// escapes, so a name holding one switches to double).
func requoteCodeName(name string, q byte) string {
	if q != '"' && q != '\'' {
		q = '"'
	}
	if q == '\'' && (strings.Contains(name, "'") || strings.Contains(name, "\\")) {
		q = '"'
	}
	esc := strings.ReplaceAll(name, `\`, `\\`)
	if q == '"' {
		esc = strings.ReplaceAll(esc, `"`, `\"`)
	}
	return string(q) + esc + string(q)
}

// rewriteCodeSource applies renames at recorded spans. A source position
// claimed by conflicting entities is left alone — a loud resolve error beats
// a confident wrong edit.
func rewriteCodeSource(src string, spans []codeSpan, ren []codeRename) (string, int) {
	type key struct {
		line, start int
	}
	byPos := map[key][]codeSpan{}
	for _, s := range spans {
		k := key{s.line, s.start}
		byPos[k] = append(byPos[k], s)
	}
	type edit struct {
		start, end int
		repl       string
	}
	byLine := map[int][]edit{}
	n := 0
	for _, s := range spans {
		var match *codeRename
		for i, r := range ren {
			if r.kind == s.kind && r.id == s.id && r.propID == s.propID && r.from == s.text {
				match = &ren[i]
				break
			}
		}
		if match == nil {
			continue
		}
		// One position, one entity: conflicting claims abort the edit.
		conflict := false
		for _, o := range byPos[key{s.line, s.start}] {
			if o.kind != s.kind || o.id != s.id || o.propID != s.propID {
				conflict = true
				break
			}
		}
		if conflict {
			continue
		}
		byLine[s.line] = append(byLine[s.line], edit{s.start, s.end, requoteCodeName(match.to, s.quote)})
		n++
	}
	if n == 0 {
		return src, 0
	}
	lines := strings.Split(src, "\n")
	for ln, edits := range byLine {
		if ln < 1 || ln > len(lines) {
			continue
		}
		raw := lines[ln-1]
		lead := len(raw) - len(strings.TrimLeft(raw, " "))
		// Right to left, so earlier offsets stay valid.
		for i := len(edits) - 1; i >= 0; i-- {
			e := edits[i]
			a, b := lead+e.start, lead+e.end
			if a < lead || b > len(raw) || a >= b {
				continue
			}
			raw = raw[:a] + e.repl + raw[b:]
		}
		lines[ln-1] = raw
	}
	return strings.Join(lines, "\n"), n
}

// diffSchemaNames lists property and option renames between a stored schema
// and its incoming replacement, matched by id.
func diffSchemaNames(old, fresh []PropSchema) []codeRename {
	oldByID := map[string]PropSchema{}
	for _, p := range old {
		oldByID[p.ID] = p
	}
	var out []codeRename
	for _, p := range fresh {
		o, ok := oldByID[p.ID]
		if !ok {
			continue
		}
		if o.Name != p.Name {
			out = append(out, codeRename{kind: "prop", id: p.ID, from: o.Name, to: p.Name})
		}
		oldOpts := map[string]string{}
		for _, op := range o.Options {
			oldOpts[op.ID] = op.Name
		}
		for _, op := range p.Options {
			if on, ok := oldOpts[op.ID]; ok && on != op.Name {
				out = append(out, codeRename{kind: "option", id: op.ID, propID: p.ID, from: on, to: op.Name})
			}
		}
	}
	return out
}

// rewriteMemberInCode renames one member across every stored process code
// that names them. Quiet when nothing references them.
func (s *Server) rewriteMemberInCode(memberID, from, to string) {
	if strings.TrimSpace(from) == "" || from == to {
		return
	}
	ren := []codeRename{{kind: "member", id: memberID, from: from, to: to}}
	rows, err := s.db.Query(`SELECT c.page_id, c.schema, c.workflow FROM collections c WHERE c.workflow LIKE '%"code"%'`)
	if err != nil {
		return
	}
	defer rows.Close()
	type job struct {
		pageID, schemaRaw, workflowRaw string
	}
	var jobs []job
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.pageID, &j.schemaRaw, &j.workflowRaw); err == nil {
			jobs = append(jobs, j)
		}
	}
	rows.Close()
	for _, j := range jobs {
		members := s.codeMembersOf(j.pageID)
		found := false
		for _, m := range members {
			if m.ID == memberID {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		schema := parseSchemaProps(j.schemaRaw)
		cfg := parseWorkflow(j.workflowRaw)
		if cfg == nil || len(cfg.Code) == 0 {
			continue
		}
		// Resolve against the pre-rename name: the members table already
		// carries the new one.
		oldMembers := make([]codeMember, len(members))
		for i, m := range members {
			oldMembers[i] = m
			if m.ID == memberID {
				oldMembers[i].Name = from
			}
		}
		if refs, blocks := rewriteCodeWorkflow(cfg, schema, oldMembers, ren); blocks > 0 && refs > 0 {
			_ = s.saveWorkflow(j.pageID, cfg)
		}
	}
}
// rewriteCodeWorkflow rewrites renamed names in a config's code sources,
// resolving against the pre-rename schema. It returns how many references
// in how many blocks changed.
func rewriteCodeWorkflow(cfg *workflowConfig, oldSchema []PropSchema, members []codeMember, ren []codeRename) (refs, blocks int) {
	if cfg == nil || len(ren) == 0 || len(cfg.Code) == 0 {
		return 0, 0
	}
	byID := map[string]PropSchema{}
	for _, p := range oldSchema {
		byID[p.ID] = p
	}
	status, ok := byID[cfg.StatusPropID]
	if !ok {
		return 0, 0
	}
	for i := range cfg.Code {
		f, diags := parseWorkflowCode(cfg.Code[i].Source)
		if len(diags) > 0 {
			continue
		}
		spans := collectCodeSpans(f, oldSchema, status, members)
		newSrc, n := rewriteCodeSource(cfg.Code[i].Source, spans, ren)
		if n > 0 {
			cfg.Code[i].Source = newSrc
			refs += n
			blocks++
		}
	}
	return refs, blocks
}
