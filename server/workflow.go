package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// Lightweight business process (workflow constructor, iteration 1).
//
// A collection may name one select property as its status and attach flat
// When/Then rules: When the status becomes X (or a row is created), Then run
// actions. An optional precondition and an optional source allow-list stay
// collapsed in the UI until needed. No canvas, no branching.

type workflowAction struct {
	Type  string          `json:"type"`
	Prop  string          `json:"prop"`
	Value json.RawMessage `json:"value"`
	URL   string          `json:"url"`
	Mode  string          `json:"mode"`
}

type workflowWhen struct {
	Type string `json:"type"`
	To   string `json:"to"`
}

type workflowPrecondition struct {
	ChecklistProp string `json:"checklistProp"`
	RequiredProp  string `json:"requiredProp"`
}

// A row-value condition: the rule fires only when the row's property is
// (or is not) the value. Selects compare option ids, multiselects contain
// them, text and numbers compare as written. Values holds an OR list
// ("is A, B" means A or B); Value stays as the first entry so older
// readers that only know the single form keep working.
type workflowPropCond struct {
	Prop   string   `json:"prop"`
	Op     string   `json:"op"`
	Value  string   `json:"value"`
	Values []string `json:"values,omitempty"`
}

type workflowRule struct {
	ID           string                `json:"id"`
	When         workflowWhen          `json:"when"`
	AllowFrom    []string              `json:"allowFrom"`
	WhenProps    []workflowPropCond    `json:"whenProps"`
	Precondition *workflowPrecondition `json:"precondition"`
	Do           []workflowAction      `json:"do"`
}

// A block of process code: source text the user edits, plus the resolved
// rules it compiled to on the last successful save. The text is the source
// of truth; the stored rules keep the process running between edits without
// re-resolving names on every transition.
type workflowCodeBlock struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Source string         `json:"source"`
	Rules  []workflowRule `json:"rules"`
}

type workflowConfig struct {
	StatusPropID string              `json:"statusPropId"`
	Rules        []workflowRule      `json:"rules"`
	Code         []workflowCodeBlock `json:"code,omitempty"`
}

// allRules is the executable rule list: visual rules plus every saved code
// block's compiled rules, in order. Everything that matches, simulates or
// draws the process goes through here, so code and clicks can never drift
// apart at runtime.
func (cfg *workflowConfig) allRules() []workflowRule {
	if cfg == nil || len(cfg.Code) == 0 {
		if cfg == nil {
			return nil
		}
		return cfg.Rules
	}
	out := make([]workflowRule, 0, len(cfg.Rules)+len(cfg.Code))
	out = append(out, cfg.Rules...)
	for _, b := range cfg.Code {
		out = append(out, b.Rules...)
	}
	return out
}

func parseWorkflow(raw string) *workflowConfig {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var cfg workflowConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return nil
	}
	cfg.StatusPropID = strings.TrimSpace(cfg.StatusPropID)
	if cfg.StatusPropID == "" || (len(cfg.Rules) == 0 && len(cfg.Code) == 0) {
		return nil
	}
	return &cfg
}

func parseSchemaProps(raw string) []PropSchema {
	var schema []PropSchema
	if err := json.Unmarshal([]byte(raw), &schema); err != nil {
		return nil
	}
	return schema
}

