package server

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Office text extraction for AI attachments and MCP file reads. Only the
// standard library: archive/zip plus XML decoding, so no native dependency
// enters the build (CGO stays off, cross-compiles keep working).
//
// The goal is what an agent needs to WORK with the file, not a rendering: sheet
// names, table rows and cell values keep their shape (Markdown tables), slide
// numbers separate their text, and paragraph breaks survive. A previous version
// collected every text element in document order, which was enough for prose
// and wrong for tables: a spreadsheet came out as its shared-strings list plus
// a row of numbers, with no cell belonging to a column.
//
// Output is capped: AI context wants the beginning of a document, not the whole
// book. A broken archive or a zip bomb degrades to an empty string, never to an
// error or a panic for the caller.
const officeTextCap = 200_000
const officeZipCap = 20 << 20 // total uncompressed bytes read, zip-bomb guard

// extractOfficeText pulls readable text out of an OOXML or OpenDocument file
// already in memory.
func extractOfficeText(data []byte, ext string) (text string) {
	defer func() {
		if r := recover(); r != nil {
			text = ""
		}
	}()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	switch ext {
	case ".docx":
		return strings.TrimSpace(extractDocx(zr))
	case ".xlsx":
		return strings.TrimSpace(extractXlsx(zr))
	case ".pptx":
		return strings.TrimSpace(extractPptx(zr))
	case ".odt":
		return strings.TrimSpace(extractOdt(zr))
	}
	return ""
}

// zipPart reads one entry, charging the shared uncompressed budget so a
// crafted archive cannot expand without bound.
func zipPart(zr *zip.Reader, name string, budget *int) []byte {
	if *budget <= 0 {
		return nil
	}
	f, err := zr.Open(name)
	if err != nil {
		return nil
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, int64(*budget)))
	if err != nil {
		return nil
	}
	*budget -= len(data)
	return data
}

func decodeXML(data []byte) *xml.Decoder {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	return dec
}

// docSpec tells the shared table/paragraph walker which local element names
// play which role in a given format. The formats differ only in vocabulary:
// Word says tbl/tr/tc/p/t, OpenDocument says table/table-row/table-cell/p/h and
// puts its text anywhere.
type docSpec struct {
	table map[string]bool
	row   map[string]bool
	cell  map[string]bool
	para  map[string]bool
	// text names the elements whose character data is content. Nil means any
	// character data at all (OpenDocument).
	text map[string]bool
}

// extractTableText walks one XML part and writes prose as lines, tables as
// Markdown tables. Paragraphs inside a cell join with a space.
func extractTableText(data []byte, spec docSpec) string {
	var out strings.Builder
	var para, cell strings.Builder
	var row []string
	var table [][]string
	inCell, inTable := false, false
	var stack []string
	dec := decodeXML(data)
	for out.Len() < officeTextCap {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := localName(t.Name.Local)
			stack = append(stack, name)
			switch {
			case spec.table[name]:
				inTable, table, row = true, nil, nil
			case spec.row[name]:
				row = nil
			case spec.cell[name]:
				inCell = true
				cell.Reset()
			}
		case xml.CharData:
			if len(stack) == 0 {
				continue
			}
			if spec.text != nil && !spec.text[stack[len(stack)-1]] {
				continue
			}
			if inCell {
				cell.WriteString(string(t))
			} else {
				para.WriteString(string(t))
			}
		case xml.EndElement:
			name := localName(t.Name.Local)
			switch {
			case spec.cell[name]:
				row = append(row, squash(cell.String()))
				inCell = false
			case spec.row[name]:
				if len(row) > 0 {
					table = append(table, row)
				}
				row = nil
			case spec.table[name]:
				if len(table) > 0 {
					out.WriteString("\n" + markdownTable(table) + "\n")
				}
				inTable, table = false, nil
			case spec.para[name]:
				if inCell {
					cell.WriteString(" ")
				} else {
					if line := squash(para.String()); line != "" {
						out.WriteString(line + "\n")
					}
					para.Reset()
				}
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			_ = inTable
		}
	}
	return out.String()
}

var docxSpec = docSpec{
	table: map[string]bool{"tbl": true},
	row:   map[string]bool{"tr": true},
	cell:  map[string]bool{"tc": true},
	para:  map[string]bool{"p": true},
	text:  map[string]bool{"t": true},
}

var odtSpec = docSpec{
	table: map[string]bool{"table": true},
	row:   map[string]bool{"table-row": true},
	cell:  map[string]bool{"table-cell": true},
	para:  map[string]bool{"p": true, "h": true},
}

func extractDocx(zr *zip.Reader) string {
	budget := officeZipCap
	data := zipPart(zr, "word/document.xml", &budget)
	if data == nil {
		return ""
	}
	return extractTableText(data, docxSpec)
}

