package server

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// A lookup may be edited where it is read when the shown value belongs to
// exactly one record. These tests pin the rule from the outside: what a row
// says about the cell, because that is all the interface gets.
func TestLookupCellNamesItsRecord(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "lookup-write@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"contact","name":"Contact","type":"text"},
		{"id":"scale","name":"Scale","type":"select","options":[{"id":"big","name":"Крупный"}]}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"lpr","name":"ЛПР","type":"rollup","rollupRelation":"company","rollupTarget":"contact","rollupAgg":"first"},
		{"id":"list","name":"Все ЛПР","type":"rollup","rollupRelation":"company","rollupTarget":"contact","rollupAgg":"all"}]`)

	one := s.makeRow(t, ws, uid, companies, "Чанган", `{"contact":"Анна +7 905 913-67-63"}`)
	two := s.makeRow(t, ws, uid, companies, "СофтЛаб", `{"contact":"Ирина Травина"}`)
	empty := s.makeRow(t, ws, uid, companies, "Чашка кофе", `{}`)
	empty2 := s.makeRow(t, ws, uid, companies, "Кофейня", `{}`)

	linked := s.makeRow(t, ws, uid, sponsors, "One link", `{"company":["`+one+`"]}`)
	twoLinks := s.makeRow(t, ws, uid, sponsors, "Two links", `{"company":["`+one+`","`+two+`"]}`)
	oneEmpty := s.makeRow(t, ws, uid, sponsors, "One empty", `{"company":["`+empty+`"]}`)
	twoEmpty := s.makeRow(t, ws, uid, sponsors, "Two empty", `{"company":["`+empty+`","`+empty2+`"]}`)

	rows, _, err := s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	cell := func(rowID, prop string) map[string]any {
		for _, r := range rows {
			if r["id"] != rowID {
				continue
			}
			lookups, _ := r["lookup"].(map[string]any)
			m, _ := lookups[prop].(map[string]any)
			return m
		}
		t.Fatalf("row %s not in the answer", rowID)
		return nil
	}
	write := func(rowID, prop string) map[string]any {
		m, _ := cell(rowID, prop)["write"].(map[string]any)
		return m
	}

	// One record put the value there: the cell says which, and carries the raw
	// value so an editor can show a select id or a day rather than its text.
	w := write(linked, "lpr")
	if w == nil || w["page"] != one {
		t.Fatalf("one-record lookup write is %#v", w)
	}
	if c := cell(linked, "lpr"); c["prop"] != "contact" || c["collection"] != companies {
		t.Errorf("the cell does not address the target field: %#v", c)
	}
	if w["value"] != "Анна +7 905 913-67-63" {
		t.Errorf("raw value is %#v, want the stored text", w["value"])
	}
	if w["title"] != "Чанган" {
		t.Errorf("source title is %#v, want «Чанган»", w["title"])
	}

	// Two records put values there: read-only. A join has no single target.
	if w := write(twoLinks, "list"); w != nil {
		t.Errorf("two-record lookup offered a write target: %#v", w)
	}
	if w := write(twoLinks, "lpr"); w != nil {
		// "first" shows one value, but two rows contributed to the cell — and
		// the one whose value is shown may change with the order of the links.
		t.Errorf("a multi-contributor first lookup offered a write target: %#v", w)
	}

	// Nothing shown, one row could hold it: filling the gap has one place to go.
	w = write(oneEmpty, "lpr")
	if w == nil || w["page"] != empty {
		t.Fatalf("empty single-candidate lookup offers %#v", w)
	}
	if v, ok := w["value"]; !ok || v != nil {
		t.Errorf("an empty source should carry a nil value, got %#v", v)
	}

	// Nothing shown, several rows could hold it: name them and let the person
	// choose, rather than guessing a record.
	cands, _ := cell(twoEmpty, "lpr")["candidates"].([]map[string]any)
	if len(cands) != 2 {
		t.Fatalf("ambiguous lookup candidates are %#v", cell(twoEmpty, "lpr")["candidates"])
	}

	// The cell also names every visible value, so the interface can draw one
	// chip per record instead of a joined string that reads as more people.
	vals, _ := cell(twoLinks, "list")["values"].([]lookupCellValue)
	if len(vals) != 2 || vals[0].Title != "Чанган" || vals[1].Title != "СофтЛаб" {
		t.Errorf("values are %#v, want one per contributing record", vals)
	}
}

// The write really lands in the other row: that is the whole promise. Read the
// sponsor again and it shows the new contact, because there is no copy to keep
// in step.
func TestLookupWriteLandsInTheSourceRow(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "lookup-write-e2e@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"contact","name":"Contact","type":"text"}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"lpr","name":"ЛПР","type":"rollup","rollupRelation":"company","rollupTarget":"contact","rollupAgg":"first"}]`)

	company := s.makeRow(t, ws, uid, companies, "Чанган", `{"contact":"Анна"}`)
	sponsor := s.makeRow(t, ws, uid, sponsors, "Sponsor", `{"company":["`+company+`"]}`)

	rec := doReq(t, s, "PATCH", "/api/pages/"+company, cookie, `{"propsPatch":{"contact":"Анна +7 905 913-67-63"}}`)
	if rec.Code != 200 {
		t.Fatalf("write: %d %s", rec.Code, rec.Body)
	}

	rows, _, err := s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows: %v (%d)", err, len(rows))
	}
	props, _ := rows[0]["props"].(map[string]any)
	if got, _ := props["lpr"].(string); got != "Анна +7 905 913-67-63" {
		t.Errorf("sponsor lookup reads %q after the write", got)
	}
	if rows[0]["id"] != sponsor {
		t.Fatalf("wrong row: %v", rows[0]["id"])
	}
}

