package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// A collection turns a page into a small database: its child pages are the
// rows, `schema` defines typed properties, `views` are saved view configs
// (table, board, list). Property values live in pages.props.

const defaultSchema = `[
 {"id":"status","name":"Status","type":"select","options":[
   {"id":"todo","name":"To do","color":"#c4554d"},
   {"id":"doing","name":"In progress","color":"#b58a3b"},
   {"id":"done","name":"Done","color":"#2f7d4f"}]}
]`

const defaultViews = `[
 {"id":"board","name":"Board","type":"board","groupBy":"status"},
 {"id":"table","name":"Table","type":"table"}
]`

func (s *Server) handleGetCollection(w http.ResponseWriter, r *http.Request) {
	if !s.canReadReq(r, r.PathValue("id")) {
		httpError(w, 404, "not a collection")
		return
	}
	var schema, views, newFromTemplate, workflow string
	err := s.db.QueryRow(`SELECT schema, views, new_from_template, workflow FROM collections WHERE page_id = ?`, r.PathValue("id")).Scan(&schema, &views, &newFromTemplate, &workflow)
	if err == sql.ErrNoRows {
		httpError(w, 404, "not a collection")
		return
	}
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	out := map[string]json.RawMessage{
		"schema": json.RawMessage(schema),
		"views":  json.RawMessage(views),
	}
	// Empty means plain blank rows: omitted rather than sent as nothing.
	if newFromTemplate != "" {
		out["newFromTemplate"] = json.RawMessage(strconv.Quote(newFromTemplate))
	}
	if strings.TrimSpace(workflow) != "" && strings.TrimSpace(workflow) != "null" {
		out["workflow"] = json.RawMessage(workflow)
	}
	writeJSON(w, out)
}