// PropSchema is the minimal schema view the workflow engine needs. The full
// schema type lives in mcp_schema.go; this stays local to avoid coupling.
type PropSchema struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Options []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"options"`
}

// validateWorkflowRule checks one rule; label names it in errors
// ("rule 3" for visual rules, "line 12" for code). Apart from the label
// the messages are identical.
func validateWorkflowRule(r workflowRule, label string, byID map[string]PropSchema, validOpt map[string]bool) error {
	if r.When.Type != "status_to" && r.When.Type != "created" {
		return fmt.Errorf("%s: unknown trigger", label)
	}
	if r.When.Type == "status_to" && !validOpt[r.When.To] {
		return fmt.Errorf("%s: unknown status option", label)
	}
	for _, from := range r.AllowFrom {
		if !validOpt[from] {
			return fmt.Errorf("%s: unknown source status", label)
		}
	}
	if r.Precondition != nil {
		if r.Precondition.ChecklistProp != "" {
			p, ok := byID[r.Precondition.ChecklistProp]
			if !ok || p.Type != "checklist" {
				return fmt.Errorf("%s: checklist property must be a checklist", label)
			}
		}
		if r.Precondition.RequiredProp != "" {
			if _, ok := byID[r.Precondition.RequiredProp]; !ok {
				return fmt.Errorf("%s: unknown required property", label)
			}
		}
	}
	for _, c := range r.WhenProps {
		p, ok := byID[c.Prop]
		if c.Prop == "" || !ok {
			return fmt.Errorf("%s: unknown property in condition", label)
		}
		switch p.Type {
		case "select", "multiselect", "text", "number":
		default:
			return fmt.Errorf("%s: conditions support select, multiselect, text and number properties", label)
		}
		if c.Op != "" && c.Op != "is" && c.Op != "is_not" {
			return fmt.Errorf("%s: condition operator must be is or is_not", label)
		}
		vals := c.Values
		if len(vals) == 0 {
			vals = []string{c.Value}
		}
		if len(vals) == 0 || (len(vals) == 1 && vals[0] == "") {
			return fmt.Errorf("%s: condition value is empty", label)
		}
		if p.Type == "select" || p.Type == "multiselect" {
			for _, v := range vals {
				known := false
				for _, o := range p.Options {
					if o.ID == v {
						known = true
						break
					}
				}
				if !known {
					return fmt.Errorf("%s: %q is not an option of %s", label, v, propName(byID, c.Prop))
				}
			}
		}
	}
	// A rule with no finished actions is a pure guard: it still restricts
	// the move (allow-list + precondition) but automates nothing. Blank
	// actions never reach the server — the editor filters them out.
	if len(r.Do) == 0 {
		return nil
	}
	for _, a := range r.Do {
		switch a.Type {
		case "set_prop":
			if p, ok := byID[a.Prop]; !ok {
				return fmt.Errorf("%s: unknown property", label)
			} else if p.Type == "checklist" {
				return fmt.Errorf("%s: a checklist cannot be set, only asked for", label)
			}
		case "require_prop":
			p, ok := byID[a.Prop]
			if !ok {
				return fmt.Errorf("%s: unknown property", label)
			}
			switch p.Type {
			case "text", "date", "person", "select", "multiselect", "checklist":
			default:
				return fmt.Errorf("%s: only text, date, person, select, multiselect or checklist can be asked for", label)
			}
			if a.Mode != "" && a.Mode != "always" && a.Mode != "if_empty" {
				return fmt.Errorf("%s: unknown ask mode", label)
			}
		case "require_comment":
			// UI-only: there is nobody to ask over the API, so nothing to
			// validate beyond the shape. Agents post comments separately.
			if a.Mode != "" && a.Mode != "always" && a.Mode != "if_empty" {
				return fmt.Errorf("%s: unknown ask mode", label)
			}
		case "set_today":
			p, ok := byID[a.Prop]
			if !ok || p.Type != "date" {
				return fmt.Errorf("%s: date property required", label)
			}
		case "assign_me":
			p, ok := byID[a.Prop]
			if !ok || p.Type != "person" {
				return fmt.Errorf("%s: person property required", label)
			}
		case "webhook":
			if strings.TrimSpace(a.URL) == "" {
				return fmt.Errorf("%s: webhook URL required", label)
			}
		default:
			return fmt.Errorf("%s: unknown action", label)
		}
	}
	return nil
}

// validateWorkflow rejects unknown properties, unknown status options and bad
// action shapes before anything is stored.
func validateWorkflow(cfg *workflowConfig, schema []PropSchema) error {
	if cfg == nil {
		return nil
	}
	byID := map[string]PropSchema{}
	for _, p := range schema {
		byID[p.ID] = p
	}
	status, ok := byID[cfg.StatusPropID]
	if !ok {
		return fmt.Errorf("unknown status property")
	}
	if status.Type != "select" && status.Type != "multiselect" {
		return fmt.Errorf("status property must be a select")
	}
	validOpt := map[string]bool{}
	for _, o := range status.Options {
		validOpt[o.ID] = true
	}
	for i, r := range cfg.Rules {
		if err := validateWorkflowRule(r, fmt.Sprintf("rule %d", i+1), byID, validOpt); err != nil {
			return err
		}
	}
	return nil
}

// codeMembersOf lists the workspace members around a page for process-code
// resolution (person names become user ids). Unknown pages resolve to
// nobody rather than failing the save.
func (s *Server) codeMembersOf(pageID string) []codeMember {
	var ws string
	if err := s.db.QueryRow(`SELECT workspace_id FROM pages WHERE id = ?`, pageID).Scan(&ws); err != nil || ws == "" {
		return nil
	}
	rows, err := s.db.Query(`SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name`, ws)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []codeMember
	for rows.Next() {
		var m codeMember
		if err := rows.Scan(&m.ID, &m.Name); err == nil {
			out = append(out, m)
		}
	}
	return out
}

// blockLabel names a code block in errors: its name, or its position when
// unnamed.
func blockLabel(b workflowCodeBlock, i int) string {
	if strings.TrimSpace(b.Name) != "" {
		return b.Name
	}
	return fmt.Sprintf("block %d", i+1)
}

// checkWorkflowCode parses, resolves and validates every code block,
// returning every problem with its block name and line. The UI's live
// check shows the whole list; saves refuse on the first one.
func checkWorkflowCode(cfg *workflowConfig, schema []PropSchema, members []codeMember) []codeDiag {
	if cfg == nil || len(cfg.Code) == 0 {
		return nil
	}
	byID := map[string]PropSchema{}
	for _, p := range schema {
		byID[p.ID] = p
	}
	status, ok := byID[cfg.StatusPropID]
	if !ok {
		return []codeDiag{{Block: blockLabel(cfg.Code[0], 0), Msg: "unknown status property"}}
	}
	if status.Type != "select" && status.Type != "multiselect" {
		return []codeDiag{{Block: blockLabel(cfg.Code[0], 0), Msg: "status property must be a select"}}
	}
	validOpt := map[string]bool{}
	for _, o := range status.Options {
		validOpt[o.ID] = true
	}
	var out []codeDiag
	for bi, b := range cfg.Code {
		label := blockLabel(b, bi)
		f, diags := parseWorkflowCode(b.Source)
		for _, d := range diags {
			d.Block = label
			out = append(out, d)
		}
		if len(diags) > 0 {
			continue
		}
		rules, rdiags := resolveWorkflowCode(b.ID, f, schema, status, members)
		for _, d := range rdiags {
			d.Block = label
			out = append(out, d)
		}
		for i, r := range rules {
			if err := validateWorkflowRule(r, fmt.Sprintf("%s rule %d", label, i+1), byID, validOpt); err != nil {
				out = append(out, codeDiag{Block: label, Line: bLine(f, i), Msg: err.Error()})
			}
		}
	}
	return out
}

// bLine maps a resolved rule back to its source line for error labels.
func bLine(f *codeFile, i int) int {
	if f != nil && i < len(f.rules) {
		return f.rules[i].headLine
	}
	return 0
}

// compileWorkflowCode resolves every code block's source into its stored
// rules and assigns ids to blocks that lack them. Validation runs first
// (validateWorkflowCode), so this only maps names that are known good.
func compileWorkflowCode(cfg *workflowConfig, schema []PropSchema, members []codeMember) error {
	if cfg == nil || len(cfg.Code) == 0 {
		return nil
	}
	byID := map[string]PropSchema{}
	for _, p := range schema {
		byID[p.ID] = p
	}
	status := byID[cfg.StatusPropID]
	for i := range cfg.Code {
		if strings.TrimSpace(cfg.Code[i].ID) == "" {
			cfg.Code[i].ID = newID()
		}
		f, diags := parseWorkflowCode(cfg.Code[i].Source)
		if len(diags) > 0 {
			return fmt.Errorf("code %q line %d: %s", blockLabel(cfg.Code[i], i), diags[0].Line, diags[0].Msg)
		}
		rules, rdiags := resolveWorkflowCode(cfg.Code[i].ID, f, schema, status, members)
		if len(rdiags) > 0 {
			return fmt.Errorf("code %q line %d: %s", blockLabel(cfg.Code[i], i), rdiags[0].Line, rdiags[0].Msg)
		}
		if rules == nil {
			rules = []workflowRule{}
		}
		cfg.Code[i].Rules = rules
	}
	return nil
}

// validateWorkflowCode refuses a save on the first code problem.
func validateWorkflowCode(cfg *workflowConfig, schema []PropSchema, members []codeMember) error {
	if diags := checkWorkflowCode(cfg, schema, members); len(diags) > 0 {
		d := diags[0]
		if d.Line > 0 {
			return fmt.Errorf("code %q line %d: %s", d.Block, d.Line, d.Msg)
		}
		return fmt.Errorf("code %q: %s", d.Block, d.Msg)
	}
	return nil
}

// askCovers: a field the firing rules themselves ask for is filled by the
// dialog, not a reason to refuse up front — the require step's own check
// carries the guarantee (and names the field).
func askCovers(rules []workflowRule, prop string) bool {
	for _, r := range rules {
		for _, a := range r.Do {
			if a.Type == "require_prop" && a.Prop == prop {
				return true
			}
		}
	}
	return false
}

// requireSatisfied: asking for a checklist means getting it fully ticked —
// anything less still blocks. Any other property counts as filled as soon
// as it is non-empty.
func requireSatisfied(schemas map[string]PropSchema, prop string, props map[string]json.RawMessage) bool {
	if p, ok := schemas[prop]; ok && p.Type == "checklist" {
		return checklistDone(props, prop)
	}
	return propNonEmpty(props, prop)
}

func propString(props map[string]json.RawMessage, key string) string {
	raw, ok := props[key]
	if !ok || len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	// Multiselect stores an array; a single status move carries one value.
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
		return arr[0]
	}
	return strings.Trim(string(raw), `"`)
}

