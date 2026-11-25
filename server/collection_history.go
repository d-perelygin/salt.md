package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// A database's structure — its properties, its views and its process — is not
// a page's body. Schema and views live in the `collections` table; the page
// itself is empty. Page revisions therefore say nothing about the shape of the
// database, and a removed column or view used to be simply gone.
//
// This is a separate snapshot store on the same rules as page history: a
// version is the whole structure at one moment, what changed is computed once,
// against the version above it, and stored with it. Restoring never destroys:
// the state being replaced is written as a version first.
//
// Row values are deliberately NOT part of this. They live in pages.props and
// belong to the row's own history; a structure restore never touches them, so
// removing a column and bringing it back returns the values with it.

const (
	// A database is edited in bursts too: dragging column widths, typing a
	// name, moving a view. Two minutes is the page editor's own window, and
	// the same reasoning applies — a burst leaves one version, not twenty.
	collectionRevisionThrottle = 2 * time.Minute
	collectionRevisionKeep     = 50
)

// errStructureConflict marks a restore that would leave the process pointing
// at a property or option that no longer exists. The handler answers 409: the
// request was fine, the result would not be, and the caller should restore
// more of the structure instead.
var errStructureConflict = errors.New("structure conflict")

// collectionState is one database's shape, canonicalised. Canonical means
// map keys in a fixed order and column widths removed: the encoding of the
// JSON is not part of the structure, and a width is the reader's layout, not
// the database's shape.
type collectionState struct {
	schema   string // property definitions, JSON array
	views    string // view configs, JSON array, colWidths stripped
	workflow string // process, JSON object, "" when there is none
	template string // page id new rows are made from, "" for blank rows
}

func (st collectionState) equal(o collectionState) bool {
	return st.schema == o.schema && st.views == o.views &&
		st.workflow == o.workflow && st.template == o.template
}

func (st collectionState) empty() bool {
	return st.schema == "[]" && st.views == "[]" && st.workflow == "" && st.template == ""
}

// ---- reading and writing state ---------------------------------------------

func (s *Server) isCollection(pageID string) bool {
	var n int
	if s.db.QueryRow(`SELECT COUNT(*) FROM collections WHERE page_id = ?`, pageID).Scan(&n) != nil {
		return false
	}
	return n > 0
}

// collectionStructureTool names the MCP tools that change a database's shape.
// Their history is captured around the call in mcpCall, where the actor is in
// hand and a test sees one place instead of six signatures.
func collectionStructureTool(name string) bool {
	switch name {
	case "update_schema", "set_view", "delete_view",
		"add_workflow_rule", "remove_workflow_rule", "set_workflow_code":
		return true
	}
	return false
}

func (s *Server) readRawCollectionState(pageID string) (collectionState, bool) {
	var schema, views, workflow, template string
	err := s.db.QueryRow(`SELECT schema, views, COALESCE(workflow, ''), COALESCE(new_from_template, '')
		FROM collections WHERE page_id = ?`, pageID).Scan(&schema, &views, &workflow, &template)
	if err != nil {
		return collectionState{}, false
	}
	return collectionState{
		schema:   canonicalCollectionJSON(schema, "[]", false),
		views:    canonicalCollectionJSON(views, "[]", true),
		workflow: canonicalCollectionWorkflow(workflow),
		template: strings.TrimSpace(template),
	}, true
}

// canonicalCollectionJSON re-encodes a JSON array with its map keys sorted, so
// two saves that differ only in key order compare equal. Widths are dropped
// from views: they are layout, not structure, and a restored version must not
// yank a column back to a width somebody dragged this morning.
func canonicalCollectionJSON(raw, fallback string, stripWidths bool) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return fallback
	}
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return raw
	}
	if stripWidths {
		if list, ok := v.([]any); ok {
			for _, item := range list {
				if m, ok := item.(map[string]any); ok {
					delete(m, "colWidths")
				}
			}
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return raw
	}
	return string(b)
}

// canonicalCollectionWorkflow treats "no process" as one state, however it is
// spelled: an empty object, a null, a status with no rules.
func canonicalCollectionWorkflow(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return ""
	}
	if cfg := parseWorkflow(raw); cfg == nil || (cfg.StatusPropID == "" && len(cfg.Rules) == 0 && len(cfg.Code) == 0) {
		return ""
	}
	return canonicalCollectionJSON(raw, "", false)
}

func (s *Server) rawCollectionViews(pageID string) string {
	var raw string
	if s.db.QueryRow(`SELECT views FROM collections WHERE page_id = ?`, pageID).Scan(&raw) != nil {
		return "[]"
	}
	return raw
}

