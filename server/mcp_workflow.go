// Business-process tools: agents read and write the same When/Then rules
// the Process tab edits. Everything the tab enforces applies here too —
// unknown properties, dead status options and bad action shapes are refused
// with the reason, and a guarded move answers 409 with what is missing.
package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// --- Reading ---------------------------------------------------------------

// mcpGetWorkflow describes a database's process in the agent's own words:
// option and property NAMES (ids stay machine-readable beside them), one
// summary line per rule, rule ids for remove_workflow_rule.
func (s *Server) mcpGetWorkflow(pageID string) (string, error) {
	schemaRaw, _, workflowRaw, err := s.collectionConfig(pageID)
	if err != nil {
		return "", err
	}
	schema := parseSchemaProps(schemaRaw)
	names := map[string]string{}
	for _, p := range schema {
		names[p.ID] = p.Name
		if names[p.ID] == "" {
			names[p.ID] = p.ID
		}
	}
	propName := func(id string) string {
		if n, ok := names[id]; ok && n != "" {
			return n
		}
		if id == "" {
			return "—"
		}
		return id
	}
	cfg := parseWorkflow(workflowRaw)
	out := map[string]any{"page_id": pageID, "status_property": nil, "rules": []any{}}
	if cfg == nil {
		selects := []any{}
		for _, p := range schema {
			if p.Type == "select" || p.Type == "multiselect" {
				selects = append(selects, map[string]any{"id": p.ID, "name": propName(p.ID)})
			}
		}
		out["note"] = "no process stored: every move is allowed. To start one, add_workflow_rule with status_property set to one of the select properties below"
		out["status_candidates"] = selects
		b, _ := json.Marshal(out)
		return string(b), nil
	}
	statusOpts := map[string]string{}
	var allProps []struct {
		ID      string `json:"id"`
		Options []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"options"`
	}
	if err := json.Unmarshal([]byte(schemaRaw), &allProps); err == nil {
		for _, sp := range allProps {
			if sp.ID == cfg.StatusPropID {
				for _, o := range sp.Options {
					statusOpts[o.ID] = o.Name
				}
			}
		}
	}
	optName := func(id string) string {
		if n, ok := statusOpts[id]; ok && n != "" {
			return n
		}
		return id
	}
	out["status_property"] = map[string]any{"id": cfg.StatusPropID, "name": propName(cfg.StatusPropID)}
	list := []any{}
	for _, r := range cfg.Rules {
		when := map[string]any{"type": r.When.Type}
		if r.When.Type == "status_to" {
			when["to"] = map[string]any{"id": r.When.To, "name": optName(r.When.To)}
		}
		froms := []any{}
		for _, f := range r.AllowFrom {
			froms = append(froms, map[string]any{"id": f, "name": optName(f)})
		}
		actions := []any{}
		for _, a := range r.Do {
			actions = append(actions, workflowActionSummary(a, propName))
		}
		entry := map[string]any{
			"id":      r.ID,
			"when":    when,
			"summary": workflowRuleSummary(r, schemaRaw, propName, optName),
			"actions": actions,
		}
		if len(froms) > 0 {
			entry["allow_from"] = froms
		}
		if r.Precondition != nil {
			if r.Precondition.ChecklistProp != "" {
				entry["only_if_checklist"] = map[string]any{"id": r.Precondition.ChecklistProp, "name": propName(r.Precondition.ChecklistProp)}
			}
			if r.Precondition.RequiredProp != "" {
				entry["only_if_filled"] = map[string]any{"id": r.Precondition.RequiredProp, "name": propName(r.Precondition.RequiredProp)}
			}
		}
		if len(r.WhenProps) > 0 {
			conds := []any{}
			for _, c := range r.WhenProps {
				conds = append(conds, map[string]any{
					"property": map[string]any{"id": c.Prop, "name": propName(c.Prop)},
					"op":       condOpWord(c.Op),
					"value":     condValueWord(schemaRaw, c.Prop, c.Value),
				})
			}
			entry["only_if"] = conds
		}
		list = append(list, entry)
	}
	out["rules"] = list
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return wrapUntrusted(string(b)), nil
}

// collectionConfig loads the three halves of a database's configuration.
func (s *Server) collectionConfig(pageID string) (schema, views, workflow string, err error) {
	err = s.db.QueryRow(`SELECT schema, views, workflow FROM collections WHERE page_id = ?`, pageID).Scan(&schema, &views, &workflow)
	if err != nil {
		return "", "", "", fmt.Errorf("page %q is not a database", pageID)
	}
	return schema, views, workflow, nil
}

func workflowActionSummary(a workflowAction, propName func(string) string) map[string]any {
	m := map[string]any{"action": a.Type}
	switch a.Type {
	case "set_prop":
		m["property"] = map[string]any{"id": a.Prop, "name": propName(a.Prop)}
		var v any
		if len(a.Value) > 0 {
			_ = json.Unmarshal(a.Value, &v)
		}
		m["value"] = v
	case "require_prop":
		m["property"] = map[string]any{"id": a.Prop, "name": propName(a.Prop)}
		m["mode"] = a.Mode
	case "require_comment":
		m["mode"] = a.Mode
	case "set_today", "assign_me":
		m["property"] = map[string]any{"id": a.Prop, "name": propName(a.Prop)}
	case "webhook":
		m["url"] = a.URL
	}
	return m
}

func workflowRuleSummary(r workflowRule, schemaRaw string, propName func(string) string, optName func(string) string) string {
	parts := []string{}
	if r.When.Type == "status_to" {
		parts = append(parts, fmt.Sprintf("when the status becomes %s", optName(r.When.To)))
	} else {
		parts = append(parts, "when a row is created")
	}
	for _, f := range r.AllowFrom {
		parts = append(parts, "only from "+optName(f))
	}
	for _, c := range r.WhenProps {
		parts = append(parts, fmt.Sprintf("only if %s %s %s", propName(c.Prop), condOpWord(c.Op), condValueWord(schemaRaw, c.Prop, c.Value)))
	}
	if r.Precondition != nil {
		if r.Precondition.ChecklistProp != "" {
			parts = append(parts, "only if the "+propName(r.Precondition.ChecklistProp)+" checklist is complete")
		}
		if r.Precondition.RequiredProp != "" {
			parts = append(parts, "only if "+propName(r.Precondition.RequiredProp)+" is filled")
		}
	}
	for _, a := range r.Do {
		switch a.Type {
		case "set_prop":
			var v any
			if len(a.Value) > 0 {
				_ = json.Unmarshal(a.Value, &v)
			}
			vs, _ := json.Marshal(v)
			if len(vs) > 40 {
				vs = append(vs[:37], '.', '.', '.')
			}
			parts = append(parts, fmt.Sprintf("set %s to %s", propName(a.Prop), string(vs)))
		case "require_prop":
			parts = append(parts, fmt.Sprintf("ask %s (%s)", propName(a.Prop), askModeWord(a.Mode)))
		case "require_comment":
			parts = append(parts, fmt.Sprintf("ask for a comment (%s)", askModeWord(a.Mode)))
		case "set_today":
			parts = append(parts, "stamp today into "+propName(a.Prop))
		case "assign_me":
			parts = append(parts, "assign the mover to "+propName(a.Prop))
		case "webhook":
			parts = append(parts, "call webhook "+a.URL)
		}
	}
	if len(parts) == 1 {
		parts = append(parts, "no actions: a pure guard")
	}
	return strings.Join(parts, " · ")
}

func askModeWord(mode string) string {
	if mode == "always" {
		return "always"
	}
	return "if empty"
}

// condOpWord reads the way an agent wrote the operator back to it.
func condOpWord(op string) string {
	if op == "is_not" {
		return "is not"
	}
	return "is"
}

// condValueWord renders a condition value the way the reader sees it:
// option names for selects, raw text otherwise.
func condValueWord(schemaRaw, propID, value string) string {
	var schema []struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Options []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"options"`
	}
	if err := json.Unmarshal([]byte(schemaRaw), &schema); err != nil {
		return value
	}
	for _, p := range schema {
		if p.ID != propID {
			continue
		}
		if p.Type != "select" && p.Type != "multiselect" {
			return value
		}
		for _, o := range p.Options {
			if o.ID == value {
				if o.Name != "" {
					return o.Name
				}
				return o.ID
			}
		}
		return value
	}
	return value
}