func propNonEmpty(props map[string]json.RawMessage, key string) bool {
	raw, ok := props[key]
	if !ok || len(raw) == 0 || string(raw) == "null" || string(raw) == `""` || string(raw) == "[]" {
		return false
	}
	return true
}

// propCondHolds evaluates one row-value condition against the row as it
// stands. Unknown properties never hold: the rule stays silent rather than
// misfiring on a stale column.
func propCondHolds(schemas map[string]PropSchema, props map[string]json.RawMessage, c workflowPropCond) bool {
	p, ok := schemas[c.Prop]
	if !ok {
		return false
	}
	want := c.Values
	if len(want) == 0 {
		if c.Value == "" {
			return false
		}
		want = []string{c.Value}
	}
	hit := false
	if p.Type == "multiselect" {
		if raw, present := props[c.Prop]; present && len(raw) > 0 {
			var arr []string
			if json.Unmarshal(raw, &arr) == nil {
				for _, s := range arr {
					for _, w := range want {
						if s == w {
							hit = true
							break
						}
					}
					if hit {
						break
					}
				}
			} else if str := propString(props, c.Prop); str != "" {
				for _, w := range want {
					if str == w {
						hit = true
						break
					}
				}
			}
		}
	} else {
		got := propString(props, c.Prop)
		for _, w := range want {
			if got == w {
				hit = true
				break
			}
		}
	}
	if c.Op == "" || c.Op == "is" {
		return hit
	}
	return !hit
}

