package server

// Name-to-id resolution for process code: what the user typed as names
// ("Статус", "Рилс", "Данил") becomes the stored ids the engine compares.
// Resolution happens on save (validateWorkflowCode) and the resolved rules
// are stored beside the source, so renaming a property afterwards breaks the
// *text* (flagged on next save) but never silently changes behavior.

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type codeResolver struct {
	schema  []PropSchema
	byID    map[string]PropSchema
	status  PropSchema
	members []codeMember
}

// resolveWorkflowCode turns one parsed block into executable rules. Rule ids
// are synthetic but stable: code:<blockID>:<index>.
func resolveWorkflowCode(blockID string, f *codeFile, schema []PropSchema, status PropSchema, members []codeMember) ([]workflowRule, []codeDiag) {
	r := &codeResolver{
		schema:  schema,
		byID:    map[string]PropSchema{},
		status:  status,
		members: members,
	}
	for _, p := range schema {
		r.byID[p.ID] = p
	}
	var out []workflowRule
	var diags []codeDiag
	for i, cr := range f.rules {
		rule, derr := r.resolveRule(fmt.Sprintf("code:%s:%d", blockID, i), &cr)
		if derr != nil {
			diags = append(diags, *derr)
			continue
		}
		out = append(out, *rule)
	}
	return out, diags
}

func (r *codeResolver) fail(line int, format string, args ...any) *codeDiag {
	return &codeDiag{Line: line, Msg: fmt.Sprintf(format, args...)}
}

func candidateList(names []string, max int) string {
	if len(names) > max {
		names = names[:max]
	}
	quoted := make([]string, 0, len(names))
	for _, n := range names {
		quoted = append(quoted, fmt.Sprintf("%q", n))
	}
	return strings.Join(quoted, ", ")
}

func propNames(schema []PropSchema) []string {
	out := make([]string, 0, len(schema))
	for _, p := range schema {
		out = append(out, p.Name)
	}
	return out
}

func (r *codeResolver) propRef(n codeNameRef) (PropSchema, *codeDiag) {
	for _, p := range r.schema {
		if p.Name == n.text {
			return p, nil
		}
	}
	if p, ok := r.byID[n.text]; ok {
		return p, nil
	}
	for _, p := range r.schema {
		if strings.EqualFold(p.Name, n.text) {
			return p, nil
		}
	}
	return PropSchema{}, r.fail(n.line, "unknown property %q (known: %s)", n.text, candidateList(propNames(r.schema), 8))
}

func optNames(p PropSchema) []string {
	out := make([]string, 0, len(p.Options))
	for _, o := range p.Options {
		out = append(out, o.Name)
	}
	return out
}

// optionID maps a written option name (or bare id) to the stored option id.
func (r *codeResolver) optionID(prop PropSchema, n codeNameRef) (string, *codeDiag) {
	for _, o := range prop.Options {
		if o.Name == n.text {
			return o.ID, nil
		}
	}
	for _, o := range prop.Options {
		if o.ID == n.text {
			return o.ID, nil
		}
	}
	for _, o := range prop.Options {
		if strings.EqualFold(o.Name, n.text) {
			return o.ID, nil
		}
	}
	return "", r.fail(n.line, "unknown option %q (options of %q: %s)", n.text, prop.Name, candidateList(optNames(prop), 8))
}

func memberNames(members []codeMember) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		out = append(out, m.Name)
	}
	return out
}

func (r *codeResolver) memberID(n codeNameRef) (string, *codeDiag) {
	for _, m := range r.members {
		if m.Name == n.text {
			return m.ID, nil
		}
	}
	for _, m := range r.members {
		if m.ID == n.text {
			return m.ID, nil
		}
	}
	var hit *codeMember
	for i, m := range r.members {
		if strings.EqualFold(m.Name, n.text) {
			if hit != nil {
				return "", r.fail(n.line, "several members match %q — write the full name", n.text)
			}
			hit = &r.members[i]
		}
	}
	if hit != nil {
		return hit.ID, nil
	}
	return "", r.fail(n.line, "unknown member %q (members: %s)", n.text, candidateList(memberNames(r.members), 8))
}

func (r *codeResolver) statusOpt(n codeNameRef) (string, *codeDiag) {
	if r.status.ID == "" {
		return "", r.fail(n.line, "no status property is set — pick one in the Process tab first")
	}
	for _, o := range r.status.Options {
		if o.Name == n.text {
			return o.ID, nil
		}
	}
	for _, o := range r.status.Options {
		if o.ID == n.text {
			return o.ID, nil
		}
	}
	for _, o := range r.status.Options {
		if strings.EqualFold(o.Name, n.text) {
			return o.ID, nil
		}
	}
	return "", r.fail(n.line, "unknown status %q (statuses: %s)", n.text, candidateList(optNames(r.status), 12))
}