// --- Writing ---------------------------------------------------------------

// The rule an agent sends. Property references are ids (get_collection lists
// them); status options accept an id or a NAME, case-insensitive, because
// agents think in the words on the board.
type workflowRuleSpec struct {
	PageID          string               `json:"page_id"`
	RuleID          string               `json:"rule_id"`
	StatusProperty  string               `json:"status_property"`
	When            workflowWhenSpec     `json:"when"`
	AllowFrom       []string             `json:"allow_from"`
	OnlyIfChecklist string               `json:"only_if_checklist"`
	OnlyIfFilled    string               `json:"only_if_filled"`
	OnlyIf          []workflowCondSpec   `json:"only_if"`
	Actions         []workflowActionSpec `json:"actions"`
}

// One row-value condition: the rule fires only when the row's property is
// (or is not) the value. Value is an option id or NAME for selects (resolved
// case-insensitively like status options), raw text for text and numbers.
type workflowCondSpec struct {
	Property string          `json:"property"`
	Op       string          `json:"op"`
	Value    json.RawMessage `json:"value"`
}

type workflowWhenSpec struct {
	Type string `json:"type"`
	To   string `json:"to"`
}

type workflowActionSpec struct {
	Action   string          `json:"action"`
	Property string          `json:"property"`
	Value    json.RawMessage `json:"value"`
	Mode     string          `json:"mode"`
	URL      string          `json:"url"`
}

