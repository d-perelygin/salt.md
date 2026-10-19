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
				if _, ok := byID[a.Prop]; !ok {
					return fmt.Errorf("rule %d: unknown property", i+1)
				}
			case "require_prop":
				p, ok := byID[a.Prop]
				if !ok {
					return fmt.Errorf("rule %d: unknown property", i+1)
				}
				switch p.Type {
				case "text", "date", "person", "select", "multiselect":
				default:
					return fmt.Errorf("rule %d: only text, date, person or select can be asked for", i+1)
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

// checkWorkflowTransition enforces allow-list + precondition + asked-for
// fields for a status move. merged holds the row AFTER the incoming patch is
// applied, patch holds only what this request carries: `always` answers must
// arrive in the request, `if_empty` ones may already be on the row.
// It returns the matching rules and auto-apply property updates (set_prop,
// set_today, assign_me) plus webhook URLs to fire after commit.
func checkWorkflowTransition(cfg *workflowConfig, from, to string, merged, patch map[string]json.RawMessage, actorID string, names map[string]string) (matched []workflowRule, auto map[string]any, hooks []string, reason string) {
	auto = map[string]any{}
	for _, r := range cfg.Rules {
		if r.When.Type != "status_to" || r.When.To != to {
			continue
		}
		if len(r.AllowFrom) > 0 {
			ok := false
			for _, f := range r.AllowFrom {
				if f == from {
					ok = true
					break
				}
			}
			if !ok {
				reason = "transition is not allowed from this status"
				return nil, nil, nil, reason
			}
		}
		if r.Precondition != nil {
			if r.Precondition.ChecklistProp != "" && !checklistDone(merged, r.Precondition.ChecklistProp) {
				reason = "checklist is not complete"
				return nil, nil, nil, reason
			}
			if r.Precondition.RequiredProp != "" && !propNonEmpty(merged, r.Precondition.RequiredProp) {
				reason = "required property is empty"
				return nil, nil, nil, reason
			}
		}
		matched = append(matched, r)
		for _, a := range r.Do {
			switch a.Type {
			case "require_prop":
				name := names[a.Prop]
				if name == "" {
					name = a.Prop
				}
				if a.Mode == "always" {
					if !propNonEmpty(patch, a.Prop) {
						reason = fmt.Sprintf("fill in %s before moving", name)
						return nil, nil, nil, reason
					}
				} else if !propNonEmpty(merged, a.Prop) {
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