// A record in the trash is not a source: it is not read, so it cannot be
// written through either. Restoring it brings the link back on its own.
func TestLookupWriteSkipsTrashedRecords(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "lookup-write-trash@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"contact","name":"Contact","type":"text"}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"lpr","name":"ЛПР","type":"rollup","rollupRelation":"company","rollupTarget":"contact","rollupAgg":"first"}]`)

	live := s.makeRow(t, ws, uid, companies, "Живая", `{"contact":"Анна"}`)
	gone := s.makeRow(t, ws, uid, companies, "В корзине", `{"contact":"Пётр"}`)
	s.makeRow(t, ws, uid, sponsors, "Sponsor", `{"company":["`+live+`","`+gone+`"]}`)
	if _, err := s.db.Exec(`UPDATE pages SET trashed_at = ? WHERE id = ?`, now(), gone); err != nil {
		t.Fatalf("trash: %v", err)
	}

	rows, _, err := s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows: %v", err)
	}
	lookups, _ := rows[0]["lookup"].(map[string]any)
	cell, _ := lookups["lpr"].(map[string]any)
	w, _ := cell["write"].(map[string]any)
	if w == nil || w["page"] != live {
		t.Fatalf("the trashed row is still a write target: %#v", cell)
	}
	vals, _ := cell["values"].([]lookupCellValue)
	for _, v := range vals {
		if v.Page == gone {
			t.Errorf("a trashed record is still a visible value: %#v", v)
		}
	}
}

// A target the interface cannot edit is never offered, and neither is a status
// that a workflow moves through a dialog.
func TestLookupWriteRefusesWhatItCannotEdit(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "lookup-write-types@example.test")
	u := &user{ID: uid}
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"steps","name":"Steps","type":"checklist"},
		{"id":"status","name":"Status","type":"select","options":[{"id":"new","name":"New"}]}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"steps","name":"Steps","type":"rollup","rollupRelation":"company","rollupTarget":"steps","rollupAgg":"first"},
		{"id":"status","name":"Status","type":"rollup","rollupRelation":"company","rollupTarget":"status","rollupAgg":"first"}]`)

	company := s.makeRow(t, ws, uid, companies, "Co", `{"steps":[{"id":"a","text":"one","done":true}],"status":"new"}`)
	s.makeRow(t, ws, uid, sponsors, "Sponsor", `{"company":["`+company+`"]}`)

	// A workflow on the target collection, driven by "status".
	if _, err := s.db.Exec(`UPDATE collections SET workflow = ? WHERE page_id = ?`,
		`{"statusPropId":"status","rules":[]}`, companies); err != nil {
		t.Fatalf("workflow: %v", err)
	}

	rows, _, err := s.collectionRowsQuery(u, sponsors, nil, nil, "", 100, 0, time.Time{})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows: %v", err)
	}
	lookups, _ := rows[0]["lookup"].(map[string]any)
	for _, prop := range []string{"steps", "status"} {
		cell, _ := lookups[prop].(map[string]any)
		if w, ok := cell["write"]; ok {
			t.Errorf("%s offered a write target: %#v", prop, w)
		}
	}
	// The values still travel, so the cell can draw them: refusing a write must
	// not make the row less readable.
	if cell, _ := lookups["status"].(map[string]any); cell["values"] == nil {
		t.Errorf("the status lookup lost its values")
	}
}

// The page of a row shows the same cells as its table row: opening a sponsor
// must not make an editable lookup read-only.
func TestLookupWriteTravelsWithThePage(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "lookup-write-page@example.test")
	ws := s.firstWorkspaceOf(t, uid)

	companies := s.makeCollection(t, ws, uid, "Companies", `[
		{"id":"contact","name":"Contact","type":"text"}]`)
	sponsors := s.makeCollection(t, ws, uid, "Sponsors", `[
		{"id":"company","name":"Company","type":"relation","relationCollection":"`+companies+`"},
		{"id":"lpr","name":"ЛПР","type":"rollup","rollupRelation":"company","rollupTarget":"contact","rollupAgg":"first"}]`)
	company := s.makeRow(t, ws, uid, companies, "Чанган", `{"contact":"Анна"}`)
	sponsor := s.makeRow(t, ws, uid, sponsors, "Sponsor", `{"company":["`+company+`"]}`)

	rec := doReq(t, s, "GET", "/api/pages/"+sponsor, cookie, "")
	if rec.Code != 200 {
		t.Fatalf("page: %d %s", rec.Code, rec.Body)
	}
	var got struct {
		Lookup map[string]map[string]any `json:"lookup"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("page answer: %v", err)
	}
	if got.Lookup["lpr"] == nil {
		t.Fatalf("the opened row carries no lookup cell: %s", rec.Body)
	}
	w, _ := got.Lookup["lpr"]["write"].(map[string]any)
	if w == nil || w["page"] != company {
		t.Errorf("opened row write target is %#v", got.Lookup["lpr"])
	}
	_ = fmt.Sprint(uid)
}
