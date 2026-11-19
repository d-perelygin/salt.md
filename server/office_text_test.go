package server

import (
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