// ---- the store -------------------------------------------------------------

func (s *Server) insertCollectionRevision(pageID string, st collectionState, authorID, authorName, changes string) string {
	// The store never keeps a width, whoever the caller is: a revision is the
	// shape, and a width belongs to the reader who dragged it.
	st.schema = canonicalCollectionJSON(st.schema, "[]", false)
	st.views = canonicalCollectionJSON(st.views, "[]", true)
	st.workflow = canonicalCollectionWorkflow(st.workflow)
	id := newID()
	_, err := s.db.Exec(`INSERT INTO collection_revisions
		(id, page_id, seq, created_at, author_id, author_name, schema, views, workflow, new_from_template, changes)
		SELECT ?, ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?
		FROM collection_revisions WHERE page_id = ?`,
		id, pageID, now(), authorID, authorName, st.schema, st.views, st.workflow, st.template, changes, pageID)
	if err != nil {
		return ""
	}
	// Prune to the newest N, by seq: two versions written in the same instant
	// must still have an order.
	s.db.Exec(`DELETE FROM collection_revisions WHERE page_id = ? AND seq NOT IN (
		SELECT seq FROM collection_revisions WHERE page_id = ? ORDER BY seq DESC LIMIT ?)`,
		pageID, pageID, collectionRevisionKeep)
	return id
}

func (s *Server) newestCollectionRevision(pageID string) (string, collectionState, string, bool) {
	var id, createdAt string
	var st collectionState
	err := s.db.QueryRow(`SELECT id, created_at, schema, views, COALESCE(workflow, ''), COALESCE(new_from_template, '')
		FROM collection_revisions WHERE page_id = ? ORDER BY seq DESC LIMIT 1`, pageID).
		Scan(&id, &createdAt, &st.schema, &st.views, &st.workflow, &st.template)
	if err != nil {
		return "", collectionState{}, "", false
	}
	return id, st, createdAt, true
}

func (s *Server) oldestCollectionRevision(pageID string) string {
	var id string
	s.db.QueryRow(`SELECT id FROM collection_revisions WHERE page_id = ? ORDER BY seq ASC LIMIT 1`, pageID).Scan(&id)
	return id
}

func (s *Server) collectionRevisionState(pageID, revID string) (collectionState, bool) {
	var st collectionState
	err := s.db.QueryRow(`SELECT schema, views, COALESCE(workflow, ''), COALESCE(new_from_template, '')
		FROM collection_revisions WHERE id = ? AND page_id = ?`, revID, pageID).
		Scan(&st.schema, &st.views, &st.workflow, &st.template)
	if err != nil {
		return collectionState{}, false
	}
	return st, true
}

// appendCollectionRevision writes one version, unless it equals the one above
// it. Throttled saves are dropped rather than merged: the next save records
// the state that includes them, so nothing is lost.
func (s *Server) appendCollectionRevision(pageID string, st collectionState, authorID, authorName string, force bool) string {
	_, newest, newestAt, ok := s.newestCollectionRevision(pageID)
	if !ok {
		return s.insertCollectionRevision(pageID, st, authorID, authorName, "")
	}
	if newest.equal(st) {
		return ""
	}
	changes := marshalCollectionChanges(diffCollectionStates(newest, st))
	if !force && !collectionChangesForce(changes) {
		if t, err := time.Parse(time.RFC3339Nano, newestAt); err == nil && time.Since(t) < collectionRevisionThrottle {
			return ""
		}
	}
	return s.insertCollectionRevision(pageID, st, authorID, authorName, changes)
}

// recordCollectionRevision is the hook every structural write calls AFTER it
// has written. before is the state the write replaced, so a database with no
// history yet keeps the state it looked like before its first recorded change.
func (s *Server) recordCollectionRevision(pageID, authorID, authorName string, before collectionState) {
	s.recordCollectionRevisionWithin(pageID, authorID, authorName, before, false)
}

// recordCollectionRevisionForced skips the throttle. A side effect of
// renaming an account is deliberate and rare enough that it must not be
// swallowed by a structure save a minute earlier.
func (s *Server) recordCollectionRevisionForced(pageID, authorID, authorName string, before collectionState) {
	s.recordCollectionRevisionWithin(pageID, authorID, authorName, before, true)
}

func (s *Server) recordCollectionRevisionWithin(pageID, authorID, authorName string, before collectionState, force bool) {
	after, ok := s.readRawCollectionState(pageID)
	if !ok || before.equal(after) {
		return
	}
	_, _, _, had := s.newestCollectionRevision(pageID)
	if !had {
		s.insertCollectionRevision(pageID, before, "", "", "")
	}
	s.appendCollectionRevision(pageID, after, authorID, authorName, force || !had)
}

