package server

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// A lookup cell names the records behind it, so the interface can edit each of
// them where the value is read. These tests pin what the row says about the
// cell, because that is all the interface gets.
func TestLookupCellNamesItsSources(t *testing.T) {
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
	sources := func(rowID, prop string) []lookupSource {
		raw, _ := cell(rowID, prop)["sources"].([]lookupSource)
		return raw
	}

	// One record behind the value: the cell edits that record in place, and
	// carries its raw value so an editor can show a select id or a day.
	src := sources(linked, "lpr")
	if len(src) != 1 || src[0].Page != one || src[0].Title != "Чанган" {
		t.Fatalf("one-record lookup sources are %#v", src)
	}
	if src[0].Value != "Анна +7 905 913-67-63" {
		t.Errorf("raw value is %#v, want the stored text", src[0].Value)
	}
	if c := cell(linked, "lpr"); c["prop"] != "contact" || c["collection"] != companies {
		t.Errorf("the cell does not address the target field: %#v", c)
	}

	// Two records behind the value: the cell opens a list, one editable block
	// per record — never a single string to edit.
	src = sources(twoLinks, "list")
	if len(src) != 2 || src[0].Page != one || src[1].Page != two {
		t.Fatalf("two-record lookup sources are %#v", src)
	}
	// "First value" shows ONE record's value, so it edits that record and not
	// the other rows behind the cell.
	if src = sources(twoLinks, "lpr"); len(src) != 1 || src[0].Page != one {
		t.Fatalf("a first-value lookup offered %#v", src)
	}

	// Nothing shown, one record could hold it: the gap can be filled from here.
	src = sources(oneEmpty, "lpr")
	if len(src) != 1 || src[0].Page != empty {
		t.Fatalf("empty single-candidate lookup offers %#v", src)
	}
	if src[0].Value != nil {
		t.Errorf("an empty source should carry a nil value, got %#v", src[0].Value)
	}

	// Nothing shown, several records could hold it: name them all, with empty
	// fields, rather than guessing.
	if src = sources(twoEmpty, "lpr"); len(src) != 2 {
		t.Fatalf("ambiguous lookup sources are %#v", src)
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
	src, _ := cell["sources"].([]lookupSource)
	if len(src) != 1 || src[0].Page != live {
		t.Fatalf("the trashed row is still a source: %#v", cell)
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
		if cell, ok := lookups[prop]; ok {
			t.Errorf("%s offered a source to write: %#v", prop, cell)
		}
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
	src, _ := got.Lookup["lpr"]["sources"].([]any)
	if len(src) != 1 {
		t.Errorf("opened row sources are %#v", got.Lookup["lpr"]["sources"])
	}
	_ = fmt.Sprint(uid)
}
