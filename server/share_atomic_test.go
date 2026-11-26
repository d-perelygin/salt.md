package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// A re-share replaces the live link only when the new settings were actually
// understood. A broken body used to decode to zeroes and delete the working
// link before inserting a naked replacement; a failed insert then left the page
// with no link at all.
func TestSharePageKeepsTheOldLinkOnBadJSON(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "share-atomic@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Public page", "[]")

	rec := doReq(t, s, "POST", "/api/pages/"+page+"/share", cookie, `{"expiresInDays":7}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create share: %d %s", rec.Code, rec.Body)
	}
	var created struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.Token == "" {
		t.Fatalf("share answer: %v (%s)", err, rec.Body)
	}
	if rec := doReq(t, s, "GET", "/api/public/"+created.Token, "", ""); rec.Code != http.StatusOK {
		t.Fatalf("public link before: %d", rec.Code)
	}

	bad := doReq(t, s, "POST", "/api/pages/"+page+"/share", cookie, `{"expiresInDays":`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("bad body: %d %s, want 400", bad.Code, bad.Body)
	}
	if rec := doReq(t, s, "GET", "/api/public/"+created.Token, "", ""); rec.Code != http.StatusOK {
		t.Errorf("the old link stopped working after a rejected re-share: %d", rec.Code)
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM share_links WHERE page_id = ? AND mode != 'form'`, page).Scan(&n)
	if n != 1 {
		t.Errorf("share rows = %d, want the one live link", n)
	}
}
