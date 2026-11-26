package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A live link is shared knowledge, not the minting browser's private note:
// anyone who may edit the page can read it back and pass it on. Readers still
// get the same 403 the endpoint always gave them — the token is a way in.
func TestShareLinkVisibleToEditors(t *testing.T) {
	s := testServer(t)
	_, page, _, cookies := accessFixture(t, s)
	alice := cookies["alice-pa@example.test"] // admin
	bob := cookies["bob-pa@example.test"]     // member: may edit
	carol := cookies["carol-pa@example.test"] // viewer
	dave := cookies["dave-pa@example.test"]   // outside the workspace
	token := shareForTest(t, s, alice, page)

	type shareStatus struct {
		Shared bool   `json:"shared"`
		URL    string `json:"url"`
	}
	get := func(cookie string) (*httptest.ResponseRecorder, shareStatus) {
		t.Helper()
		rec := requestAs(t, s, cookie, "GET", "/api/pages/"+page+"/share", "")
		var st shareStatus
		_ = json.Unmarshal(rec.Body.Bytes(), &st)
		return rec, st
	}

	rec, st := get(bob)
	if rec.Code != http.StatusOK || !st.Shared {
		t.Fatalf("member share status: %d %s", rec.Code, rec.Body.String())
	}
	if want := "/public/" + token; !strings.HasSuffix(st.URL, want) {
		t.Fatalf("member sees %q, want a link ending in %q", st.URL, want)
	}

	for name, cookie := range map[string]string{"viewer": carol, "outsider": dave} {
		if rec, _ := get(cookie); rec.Code != http.StatusForbidden {
			t.Errorf("%s share status: %d, want 403", name, rec.Code)
		}
	}
}