// whenPropsHold: every value condition holds (AND). An empty list holds.
func whenPropsHold(schemas map[string]PropSchema, props map[string]json.RawMessage, conds []workflowPropCond) bool {
	for _, c := range conds {
		if !propCondHolds(schemas, props, c) {
			return false
		}
	}
	return true
}

// condDisplay renders a condition's value the way the reader sees it:
// option names for selects, raw text otherwise.
func condDisplay(schemas map[string]PropSchema, c workflowPropCond) string {
	if p, ok := schemas[c.Prop]; ok && (p.Type == "select" || p.Type == "multiselect") {
		for _, o := range p.Options {
			if o.ID == c.Value {
				if o.Name != "" {
					return o.Name
				}
				return o.ID
			}
		}
	}
	return c.Value
}

func checklistDone(props map[string]json.RawMessage, key string) bool {
	raw, ok := props[key]
	if !ok || len(raw) == 0 {
		return false
	}
	var items []struct {
		Done bool `json:"done"`
	}
	if err := json.Unmarshal(raw, &items); err != nil || len(items) == 0 {
		return false
	}
	for _, it := range items {
		if !it.Done {
			return false
		}
	}
	return true
}

// schemaIndex keys schema properties by id for the transition checks below.
func schemaIndex(raw string) map[string]PropSchema {
	idx := map[string]PropSchema{}
	for _, p := range parseSchemaProps(raw) {
		idx[p.ID] = p
	}
	return idx
}

// propName is the human name for 409 reasons, falling back to the id when
// the property is gone (stale rule pointing at a deleted column).
func propName(schemas map[string]PropSchema, id string) string {
	if p, ok := schemas[id]; ok && p.Name != "" {
		return p.Name
	}
	return id
}