func (s *Server) handlePutCollection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canWriteReq(r, id) {
		httpError(w, 404, "page not found")
		return
	}
	var body struct {
		Schema          json.RawMessage `json:"schema"`
		Views           json.RawMessage `json:"views"`
		NewFromTemplate *string         `json:"newFromTemplate"`
		Workflow        json.RawMessage `json:"workflow"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	// Either half may come alone, and the half that was not sent stays as it is
	// stored. A browser tab saved both on every view change, the schema as it
	// had loaded it, so changing a column width in a tab opened before an agent
	// added a property took the property away again.
	sent := func(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }
	hasSchema, hasViews := sent(body.Schema), sent(body.Views)
	if (!hasSchema && !hasViews) || (hasSchema && !json.Valid(body.Schema)) || (hasViews && !json.Valid(body.Views)) {
		httpError(w, 400, "schema and views must be valid JSON")
		return
	}
	var exists int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pages WHERE id = ?`, id).Scan(&exists); err != nil || exists == 0 {
		httpError(w, 404, "page not found")
		return
	}
	tplCol, tplHolder, tplSet := "", "", ""
	tplArgs := []any{}
	if body.NewFromTemplate != nil {
		tplCol, tplHolder = ", new_from_template", ", ?"
		tplSet = ", new_from_template = excluded.new_from_template"
		tpl := ""
		if *body.NewFromTemplate != "" {
			var isTpl int
			if err := s.db.QueryRow(`SELECT COUNT(*) FROM pages WHERE id = ? AND is_template = 1 AND trashed_at IS NULL`, *body.NewFromTemplate).Scan(&isTpl); err == nil && isTpl > 0 {
				tpl = *body.NewFromTemplate
			}
		}
		tplArgs = []any{tpl}
	}
	// Workflow is optional; when present it is validated before anything is
	// stored. Absent (null) leaves it untouched, an empty object clears the
	// process. A half update without a schema validates against the stored
	// one, so a view-only save cannot strand rules pointing nowhere.
	workflowTouched := sent(body.Workflow)
	workflowJSON := ""
	if workflowTouched {
		var cfg workflowConfig
		if err := json.Unmarshal(body.Workflow, &cfg); err != nil {
			httpError(w, 400, "workflow is not valid JSON")
			return
		}
		// An empty object clears the process without further checks.
		isEmpty := strings.TrimSpace(cfg.StatusPropID) == "" && len(cfg.Rules) == 0
		if !isEmpty {
			effSchema := string(body.Schema)
			if !hasSchema {
				_ = s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, id).Scan(&effSchema)
			}
			if err := validateWorkflow(&cfg, parseSchemaProps(effSchema)); err != nil {
				httpError(w, 400, err.Error())
				return
			}
			raw, _ := json.Marshal(cfg)
			workflowJSON = string(raw)
		}
	}
	wfCol, wfHolder, wfSet := "", "", ""
	wfArgs := []any{}
	if workflowTouched {
		wfCol, wfHolder = ", workflow", ", ?"
		wfSet = ", workflow = excluded.workflow"
		wfArgs = []any{workflowJSON}
	}
	// Same-named columns break every name-based lookup (process code,
	// filters), so they never get stored. Reads of older duplicates stay
	// untouched; the next save renames one side first.
	if hasSchema {
		if err := validateSchemaNames(parseSchemaProps(string(body.Schema))); err != nil {
			httpError(w, 400, err.Error())
			return
		}
	}
	var err error
	switch {
	case hasSchema && hasViews:
		_, err = s.db.Exec(`INSERT INTO collections (page_id, schema, views`+tplCol+wfCol+`) VALUES (?, ?, ?`+tplHolder+wfHolder+`)
			ON CONFLICT(page_id) DO UPDATE SET schema = excluded.schema, views = excluded.views`+tplSet+wfSet,
			append(append([]any{id, string(body.Schema), string(body.Views)}, tplArgs...), wfArgs...)...)
	case hasSchema:
		_, err = s.db.Exec(`INSERT INTO collections (page_id, schema, views`+tplCol+wfCol+`) VALUES (?, ?, '[]'`+tplHolder+wfHolder+`)
			ON CONFLICT(page_id) DO UPDATE SET schema = excluded.schema`+tplSet+wfSet,
			append(append([]any{id, string(body.Schema)}, tplArgs...), wfArgs...)...)
	default:
		_, err = s.db.Exec(`INSERT INTO collections (page_id, schema, views`+tplCol+wfCol+`) VALUES (?, '[]', ?`+tplHolder+wfHolder+`)
			ON CONFLICT(page_id) DO UPDATE SET views = excluded.views`+tplSet+wfSet,
			append(append([]any{id, string(body.Views)}, tplArgs...), wfArgs...)...)
	}
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if _, err := s.db.Exec(`UPDATE pages SET type = 'collection', updated_at = ? WHERE id = ?`, now(), id); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	s.pagesChanged()
	// The schema and the views ARE the database: adding a column or removing a
	// view changes it for everyone, and an open view on a second screen kept
	// drawing the old shape.
	s.rowsChanged(id)
	var stored struct{ schema, views, workflow string }
	s.db.QueryRow(`SELECT schema, views, workflow FROM collections WHERE page_id = ?`, id).Scan(&stored.schema, &stored.views, &stored.workflow)
	out := map[string]json.RawMessage{"schema": json.RawMessage(stored.schema), "views": json.RawMessage(stored.views)}
	if strings.TrimSpace(stored.workflow) != "" {
		out["workflow"] = json.RawMessage(stored.workflow)
	}
	writeJSON(w, out)
}

// handleCollectionRows returns a collection's child rows filtered, sorted and
// paginated SERVER-SIDE via SQLite json_extract, so a 50k-row database doesn't
// force the client to pull everything. Query params:
//
//	limit, offset          — pagination (default 100, max 500)
//	filter=<propId>:<value> — equals (repeatable); empty value = "is set";
//	                           matches a scalar OR an array element (multiselect)
//	filter_group=[{...}] — one OR group as a JSON array of conditions in the
//	                           same shape (repeatable); ANDed inside, ORed
//	                           between groups; a repeatable `filter` beside
//	                           them holds for every group
//	sort=<propId>:<asc|desc>[,<propId>:<asc|desc>...] — repeatable; the first
//	key wins ties, like SQL ORDER BY
type collectionRow struct {
	ID       string          `json:"id"`
	Title    string          `json:"title"`
	Icon     string          `json:"icon"`
	Cover    string          `json:"cover"`
	Position float64         `json:"position"`
	Props    json.RawMessage `json:"props"`
}