// backfillCollectionRevisions gives every database that predates this feature
// one baseline version, so its first real edit has something to compare with.
// Idempotent: a database that already has any version is left alone.
func backfillCollectionRevisions(db *sql.DB) error {
	rows, err := db.Query(`SELECT c.page_id FROM collections c
		WHERE NOT EXISTS (SELECT 1 FROM collection_revisions r WHERE r.page_id = c.page_id)`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		var schema, views, workflow, template string
		if db.QueryRow(`SELECT schema, views, COALESCE(workflow, ''), COALESCE(new_from_template, '')
			FROM collections WHERE page_id = ?`, id).Scan(&schema, &views, &workflow, &template) != nil {
			continue
		}
		st := collectionState{
			schema:   canonicalCollectionJSON(schema, "[]", false),
			views:    canonicalCollectionJSON(views, "[]", true),
			workflow: canonicalCollectionWorkflow(workflow),
			template: strings.TrimSpace(template),
		}
		if _, err := db.Exec(`INSERT INTO collection_revisions
			(id, page_id, seq, created_at, author_id, author_name, schema, views, workflow, new_from_template, changes)
			VALUES (?, ?, 0, ?, '', '', ?, ?, ?, ?, '')`,
			newID(), id, now(), st.schema, st.views, st.workflow, st.template); err != nil {
			return err
		}
	}
	return nil
}

// ---- what changed ----------------------------------------------------------

// collectionChange is one readable difference, stored with the version that
// introduced it. Ids travel with it so the interface can offer "restore this
// column" on the very row that says the column disappeared.
type collectionChange struct {
	Kind  string `json:"kind"`
	Scope string `json:"scope"`           // property | view | workflow | template
	ID    string `json:"id,omitempty"`    // property or view id
	Item  string `json:"item,omitempty"`  // option name, when the change is inside one
	Name  string `json:"name,omitempty"`  // the column or view the change belongs to
	Field string `json:"field,omitempty"` // which part changed: type, options, filters…
	From  string `json:"from,omitempty"`
	To    string `json:"to,omitempty"`
}

func marshalCollectionChanges(changes []collectionChange) string {
	if len(changes) == 0 {
		return ""
	}
	b, err := json.Marshal(changes)
	if err != nil {
		return ""
	}
	return string(b)
}

// collectionChangesForce says whether a change is worth recording at once: a
// column, a view, an option or a rule appearing or disappearing is a
// deliberate act, while typing a name is not.
func collectionChangesForce(raw string) bool {
	var changes []collectionChange
	if json.Unmarshal([]byte(raw), &changes) != nil {
		return true
	}
	for _, c := range changes {
		if strings.HasSuffix(c.Kind, "_added") || strings.HasSuffix(c.Kind, "_removed") {
			return true
		}
	}
	return false
}

func diffCollectionStates(prev, now collectionState) []collectionChange {
	out := []collectionChange{}
	out = append(out, diffCollectionSchema(prev.schema, now.schema)...)
	out = append(out, diffCollectionViews(prev.views, now.views)...)
	out = append(out, diffCollectionWorkflow(prev, now)...)
	if prev.template != now.template {
		out = append(out, collectionChange{Kind: "template_changed", Scope: "template", From: prev.template, To: now.template})
	}
	return out
}

func parseMapList(raw string) []map[string]any {
	var list []map[string]any
	if json.Unmarshal([]byte(raw), &list) != nil {
		return nil
	}
	return list
}

func mapString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func mapList(list []map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, m := range list {
		if id := mapString(m, "id"); id != "" {
			out[id] = m
		}
	}
	return out
}

