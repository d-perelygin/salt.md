package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// A lookup is the rollup that carries a value instead of a number. The test is
// written against the question a person asks the table — "which scale is the
// company at, which categories does it have" — because the failure this
// replaces was a column of ids that looked like data and was not.
func TestRollupLookupPullsRelatedValues(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "lookup@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"scale","name":"Scale","type":"select","options":[
			{"id":"big","name":"Крупный","color":"#2f9e44"},
			{"id":"small","name":"Мелкий","color":"#909090"}]},
		{"id":"cats","name":"Categories","type":"multiselect","options":[
			{"id":"food","name":"еда"},{"id":"it","name":"IT"}]}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"scale","name":"Scale","type":"rollup","rollupRelation":"company","rollupTarget":"scale","rollupAgg":"first"},
		{"id":"cats","name":"Categories","type":"rollup","rollupRelation":"company","rollupTarget":"cats","rollupAgg":"all"},
		{"id":"cats-unique","name":"Categories unique","type":"rollup","rollupRelation":"company","rollupTarget":"cats","rollupAgg":"unique"},
		{"id":"big-only","name":"Big only","type":"rollup","rollupRelation":"company","rollupTarget":"scale","rollupAgg":"all",
		 "rollupWhereProp":"scale","rollupWhereOp":"is","rollupWhereValue":"big"}]`)

	big := s.makeRow(t, ws, uid, companies, "Big Co", `{"scale":"big","cats":["food","it"]}`)
	small := s.makeRow(t, ws, uid, companies, "Small Co", `{"scale":"small","cats":["food"]}`)
	s.makeRow(t, ws, uid, sponsors, "Both", `{"company":["`+big+`","`+small+`"]}`)
	s.makeRow(t, ws, uid, sponsors, "None", `{}`)
	s.makeRow(t, ws, uid, sponsors, "Small only", `{"company":["`+small+`"]}`)

	rows, _, err := s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	byTitle := map[string]map[string]any{}
	for _, r := range rows {
		byTitle[r["title"].(string)], _ = r["props"].(map[string]any)
	}

	both := byTitle["Both"]
	if got, _ := both["scale"].(string); got != "Крупный" {
		t.Errorf("first lookup is %q, want the option NAME «Крупный» (not the id)", got)
	}
	// "All values" keeps every value of every related row, duplicates included:
	// it says what the rows hold, not how many kinds there are. "Unique" is the
	// function that collapses them, and the two must not quietly become one.
	if got, _ := both["cats"].(string); got != "еда, IT, еда" {
		t.Errorf("all lookup is %q, want every value in row order", got)
	}
	if got, _ := both["cats-unique"].(string); got != "еда, IT" {
		t.Errorf("unique lookup is %q, want the same two categories once", got)
	}
	// The condition narrows the rows the lookup reads, exactly as it narrows a
	// count — otherwise a lookup could not say "the scale of the big ones".
	if got, _ := both["big-only"].(string); got != "Крупный" {
		t.Errorf("conditional lookup is %q, want only the matching company", got)
	}

	// A row with no links is blank, not zero and not a stray separator: the
	// cell has nothing to say, and 0 is a statement about a value.
	if got := byTitle["None"]["scale"]; got != "" {
		t.Errorf("a sponsor without a company shows %#v, want an empty cell", got)
	}
	if got := byTitle["None"]["cats"]; got != "" {
		t.Errorf("a sponsor without a company shows %#v categories, want none", got)
	}

	// One linked row reads the same in all three functions.
	if got, _ := byTitle["Small only"]["scale"].(string); got != "Мелкий" {
		t.Errorf("single-company lookup is %q, want «Мелкий»", got)
	}
}

// What the relation reaches is what the lookup sees: a trashed row is gone from
// the relation (restore brings it back), and a row the caller may not read
// answers nothing rather than leaking its value.
func TestRollupLookupSkipsTrashedRows(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "lookup-trash@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"scale","name":"Scale","type":"select","options":[{"id":"big","name":"Крупный"}]}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"scale","name":"Scale","type":"rollup","rollupRelation":"company","rollupTarget":"scale","rollupAgg":"first"},
		{"id":"count","name":"Companies","type":"rollup","rollupRelation":"company","rollupAgg":"count"}]`)

	live := s.makeRow(t, ws, uid, companies, "Live", `{"scale":"big"}`)
	gone := s.makeRow(t, ws, uid, companies, "Gone", `{"scale":"big"}`)
	s.makeRow(t, ws, uid, sponsors, "Sponsor", `{"company":["`+live+`","`+gone+`"]}`)
	if _, err := s.db.Exec(`UPDATE pages SET trashed_at = ? WHERE id = ?`, now(), gone); err != nil {
		t.Fatalf("trash: %v", err)
	}

	rows, _, err := s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows: %v (%d rows)", err, len(rows))
	}
	props, _ := rows[0]["props"].(map[string]any)
	if got, _ := props["scale"].(string); got != "Крупный" {
		t.Errorf("the lookup read the trashed company: %q", got)
	}
	if got, _ := toNumber(props["count"]); got != 1 {
		t.Errorf("the count still includes the trashed row: %v", got)
	}

	// Restore is the other half of the promise: the id never left the relation,
	// so the value comes back on its own.
	if _, err := s.db.Exec(`UPDATE pages SET trashed_at = NULL WHERE id = ?`, gone); err != nil {
		t.Fatalf("restore: %v", err)
	}
	rows, _, err = s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows after restore: %v", err)
	}
	props, _ = rows[0]["props"].(map[string]any)
	if got, _ := toNumber(props["count"]); got != 2 {
		t.Errorf("restore did not bring the link back: count %v", got)
	}
}

