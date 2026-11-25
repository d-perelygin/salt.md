package server

import (
	"html"
	"regexp"
	"strings"
)

// extractFileText turns an uploaded file into the plain text an agent can read.
//
// One function for both paths that need it — the chat's + attachment and
// read_page_file — because they had separate switches that disagreed: a format
// the chat understood could be "not readable as text" on the page, and the
// other way round. The list below is what the interface accepts; a format it
// cannot extract still uploads, it just has no text to give the model.
//
// savedPath is where the file lives on disk: the PDF reader opens a path rather
// than a byte slice. The bytes come along so the ZIP-based formats never touch
// the disk a second time.
func extractFileText(data []byte, savedPath, ext string) string {
	switch strings.ToLower(ext) {
	case ".pdf":
		return extractPDFText(savedPath)
	case ".docx", ".xlsx", ".pptx", ".odt":
		return extractOfficeText(data, ext)
	case ".html", ".htm":
		return htmlToText(string(data))
	case ".rtf":
		return rtfToText(string(data))
	}
	if isTextExt(ext) {
		return string(data)
	}
	return ""
}

// isTextExt lists the extensions read as text verbatim: plain text, data files,
// logs, and the source-code formats people paste into notes. Deliberately a
// list and not a guess from the bytes — a .png is not text just because its
// first bytes happen to be printable.
func isTextExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
		".xml", ".log", ".ini", ".toml", ".conf", ".sql", ".diff", ".patch",
		".go", ".py", ".js", ".ts", ".tsx", ".jsx", ".css", ".scss", ".sh",
		".bash", ".zsh", ".rb", ".rs", ".c", ".h", ".cpp", ".hpp", ".java",
		".kt", ".swift", ".php", ".lua", ".r", ".tex":
		return true
	}
	return false
}

var (
	htmlDrop  = regexp.MustCompile(`(?is)<(script|style|noscript)[^>]*>.*?</(script|style|noscript)>`)
	htmlBreak = regexp.MustCompile(`(?i)<\s*(br|/p|/div|/li|/tr|/h[1-6]|/table|/blockquote|/pre)\s*/?\s*>`)
	htmlTag   = regexp.MustCompile(`(?s)<[^>]*>`)
	htmlSpace = regexp.MustCompile(`[ \t\f\v]+`)
	htmlBlank = regexp.MustCompile(`\n{3,}`)
)

// htmlToText is a reader, not a renderer: headings, paragraphs, list items and
// table rows keep their line breaks, every other tag goes. Entities are
// decoded, so "&amp;" reaches the model as "&" and not as markup to puzzle over.
func htmlToText(s string) string {
	s = htmlDrop.ReplaceAllString(s, " ")
	s = htmlBreak.ReplaceAllString(s, "\n")
	s = htmlTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	lines := strings.Split(s, "\n")
	kept := make([]string, 0, len(lines))
	for _, ln := range lines {
		kept = append(kept, strings.TrimSpace(htmlSpace.ReplaceAllString(ln, " ")))
	}
	s = strings.Join(kept, "\n")
	s = htmlBlank.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

var (
	rtfHex     = regexp.MustCompile(`\\'[0-9a-fA-F]{2}`)
	rtfControl = regexp.MustCompile(`\\[a-zA-Z]+-?\d* ?`)
)

// rtfToText strips the RTF control words. The format is a run of groups and
// escape sequences, so what is left after them — plus its paragraph breaks —
// is the prose. It is not a parser, and does not pretend to be one.
func rtfToText(s string) string {
	s = strings.NewReplacer(`\par`, "\n", `\line`, "\n", `\tab`, "\t").Replace(s)
	s = rtfHex.ReplaceAllString(s, "")
	s = rtfControl.ReplaceAllString(s, "")
	// Escaped literals survive the control-word sweep.
	s = strings.NewReplacer(`\\`, "\x00", `\{`, "\x01", `\}`, "\x02").Replace(s)
	s = strings.NewReplacer("{", "", "}", "").Replace(s)
	s = strings.NewReplacer("\x00", `\`, "\x01", "{", "\x02", "}").Replace(s)
	return strings.TrimSpace(s)
}