func idsOf(list []map[string]any) []string {
	out := make([]string, 0, len(list))
	for _, m := range list {
		if id := mapString(m, "id"); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// movedIDs names the ids whose RELATIVE order changed between two lists.
//
// Comparing absolute indexes would report every column below an inserted one
// as moved. The longest common subsequence is the columns that kept their
// order; whatever is left is what somebody actually dragged. A list of 100
// columns is 10k comparisons, once per save — invisible, and the alternative
// is a history line that says eight columns moved because one was added.
func movedIDs(oldIDs, newIDs []string) map[string]bool {
	inOld := map[string]bool{}
	for _, id := range oldIDs {
		inOld[id] = true
	}
	inNew := map[string]bool{}
	for _, id := range newIDs {
		inNew[id] = true
	}
	var a, b []string
	for _, id := range oldIDs {
		if inNew[id] {
			a = append(a, id)
		}
	}
	for _, id := range newIDs {
		if inOld[id] {
			b = append(b, id)
		}
	}
	kept := map[string]bool{}
	if len(a) == 0 || len(b) == 0 {
		return kept
	}
	dp := make([][]int, len(a)+1)
	for i := range dp {
		dp[i] = make([]int, len(b)+1)
	}
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			switch {
			case a[i-1] == b[j-1]:
				dp[i][j] = dp[i-1][j-1] + 1
			case dp[i-1][j] >= dp[i][j-1]:
				dp[i][j] = dp[i-1][j]
			default:
				dp[i][j] = dp[i][j-1]
			}
		}
	}
	i, j := len(a), len(b)
	for i > 0 && j > 0 {
		switch {
		case a[i-1] == b[j-1]:
			kept[a[i-1]] = true
			i--
			j--
		case dp[i-1][j] >= dp[i][j-1]:
			i--
		default:
			j--
		}
	}
	moved := map[string]bool{}
	for _, id := range a {
		if !kept[id] {
			moved[id] = true
		}
	}
	return moved
}

// changeValue renders a scalar for the diff line. Objects and arrays say
// nothing: the field name alone is the useful part ("filters changed"), and a
// paragraph of JSON in a history row is not.
func changeValue(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return clipText(t, 80)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "✓"
		}
		return ""
	}
	return ""
}

func countValue(v any) string {
	switch t := v.(type) {
	case []any:
		return strconv.Itoa(len(t))
	}
	return changeValue(v)
}

func indexOfID(list []map[string]any, id string) int {
	for i, m := range list {
		if mapString(m, "id") == id {
			return i
		}
	}
	return -1
}

func diffCollectionSchema(before, after string) []collectionChange {
	oldList, newList := parseMapList(before), parseMapList(after)
	oldByID, newByID := mapList(oldList), mapList(newList)
	out := []collectionChange{}

	for _, m := range oldList {
		id := mapString(m, "id")
		if _, ok := newByID[id]; !ok {
			out = append(out, collectionChange{Kind: "column_removed", Scope: "property", ID: id, Name: mapString(m, "name")})
		}
	}
	moved := movedIDs(idsOf(oldList), idsOf(newList))
	for i, m := range newList {
		id := mapString(m, "id")
		old, exists := oldByID[id]
		if !exists {
			out = append(out, collectionChange{Kind: "column_added", Scope: "property", ID: id, Name: mapString(m, "name")})
			continue
		}
		if moved[id] {
			out = append(out, collectionChange{
				Kind: "column_moved", Scope: "property", ID: id, Name: mapString(m, "name"),
				From: strconv.Itoa(indexOfID(oldList, id) + 1), To: strconv.Itoa(i + 1),
			})
		}
		out = append(out, diffProperty(old, m)...)
	}
	return out
}

func diffProperty(old, fresh map[string]any) []collectionChange {
	id := mapString(fresh, "id")
	name := mapString(fresh, "name")
	if name == "" {
		name = mapString(old, "name")
	}
	out := []collectionChange{}

	oldOpts := map[string]map[string]any{}
	if list, ok := old["options"].([]any); ok {
		for _, raw := range list {
			if m, ok := raw.(map[string]any); ok {
				oldOpts[mapString(m, "id")] = m
			}
		}
	}
	newOpts := map[string]map[string]any{}
	if list, ok := fresh["options"].([]any); ok {
		for _, raw := range list {
			if m, ok := raw.(map[string]any); ok {
				newOpts[mapString(m, "id")] = m
			}
		}
	}
	for oid, om := range oldOpts {
		if _, ok := newOpts[oid]; !ok {
			out = append(out, collectionChange{Kind: "option_removed", Scope: "property", ID: id, Name: name, Item: mapString(om, "name")})
		}
	}
	for oid, nm := range newOpts {
		om, ok := oldOpts[oid]
		if !ok {
			out = append(out, collectionChange{Kind: "option_added", Scope: "property", ID: id, Name: name, Item: mapString(nm, "name")})
			continue
		}
		if mapString(om, "name") != mapString(nm, "name") {
			out = append(out, collectionChange{Kind: "option_changed", Scope: "property", ID: id, Name: name,
				Item: mapString(nm, "name"), Field: "name", From: mapString(om, "name"), To: mapString(nm, "name")})
		}
		if mapString(om, "color") != mapString(nm, "color") {
			out = append(out, collectionChange{Kind: "option_changed", Scope: "property", ID: id, Name: name,
				Item: mapString(nm, "name"), Field: "color", From: mapString(om, "color"), To: mapString(nm, "color")})
		}
	}

	keys := map[string]bool{}
	for k := range old {
		keys[k] = true
	}
	for k := range fresh {
		keys[k] = true
	}
	delete(keys, "id")
	delete(keys, "options")
	names := make([]string, 0, len(keys))
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, key := range names {
		ov, nv := old[key], fresh[key]
		if jsonEqual(jsonValue(ov), jsonValue(nv)) {
			continue
		}
		out = append(out, collectionChange{Kind: "column_changed", Scope: "property", ID: id, Name: name,
			Field: key, From: changeValue(ov), To: changeValue(nv)})
	}
	return out
}

