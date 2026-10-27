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