// jsonPath builds a safe SQLite JSON path for a property id we control the
// charset of (schema slugs are [a-z0-9_-]); reject anything else.
func safePropID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// rowFilter is one condition on a property. Op is one of
// is|is_not|contains|gt|lt|between|is_empty|is_not_empty; empty Op defaults to
// is (or is_not_empty when Value is also empty, for backward compatibility).
//
// Values carries a SET for is/is_not — "class is none of A, H" as one condition
// instead of two rows that happen to sit next to each other. Value stays for the
// single-value case and every other operator.
//
// Value2 is the upper bound of `between`. A date range was the one thing people
// asked for that could not be said at all: "after X" and "before Y" as two
// conditions works, but nobody finds it.
type rowFilter struct {
	Prop, Op, Value string
	Values          []string
	Value2          string
	// Kind is the property's type where where() has to compare differently,
	// "number" or "checkbox", and empty otherwise. Set per query by
	// typeFilters, because where() has no schema.
	Kind string
}

// typeFilters tells each condition what kind of property it is on, where
// that changes the comparison. A number is stored as a JSON number and a
// ticked box as JSON true, and comparing either with the filter's text
// matched nothing: "Qty is 5" and "Done is Checked" found no rows (#95).
func (s *Server) typeFilters(collectionID string, filters []rowFilter) []rowFilter {
	schema, _, err := s.loadCollection(collectionID)
	if err != nil {
		return filters
	}
	kinds := map[string]string{}
	for _, p := range schema {
		id, _ := p["id"].(string)
		switch t, _ := p["type"].(string); t {
		case "number", "checkbox":
			kinds[id] = t
		}
	}
	out := make([]rowFilter, len(filters))
	for i, f := range filters {
		f.Kind = kinds[f.Prop]
		out[i] = f
	}
	return out
}

// resolvePersonFilters resolves "@me" in filters on PERSON properties of the
// collection to the viewer's ID (and name), so a view "Assignee is Me" works
// dynamically for whoever opens it.
func (s *Server) resolvePersonFilters(collectionID string, filters []rowFilter, u *user) []rowFilter {
	schema, _, err := s.loadCollection(collectionID)
	if err != nil {
		return filters
	}
	persons := map[string]bool{}
	for _, p := range schema {
		if id, _ := p["id"].(string); id != "" {
			if t, _ := p["type"].(string); t == "person" {
				persons[id] = true
			}
		}
	}
	if len(persons) == 0 {
		return filters
	}
	out := make([]rowFilter, len(filters))
	for i, f := range filters {
		if persons[f.Prop] {
			f = f.resolvePerson(u)
		}
		out[i] = f
	}
	return out
}

// resolvePerson turns "@me" into the person asking: their id, and their name
// as well, because a person an agent wrote as plain text is matched by name,
// the way the chip in the browser matches it. Nobody signed in is nobody, a
// value no row holds, so the condition keeps filtering instead of dropping
// out the way a condition without a value does.
//
// Only where whole values are compared. Under contains, "@me" is text like
// any other, the same as in the browser (matchesFilter).
func (f rowFilter) resolvePerson(u *user) rowFilter {
	if f.Op != "" && f.Op != "is" && f.Op != "is_not" {
		return f
	}
	target := []string{"__nobody__"}
	if u != nil && u.ID != "" {
		target = []string{u.ID}
		if u.Name != "" && u.Name != u.ID {
			target = append(target, u.Name)
		}
	}
	expand := func(v string) []string {
		if v == "@me" {
			return target
		}
		return []string{v}
	}
	isMe := f.Value == "@me"
	if len(f.Values) > 0 {
		var next []string
		for _, v := range f.Values {
			next = append(next, expand(v)...)
		}
		f.Values = next
	} else if isMe {
		f.Values = target
	}
	if isMe {
		if u != nil && u.ID != "" {
			f.Value = u.ID
		} else {
			f.Value = "__nobody__"
		}
	}
	return f
}

// vals is what the condition actually compares against: the set if there is one,
// otherwise the single value. Never both.
func (f rowFilter) vals() []string {
	if len(f.Values) > 0 {
		return f.Values
	}
	if f.Value == "" {
		return nil
	}
	return []string{f.Value}
}