// checkWorkflowTransition enforces the gates of a status move. merged holds
// the row AFTER the incoming patch is applied, patch holds only what this
// request carries: `always` answers must arrive in the request, `if_empty`
// ones may already be on the row.
// It returns the matching rules and auto-apply property updates (set_prop,
// set_today, assign_me) plus webhook URLs to fire after commit.
//
// One status can hold several rules and they combine with OR: each rule only
// ever guards its own gate. A foreign gate never blocks another road in —
// rules whose allow-list does not name this source are ignored entirely.
// The gate as a whole stays closed: when rules exist for `to` but none of
// them lets this `from` in, the move is refused. When several matching rules
// write one field, the last rule in the list wins.
func checkWorkflowTransition(cfg *workflowConfig, from, to string, merged, patch map[string]json.RawMessage, actorID string, schemas map[string]PropSchema) (matched []workflowRule, auto map[string]any, hooks []string, reason string) {
	auto = map[string]any{}
	var targeted []workflowRule
	for _, r := range cfg.Rules {
		if r.When.Type != "status_to" || r.When.To != to {
			continue
		}
		targeted = append(targeted, r)
		if len(r.AllowFrom) > 0 {
			ok := false
			for _, f := range r.AllowFrom {
				if f == from {
					ok = true
					break
				}
			}
			if !ok {
				continue
			}
		}
		if !whenPropsHold(schemas, merged, r.WhenProps) {
			continue
		}
		matched = append(matched, r)
	}
	if len(targeted) > 0 && len(matched) == 0 {
		// Name a value miss when the sources are fine: "not allowed from
		// this status" lies when a row value is what misses.
		for _, r := range targeted {
			if len(r.AllowFrom) > 0 {
				ok := false
				for _, f := range r.AllowFrom {
					if f == from {
						ok = true
						break
					}
				}
				if !ok {
					continue
				}
			}
			for _, c := range r.WhenProps {
				if !propCondHolds(schemas, merged, c) {
					if c.Op == "is_not" {
						return nil, nil, nil, fmt.Sprintf("%s must not be %q to move here", propName(schemas, c.Prop), condDisplay(schemas, c))
					}
					return nil, nil, nil, fmt.Sprintf("%s must be %q to move here", propName(schemas, c.Prop), condDisplay(schemas, c))
				}
			}
		}
		return nil, nil, nil, "transition is not allowed from this status"
	}
	for _, r := range matched {
		if r.Precondition != nil {
			if r.Precondition.ChecklistProp != "" && !checklistDone(merged, r.Precondition.ChecklistProp) {
				reason = "checklist is not complete"
				return nil, nil, nil, reason
			}
			if r.Precondition.RequiredProp != "" && !propNonEmpty(merged, r.Precondition.RequiredProp) && !askCovers(matched, r.Precondition.RequiredProp) {
				reason = "required property is empty"
				return nil, nil, nil, reason
			}
		}
		for _, a := range r.Do {
			switch a.Type {
			case "require_prop":
				name := propName(schemas, a.Prop)
				if a.Mode == "always" {
					if !requireSatisfied(schemas, a.Prop, patch) {
						reason = fmt.Sprintf("fill in %s before moving", name)
						return nil, nil, nil, reason
					}
				} else if !requireSatisfied(schemas, a.Prop, merged) {
					reason = fmt.Sprintf("fill in %s before moving", name)
					return nil, nil, nil, reason
				}
			case "require_comment":
				// Asked in the interface, unenforceable here: a status PATCH
				// carries no comment, and rejecting every comment-less move
				// would block the API entirely.
			case "set_prop":
				var v any
				if len(a.Value) > 0 {
					_ = json.Unmarshal(a.Value, &v)
				}
				// A relative day ("today+7d") resolves at the moment the rule
				// fires, borrowing the filter words' grammar (see smartdate.go).
				// Anything else — including a bad word — is stored as written,
				// and the reader sees the cell exactly as typed.
				if str, ok := v.(string); ok {
					if p, found := schemas[a.Prop]; found && p.Type == "date" {
						if day, ok := resolveSmartDate(str, time.Now().UTC()); ok {
							v = day
						}
					}
				}
				auto[a.Prop] = v
			case "set_today":
				auto[a.Prop] = time.Now().UTC().Format("2006-01-02")
			case "assign_me":
				if actorID != "" {
					auto[a.Prop] = []string{actorID}
				}
			case "webhook":
				if strings.TrimSpace(a.URL) != "" {
					hooks = append(hooks, strings.TrimSpace(a.URL))
				}
			}
		}
	}
	return matched, auto, hooks, ""
}

