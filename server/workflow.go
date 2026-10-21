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

type workflowRule struct {
	ID           string                `json:"id"`
	When         workflowWhen          `json:"when"`
	AllowFrom    []string              `json:"allowFrom"`
	Precondition *workflowPrecondition `json:"precondition"`
	Do           []workflowAction      `json:"do"`
}

type workflowConfig struct {
	StatusPropID string         `json:"statusPropId"`
	Rules        []workflowRule `json:"rules"`
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
	if cfg.StatusPropID == "" || len(cfg.Rules) == 0 {
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
		ID string `json:"id"`
	} `json:"options"`
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
		if r.When.Type != "status_to" && r.When.Type != "created" {
			return fmt.Errorf("rule %d: unknown trigger", i+1)
		}
		if r.When.Type == "status_to" && !validOpt[r.When.To] {
			return fmt.Errorf("rule %d: unknown status option", i+1)
		}
		for _, from := range r.AllowFrom {
			if !validOpt[from] {
				return fmt.Errorf("rule %d: unknown source status", i+1)
			}
		}
		if r.Precondition != nil {
			if r.Precondition.ChecklistProp != "" {
				p, ok := byID[r.Precondition.ChecklistProp]
				if !ok || p.Type != "checklist" {
					return fmt.Errorf("rule %d: checklist property must be a checklist", i+1)
				}
			}
			if r.Precondition.RequiredProp != "" {
				if _, ok := byID[r.Precondition.RequiredProp]; !ok {
					return fmt.Errorf("rule %d: unknown required property", i+1)
				}
			}
		}
		// A rule with no finished actions is a pure guard: it still restricts
		// the move (allow-list + precondition) but automates nothing. Blank
		// actions never reach the server — the editor filters them out.
		if len(r.Do) == 0 {
			continue
		}
		for _, a := range r.Do {
			switch a.Type {
			case "set_prop":
				if p, ok := byID[a.Prop]; !ok {
					return fmt.Errorf("rule %d: unknown property", i+1)
				} else if p.Type == "checklist" {
					return fmt.Errorf("rule %d: a checklist cannot be set, only asked for", i+1)
				}
			case "require_prop":
				p, ok := byID[a.Prop]
				if !ok {
					return fmt.Errorf("rule %d: unknown property", i+1)
				}
				switch p.Type {
				case "text", "date", "person", "select", "multiselect", "checklist":
				default:
					return fmt.Errorf("rule %d: only text, date, person, select or checklist can be asked for", i+1)
				}
				if a.Mode != "" && a.Mode != "always" && a.Mode != "if_empty" {
					return fmt.Errorf("rule %d: unknown ask mode", i+1)
				}
			case "require_comment":
				// UI-only: there is nobody to ask over the API, so nothing to
				// validate beyond the shape. Agents post comments separately.
				if a.Mode != "" && a.Mode != "always" && a.Mode != "if_empty" {
					return fmt.Errorf("rule %d: unknown ask mode", i+1)
				}
			case "set_today":
				p, ok := byID[a.Prop]
				if !ok || p.Type != "date" {
					return fmt.Errorf("rule %d: date property required", i+1)
				}
			case "assign_me":
				p, ok := byID[a.Prop]
				if !ok || p.Type != "person" {
					return fmt.Errorf("rule %d: person property required", i+1)
				}
			case "webhook":
				if strings.TrimSpace(a.URL) == "" {
					return fmt.Errorf("rule %d: webhook URL required", i+1)
				}
			default:
				return fmt.Errorf("rule %d: unknown action", i+1)
			}
		}
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
		matched = append(matched, r)
	}
	if len(targeted) > 0 && len(matched) == 0 {
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