func isNumeric(s string) bool {
	_, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return err == nil
}

// privateRowRule is the SQL condition that keeps other people's private rows
// out of everything that reads a collection's rows. The visibility switch in
// the page header applies to database rows too. The row list honoured it first;
// the Markdown export, get_page over MCP, the calendar feed and a publicly
// shared collection went on reading every row, so a row hidden in the app was
// readable four other ways. Every reader of rows goes through this now.
//
// userID "" is somebody without an account, reading a shared link: no private
// row at all, whoever owns it. Workspace admins still see everything, the same
// rule as in forbiddenPrivateAncestor.
func (s *Server) privateRowRule(userID, colID string) (string, []any) {
	if userID == "" {
		return "visibility != 'private'", nil
	}
	wsAdmin := 0
	if s.isWorkspaceAdmin(userID, s.pageWorkspace(colID)) {
		wsAdmin = 1
	}
	return "(? = 1 OR visibility != 'private' OR owner_id = ?)", []any{wsAdmin, userID}
}

// where builds the SQL for one filter condition and the arguments to go with
// it. An empty condition means "does not filter": an unsafe property id, a
// comparison with nothing to compare against, or a half-built range. The
// caller skips those, so an unfinished condition never blanks the answer.
// templateFilterProp is the one condition that is not about a column: whether
// the row is a template. A pseudo-property, so it travels in the same shape as
// every other condition and a view can save it like any other (the client has
// the same id — see TEMPLATE_FILTER).
const templateFilterProp = "@template"

// The two orders that are not about a column: when the row was made and when
// it was last touched. Pseudo-properties, like the template condition — a view
// saves them in the same Sort shape as any column, and the client offers them
// under the same System heading as the template condition.
const sortCreatedProp = "@created"
const sortUpdatedProp = "@updated"