func (r *codeResolver) resolveRule(id string, cr *codeRule) (*workflowRule, *codeDiag) {
	rule := &workflowRule{ID: id}
	// when
	if cr.created {
		rule.When = workflowWhen{Type: "created"}
	} else {
		to, d := r.statusOpt(cr.to)
		if d != nil {
			return nil, d
		}
		rule.When = workflowWhen{Type: "status_to", To: to}
	}
	// only from: union with the explicit source, never a conflict — the
	// engine only lets the listed sources through either way. The explicit
	// source lands where it was written: appended when only from names
	// others, first when it stands alone.
	seen := map[string]bool{}
	for _, f := range cr.allowFrom {
		id, d := r.statusOpt(f)
		if d != nil {
			return nil, d
		}
		if !seen[id] {
			seen[id] = true
			rule.AllowFrom = append(rule.AllowFrom, id)
		}
	}
	if cr.from != nil {
		from, d := r.statusOpt(*cr.from)
		if d != nil {
			return nil, d
		}
		if !seen[from] {
			rule.AllowFrom = append(rule.AllowFrom, from)
		}
	}
	// preconditions
	if cr.checklist != nil {
		p, d := r.propRef(*cr.checklist)
		if d != nil {
			return nil, d
		}
		if p.Type != "checklist" {
			return nil, &codeDiag{Line: cr.checklist.line, Msg: fmt.Sprintf("%q is a %s, not a checklist", p.Name, p.Type)}
		}
		rule.Precondition = &workflowPrecondition{ChecklistProp: p.ID}
	}
	if cr.required != nil {
		p, d := r.propRef(*cr.required)
		if d != nil {
			return nil, d
		}
		if rule.Precondition == nil {
			rule.Precondition = &workflowPrecondition{}
		}
		rule.Precondition.RequiredProp = p.ID
	}
	// conditions: one `if` line is one condition; several values mean OR.
	for _, c := range cr.conds {
		p, d := r.propRef(c.prop)
		if d != nil {
			return nil, d
		}
		switch p.Type {
		case "select", "multiselect", "text", "number":
		default:
			return nil, &codeDiag{Line: c.line, Msg: fmt.Sprintf("conditions support select, multiselect, text and number properties (%q is %s)", p.Name, p.Type)}
		}
		op := "is"
		if c.not {
			op = "is_not"
		}
		vals, d := r.condValues(p, c.vals)
		if d != nil {
			return nil, d
		}
		rule.WhenProps = append(rule.WhenProps, workflowPropCond{Prop: p.ID, Op: op, Value: vals[0], Values: vals})
	}
	// actions
	for _, a := range cr.actions {
		act, d := r.resolveAction(a)
		if d != nil {
			return nil, d
		}
		rule.Do = append(rule.Do, *act)
	}
	return rule, nil
}

func (r *codeResolver) condValue(p PropSchema, v codeValue) (string, *codeDiag) {
	vals, d := r.condValues(p, []codeValue{v})
	if d != nil {
		return "", d
	}
	return vals[0], nil
}

// condValues resolves every value on one `if` line; several stay as an OR.
func (r *codeResolver) condValues(p PropSchema, vals []codeValue) ([]string, *codeDiag) {
	if len(vals) == 0 {
		return nil, r.fail(valsLine(vals), "condition needs a value")
	}
	var out []string
	for _, v := range vals {
		switch p.Type {
		case "select", "multiselect":
			if v.kind != "str" {
				return nil, r.fail(v.line, "option name must be quoted, like \"Done\"")
			}
			id, d := r.optionID(p, codeNameRef{text: v.text, line: v.line})
			if d != nil {
				return nil, d
			}
			out = append(out, id)
		case "number":
			if v.kind != "num" {
				return nil, r.fail(v.line, "a number here, without quotes")
			}
			out = append(out, v.text)
		default: // text
			if v.kind != "str" {
				return nil, r.fail(v.line, "text goes in quotes")
			}
			if v.text == "" {
				return nil, r.fail(v.line, "condition value is empty — write something between the quotes")
			}
			out = append(out, v.text)
		}
	}
	return out, nil
}

func valsLine(vals []codeValue) int {
	if len(vals) > 0 {
		return vals[0].line
	}
	return 0
}

