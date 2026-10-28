package server

import (
	"encoding/json"
	"strings"
	"testing"
)

// An agent writing Markdown has no other way to draw a rule, and `---` is what
// every model reaches for. The export already spelled a divider that way, so
// until this worked a page written by an agent and one rewritten by it came
// back different: the second one showed a literal "---" where the line was.
func TestThematicBreakBecomesADivider(t *testing.T) {
	md := "# Plan\n\nErstens.\n\n---\n\nZweitens.\n"
	blocks := mdToBlocks(md)

	var types []string
	for _, b := range blocks {
		types = append(types, b.Type)
	}
	want := []string{"heading", "paragraph", "divider", "paragraph"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Fatalf("blocks are %v, want %v", types, want)
	}
}

// Every spelling Markdown accepts, because the agent picks the one it was
// trained on and none of them is wrong.
func TestEveryRuleSpelling(t *testing.T) {
	for _, line := range []string{"---", "***", "___", "- - -", "* * *", "_ _ _", "-----"} {
		blocks := mdToBlocks("oben\n\n" + line + "\n\nunten\n")
		n := 0
		for _, b := range blocks {
			if b.Type == "divider" {
				n++
			}
		}
		if n != 1 {
			t.Errorf("%q produced %d dividers, want 1", line, n)
		}
	}
}

// Three dashes are a rule only when they are the whole line and all the same
// marker. A sentence that contains them, a dashed word, and a line that starts
// with the rule but goes on all stay text.
func TestHyphensInsideTextStayText(t *testing.T) {
	for _, md := range []string{"a --- b\n", "--keep---going\n", "--- text\n", "---- **** ____\n"} {
		for _, b := range mdToBlocks(md) {
			if b.Type == "divider" {
				t.Errorf("%q became a divider", md)
			}
		}
	}
}

// A rule right under a list item is still a rule — Markdown gives the break
// precedence, and an agent that closes a list with one means it.
func TestRuleEndsAList(t *testing.T) {
	blocks := mdToBlocks("- Punkt\n---\n")
	if len(blocks) != 2 || blocks[0].Type != "bulletListItem" || blocks[1].Type != "divider" {
		var types []string
		for _, b := range blocks {
			types = append(types, b.Type)
		}
		t.Fatalf("blocks are %v, want [bulletListItem divider]", types)
	}
}

// And back out again: a page that goes through Markdown keeps its line.
func TestDividerRoundTripsThroughMarkdown(t *testing.T) {
	in := "oben\n\n---\n\nunten\n"
	raw, err := json.Marshal(mdToBlocks(in))
	if err != nil {
		t.Fatal(err)
	}
	md := blocksToMarkdown(raw)
	if !strings.Contains(md, "---") {
		t.Fatalf("the divider did not come back as Markdown:\n%s", md)
	}
	n := 0
	for _, b := range mdToBlocks(md) {
		if b.Type == "divider" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("second pass produced %d dividers, want 1", n)
	}
}