func (f rowFilter) where() (string, []any) {
	if f.Prop == templateFilterProp {
		// "is a template" is the checked value; anything else — and "is not a
		// template" with it — asks for the other half.
		want := 1
		no := f.Value == "false" || f.Value == "0"
		if f.Op == "is_not" {
			no = !no
		}
		if no {
			want = 0
		}
		return "is_template = ?", []any{want}
	}
	if !safePropID(f.Prop) && f.Prop != sortCreatedProp && f.Prop != sortUpdatedProp {
		return "", nil
	}
	// A relative day ("today-1M") names a different date every day. It is
	// resolved per query in collectionRowsQuery (date properties only, so
	// a status option named "Today" keeps working) — never here, where the
	// property type is out of reach.
	ex := "json_extract(props, '$." + f.Prop + "')"
	// Created and Updated are not columns: they read the row’s own timestamps
	// as days, so every operator below compares days to days.
	sysCol := ""
	if f.Prop == sortCreatedProp {
		sysCol = "created_at"
	} else if f.Prop == sortUpdatedProp {
		sysCol = "updated_at"
	}
	if sysCol != "" {
		ex = "date(" + sysCol + ")"
	}
	op := f.Op
	if op == "" {
		if f.Value == "" {
			op = "is_not_empty"
		} else {
			op = "is"
		}
	}
	vals := f.vals()
	// A half-typed relative day ("today-") is not a value yet. Comparing it
	// literally would empty the table mid-keystroke, so the condition waits
	// instead, under the same rule the interface applies before sending (see
	// filterIsArmed). Finished words on non-date properties still compare
	// literally; only the dangling sign is special.
	if op != "is_empty" && op != "is_not_empty" {
		if isUnfinishedRelativeDay(f.Value) || isUnfinishedRelativeDay(f.Value2) {
			return "", nil
		}
		kept := make([]string, 0, len(vals))
		for _, v := range vals {
			if !isUnfinishedRelativeDay(v) {
				kept = append(kept, v)
			}
		}
		vals = kept
	}
	// A condition with nothing to compare against does not filter. It used
	// to compare with the empty string and therefore match nothing, so the
	// moment you added "Date is …" the table went blank before you had
	// typed anything — which read as the date filter being broken. The
	// deliberate version of that question is is_empty.
	if op != "is_empty" && op != "is_not_empty" && len(vals) == 0 {
		return "", nil
	}
	if op == "between" && f.Value2 == "" {
		return "", nil
	}
	// One placeholder per value, for `IN (?, ?, …)`.
	holders := strings.TrimSuffix(strings.Repeat("?, ", len(vals)), ", ")
	anyOf := make([]any, len(vals))
	for i, v := range vals {
		anyOf[i] = v
	}
	if op == "is" || op == "is_not" {
		if cond, args, ok := f.typedIs(ex, op, vals); ok {
			return cond, args
		}
	}
	// The value may be stored as a scalar or inside a list (multiselect, a
	// relation): both spellings have to answer the same question. A checklist
	// stores objects ({id, text, done}), so the comparison runs against each
	// element's text — falling back to the element itself, which is what
	// scalars and legacy plain-string items are. That fallback is what keeps
	// every other property type answering exactly as before. The validity
	// guard is load-bearing: json_extract errors on a plain string, it does
	// not return NULL, so extracting blindly broke every filter on every
	// text-valued property.
	textOf := "CASE WHEN json_valid(value) THEN COALESCE(json_extract(value, '$.text'), value) ELSE value END"
	inList := "EXISTS (SELECT 1 FROM json_each(props, '$." + f.Prop + "') WHERE " + textOf + " IN (" + holders + "))"
	// A system timestamp is neither a scalar in props nor a list: one value the
	// row always has, so the list half of the question is always false.
	if sysCol != "" {
		inList = "1 = 0"
	}
	set := "(" + ex + " IS NOT NULL AND " + ex + " != '' AND " + ex + " != json('[]'))"
	switch op {
	case "is_empty":
		return "NOT " + set, nil
	case "is_not_empty":
		return set, nil
	case "is":
		// A system timestamp has no list half: its placeholders are its own.
		if sysCol != "" {
			return ex + " IN (" + holders + ")", anyOf
		}
		return "(" + ex + " IN (" + holders + ") OR " + inList + ")", append(anyOf, anyOf...)
	case "is_not":
		// A missing/empty value counts as "is not X" — and with a set, as
		// "is none of them".
		if sysCol != "" {
			return ex + " NOT IN (" + holders + ")", anyOf
		}
		return "(" + ex + " IS NULL OR (" + ex + " NOT IN (" + holders + ") AND NOT " + inList + "))", append(anyOf, anyOf...)
	case "contains":
		// Matched against each element's text (see above), never against the
		// raw JSON: searching the blob itself matched ids, keys and booleans,
		// so "true" found every row with a ticked box. A scalar yields itself
		// from json_each, so plain text columns answer through the same
		// expression — no separate branch.
		like := "%" + f.Value + "%"
		return "EXISTS (SELECT 1 FROM json_each(props, '$." + f.Prop + "') WHERE " + textOf + " LIKE ?)", []any{like}
	case "gt", "lt":
		cmp := ">"
		if op == "lt" {
			cmp = "<"
		}
		if isNumeric(f.Value) {
			return "CAST(" + ex + " AS REAL) " + cmp + " CAST(? AS REAL)", []any{f.Value}
		}
		return ex + " " + cmp + " ?", []any{f.Value}
	case "between":
		// Inclusive at both ends: a range named by two dates includes the
		// days it is named after. ISO dates compare correctly as text, so
		// only numbers need the cast.
		if isNumeric(f.Value) && isNumeric(f.Value2) {
			return "(CAST(" + ex + " AS REAL) >= CAST(? AS REAL) AND CAST(" + ex + " AS REAL) <= CAST(? AS REAL))", []any{f.Value, f.Value2}
		}
		return "(" + ex + " >= ? AND " + ex + " <= ?)", []any{f.Value, f.Value2}
	}
	return "", nil
}

