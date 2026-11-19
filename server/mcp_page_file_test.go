package server

import (
	"strings"
	"testing"
)

// The page's own references are the allowlist: a listed stranger file must
// not open, and neither must a page the caller cannot read.
func TestReadPageFileGate(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "pagefile@example.test")
	u := &user{ID: uid, Name: "Test"}
	ws := s.firstWorkspaceOf(t, uid)
	seedFile(t, s, "gated.txt", "hello gated")
	seedFile(t, s, "stranger.txt", "must not leak")
	seedPage(t, s, "gate-doc", "", ws, uid, "private", `[{"type":"file","props":{"url":"/files/gated.txt","name":"Gated"}}]`)
	other, _ := signedIn(t, s, "pagefile-other@example.test")
	ou := &user{ID: other, Name: "Other"}

	if out, err := callTool(t, s, u, "read_page_file", `{"page_id":"gate-doc"}`); err != nil || !strings.Contains(out, "gated.txt") {
		t.Fatalf("list: %v %s", err, out)
	}
	if out, err := callTool(t, s, u, "read_page_file", `{"page_id":"gate-doc","file_name":"gated.txt"}`); err != nil || !strings.Contains(out, "hello gated") {
		t.Fatalf("read: %v %s", err, out)
	}
	if _, err := callTool(t, s, u, "read_page_file", `{"page_id":"gate-doc","file_name":"stranger.txt"}`); err == nil {
		t.Fatal("unreferenced file opened")
	}
	if _, err := callTool(t, s, ou, "read_page_file", `{"page_id":"gate-doc"}`); err == nil {
		t.Fatal("foreign page opened")
	}
}
