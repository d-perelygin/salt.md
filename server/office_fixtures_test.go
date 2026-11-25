package server

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// Small, synthetic office files: the real ones are megabytes of boilerplate
// around the same few elements, and a test that builds them here says exactly
// which part of the format the reader is expected to understand.

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("zip %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func docxFixture(t *testing.T) []byte {
	return zipOf(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		"word/document.xml": `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Договор с подрядчиком</w:t></w:r></w:p>
<w:p><w:r><w:t>Срок: три месяца.</w:t></w:r></w:p>
<w:tbl>
 <w:tr><w:tc><w:p><w:r><w:t>Сумма</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Срок</w:t></w:r></w:p></w:tc></w:tr>
 <w:tr><w:tc><w:p><w:r><w:t>1000</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3 мес</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`,
	})
}

func xlsxFixture(t *testing.T) []byte {
	return zipOf(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Смета" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>`,
		"xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Позиция</t></si><si><t>Цена</t></si><si><t>Рилс</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5000</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Монтаж</t></is></c><c r="B3"><v>777</v></c></row>
</sheetData></worksheet>`,
	})
}

func pptxFixture(t *testing.T) []byte {
	return zipOf(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		"ppt/slides/slide2.xml": `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Второй слайд</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		"ppt/slides/slide1.xml": `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Первый слайд</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
	})
}

func odtFixture(t *testing.T) []byte {
	return zipOf(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		"content.xml": `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:text>
<text:h>Отчёт</text:h>
<text:p>Вводный абзац.</text:p>
<table:table>
 <table:table-row><table:table-cell><text:p>Метрика</text:p></table:table-cell><table:table-cell><text:p>Значение</text:p></table:table-cell></table:table-row>
 <table:table-row><table:table-cell><text:p>Рилсы</text:p></table:table-cell><table:table-cell><text:p>12</text:p></table:table-cell></table:table-row>
</table:table>
</office:text></office:body></office:document-content>`,
	})
}

// Tables keep their shape, sheets keep their names and columns, slides keep
// their order — the three things a flat "every text element in document order"
// walk lost.
func TestOfficeTextKeepsTablesAndOrder(t *testing.T) {
	docx := extractOfficeText(docxFixture(t), ".docx")
	for _, want := range []string{"Договор с подрядчиком", "Срок: три месяца.", "| Сумма | Срок |", "| 1000 | 3 мес |"} {
		if !strings.Contains(docx, want) {
			t.Errorf("docx: missing %q in:\n%s", want, docx)
		}
	}

	xlsx := extractOfficeText(xlsxFixture(t), ".xlsx")
	for _, want := range []string{"[Смета]", "| Позиция | Цена |", "| Рилс | 5000 |", "| Монтаж | 777 |"} {
		if !strings.Contains(xlsx, want) {
			t.Errorf("xlsx: missing %q in:\n%s", want, xlsx)
		}
	}
	if strings.Contains(xlsx, "0 1") || strings.Contains(xlsx, "| 0 | 1 |") {
		t.Errorf("xlsx: sharedString indices leaked into the table:\n%s", xlsx)
	}

	pptx := extractOfficeText(pptxFixture(t), ".pptx")
	if strings.Index(pptx, "[Slide 1]") < 0 || strings.Index(pptx, "[Slide 2]") < 0 {
		t.Fatalf("pptx: slides are not numbered:\n%s", pptx)
	}
	if strings.Index(pptx, "Первый слайд") > strings.Index(pptx, "Второй слайд") {
		t.Errorf("pptx: slides are out of order:\n%s", pptx)
	}

	odt := extractOfficeText(odtFixture(t), ".odt")
	for _, want := range []string{"Отчёт", "Вводный абзац.", "| Метрика | Значение |", "| Рилсы | 12 |"} {
		if !strings.Contains(odt, want) {
			t.Errorf("odt: missing %q in:\n%s", want, odt)
		}
	}
}