func jsonValue(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func diffCollectionViews(before, after string) []collectionChange {
	oldList, newList := parseMapList(before), parseMapList(after)
	oldByID, newByID := mapList(oldList), mapList(newList)
	out := []collectionChange{}

	for _, m := range oldList {
		id := mapString(m, "id")
		if _, ok := newByID[id]; !ok {
			out = append(out, collectionChange{Kind: "view_removed", Scope: "view", ID: id, Name: mapString(m, "name")})
		}
	}
	moved := movedIDs(idsOf(oldList), idsOf(newList))
	for i, m := range newList {
		id := mapString(m, "id")
		old, exists := oldByID[id]
		if !exists {
			out = append(out, collectionChange{Kind: "view_added", Scope: "view", ID: id, Name: mapString(m, "name")})
			continue
		}
		if moved[id] {
			out = append(out, collectionChange{Kind: "view_moved", Scope: "view", ID: id, Name: mapString(m, "name"),
				From: strconv.Itoa(indexOfID(oldList, id) + 1), To: strconv.Itoa(i + 1)})
		}
		out = append(out, diffView(old, m)...)
	}
	return out
}

// viewCountFields are list-valued: a count says what changed without pasting
// the whole filter into a history row.
var viewCountFields = map[string]bool{
	"filters": true, "filterGroups": true, "trayFilters": true, "trayFilterGroups": true,
	"sorts": true, "hidden": true, "stuckCols": true,
}

func diffView(old, fresh map[string]any) []collectionChange {
	id := mapString(fresh, "id")
	name := mapString(fresh, "name")
	if name == "" {
		name = mapString(old, "name")
	}
	keys := map[string]bool{}
	for k := range old {
		if k != "id" && k != "colWidths" {
			keys[k] = true
		}
	}
	for k := range fresh {
		if k != "id" && k != "colWidths" {
			keys[k] = true
		}
	}
	names := make([]string, 0, len(keys))
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	out := []collectionChange{}
	for _, key := range names {
		ov, nv := old[key], fresh[key]
		if jsonEqual(jsonValue(ov), jsonValue(nv)) {
			continue
		}
		from, to := changeValue(ov), changeValue(nv)
		if viewCountFields[key] {
			from, to = countValue(ov), countValue(nv)
		}
		out = append(out, collectionChange{Kind: "view_changed", Scope: "view", ID: id, Name: name,
			Field: key, From: from, To: to})
	}
	return out
}

func diffCollectionWorkflow(prev, now collectionState) []collectionChange {
	before, after := parseWorkflow(prev.workflow), parseWorkflow(now.workflow)
	if before == nil && after == nil {
		return nil
	}
	if before == nil {
		before = &workflowConfig{}
	}
	if after == nil {
		after = &workflowConfig{}
	}
	out := []collectionChange{}
	scope := "workflow"

	if before.StatusPropID != after.StatusPropID {
		out = append(out, collectionChange{Kind: "workflow_changed", Scope: scope, Field: "status",
			From: schemaPropName(prev.schema, before.StatusPropID), To: schemaPropName(now.schema, after.StatusPropID)})
	}
	oldRules, newRules := rulesByID(before.Rules), rulesByID(after.Rules)
	for id, r := range oldRules {
		if _, ok := newRules[id]; !ok {
			out = append(out, collectionChange{Kind: "workflow_rule_removed", Scope: scope, ID: id, Name: ruleLabel(r)})
		}
	}
	for id, r := range newRules {
		old, ok := oldRules[id]
		if !ok {
			out = append(out, collectionChange{Kind: "workflow_rule_added", Scope: scope, ID: id, Name: ruleLabel(r)})
			continue
		}
		if jsonValue(old) != jsonValue(r) {
			out = append(out, collectionChange{Kind: "workflow_rule_changed", Scope: scope, ID: id, Name: ruleLabel(r)})
		}
	}
	oldCode, newCode := blocksByID(before.Code), blocksByID(after.Code)
	for id, b := range oldCode {
		if _, ok := newCode[id]; !ok {
			out = append(out, collectionChange{Kind: "workflow_code_removed", Scope: scope, ID: id, Name: b.Name})
		}
	}
	for id, b := range newCode {
		old, ok := oldCode[id]
		if !ok {
			out = append(out, collectionChange{Kind: "workflow_code_added", Scope: scope, ID: id, Name: b.Name})
			continue
		}
		if old.Source != b.Source {
			out = append(out, collectionChange{Kind: "workflow_code_changed", Scope: scope, ID: id, Name: b.Name})
		}
	}
	if len(out) == 0 && prev.workflow != now.workflow {
		out = append(out, collectionChange{Kind: "workflow_changed", Scope: scope, Field: "process"})
	}
	return out
}

func schemaPropName(schemaRaw, propID string) string {
	if propID == "" {
		return ""
	}
	for _, m := range parseMapList(schemaRaw) {
		if mapString(m, "id") == propID {
			return mapString(m, "name")
		}
	}
	return propID
}

func rulesByID(rules []workflowRule) map[string]workflowRule {
	out := map[string]workflowRule{}
	for _, r := range rules {
		if r.ID != "" {
			out[r.ID] = r
		}
	}
	return out
}

func blocksByID(blocks []workflowCodeBlock) map[string]workflowCodeBlock {
	out := map[string]workflowCodeBlock{}
	for _, b := range blocks {
		if b.ID != "" {
			out[b.ID] = b
		}
	}
	return out
}

// ruleLabel names a rule for the history list. A rule has no name of its own,
// so the trigger stands in for it; the interface renders it as written.
func ruleLabel(r workflowRule) string {
	if r.When.Type == "created" {
		return "new row"
	}
	return ""
}

// ---- restoring -------------------------------------------------------------

func (s *Server) validateCollectionState(pageID string, st collectionState) error {
	schema := parseSchemaProps(st.schema)
	if err := validateSchemaNames(schema); err != nil {
		return fmt.Errorf("%w: %v", errStructureConflict, err)
	}
	if st.workflow == "" {
		return nil
	}
	cfg := parseWorkflow(st.workflow)
	if cfg == nil {
		return nil
	}
	if err := validateWorkflow(cfg, schema); err != nil {
		return fmt.Errorf("%w: %v", errStructureConflict, err)
	}
	if err := validateWorkflowCode(cfg, schema, s.codeMembersOf(pageID)); err != nil {
		return fmt.Errorf("%w: %v", errStructureConflict, err)
	}
	return nil
}

func (s *Server) writeCollectionState(pageID string, st collectionState) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE collections SET schema = ?, views = ?, workflow = ?, new_from_template = ?
		WHERE page_id = ?`, st.schema, st.views, st.workflow, st.template, pageID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE pages SET updated_at = ?, type = 'collection' WHERE id = ?`, now(), pageID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.pagesChanged()
	s.rowsChanged(pageID)
	return nil
}