// Values that are not a select still read: a number keeps its digits, a
// checkbox its tick, a checklist its progress. And the value the schema no
// longer knows is shown as stored rather than dropped.
func TestLookupTextFormatsScalars(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "lookup-text@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	_ = s.makeCollection(t, ws, uid, "Unused", `[]`)
	def := func(typ, id string) propDef {
		return propDef{ID: id, Type: typ}
	}
	props := map[string]any{
		"n":       float64(5000),
		"n2":      float64(0.5),
		"box":     true,
		"box-off": false,
		"list":    []any{map[string]any{"text": "a", "done": true}, map[string]any{"text": "b", "done": false}},
		"sel":     "gone-option",
	}
	cases := []struct {
		def  propDef
		want string
	}{
		{def("number", "n"), "5000"},
		{def("number", "n2"), "0.5"},
		{def("checkbox", "box"), "✓"},
		{def("checkbox", "box-off"), ""},
		{def("checklist", "list"), "1/2"},
		{def("select", "sel"), "gone-option"},
	}
	for _, c := range cases {
		if got := strings.Join(s.lookupValues(c.def, props, map[string]string{}), ", "); got != c.want {
			t.Errorf("%s: %q, want %q", c.def.ID, got, c.want)
		}
	}
}

// The value travels to the client as JSON, so the shape it lands in matters:
// a lookup must be a plain string and never a number, or the table would put a
// progress bar on a status.
func TestLookupValueIsAString(t *testing.T) {
	vals := []string{"Крупный", "еда", "IT"}
	out := mergeLookup("all", vals)
	if out != "Крупный, еда, IT" {
		t.Fatalf("all: %q", out)
	}
	b, err := json.Marshal(map[string]any{"v": out})
	if err != nil || !strings.Contains(string(b), `"v":"Крупный`) {
		t.Errorf("lookup value did not travel as a string: %s (%v)", b, err)
	}
	if got := mergeLookup("first", nil); got != "" {
		t.Errorf("empty first: %q", got)
	}
	if got := mergeLookup("unique", []string{"a", "b", "a"}); got != "a, b" {
		t.Errorf("unique: %q", got)
	}
}
