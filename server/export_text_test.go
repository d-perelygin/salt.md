package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPagePlainText(t *testing.T) {
	content := `[
		{
			"type": "heading",
			"props": { "level": 1 },
			"content": [{ "type": "text", "text": "My Heading", "styles": {} }]
		},
		{
			"type": "paragraph",
			"props": {},
			"content": [
				{ "type": "text", "text": "This is ", "styles": {} },
				{ "type": "text", "text": "bold", "styles": { "bold": true } },
				{ "type": "text", "text": " and ", "styles": {} },
				{ "type": "link", "content": [{ "type": "text", "text": "a link", "styles": {} }], "href": "https://example.com" }
			]
		},
		{
			"type": "bulletListItem",
			"props": {},
			"content": [{ "type": "text", "text": "First bullet", "styles": {} }]
		},
		{
			"type": "checkListItem",
			"props": { "checked": true },
			"content": [{ "type": "text", "text": "Done task", "styles": {} }]
		}
	]`

	p := &page{
		pageMeta: pageMeta{Title: "Test Document"},
		Content:  json.RawMessage(content),
	}

	txt := pagePlainText(p)

	if !strings.Contains(txt, "Test Document\n\n") {
		t.Errorf("Expected title, got:\n%s", txt)
	}
	if !strings.Contains(txt, "My Heading\n\n") {
		t.Errorf("Expected heading without #, got:\n%s", txt)
	}
	if strings.Contains(txt, "#") {
		t.Errorf("Plain text should not have #, got:\n%s", txt)
	}
	if strings.Contains(txt, "**") {
		t.Errorf("Plain text should not have **, got:\n%s", txt)
	}
	if strings.Contains(txt, "https://example.com") {
		t.Errorf("Plain text should not have raw URL when label exists, got:\n%s", txt)
	}
	if !strings.Contains(txt, "This is bold and a link") {
		t.Errorf("Expected 'This is bold and a link', got:\n%s", txt)
	}
	if !strings.Contains(txt, "• First bullet") {
		t.Errorf("Expected bullet with dot, got:\n%s", txt)
	}
	if !strings.Contains(txt, "[x] Done task") {
		t.Errorf("Expected [x] Done task, got:\n%s", txt)
	}
}

func TestPagePlainTextPageLinkAndFormatting(t *testing.T) {
	// BUG-16: pageLink preserves label; BUG-49: non-emoji icons skipped,
	// columns flattened, toggleListItem emits trailing blank line.
	content := `[
		{
			"type": "paragraph",
			"props": {},
			"content": [
				{ "type": "text", "text": "See ", "styles": {} },
				{ "type": "pageLink", "props": { "pageId": "abc", "label": "Roadmap" } },
				{ "type": "text", "text": " today", "styles": {} }
			]
		},
		{
			"type": "columns",
			"children": [
				{
					"type": "column",
					"children": [
						{ "type": "paragraph", "content": [{ "type": "text", "text": "Inside column" }] }
					]
				}
			]
		},
		{
			"type": "toggleListItem",
			"content": [{ "type": "text", "text": "Toggle item" }]
		},
		{
			"type": "paragraph",
			"content": [{ "type": "text", "text": "After toggle" }]
		}
	]`

	for _, icon := range []string{"lucide:Rocket:#e03131", "mdi:Star", "/files/logo.png"} {
		p := &page{
			pageMeta: pageMeta{Title: "Doc", Icon: icon},
			Content:  json.RawMessage(content),
		}
		txt := pagePlainText(p)
		if !strings.HasPrefix(txt, "Doc\n\n") {
			t.Errorf("non-emoji icon %q leaked into title prefix:\n%s", icon, txt)
		}
	}

	p := &page{
		pageMeta: pageMeta{Title: "Doc", Icon: "🚀"},
		Content:  json.RawMessage(content),
	}
	txt := pagePlainText(p)
	if !strings.HasPrefix(txt, "🚀 Doc\n\n") {
		t.Errorf("emoji icon missing from title prefix:\n%s", txt)
	}
	if !strings.Contains(txt, "See Roadmap today") {
		t.Errorf("pageLink label lost:\n%s", txt)
	}
	if !strings.Contains(txt, "\nInside column\n") {
		t.Errorf("columns container added unexpected indentation:\n%s", txt)
	}
	if !strings.Contains(txt, "• Toggle item\n\nAfter toggle") {
		t.Errorf("toggleListItem missing trailing blank line:\n%s", txt)
	}
}

func TestPlainTextExportDepthCap(t *testing.T) {
	// BUG-48: cap recursion at 64 and indentation width at 32 (64 spaces).
	var sb strings.Builder
	for i := 0; i < 80; i++ {
		sb.WriteString(`[{"type":"paragraph","content":[{"type":"text","text":"lvl"}],"children":`)
	}
	sb.WriteString(`[{"type":"paragraph","content":[{"type":"text","text":"deepest"}]}]`)
	for i := 0; i < 80; i++ {
		sb.WriteString(`}]`)
	}
	txt := blocksToPlainText([]byte(sb.String()))
	if strings.Contains(txt, "deepest") {
		t.Errorf("expected depth > 64 node to be truncated, got:\n%s", txt)
	}
	if strings.Contains(txt, strings.Repeat(" ", 66)+"lvl") {
		t.Errorf("expected indentation capped at 32 levels (64 spaces), got:\n%s", txt)
	}
	if !strings.Contains(txt, strings.Repeat(" ", 64)+"lvl") {
		t.Errorf("expected depth >= 32 up to 64 to cap at 64 spaces")
	}
}

func TestCollectionPlainTextFormatting(t *testing.T) {
	s := testServer(t)
	aliceID, _ := signedIn(t, s, "alice-exp@example.test")
	ws := makeNamedWorkspace(t, s, aliceID, "ExpWS")
	col := s.makeCollection(t, ws, aliceID, "Tasks", `[
		{"id":"score","name":"Score","type":"number"},
		{"id":"steps","name":"Steps","type":"checklist"},
		{"id":"notes","name":"Notes\tCol","type":"text"}
	]`)
	s.makeRow(t, ws, aliceID, col, "Row\tOne\nLine2", `{"score":1.5,"steps":[{"id":"1","text":"First","done":true},{"id":"2","text":"Second","done":false}],"notes":"hello\tworld\r\nnext"}`)

	p, err := s.getPage(col)
	if err != nil {
		t.Fatalf("getPage: %v", err)
	}
	txt, err := s.collectionPlainText(p, aliceID)
	if err != nil {
		t.Fatalf("collectionPlainText: %v", err)
	}
	if strings.Contains(txt, "1.5000") || !strings.Contains(txt, "\t1.5\t") {
		t.Errorf("expected clean float 1.5, got:\n%s", txt)
	}
	if !strings.Contains(txt, "[x] First, [ ] Second") {
		t.Errorf("expected serialized checklist, got:\n%s", txt)
	}
	lines := strings.Split(strings.TrimSpace(txt), "\n")
	// Title line, blank line, header line, 1 row line = 4 lines
	if len(lines) != 4 {
		t.Errorf("embedded newline broke TSV row count (got %d lines):\n%s", len(lines), txt)
	}
	if gotCols := strings.Count(lines[3], "\t"); gotCols != 3 {
		t.Errorf("embedded tab broke TSV column count (got %d tabs, want 3):\n%s", gotCols, lines[3])
	}
}