// restoreCollectionRevision puts back the whole structure, or one column, one
// view, or the process. Either way the current state is filed first and the
// result is filed after, so the restore itself is a readable version and can
// be undone.
func (s *Server) restoreCollectionRevision(pageID, revID, scope, itemID string, u *user) (string, error) {
	rev, ok := s.collectionRevisionState(pageID, revID)
	if !ok {
		return "", fmt.Errorf("revision %q not found on page %s", revID, pageID)
	}
	cur, ok := s.readRawCollectionState(pageID)
	if !ok {
		return "", fmt.Errorf("page %q is not a database", pageID)
	}
	next := cur
	what := "structure"
	switch scope {
	case "", "all":
		next = rev
	case "schema":
		next.schema = rev.schema
		what = "columns"
	case "views":
		next.views = rev.views
		what = "views"
	case "workflow":
		next.workflow = rev.workflow
		what = "process"
	case "property":
		if itemID == "" {
			return "", fmt.Errorf("item_id is required for scope=property")
		}
		merged, ok := mergeSchemaItem(cur.schema, rev.schema, itemID)
		if !ok {
			return "", fmt.Errorf("revision %q has no property %q", revID, itemID)
		}
		next.schema = merged
		what = "column"
	case "view":
		if itemID == "" {
			return "", fmt.Errorf("item_id is required for scope=view")
		}
		merged, ok := mergeViewItem(cur.views, rev.views, itemID)
		if !ok {
			return "", fmt.Errorf("revision %q has no view %q", revID, itemID)
		}
		next.views = merged
		what = "view"
	default:
		return "", fmt.Errorf("unknown scope %q — use all, schema, views, workflow, property or view", scope)
	}
	// Widths were never part of the stored structure; a restore keeps the
	// widths the reader has now, matched by view id.
	next.views = withCurrentWidths(next.views, s.rawCollectionViews(pageID))

	if err := s.validateCollectionState(pageID, next); err != nil {
		return "", err
	}
	s.appendCollectionRevision(pageID, cur, u.ID, u.Name, true)
	if err := s.writeCollectionState(pageID, next); err != nil {
		return "", err
	}
	// File what is stored, not the in-memory merge: the merge still carries
	// the reader's column widths, and those never belong in a revision.
	if after, ok := s.readRawCollectionState(pageID); ok {
		s.appendCollectionRevision(pageID, after, u.ID, u.Name, true)
	}
	if what == "structure" {
		return fmt.Sprintf("Restored the structure of %s to revision %s", pageID, revID), nil
	}
	return fmt.Sprintf("Restored the %s from revision %s", what, revID), nil
}