func extractOdt(zr *zip.Reader) string {
	budget := officeZipCap
	data := zipPart(zr, "content.xml", &budget)
	if data == nil {
		return ""
	}
	return extractTableText(data, odtSpec)
}

// --- spreadsheets -----------------------------------------------------------

// sheetRef is one sheet of a workbook: its name as shown in the interface and
// the zip entry holding its cells.
type sheetRef struct{ name, path string }

func extractXlsx(zr *zip.Reader) string {
	budget := officeZipCap
	shared := parseSharedStrings(zipPart(zr, "xl/sharedStrings.xml", &budget))
	sheets := workbookSheets(zr, &budget)
	var out strings.Builder
	for _, sh := range sheets {
		if out.Len() >= officeTextCap {
			break
		}
		data := zipPart(zr, sh.path, &budget)
		if data == nil {
			continue
		}
		rows := sheetRows(data, shared)
		if len(rows) == 0 {
			continue
		}
		out.WriteString("[" + sh.name + "]\n" + markdownTable(rows) + "\n\n")
	}
	return out.String()
}

// parseSharedStrings collects the text of every <si>, including the runs of a
// rich string (<r><t>), which the old flat walker joined without separation.
func parseSharedStrings(data []byte) []string {
	if data == nil {
		return nil
	}
	var out []string
	var cur strings.Builder
	inSI := false
	var stack []string
	dec := decodeXML(data)
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := localName(t.Name.Local)
			stack = append(stack, name)
			if name == "si" {
				inSI = true
				cur.Reset()
			}
		case xml.CharData:
			if inSI && len(stack) > 0 && stack[len(stack)-1] == "t" {
				cur.Write(t)
			}
		case xml.EndElement:
			name := localName(t.Name.Local)
			if name == "si" && inSI {
				out = append(out, squash(cur.String()))
				inSI = false
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	return out
}

// workbookSheets reads the sheet order and names from xl/workbook.xml, resolving
// each r:id through the workbook relationships. Without that map the sheets are
// whatever order the archive happens to store them in, and the names are lost.
func workbookSheets(zr *zip.Reader, budget *int) []sheetRef {
	rels := map[string]string{}
	if data := zipPart(zr, "xl/_rels/workbook.xml.rels", budget); data != nil {
		type rel struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		}
		var doc struct {
			Rels []rel `xml:"Relationship"`
		}
		if xml.Unmarshal(data, &doc) == nil {
			for _, r := range doc.Rels {
				rels[r.ID] = r.Target
			}
		}
	}
	var sheets []sheetRef
	if data := zipPart(zr, "xl/workbook.xml", budget); data != nil {
		type sheet struct {
			Name    string `xml:"name,attr"`
			SheetID string `xml:"sheetId,attr"`
			RID     string `xml:"id,attr"`
		}
		var doc struct {
			Sheets []sheet `xml:"sheets>sheet"`
		}
		if xml.Unmarshal(data, &doc) == nil {
			for i, sh := range doc.Sheets {
				name := strings.TrimSpace(sh.Name)
				if name == "" {
					name = "Sheet " + strconv.Itoa(i+1)
				}
				path := ""
				if target := rels[sh.RID]; target != "" {
					path = strings.TrimPrefix(target, "/")
					if !strings.HasPrefix(path, "xl/") {
						path = "xl/" + path
					}
				} else {
					path = "xl/worksheets/sheet" + strconv.Itoa(i+1) + ".xml"
				}
				sheets = append(sheets, sheetRef{name: name, path: path})
			}
		}
	}
	if len(sheets) > 0 {
		return sheets
	}
	// No workbook part: fall back to the worksheet entries in archive order,
	// still naming them so the model knows where a table starts.
	var paths []string
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/") && strings.HasSuffix(f.Name, ".xml") {
			paths = append(paths, f.Name)
		}
	}
	sort.Strings(paths)
	for i, p := range paths {
		sheets = append(sheets, sheetRef{name: "Sheet " + strconv.Itoa(i+1), path: p})
	}
	return sheets
}