// typedIs is "is" and "is not" on a number or a checkbox, compared the way the
// browser compares them in its second pass (matchesFilter). ok is false where
// the plain text comparison applies.
//
// A number matches as a number, so 5 and 5.0 are one value, and still as text,
// because a number written as text through the API ("5") always matched.
// A box matches ticked when it holds JSON true; a box nobody touched has no
// value at all and counts as unticked, as it does on screen.
func (f rowFilter) typedIs(ex, op string, vals []string) (string, []any, bool) {
	var cond string
	var args []any
	switch f.Kind {
	case "number":
		var nums, texts []any
		for _, v := range vals {
			if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
				nums = append(nums, n)
				texts = append(texts, v)
			}
		}
		if len(nums) == 0 {
			return "", nil, false
		}
		holders := strings.TrimSuffix(strings.Repeat("?, ", len(nums)), ", ")
		cond = "(" + ex + " IN (" + holders + ") OR " + ex + " IN (" + holders + "))"
		args = append(nums, texts...)
		if op == "is_not" {
			return "(" + ex + " IS NULL OR NOT " + cond + ")", args, true
		}
		return cond, args, true
	case "checkbox":
		var ticked, unticked bool
		for _, v := range vals {
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "true":
				ticked = true
			case "false":
				unticked = true
			}
		}
		if !ticked && !unticked {
			return "", nil, false
		}
		// COALESCE, because a missing value makes json_type NULL, and NOT NULL
		// is NULL too: the untouched box would drop out of "is Unchecked".
		isTicked := "COALESCE(json_type(props, '$." + f.Prop + "'), '') = 'true'"
		switch {
		case ticked && unticked:
			cond = "1 = 1"
		case ticked:
			cond = isTicked
		default:
			cond = "NOT " + isTicked
		}
		if op == "is_not" {
			return "NOT (" + cond + ")", nil, true
		}
		return cond, nil, true
	}
	return "", nil, false
}

