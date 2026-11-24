package server

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"strings"
)

// Office text extraction for AI attachments and MCP file reads. Only the
// standard library: archive/zip plus a streaming XML walk, so no new native
// dependency enters the build (CGO stays off, cross-compiles keep working).
//
// The walk collects the character data of text elements and breaks paragraphs
// at block elements, ignoring everything else (formatting, drawings, revision
// markup). Output is capped: AI context wants the beginning of a document, not
// the whole book.
const officeTextCap = 200_000
const officeZipCap = 20 << 20 // total uncompressed bytes read, zip-bomb guard
const officeZipFiles = 500    // entries inspected at most

// extractOfficeText pulls readable text out of an OOXML or OpenDocument file
// already in memory. Unknown extensions and broken archives degrade to an
// empty string, never to an error (or a panic) for the caller.
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
	var only map[string]bool
	var texts, breaks map[string]bool
	switch ext {
	case ".docx":
		only = map[string]bool{"word/document.xml": true}
		texts = map[string]bool{"t": true}
		breaks = map[string]bool{"p": true}
	case ".xlsx":
		texts = map[string]bool{"t": true, "v": true}
		breaks = map[string]bool{"si": true, "row": true}
	case ".pptx":
		texts = map[string]bool{"t": true}
		breaks = map[string]bool{"p": true}
	case ".odt":
		only = map[string]bool{"content.xml": true}
		texts = map[string]bool{"p": true, "h": true, "span": true}
		breaks = map[string]bool{"p": true, "h": true}
	default:
		return ""
	}
	var b strings.Builder
	budget := officeZipCap
	files := 0
	for _, f := range zr.File {
		if files >= officeZipFiles || budget <= 0 || b.Len() >= officeTextCap {
			break
		}
		if only != nil && !only[f.Name] {
			continue
		}
		if ext == ".pptx" && (!strings.HasPrefix(f.Name, "ppt/slides/slide") || !strings.HasSuffix(f.Name, ".xml")) {
			continue
		}
		if ext == ".xlsx" && only == nil {
			ok := f.Name == "xl/sharedStrings.xml" || f.Name == "xl/workbook.xml" ||
				(strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml"))
			if !ok {
				continue
			}
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		part, read := walkOfficeXML(rc, texts, breaks, budget, officeTextCap-b.Len())
		rc.Close()
		files++
		budget -= read
		if part != "" {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(part)
		}
	}
	return strings.TrimSpace(b.String())
}

// walkOfficeXML streams one XML part, collecting text. Returns the text and
// the bytes read (for the zip budget).
func walkOfficeXML(r io.Reader, texts, breaks map[string]bool, budget, capLeft int) (string, int) {
	var b strings.Builder
	var stack []string
	read := 0
	// A spreadsheet cell whose <v> is an index into sharedStrings, not a
	// value. Writing the index too put "0 1" / "2 3" in the middle of every
	// table an agent read — the strings were there, but so was the row of
	// numbers that addresses them.
	inSharedCell := false
	dec := xml.NewDecoder(io.LimitReader(r, int64(budget)))
	dec.Strict = false
	for b.Len() < capLeft {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := localName(t.Name.Local)
			stack = append(stack, name)
			if name == "c" {
				for _, a := range t.Attr {
					if localName(a.Name.Local) == "t" && a.Value == "s" {
						inSharedCell = true
					}
				}
			}
			// The sheet's own name is an attribute, and it is the one piece of
			// context a table needs: which sheet these rows belong to.
			if name == "sheet" {
				for _, a := range t.Attr {
					if localName(a.Name.Local) == "name" && strings.TrimSpace(a.Value) != "" {
						if b.Len() > 0 {
							b.WriteString("\n")
						}
						b.WriteString("[" + strings.TrimSpace(a.Value) + "]\n")
					}
				}
			}
		case xml.CharData:
			read += len(t)
			top := ""
			if len(stack) > 0 {
				top = stack[len(stack)-1]
			}
			if inSharedCell && top == "v" {
				continue // an index, not a value
			}
			if texts[top] {
				s := strings.TrimSpace(string(t))
				if s != "" {
					if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") && !strings.HasSuffix(b.String(), " ") {
						b.WriteString(" ")
					}
					b.WriteString(s)
				}
			}
		case xml.EndElement:
			name := localName(t.Name.Local)
			if name == "c" {
				inSharedCell = false
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			if breaks[name] {
				b.WriteString("\n")
			}
		}
	}
	return strings.TrimSpace(b.String()), read
}

func localName(s string) string {
	if i := strings.LastIndex(s, ":"); i >= 0 {
		return s[i+1:]
	}
	return s
}