func mergeSchemaItem(current, target, id string) (string, bool) {
	return mergeListItem(current, target, id, false)
}

func mergeViewItem(current, target, id string) (string, bool) {
	return mergeListItem(current, target, id, true)
}

// mergeListItem puts one item back into a list, at its old place when the
// place is free. A column removed and restored this way keeps its old index;
// the values never left pages.props, so they show up again immediately.
func mergeListItem(current, target, id string, keepWidths bool) (string, bool) {
	curList, tgtList := parseMapList(current), parseMapList(target)
	var item map[string]any
	targetIndex := -1
	for i, m := range tgtList {
		if mapString(m, "id") == id {
			item = m
			targetIndex = i
			break
		}
	}
	if item == nil {
		return "", false
	}
	if keepWidths {
		for _, m := range curList {
			if mapString(m, "id") == id {
				if w, ok := m["colWidths"]; ok {
					item["colWidths"] = w
				}
				break
			}
		}
	}
	replaced := false
	for i, m := range curList {
		if mapString(m, "id") == id {
			curList[i] = item
			replaced = true
			break
		}
	}
	if !replaced {
		if targetIndex > len(curList) {
			targetIndex = len(curList)
		}
		curList = append(curList, nil)
		copy(curList[targetIndex+1:], curList[targetIndex:])
		curList[targetIndex] = item
	}
	b, err := json.Marshal(curList)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// withCurrentWidths carries the reader's column widths into restored views.
// target is the stored (widthless) view list from a revision; rawCurrent is
// what is in the database right now, widths included.
func withCurrentWidths(target, rawCurrent string) string {
	views := parseMapList(target)
	if len(views) == 0 {
		return target
	}
	widths := map[string]any{}
	for _, m := range parseMapList(rawCurrent) {
		if w, ok := m["colWidths"]; ok {
			widths[mapString(m, "id")] = w
		}
	}
	for _, m := range views {
		id := mapString(m, "id")
		if w, ok := widths[id]; ok {
			m["colWidths"] = w
		} else {
			delete(m, "colWidths")
		}
	}
	b, err := json.Marshal(views)
	if err != nil {
		return target
	}
	return string(b)
}

// ---- HTTP ------------------------------------------------------------------

// serveCollectionRevisions answers the list route for a database page.
func (s *Server) serveCollectionRevisions(w http.ResponseWriter, pageID string) {
	rows, err := s.db.Query(`SELECT id, created_at, author_name, changes
		FROM collection_revisions WHERE page_id = ? ORDER BY seq DESC`, pageID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id, createdAt, author, changes string
		if err := rows.Scan(&id, &createdAt, &author, &changes); err != nil {
			httpError(w, 500, err.Error())
			return
		}
		ch := []collectionChange{}
		if changes != "" {
			json.Unmarshal([]byte(changes), &ch)
		}
		if ch == nil {
			ch = []collectionChange{}
		}
		list = append(list, map[string]any{
			"id":         id,
			"createdAt":  createdAt,
			"authorName": author,
			"kind":       "collection",
			"changes":    ch,
		})
	}
	writeJSON(w, list)
}

// serveCollectionRevision answers the get route: the structure as it was.
func (s *Server) serveCollectionRevision(w http.ResponseWriter, pageID, revID string) {
	st, ok := s.collectionRevisionState(pageID, revID)
	if !ok {
		httpError(w, 404, "revision not found")
		return
	}
	var createdAt, author, changes string
	s.db.QueryRow(`SELECT created_at, author_name, changes FROM collection_revisions WHERE id = ? AND page_id = ?`, revID, pageID).
		Scan(&createdAt, &author, &changes)
	out := map[string]any{
		"kind":            "collection",
		"schema":          json.RawMessage(st.schema),
		"views":           json.RawMessage(st.views),
		"newFromTemplate": st.template,
		"createdAt":       createdAt,
		"authorName":      author,
		"full":            true,
	}
	if st.workflow != "" {
		out["workflow"] = json.RawMessage(st.workflow)
	}
	if changes != "" {
		out["changes"] = json.RawMessage(changes)
	}
	writeJSON(w, out)
}

func (s *Server) handleRestoreCollectionRevision(w http.ResponseWriter, r *http.Request, pageID string) {
	u := requestUser(r)
	var body struct {
		Scope  string `json:"scope"`
		ItemID string `json:"itemId"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			httpError(w, 400, "invalid JSON")
			return
		}
	}
	msg, err := s.restoreCollectionRevision(pageID, r.PathValue("revId"), body.Scope, body.ItemID, u)
	if err != nil {
		if errors.Is(err, errStructureConflict) {
			httpErrorCode(w, 409, "structure_conflict", strings.TrimPrefix(err.Error(), errStructureConflict.Error()+": "))
			return
		}
		httpError(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "detail": msg})
}

// ---- MCP -------------------------------------------------------------------

func (s *Server) mcpCollectionHistory(pageID string, limit int) (string, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.Query(`SELECT id, created_at, author_id, author_name, changes
		FROM collection_revisions WHERE page_id = ? ORDER BY seq DESC LIMIT ?`, pageID, limit)
	if err != nil {
		return "", err
	}
	type rev struct {
		ID        string             `json:"id"`
		CreatedAt string             `json:"created_at"`
		Author    string             `json:"author"`
		By        string             `json:"by"`
		Changes   []collectionChange `json:"changes"`
		Baseline  bool               `json:"baseline,omitempty"`
	}
	type raw struct {
		r        rev
		authorID string
	}
	var list []raw
	for rows.Next() {
		var r rev
		var authorID, changes string
		if err := rows.Scan(&r.ID, &r.CreatedAt, &authorID, &r.Author, &changes); err != nil {
			rows.Close()
			return "", err
		}
		if changes != "" {
			json.Unmarshal([]byte(changes), &r.Changes)
		}
		if r.Changes == nil {
			r.Changes = []collectionChange{}
		}
		list = append(list, raw{r, authorID})
	}
	rows.Close()
	out := make([]rev, 0, len(list))
	for _, it := range list {
		r := it.r
		var actorType string
		err := s.db.QueryRow(`SELECT actor_type FROM audit_log
			WHERE page_id = ? AND actor_id = ? AND created_at >= ?
			ORDER BY created_at ASC LIMIT 1`, pageID, it.authorID, r.CreatedAt).Scan(&actorType)
		if err != nil || actorType == "" {
			r.By = "unknown"
		} else {
			r.By = actorType
		}
		out = append(out, r)
	}
	oldest := s.oldestCollectionRevision(pageID)
	var total int
	s.db.QueryRow(`SELECT COUNT(*) FROM collection_revisions WHERE page_id = ?`, pageID).Scan(&total)
	for i := range out {
		out[i].Baseline = oldest != "" && out[i].ID == oldest
	}
	b, err := json.Marshal(map[string]any{
		"page_id": pageID, "kind": "collection", "total": total, "oldest_revision_id": oldest,
		"revisions": out,
		"note":      "This page is a database, so these revisions are its STRUCTURE (columns, views, process), not a document body. Row values are not here: each row has its own history. action=restore takes scope (all, schema, views, workflow, property, view) and item_id for the last two. Restoring never destroys: the current structure is saved as a new revision first.",
	})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (s *Server) mcpGetCollectionRevision(pageID, revID string) (string, error) {
	st, ok := s.collectionRevisionState(pageID, revID)
	if !ok {
		return "", fmt.Errorf("revision %q not found on page %s", revID, pageID)
	}
	var createdAt, author string
	s.db.QueryRow(`SELECT created_at, author_name FROM collection_revisions WHERE id = ? AND page_id = ?`, revID, pageID).
		Scan(&createdAt, &author)
	out := map[string]any{
		"page_id": pageID, "revision_id": revID, "kind": "collection",
		"created_at": createdAt, "author": author,
		"schema":            json.RawMessage(st.schema),
		"views":             json.RawMessage(st.views),
		"new_from_template": st.template,
	}
	if st.workflow != "" {
		out["workflow"] = json.RawMessage(st.workflow)
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