// collectionRowsQuery filters, sorts and paginates a collection's rows in
// SQLite and injects computed (rollup/formula/relation) values. Shared by the
// REST handler and the MCP query_rows tool so both behave identically.
//
// flat is ANDed as it stands; groups are ORed, the conditions inside one group
// ANDed, and the two together read "this AND (that OR those)". A group with no
// complete condition constrains nothing.
//
// today is the day relative date words ("today", "today-1M") resolve against:
// the viewer's day, sent by the interface with every query. Zero means the
// caller does not know it (agents, old clients) and the server's day applies.
func (s *Server) collectionRowsQuery(u *user, colID string, flat []rowFilter, groups [][]rowFilter, sortParam string, limit, offset int, today time.Time) (list []map[string]any, total int, err error) {
	now := today
	if now.IsZero() {
		now = time.Now()
	}
	// A relative day names a different date every day. Resolve it now, per
	// query, so a saved view stays live, and only on date properties (see
	// resolveSmartDates), so a status option named "Today" keeps working.
	// Similarly, "@me" in person properties resolves to the viewing user.
	flat = s.typeFilters(colID, s.resolvePersonFilters(colID, s.resolveSmartDates(colID, flat, now), u))
	resolved := make([][]rowFilter, len(groups))
	for i, g := range groups {
		resolved[i] = s.typeFilters(colID, s.resolvePersonFilters(colID, s.resolveSmartDates(colID, g, now), u))
	}
	groups = resolved
	where := []string{"parent_id = ?", "trashed_at IS NULL"}
	args := []any{colID}
	// Other people's private rows stay out. The condition belongs in the SQL,
	// not behind the LIMIT: filtering afterwards would falsify paging and the
	// total count.
	var uid string
	if u != nil {
		uid = u.ID
	}
	rule, ruleArgs := s.privateRowRule(uid, colID)
	where = append(where, rule)
	args = append(args, ruleArgs...)
	// Restricted subtrees (fork): hide rows under a restricted node the caller
	// neither owns nor holds a grant on. Skipped entirely when the workspace
	// holds no restricted page, so the common case pays nothing — and for
	// admins the SQL short-circuits on the leading flag.
	wsAdmin := 0
	if uid != "" && s.isWorkspaceAdmin(uid, s.pageWorkspace(colID)) {
		wsAdmin = 1
	}
	if uid != "" && wsAdmin == 0 && s.hasRestrictedInWorkspace(s.pageWorkspace(colID)) {
		where = append(where, `NOT EXISTS (
			WITH RECURSIVE anc(id, parent_id, visibility, owner_id) AS (
				SELECT p2.id, p2.parent_id, p2.visibility, p2.owner_id FROM pages p2 WHERE p2.id = row.id
				UNION
				SELECT p.id, p.parent_id, p.visibility, p.owner_id FROM pages p JOIN anc ON p.id = anc.parent_id
			) SELECT 1 FROM anc LEFT JOIN page_grants g
				ON g.page_id = anc.id AND g.user_id = ? AND g.subject_type = 'user'
			WHERE anc.visibility = 'restricted' AND anc.owner_id != ?
				AND COALESCE(g.access, '') NOT IN ('view', 'edit')
		)`)
		args = append(args, uid, uid)
	}
	// The flat list is a term of its own beside the OR of the groups. Copied
	// into every group instead, it made an unfinished group match whatever the
	// flat list matched, so adding a condition could widen the answer.
	for _, f := range flat {
		if cond, cargs := f.where(); cond != "" {
			where = append(where, cond)
			args = append(args, cargs...)
		}
	}
	ors := make([]string, 0, len(groups))
	for _, g := range groups {
		ands := make([]string, 0, len(g))
		for _, f := range g {
			cond, cargs := f.where()
			if cond == "" {
				continue
			}
			ands = append(ands, cond)
			args = append(args, cargs...)
		}
		// An empty group constrains nothing — it must not narrow the answer,
		// or one unfinished group would blank the whole view.
		if len(ands) == 0 {
			continue
		}
		ors = append(ors, "("+strings.Join(ands, " AND ")+")")
	}
	if len(ors) > 0 {
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	whereSQL := strings.Join(where, " AND ")

	orderSQL := "position, created_at"
	if sortParam != "" {
		keys := []string{}
		for _, part := range strings.Split(sortParam, ",") {
			propID, dir, _ := strings.Cut(strings.TrimSpace(part), ":")
			d := "ASC"
			if strings.EqualFold(dir, "desc") {
				d = "DESC"
			}
			switch propID {
			case sortCreatedProp:
				keys = append(keys, "created_at "+d)
			case sortUpdatedProp:
				keys = append(keys, "updated_at "+d)
			default:
				if safePropID(propID) {
					keys = append(keys, "json_extract(props, '$."+propID+"') "+d)
				}
			}
		}
		if len(keys) > 0 {
			orderSQL = strings.Join(keys, ", ") + ", position"
		}
	}

	s.db.QueryRow(`SELECT COUNT(*) FROM pages AS row WHERE `+whereSQL, args...).Scan(&total)

	// is_template travels with the row because a view can filter on it (see
	// templateFilterProp): the client re-checks the conditions it was sent, and
	// it cannot re-check one whose answer is not in the payload.
	// createdAt/updatedAt travel with the row because a view can sort on them
	// (see sortCreatedProp): the client re-sorts what it was sent, and it
	// cannot order by a value that is not in the payload.
	rows, err := s.db.Query(`SELECT id, title, icon, cover, position, props, tags, is_template, created_at, updated_at FROM pages AS row WHERE `+whereSQL+` ORDER BY `+orderSQL+` LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	list = []map[string]any{}
	for rows.Next() {
		var id, title, icon, cover, props, tags, createdAt, updatedAt string
		var position float64
		var isTemplate int
		if rows.Scan(&id, &title, &icon, &cover, &position, &props, &tags, &isTemplate, &createdAt, &updatedAt) != nil {
			continue
		}
		var pm map[string]any
		if json.Unmarshal([]byte(props), &pm) != nil || pm == nil {
			pm = map[string]any{}
		}
		tagList := []string{}
		if tags != "" {
			json.Unmarshal([]byte(tags), &tagList)
		}
		list = append(list, map[string]any{
			"id": id, "title": title, "icon": icon, "cover": cover, "position": position, "props": pm, "tags": tagList,
			"isTemplate": isTemplate != 0, "createdAt": createdAt, "updatedAt": updatedAt,
		})
	}

	// Compute rollups and formulas server-side (relations resolved against the
	// target rows), so they're correct and consistent regardless of client.
	//
	// From here on we query again (the schema, and inside computeDerived a
	// canRead per target page), even though `defer rows.Close()` only fires on
	// leaving. That works solely because the loop above runs to the end:
	// database/sql then closes the rows itself and frees the — single —
	// connection. Anyone adding a `break` here keeps the cursor open and brings
	// the whole server to a standstill.
	var schemaJSON string
	if s.db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, colID).Scan(&schemaJSON) == nil {
		s.computeDerived(u, parseSchema(schemaJSON), list)
	}
	return list, total, nil
}

// filterJSON is one condition as it travels: the flat `filter` object and one
// element of a `filter_group` array share the shape.
type filterJSON struct {
	Property string   `json:"property"`
	Op       string   `json:"op"`
	Value    string   `json:"value"`
	Values   []string `json:"values"`
	Value2   string   `json:"value2"`
}

func (f filterJSON) rowFilter() rowFilter {
	return rowFilter{Prop: f.Property, Op: f.Op, Value: f.Value, Values: f.Values, Value2: f.Value2}
}

// parseFilterGroups reads repeatable filter_group params: one JSON array of
// conditions per OR group. Anything unparsable and any group left without a
// condition is skipped, so a half-built group never blanks the answer.
func parseFilterGroups(vals []string) [][]rowFilter {
	groups := [][]rowFilter{}
	for _, g := range vals {
		var conds []filterJSON
		if json.Unmarshal([]byte(g), &conds) != nil {
			continue
		}
		group := []rowFilter{}
		for _, c := range conds {
			if c.Property == "" {
				continue
			}
			group = append(group, c.rowFilter())
		}
		if len(group) > 0 {
			groups = append(groups, group)
		}
	}
	return groups
}

func (s *Server) handleCollectionRows(w http.ResponseWriter, r *http.Request) {
	colID := r.PathValue("id")
	if !s.canReadReq(r, colID) {
		httpError(w, 404, "not a collection")
		return
	}
	q := r.URL.Query()
	limit := 100
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 500 {
		limit = v
	}
	offset := 0
	if v, err := strconv.Atoi(q.Get("offset")); err == nil && v >= 0 {
		offset = v
	}
	var filters []rowFilter
	for _, f := range q["filter"] {
		// Two spellings, and both stay. `prop:op:value` is what curl, a
		// bookmarked URL and everything written before today sends; the JSON
		// object is what the interface sends, because a set of values and a
		// range have no place in a colon-separated string. Anything starting
		// with '{' is the second kind.
		if strings.HasPrefix(strings.TrimSpace(f), "{") {
			var jf filterJSON
			if json.Unmarshal([]byte(f), &jf) == nil && jf.Property != "" {
				filters = append(filters, jf.rowFilter())
			}
			continue
		}
		// Format: prop:op:value (op/value may be empty). Legacy prop:value still
		// works — a 2-part filter is treated as an equality/is-set condition.
		propID, rest, ok := strings.Cut(f, ":")
		var op, value string
		if ok {
			if o, v, ok2 := strings.Cut(rest, ":"); ok2 {
				op, value = o, v
			} else {
				value = rest
			}
		}
		filters = append(filters, rowFilter{Prop: propID, Op: op, Value: value})
	}
	// The viewer's day, so "today" means their today and not the server's.
	// Misshapen values fall back to the server's day (see parseTodayParam).
	var today time.Time
	if day, ok := parseTodayParam(q.Get("today")); ok {
		today = day
	}
	list, total, err := s.collectionRowsQuery(requestUser(r), colID, filters, parseFilterGroups(q["filter_group"]), strings.Join(q["sort"], ","), limit, offset, today)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]any{"rows": list, "total": total, "offset": offset, "limit": limit})
}

// createDefaultCollection initializes a fresh database page.
func (s *Server) createDefaultCollection(pageID string) error {
	_, err := s.db.Exec(`INSERT INTO collections (page_id, schema, views) VALUES (?, ?, ?)
		ON CONFLICT(page_id) DO NOTHING`, pageID, defaultSchema, defaultViews)
	return err
}

// extractPropsText pulls indexable text out of a props object for FTS.
func extractPropsText(props []byte) string {
	var m map[string]any
	if json.Unmarshal(props, &m) != nil {
		return ""
	}
	out := ""
	for _, v := range m {
		switch t := v.(type) {
		case string:
			out += t + " "
		case []any:
			for _, item := range t {
				if str, ok := item.(string); ok {
					out += str + " "
				}
			}
		}
	}
	return out
}
