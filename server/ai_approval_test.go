package server

import "testing"

// The approval gate in "review": reads never ask, every destructive act does.
func TestReviewAsksForEveryDestructiveTool(t *testing.T) {
	for name := range aiDestructiveTools {
		if !toolNeedsApproval(name, "review") {
			t.Errorf("%s is destructive but review mode does not ask", name)
		}
	}
	// Removing a process rule is a deletion, even though adding one is not.
	if !toolNeedsApproval("remove_workflow_rule", "review") {
		t.Errorf("removing a process rule must ask in review mode")
	}
	if !toolNeedsApproval("add_workflow_rule", "always") {
		t.Errorf("always must ask for a rule edit")
	}
	if toolNeedsApproval("get_page", "always") || toolNeedsApproval("query_rows", "review") {
		t.Errorf("read-only tools must never ask")
	}
	if toolNeedsApproval("remove_workflow_rule", "skip") {
		t.Errorf("skip must not ask")
	}
}
