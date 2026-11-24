package server

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestOfficeTextExtract(t *testing.T) {
	type tc struct {
		file  string
		ext   string
		wants []string
	}
	cases := []tc{
		{"/tmp/t.docx", ".docx", []string{"Hello docx world", "Second line here"}},
		{"/tmp/t.xlsx", ".xlsx", []string{"Name", "City", "42"}},
		{"/tmp/t.pptx", ".pptx", []string{"Slide title text"}},
		{"/tmp/t.odt", ".odt", []string{"Heading one", "Paragraph body here"}},
	}
	for _, c := range cases {
		data, err := os.ReadFile(c.file)
		if err != nil {
			t.Skipf("no fixture %s (run /tmp/mkoffice.py first): %v", c.file, err)
		}
		got := extractOfficeText(data, c.ext)
		for _, w := range c.wants {
			if !strings.Contains(got, w) {
				t.Errorf("%s: missing %q in %q", c.ext, w, got)
			}
		}
	}
	if got := extractOfficeText([]byte("not a zip"), ".docx"); got != "" {
		t.Errorf("garbage should give empty, got %q", got)
	}
	if got := extractOfficeText([]byte("x"), ".txt"); got != "" {
		t.Errorf("unknown ext should give empty, got %q", got)
	}
}

// A spreadsheet's <v> cells are sharedStrings indices, not values. Writing
// them too put a row of unrelated numbers in the middle of every table.
func TestOfficeTextXlsxSkipsSharedStringIndexes(t *testing.T) {
	files := map[string]string{
		"[Content_Types].xml":      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		"xl/workbook.xml":          `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Смета" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/sharedStrings.xml":     `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Позиция</t></si><si><t>Цена</t></si><si><t>Рилс</t></si><si><t>5000</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>777</v></c></row></sheetData></worksheet>`,
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	got := extractOfficeText(buf.Bytes(), ".xlsx")
	for _, want := range []string{"[Смета]", "Позиция", "Цена", "Рилс", "5000", "777"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "0 1") || strings.Contains(got, "2 3") {
		t.Errorf("sharedString indices leaked into the text: %q", got)
	}
}