// checkWorkflowCreation runs the rules that fire when a row arrives in the
// collection — a fresh create or a move into it. There is no source status,
// so there is no allow-list; preconditions and asked-for fields are enforced
// against the row as it will stand (merged) and the values this write carries
// (patch), exactly like on a transition.
func checkWorkflowCreation(cfg *workflowConfig, merged, patch map[string]json.RawMessage, actorID string, schemas map[string]PropSchema) (matched []workflowRule, auto map[string]any, hooks []string, reason string) {
	auto = map[string]any{}
	var created []workflowRule
	for _, r := range cfg.Rules {
		if r.When.Type == "created" {
			created = append(created, r)
		}
	}
	for _, r := range created {
		if !whenPropsHold(schemas, merged, r.WhenProps) {
			continue
		}
		if r.Precondition != nil {
			if r.Precondition.ChecklistProp != "" && !checklistDone(merged, r.Precondition.ChecklistProp) {
				reason = "checklist is not complete"
				return nil, nil, nil, reason
			}
			if r.Precondition.RequiredProp != "" && !propNonEmpty(merged, r.Precondition.RequiredProp) && !askCovers(created, r.Precondition.RequiredProp) {
				reason = "required property is empty"
				return nil, nil, nil, reason
			}
		}
		matched = append(matched, r)
		for _, a := range r.Do {
			switch a.Type {
			case "require_prop":
				name := propName(schemas, a.Prop)
				if a.Mode == "always" {
					if !requireSatisfied(schemas, a.Prop, patch) {
						reason = fmt.Sprintf("fill in %s to create", name)
						return nil, nil, nil, reason
					}
				} else if !requireSatisfied(schemas, a.Prop, merged) {
					reason = fmt.Sprintf("fill in %s to create", name)
					return nil, nil, nil, reason
				}
			case "require_comment":
				// Asked in the interface, unenforceable here: a create
				// carries no comment, and rejecting every comment-less
				// create would block forms and agents entirely.
			case "set_prop":
				var v any
				if len(a.Value) > 0 {
					_ = json.Unmarshal(a.Value, &v)
				}
				// A relative day ("today+7d") resolves at the moment the rule
				// fires, borrowing the filter words' grammar (see smartdate.go).
				// Anything else — including a bad word — is stored as written,
				// and the reader sees the cell exactly as typed.
				if str, ok := v.(string); ok {
					if p, found := schemas[a.Prop]; found && p.Type == "date" {
						if day, ok := resolveSmartDate(str, time.Now().UTC()); ok {
							v = day
						}
					}
				}
				auto[a.Prop] = v
			case "set_today":
				auto[a.Prop] = time.Now().UTC().Format("2006-01-02")
			case "assign_me":
				if actorID != "" {
					auto[a.Prop] = []string{actorID}
				}
			case "webhook":
				if strings.TrimSpace(a.URL) != "" {
					hooks = append(hooks, strings.TrimSpace(a.URL))
				}
			}
		}
	}
	return matched, auto, hooks, ""
}

// fireWorkflowHook delivers one per-rule webhook call after the transition is
// stored. Fire-and-forget through the same safeDial guard as instance
// webhooks: an unreachable or unsafe URL is logged, never fatal.
func fireWorkflowHook(target, pageID, event string) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("workflow webhook: recovered from %v", rec)
		}
	}()
	payload, err := json.Marshal(map[string]any{
		"event": event,
		"at":    time.Now().UTC().Format(time.RFC3339Nano),
		"page":  map[string]any{"id": pageID, "path": "/p/" + pageID},
	})
	if err != nil {
		return
	}
	req, err := http.NewRequest("POST", target, bytes.NewReader(payload))
	if err != nil {
		log.Printf("workflow webhook: bad request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "salt.md/"+Version)
	client := &http.Client{
		Timeout:   webhookTimeout,
		Transport: &http.Transport{DialContext: safeDial},
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			return fmt.Errorf("a webhook endpoint must not redirect")
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("workflow webhook: delivery failed: %v", err)
		return
	}
	defer resp.Body.Close()
}