// sheetRows turns one worksheet into rows of resolved cell values, keeping the
// column each value sits in. Empty rows and trailing empties are dropped; the
// table renderer pads the rest.
func sheetRows(data []byte, shared []string) [][]string {
	var rows [][]string
	cells := map[int]string{}
	maxCol := -1
	var cur strings.Builder
	cellType, cellCol := "", -1
	inV, inIS := false, false
	var stack []string
	flushCell := func() {
		val := cur.String()
		if cellType == "s" {
			if n, err := strconv.Atoi(strings.TrimSpace(val)); err == nil && n >= 0 && n < len(shared) {
				val = shared[n]
			}
		}
		val = squash(val)
		if val != "" && cellCol >= 0 {
			cells[cellCol] = val
			if cellCol > maxCol {
				maxCol = cellCol
			}
		}
		cur.Reset()
		cellType, cellCol = "", -1
	}
	flushRow := func() {
		if maxCol >= 0 {
			line := make([]string, maxCol+1)
			for c, v := range cells {
				line[c] = v
			}
			rows = append(rows, line)
		}
		cells = map[int]string{}
		maxCol = -1
	}
	dec := decodeXML(data)
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := localName(t.Name.Local)
			stack = append(stack, name)
			switch name {
			case "row":
				// Row numbers only matter for gaps; the renderer keeps the
				// order cells arrive in, which is the document order anyway.
			case "c":
				cellType, cellCol = "", -1
				for _, a := range t.Attr {
					switch localName(a.Name.Local) {
					case "t":
						cellType = a.Value
					case "r":
						cellCol = colIndex(a.Value)
					}
				}
			case "v":
				inV = true
			case "is":
				inIS = true
			}
		case xml.CharData:
			top := ""
			if len(stack) > 0 {
				top = stack[len(stack)-1]
			}
			if (inV && top == "v") || (inIS && top == "t") {
				cur.Write(t)
			}
		case xml.EndElement:
			name := localName(t.Name.Local)
			switch name {
			case "v":
				inV = false
			case "is":
				inIS = false
			case "c":
				flushCell()
			case "row":
				flushRow()
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	flushRow()
	return rows
}

// colIndex turns a cell reference's letters into a zero-based column: A→0,
// Z→25, AA→26.
func colIndex(ref string) int {
	n := 0
	seen := false
	for _, r := range ref {
		switch {
		case r >= 'A' && r <= 'Z':
			n = n*26 + int(r-'A'+1)
			seen = true
		case r >= 'a' && r <= 'z':
			n = n*26 + int(r-'a'+1)
			seen = true
		default:
			if seen {
				return n - 1
			}
			return -1
		}
	}
	if !seen {
		return -1
	}
	return n - 1
}

// --- presentations ----------------------------------------------------------

// extractPptx keeps the slides apart and in order: the archive stores them in
// whatever order it likes, and a run of paragraphs with slides 3 and 1 mixed
// together is worse than no text at all.
func extractPptx(zr *zip.Reader) string {
	type slide struct {
		n  int
		at string
	}
	var slides []slide
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, "ppt/slides/slide") || !strings.HasSuffix(f.Name, ".xml") {
			continue
		}
		digits := strings.TrimSuffix(strings.TrimPrefix(f.Name, "ppt/slides/slide"), ".xml")
		n, err := strconv.Atoi(digits)
		if err != nil {
			continue
		}
		slides = append(slides, slide{n: n, at: f.Name})
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].n < slides[j].n })
	budget := officeZipCap
	var out strings.Builder
	for _, sl := range slides {
		if out.Len() >= officeTextCap {
			break
		}
		data := zipPart(zr, sl.at, &budget)
		if data == nil {
			continue
		}
		text := strings.TrimSpace(extractTableText(data, docSpec{
			para: map[string]bool{"p": true},
			text: map[string]bool{"t": true},
		}))
		if text == "" {
			continue
		}
		out.WriteString("[Slide " + strconv.Itoa(sl.n) + "]\n" + text + "\n\n")
	}
	return out.String()
}

// --- shared rendering -------------------------------------------------------

// markdownTable renders rows as a Markdown table. The first row is the header:
// every spreadsheet and Word table an agent reads has one, and a table without
// a separator line is not a table to any Markdown reader.
func markdownTable(rows [][]string) string {
	width := 0
	for _, r := range rows {
		if len(r) > width {
			width = len(r)
		}
	}
	if width == 0 {
		return ""
	}
	var b strings.Builder
	writeRow := func(r []string) {
		b.WriteString("|")
		for i := 0; i < width; i++ {
			cell := ""
			if i < len(r) {
				cell = r[i]
			}
			cell = strings.ReplaceAll(cell, "|", `\|`)
			cell = strings.ReplaceAll(cell, "\n", " ")
			b.WriteString(" " + strings.TrimSpace(cell) + " |")
		}
		b.WriteString("\n")
	}
	writeRow(rows[0])
	b.WriteString("|")
	for i := 0; i < width; i++ {
		b.WriteString(" --- |")
	}
	b.WriteString("\n")
	for _, r := range rows[1:] {
		writeRow(r)
	}
	return strings.TrimRight(b.String(), "\n")
}

// squash collapses every run of whitespace, which is how XML paragraph
// indentation and cell padding stop leaking into an agent's answer.
func squash(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func localName(s string) string {
	if i := strings.LastIndex(s, ":"); i >= 0 {
		return s[i+1:]
	}
	return s
}
