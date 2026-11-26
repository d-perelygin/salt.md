package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// An account page is visible exactly to the people who work with that account:
// a shared workspace is the test. An id from outside must not become a way to
// read somebody's email, workspaces or writing.
func TestPersonProfileNeedsASharedWorkspace(t *testing.T) {
	s := testServer(t)
	_, page, ids, cookies := accessFixture(t, s)
	bob := ids["bob-pa@example.test"]
	alice := cookies["alice-pa@example.test"]
	carol := cookies["carol-pa@example.test"]
	dave := cookies["dave-pa@example.test"]

	// The account owns a page and a version, so its recent activity has
	// something real to filter.
	if rec := requestAs(t, s, carol, "PATCH", "/api/users/"+bob, `{"nickname":"Bobby","about":"Runs the board."}`); rec.Code != http.StatusForbidden {
		t.Fatalf("a viewer renamed somebody: %d %s", rec.Code, rec.Body)
	}
	if rec := requestAs(t, s, cookies["bob-pa@example.test"], "PATCH", "/api/users/"+bob, `{"nickname":"Bobby","about":"Runs the board."}`); rec.Code != http.StatusOK {
		t.Fatalf("own nickname: %d %s", rec.Code, rec.Body)
	}
	// A blank page is deliberately not a version, so give it a line first.
	if _, err := s.db.Exec(`UPDATE pages SET content = ? WHERE id = ?`,
		`[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]`, page); err != nil {
		t.Fatalf("content: %v", err)
	}
	s.snapshotRevisionForced(page, bob, "Bob")

	type profile struct {
		User struct {
			Name     string `json:"name"`
			Nickname string `json:"nickname"`
			About    string `json:"about"`
			Email    string `json:"email"`
		} `json:"user"`
		IsYou      bool `json:"isYou"`
		Workspaces []struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"workspaces"`
		Recent []struct {
			ID string `json:"id"`
		} `json:"recent"`
	}
	get := func(cookie string) (*http.Response, profile) {
		t.Helper()
		rec := requestAs(t, s, cookie, "GET", "/api/people/"+bob, "")
		var p profile
		_ = json.Unmarshal(rec.Body.Bytes(), &p)
		return rec.Result(), p
	}

	res, prof := get(alice)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("a workspace admin cannot open a member's page: %d", res.StatusCode)
	}
	if prof.User.Nickname != "Bobby" || prof.User.About != "Runs the board." {
		t.Errorf("profile reads %q / %q", prof.User.Nickname, prof.User.About)
	}
	if prof.User.Email == "" {
		t.Errorf("a colleague's email should be visible inside the workspace")
	}
	if prof.IsYou {
		t.Errorf("somebody else's page says it is you")
	}
	if len(prof.Workspaces) == 0 {
		t.Errorf("the shared workspace is missing from the page")
	}
	found := false
	for _, r := range prof.Recent {
		if r.ID == page {
			found = true
		}
	}
	if !found {
		t.Errorf("the version Bob wrote is missing from recent activity: %#v", prof.Recent)
	}

	res, prof = get(cookies["bob-pa@example.test"])
	if res.StatusCode != http.StatusOK || !prof.IsYou {
		t.Errorf("own page: %d, isYou=%v", res.StatusCode, prof.IsYou)
	}

	// Dave shares no workspace: the account does not exist as far as he is
	// concerned.
	if res, _ := get(dave); res.StatusCode != http.StatusNotFound {
		t.Errorf("an outsider opened the account page: %d", res.StatusCode)
	}
}