// mcpAddWorkflowRule appends one rule to a database's process, creating the
// process when status_property names its select property. Validation runs
// before anything is stored, and a refusal names the exact problem.
func (s *Server) mcpAddWorkflowRule(raw json.RawMessage) (string, error) {
	var spec workflowRuleSpec
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&spec); err != nil {
		return "", fmt.Errorf("bad rule: %v — send {page_id, when:{type,to}, allow_from?, only_if_checklist?, only_if_filled?, only_if:[{property,op?,value}]?, actions:[{action,property?,value?,mode?,url?}]}", err)
	}
	if spec.PageID == "" {
		return "", fmt.Errorf("page_id is required")
	}
	schemaRaw, _, workflowRaw, err := s.collectionConfig(spec.PageID)
	if err != nil {
		return "", err
	}
	cfg := parseWorkflow(workflowRaw)
	statusProp := strings.TrimSpace(spec.StatusProperty)
	if cfg == nil {
		if statusProp == "" {
			return "", fmt.Errorf("this database has no process yet: pass status_property with the id of a select property to start one (get_workflow lists the candidates)")
		}
		cfg = &workflowConfig{StatusPropID: statusProp}
	} else if statusProp != "" && statusProp != cfg.StatusPropID {
		return "", fmt.Errorf("this database already runs its process on another property — one status property per database")
	}
	rule, err := buildWorkflowRule(spec, schemaRaw, cfg.StatusPropID)
	if err != nil {
		return "", err
	}
	cfg.Rules = append(cfg.Rules, *rule)
	if err := validateWorkflow(cfg, parseSchemaProps(schemaRaw)); err != nil {
		return "", err
	}
	if err := s.saveWorkflow(spec.PageID, cfg); err != nil {
		return "", err
	}
	schema := parseSchemaProps(schemaRaw)
	names := map[string]string{}
	for _, p := range schema {
		names[p.ID] = p.Name
	}
	propName := func(id string) string {
		if n, ok := names[id]; ok && n != "" {
			return n
		}
		return id
	}
	optNames := map[string]string{}
	var allProps []struct {
		ID      string `json:"id"`
		Options []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"options"`
	}
	if err := json.Unmarshal([]byte(schemaRaw), &allProps); err == nil {
		for _, sp := range allProps {
			if sp.ID == cfg.StatusPropID {
				for _, o := range sp.Options {
					optNames[o.ID] = o.Name
				}
			}
		}
	}
	optName := func(id string) string {
		if n, ok := optNames[id]; ok && n != "" {
			return n
		}
		return id
	}
	b, _ := json.Marshal(map[string]any{
		"rule_id": rule.ID,
		"summary": workflowRuleSummary(*rule, schemaRaw, propName, optName),
	})
	return string(b), nil
}

// mcpRemoveWorkflowRule drops one rule by the id get_workflow reported.
func (s *Server) mcpRemoveWorkflowRule(pageID, ruleID string) (string, error) {
	if ruleID == "" {
		return "", fmt.Errorf("rule_id is required (get_workflow lists them)")
	}
	_, _, workflowRaw, err := s.collectionConfig(pageID)
	if err != nil {
		return "", err
	}
	cfg := parseWorkflow(workflowRaw)
	if cfg == nil {
		return "", fmt.Errorf("this database has no process stored")
	}
	kept := cfg.Rules[:0:0]
	found := false
	for _, r := range cfg.Rules {
		if r.ID == ruleID {
			found = true
			continue
		}
		kept = append(kept, r)
	}
	if !found {
		return "", fmt.Errorf("no rule %q on this database (get_workflow lists the ids)", ruleID)
	}
	cfg.Rules = kept
	if err := s.saveWorkflow(pageID, cfg); err != nil {
		return "", err
	}
	return fmt.Sprintf("removed rule %q (%d left)", ruleID, len(kept)), nil
}

func (s *Server) saveWorkflow(pageID string, cfg *workflowConfig) error {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`UPDATE collections SET workflow = ? WHERE page_id = ?`, string(raw), pageID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`UPDATE pages SET updated_at = ? WHERE id = ?`, now(), pageID); err != nil {
		return err
	}
	s.pagesChanged()
	// An open board draws the gates it just learned: without this the new
	// rule stays invisible until a reload.
	s.rowsChanged(pageID)
	return nil
}

// buildWorkflowRule turns the agent's spec into a stored rule, resolving
// status option names to ids the way set_properties resolves values.
func buildWorkflowRule(spec workflowRuleSpec, schemaRaw, statusPropID string) (*workflowRule, error) {
	whenType := strings.TrimSpace(spec.When.Type)
	if whenType != "status_to" && whenType != "created" {
		return nil, fmt.Errorf("when.type must be \"status_to\" or \"created\"")
	}
	rule := &workflowRule{ID: newID(), When: workflowWhen{Type: whenType}}
	if spec.When.Type == "status_to" {
		if strings.TrimSpace(spec.When.To) == "" {
			return nil, fmt.Errorf("when.to is required for a status_to rule: the option id or name the row moves into")
		}
		to, err := wfOptionID(schemaRaw, statusPropID, spec.When.To)
		if err != nil {
			return nil, err
		}
		rule.When.To = to
		for _, f := range spec.AllowFrom {
			id, err := wfOptionID(schemaRaw, statusPropID, f)
			if err != nil {
				return nil, fmt.Errorf("allow_from %v", err)
			}
			rule.AllowFrom = append(rule.AllowFrom, id)
		}
	} else {
		if strings.TrimSpace(spec.When.To) != "" || len(spec.AllowFrom) > 0 {
			return nil, fmt.Errorf("a created rule fires on every arrival: no to and no allow_from")
		}
	}
	pre := workflowPrecondition{}
	if spec.OnlyIfChecklist != "" {
		pre.ChecklistProp = spec.OnlyIfChecklist
	}
	if spec.OnlyIfFilled != "" {
		pre.RequiredProp = spec.OnlyIfFilled
	}
	if pre != (workflowPrecondition{}) {
		rule.Precondition = &pre
	}
	for i, c := range spec.OnlyIf {
		propID := strings.TrimSpace(c.Property)
		if propID == "" {
			return nil, fmt.Errorf("only_if[%d]: property is required", i)
		}
		op := strings.TrimSpace(c.Op)
		if op == "" {
			op = "is"
		}
		if op != "is" && op != "is_not" {
			return nil, fmt.Errorf("only_if[%d]: op must be \"is\" or \"is_not\"", i)
		}
		value, err := wfCondValue(schemaRaw, propID, c.Value)
		if err != nil {
			return nil, fmt.Errorf("only_if[%d]: %v", i, err)
		}
		rule.WhenProps = append(rule.WhenProps, workflowPropCond{Prop: propID, Op: op, Value: value})
	}
	for i, a := range spec.Actions {
		action := strings.TrimSpace(a.Action)
		if action == "" {
			return nil, fmt.Errorf("actions[%d]: action is required: set, ask, ask_comment, assign_me, set_today or webhook", i)
		}
		switch action {
		case "set":
			if a.Property == "" {
				return nil, fmt.Errorf("actions[%d]: set needs property", i)
			}
			rule.Do = append(rule.Do, workflowAction{Type: "set_prop", Prop: a.Property, Value: a.Value})
		case "ask":
			if a.Property == "" {
				return nil, fmt.Errorf("actions[%d]: ask needs property", i)
			}
			mode := strings.TrimSpace(a.Mode)
			if mode == "" {
				mode = "if_empty"
			}
			if mode != "always" && mode != "if_empty" {
				return nil, fmt.Errorf("actions[%d]: mode must be \"always\" or \"if_empty\"", i)
			}
			rule.Do = append(rule.Do, workflowAction{Type: "require_prop", Prop: a.Property, Mode: mode})
		case "ask_comment":
			mode := strings.TrimSpace(a.Mode)
			if mode == "" {
				mode = "always"
			}
			if mode != "always" && mode != "if_empty" {
				return nil, fmt.Errorf("actions[%d]: mode must be \"always\" or \"if_empty\"", i)
			}
			rule.Do = append(rule.Do, workflowAction{Type: "require_comment", Mode: mode})
		case "assign_me":
			if a.Property == "" {
				return nil, fmt.Errorf("actions[%d]: assign_me needs property", i)
			}
			rule.Do = append(rule.Do, workflowAction{Type: "assign_me", Prop: a.Property})
		case "set_today":
			if a.Property == "" {
				return nil, fmt.Errorf("actions[%d]: set_today needs property", i)
			}
			rule.Do = append(rule.Do, workflowAction{Type: "set_today", Prop: a.Property})
		case "webhook":
			if strings.TrimSpace(a.URL) == "" {
				return nil, fmt.Errorf("actions[%d]: webhook needs url", i)
			}
			rule.Do = append(rule.Do, workflowAction{Type: "webhook", URL: strings.TrimSpace(a.URL)})
		default:
			return nil, fmt.Errorf("actions[%d]: unknown action %q: set, ask, ask_comment, assign_me, set_today or webhook", i, a.Action)
		}
	}
	return rule, nil
}

// wfCondValue resolves a condition value the way set_properties resolves
// values: option id or NAME (case-insensitive) for selects, raw text for
// text and numbers. Unknown properties and foreign options refuse with the
// list of what exists, so the retry writes itself.
func wfCondValue(schemaRaw, propID string, raw json.RawMessage) (string, error) {
	var s string
	value := strings.TrimSpace(string(raw))
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &s); err == nil {
			value = strings.TrimSpace(s)
		} else {
			value = strings.Trim(value, `"`)
		}
	}
	if value == "" {
		return "", fmt.Errorf("value is required")
	}
	var schema []struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Options []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"options"`
	}
	if err := json.Unmarshal([]byte(schemaRaw), &schema); err != nil {
		return "", fmt.Errorf("cannot read this database's schema")
	}
	for _, p := range schema {
		if p.ID != propID {
			continue
		}
		switch p.Type {
		case "select", "multiselect", "text", "number":
		default:
			return "", fmt.Errorf("conditions support select, multiselect, text and number properties")
		}
		if p.Type != "select" && p.Type != "multiselect" {
			return value, nil
		}
		names := []string{}
		for _, o := range p.Options {
			names = append(names, o.Name)
			if o.ID == value || strings.EqualFold(o.Name, value) {
				return o.ID, nil
			}
		}
		if len(names) == 0 {
			return "", fmt.Errorf("%q has no options yet", propID)
		}
		return "", fmt.Errorf("%q is not an option here — pick one of: %s", value, strings.Join(names, ", "))
	}
	return "", fmt.Errorf("unknown property %q", propID)
}

// wfOptionID resolves a status option by id or by NAME, case-insensitive —
// agents think in the words on the board. An unresolvable value lists what
// actually exists, so the retry writes itself.
func wfOptionID(schemaRaw, statusPropID, nameOrID string) (string, error) {
	var schema []struct {
		ID      string `json:"id"`
		Options []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"options"`
	}
	if err := json.Unmarshal([]byte(schemaRaw), &schema); err != nil {
		return "", fmt.Errorf("cannot read this database's schema")
	}
	want := strings.TrimSpace(nameOrID)
	names := []string{}
	for _, p := range schema {
		if p.ID != statusPropID {
			continue
		}
		for _, o := range p.Options {
			names = append(names, o.Name)
			if o.ID == want || strings.EqualFold(o.Name, want) {
				return o.ID, nil
			}
		}
	}
	if len(names) == 0 {
		return "", fmt.Errorf("%q is not a status option (this property has no options yet)", want)
	}
	return "", fmt.Errorf("%q is not a status option here — pick one of: %s", want, strings.Join(names, ", "))
}