func (r *codeResolver) resolveAction(a codeAction) (*workflowAction, *codeDiag) {
	fail := func(format string, args ...any) *codeDiag {
		return &codeDiag{Line: a.line, Msg: fmt.Sprintf(format, args...)}
	}
	switch a.kind {
	case "set":
		p, d := r.propRef(a.prop)
		if d != nil {
			return nil, d
		}
		switch p.Type {
		case "text":
			if a.val.kind != "str" {
				return nil, fail("text goes in quotes")
			}
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: json.RawMessage(strconv.Quote(a.val.text))}, nil
		case "number":
			if a.val.kind != "num" {
				return nil, fail("a number here, without quotes")
			}
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: json.RawMessage(a.val.text)}, nil
		case "checkbox":
			if a.val.kind != "bool" {
				return nil, fail("true or false, without quotes")
			}
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: json.RawMessage(a.val.text)}, nil
		case "date":
			if a.val.kind == "today" {
				return &workflowAction{Type: "set_today", Prop: p.ID}, nil
			}
			if a.val.kind != "str" {
				return nil, fail("a date looks like \"2026-11-21\", in quotes")
			}
			if _, err := time.Parse("2006-01-02", a.val.text); err != nil {
				if _, ok := resolveSmartDate(a.val.text, time.Now().UTC()); ok {
					// A relative day like "today+7d" resolves when the rule
					// fires, exactly like the filter language.
					return &workflowAction{Type: "set_prop", Prop: p.ID, Value: json.RawMessage(strconv.Quote(a.val.text))}, nil
				}
				return nil, fail("not a date: write YYYY-MM-DD like \"2026-11-21\"")
			}
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: json.RawMessage(strconv.Quote(a.val.text))}, nil
		case "select":
			if a.val.kind != "str" {
				return nil, fail("option name must be quoted, like \"Done\"")
			}
			id, d := r.optionID(p, codeNameRef{text: a.val.text, line: a.val.line})
			if d != nil {
				return nil, d
			}
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: json.RawMessage(strconv.Quote(id))}, nil
		case "multiselect":
			if a.val.kind != "list" || len(a.val.items) == 0 {
				return nil, fail("a list of quoted options, like [\"A\", \"B\"]")
			}
			ids := make([]string, 0, len(a.val.items))
			for _, it := range a.val.items {
				id, d := r.optionID(p, codeNameRef{text: it.text, line: it.line})
				if d != nil {
					return nil, d
				}
				ids = append(ids, id)
			}
			raw, _ := json.Marshal(ids)
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: raw}, nil
		case "person":
			var names []codeValue
			if a.val.kind == "str" {
				names = []codeValue{a.val}
			} else if a.val.kind == "list" && len(a.val.items) > 0 {
				names = a.val.items
			} else {
				return nil, fail("a member name in quotes, or a list like [\"A\", \"B\"]")
			}
			ids := make([]string, 0, len(names))
			for _, nm := range names {
				id, d := r.memberID(codeNameRef{text: nm.text, line: nm.line})
				if d != nil {
					return nil, d
				}
				ids = append(ids, id)
			}
			raw, _ := json.Marshal(ids)
			return &workflowAction{Type: "set_prop", Prop: p.ID, Value: raw}, nil
		default:
			return nil, fail("cannot set %q from code (only text, number, checkbox, date, select, multiselect and person)", p.Name)
		}
	case "assign":
		p, d := r.propRef(a.prop)
		if d != nil {
			return nil, d
		}
		if p.Type != "person" {
			return nil, fail("%q is a %s, not a person property", p.Name, p.Type)
		}
		return &workflowAction{Type: "assign_me", Prop: p.ID}, nil
	case "ask":
		p, d := r.propRef(a.prop)
		if d != nil {
			return nil, d
		}
		switch p.Type {
		case "text", "date", "person", "select", "multiselect", "checklist":
		default:
			return nil, fail("cannot ask for %q: only text, date, person, select, multiselect or checklist", p.Name)
		}
		return &workflowAction{Type: "require_prop", Prop: p.ID, Mode: a.mode}, nil
	case "askcomment":
		return &workflowAction{Type: "require_comment", Mode: a.mode}, nil
	case "today":
		p, d := r.propRef(a.prop)
		if d != nil {
			return nil, d
		}
		if p.Type != "date" {
			return nil, fail("%q is a %s, not a date", p.Name, p.Type)
		}
		return &workflowAction{Type: "set_today", Prop: p.ID}, nil
	case "webhook":
		if !strings.HasPrefix(a.url, "http://") && !strings.HasPrefix(a.url, "https://") {
			return nil, fail("webhook URL must start with http:// or https://")
		}
		return &workflowAction{Type: "webhook", URL: a.url}, nil
	}
	return nil, fail("unknown action")
}
