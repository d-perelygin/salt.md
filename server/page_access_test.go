package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Restricted pages with direct user grants (fork): the permission core, the
// enumeration filters, the share endpoints and the private migration.

// accessFixture builds one workspace: alice (admin), bob (member), carol
// (viewer) and dave (outside). Returns the workspace and an open page in it.
func accessFixture(t *testing.T, s *Server) (ws, open string, ids, cookies map[string]string) {
	t.Helper()
	ids = map[string]string{}
	cookies = map[string]string{}
	for _, mail := range []string{"alice-pa@example.test", "bob-pa@example.test", "carol-pa@example.test", "dave-pa@example.test"} {
		uid, cookie := signedIn(t, s, mail)
		ids[mail] = uid
		cookies[mail] = cookie
	}
	alice := ids["alice-pa@example.test"]
	ws = makeNamedWorkspace(t, s, alice, "Zugang")
	add := func(mail, role string) {
		t.Helper()
		if _, err := s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`,
			ws, ids[mail], role); err != nil {
			t.Fatalf("add %s: %v", mail, err)
		}
	}
	add("bob-pa@example.test", "member")
	add("carol-pa@example.test", "viewer")
	open = s.makePage(t, ws, alice, "", "Open", "{}")
	return ws, open, ids, cookies
}

func grant(t *testing.T, s *Server, page, user, access string) {
	t.Helper()
	if _, err := s.db.Exec(`INSERT INTO page_grants (page_id, user_id, subject_type, access, created_at)
		VALUES (?, ?, 'user', ?, ?)`, page, user, access, now()); err != nil {
		t.Fatalf("grant: %v", err)
	}
}

func restrict(t *testing.T, s *Server, page string) {
	t.Helper()
	if _, err := s.db.Exec(`UPDATE pages SET visibility = 'restricted' WHERE id = ?`, page); err != nil {
		t.Fatalf("restrict: %v", err)
	}
}

func TestRestrictedPageAccessMatrix(t *testing.T) {
	s := testServer(t)
	ws, open, ids, _ := accessFixture(t, s)
	alice, bob, carol, dave := ids["alice-pa@example.test"], ids["bob-pa@example.test"], ids["carol-pa@example.test"], ids["dave-pa@example.test"]

	locked := s.makePage(t, ws, alice, "", "Locked", "{}")
	restrict(t, s, locked)

	// Baseline: the open page behaves exactly as before.
	for _, u := range []string{alice, bob, carol} {
		if !s.canRead(u, open) {
			t.Errorf("%s cannot read the open page", u)
		}
	}
	if s.canWrite(carol, open) {
		t.Error("a viewer writes the open page")
	}
	if !s.canWrite(bob, open) || !s.canWrite(alice, open) {
		t.Error("member/admin lost the open page")
	}

	// Nobody granted: only the owner and (below) the admin get in.
	if !s.canRead(alice, locked) || !s.canWrite(alice, locked) {
		t.Error("the owner lost their own restricted page")
	}
	if s.canRead(bob, locked) || s.canWrite(bob, locked) {
		t.Error("an ungranted member reads a restricted page")
	}
	if s.canRead(dave, locked) {
		t.Error("an outsider reads a restricted page")
	}

	// View grant: read yes, write no.
	grant(t, s, locked, bob, grantView)
	if !s.canRead(bob, locked) {
		t.Error("a view grant does not read")
	}
	if s.canWrite(bob, locked) {
		t.Error("a view grant writes")
	}

	// Edit grant, but on a viewer: the workspace role caps it.
	grant(t, s, locked, carol, grantEdit)
	if !s.canRead(carol, locked) {
		t.Error("a granted viewer does not read")
	}
	if s.canWrite(carol, locked) {
		t.Error("a grant promoted a viewer to editor")
	}

	// Edit grant on a member: full access.
	if _, err := s.db.Exec(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?`, ws, carol); err != nil {
		t.Fatal(err)
	}
	if !s.canWrite(carol, locked) {
		t.Error("an edit grant does not write for a member")
	}
}

func TestRestrictedInheritanceAndNarrowing(t *testing.T) {
	s := testServer(t)
	ws, _, ids, _ := accessFixture(t, s)
	alice, bob := ids["alice-pa@example.test"], ids["bob-pa@example.test"]

	root := s.makePage(t, ws, alice, "", "Root", "{}")
	restrict(t, s, root)
	child := s.makePage(t, ws, alice, root, "Child", "{}")
	nested := s.makePage(t, ws, alice, child, "Nested", "{}")
	restrict(t, s, nested)

	// A grant on the root covers the subtree…
	grant(t, s, root, bob, grantEdit)
	if !s.canRead(bob, child) || !s.canWrite(bob, child) {
		t.Error("a root grant does not cover the child")
	}
	// …until a nested restricted page narrows it again.
	if s.canRead(bob, nested) || s.canWrite(bob, nested) {
		t.Error("a root grant leaks through a nested restricted page")
	}
	grant(t, s, nested, bob, grantView)
	if !s.canRead(bob, nested) {
		t.Error("a nested view grant does not read")
	}
	if s.canWrite(bob, nested) {
		t.Error("a nested view grant writes")
	}
}

func TestRestrictedHiddenFromListings(t *testing.T) {
	s := testServer(t)
	ws, _, ids, _ := accessFixture(t, s)
	alice, bob := ids["alice-pa@example.test"], ids["bob-pa@example.test"]

	locked := s.makePage(t, ws, alice, "", "Locked", "{}")
	restrict(t, s, locked)

	visible := func(u string) map[string]bool {
		rows, err := s.db.Query(`SELECT id, parent_id, workspace_id, owner_id, visibility FROM pages WHERE workspace_id = ?`, ws)
		if err != nil {
			t.Fatalf("metas: %v", err)
		}
		var all []pageMeta
		for rows.Next() {
			var m pageMeta
			if rows.Scan(&m.ID, &m.ParentID, &m.WorkspaceID, &m.OwnerID, &m.Visibility) == nil {
				all = append(all, m)
			}
		}
		rows.Close()
		out := map[string]bool{}
		for _, m := range s.filterReadable(u, all) {
			out[m.ID] = true
		}
		return out
	}
	if !visible(alice)[locked] {
		t.Error("the owner lost the page in the list")
	}
	if visible(bob)[locked] {
		t.Error("a restricted page leaks into a stranger's list")
	}
	grant(t, s, locked, bob, grantView)
	if !visible(bob)[locked] {
		t.Error("a granted page stays out of the list")
	}
}

func TestRestrictedRowsHiddenFromCollections(t *testing.T) {
	s := testServer(t)
	ws, _, ids, _ := accessFixture(t, s)
	alice, bob := ids["alice-pa@example.test"], ids["bob-pa@example.test"]

	col := s.makeCollection(t, ws, alice, "Base", `[]`)
	row := s.makePage(t, ws, alice, col, "Row", `{"status":"todo"}`)
	_ = row

	list, total, err := s.collectionRowsQuery(&user{ID: bob, Name: "Bob"}, col, nil, nil, "", 100, 0, time.Time{})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Fatalf("baseline rows = %d/%d, want 1/1", total, len(list))
	}

	// Restricting the collection hides its rows from the ungranted member…
	restrict(t, s, col)
	list, total, err = s.collectionRowsQuery(&user{ID: bob, Name: "Bob"}, col, nil, nil, "", 100, 0, time.Time{})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	if total != 0 || len(list) != 0 {
		t.Errorf("restricted rows leak: total=%d len=%d", total, len(list))
	}
	// …while the owner still counts them.
	list, total, err = s.collectionRowsQuery(&user{ID: alice, Name: "Alice"}, col, nil, nil, "", 100, 0, time.Time{})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Errorf("the owner lost restricted rows: total=%d len=%d", total, len(list))
	}
}

func TestBreakGlassDoesNotOpenRestricted(t *testing.T) {
	s := testServer(t)
	ws, open, ids, _ := accessFixture(t, s)
	alice, dave := ids["alice-pa@example.test"], ids["dave-pa@example.test"]

	locked := s.makePage(t, ws, alice, "", "Locked", "{}")
	restrict(t, s, locked)

	expires := time.Now().UTC().Add(breakGlassTTL).Format(tsFixed)
	if _, err := s.db.Exec(`INSERT INTO break_glass (id, workspace_id, user_id, reason, created_at, expires_at)
		VALUES (?, ?, ?, 'audit review of shared material', ?, ?)`,
		newID(), ws, dave, now(), expires); err != nil {
		t.Fatalf("break glass: %v", err)
	}
	if !s.canRead(dave, open) {
		t.Error("emergency access lost the open page")
	}
	if s.canRead(dave, locked) {
		t.Error("emergency access opens a restricted page — it never opened private ones either")
	}
	if s.canWrite(dave, open) {
		t.Error("emergency access writes")
	}
}

func TestPrivateStillMeansPrivate(t *testing.T) {
	s := testServer(t)
	ws, _, ids, _ := accessFixture(t, s)
	alice, bob := ids["alice-pa@example.test"], ids["bob-pa@example.test"]

	// A fresh database holds no 'private' row: the migration converts them.
	var left int
	s.db.QueryRow(`SELECT COUNT(*) FROM pages WHERE visibility = 'private'`).Scan(&left)
	if left != 0 {
		t.Errorf("%d private pages survived the migration", left)
	}

	// And the value itself keeps its old meaning where it still occurs.
	secret := s.makePage(t, ws, alice, "", "Secret", "{}")
	if _, err := s.db.Exec(`UPDATE pages SET visibility = 'private' WHERE id = ?`, secret); err != nil {
		t.Fatal(err)
	}
	if !s.canRead(alice, secret) || s.canRead(bob, secret) {
		t.Error("private no longer means owner-only")
	}
}

// shareAPI exercises the share endpoints through the real router.
func TestPageShareEndpoints(t *testing.T) {
	s := testServer(t)
	ws, open, ids, cookies := accessFixture(t, s)
	aliceMail, bobMail := "alice-pa@example.test", "bob-pa@example.test"
	alice, bob := ids[aliceMail], ids[bobMail]
	aliceCookie, bobCookie := cookies[aliceMail], cookies[bobMail]

	call := func(method, url, cookie, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		s.ServeHTTP(rec, req)
		return rec
	}

	locked := s.makePage(t, ws, alice, "", "Locked", "{}")
	restrict(t, s, locked)

	// Granting on an open page is refused: nothing to grant while all read it.
	if rec := call("POST", "/api/pages/"+open+"/shares", aliceCookie,
		`{"userId":"`+bob+`","access":"view"}`); rec.Code != 400 {
		t.Errorf("grant on open page = %d, want 400", rec.Code)
	}

	// A non-manager learns nothing — not even that the page exists.
	if rec := call("GET", "/api/pages/"+locked+"/shares", bobCookie, ""); rec.Code != 404 {
		t.Errorf("share list to stranger = %d, want 404", rec.Code)
	}
	if rec := call("POST", "/api/pages/"+locked+"/shares", bobCookie,
		`{"userId":"`+bob+`","access":"view"}`); rec.Code != 404 {
		t.Errorf("grant by stranger = %d, want 404", rec.Code)
	}

	// The owner grants, lists, and the grant takes effect…
	if rec := call("POST", "/api/pages/"+locked+"/shares", aliceCookie,
		`{"userId":"`+bob+`","access":"edit"}`); rec.Code != 200 {
		t.Fatalf("grant = %d: %s", rec.Code, rec.Body.String())
	}
	rec := call("GET", "/api/pages/"+locked+"/shares", aliceCookie, "")
	if rec.Code != 200 {
		t.Fatalf("list = %d", rec.Code)
	}
	var listed []pageGrantJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed) != 1 || listed[0].UserID != bob {
		t.Fatalf("list = %s, err = %v", rec.Body.String(), err)
	}
	if !s.canWrite(bob, locked) {
		t.Error("an endpoint grant does not write")
	}
	// …bad access values are refused…
	if rec := call("POST", "/api/pages/"+locked+"/shares", aliceCookie,
		`{"userId":"`+bob+`","access":"owner"}`); rec.Code != 400 {
		t.Errorf("bad access = %d, want 400", rec.Code)
	}
	// …and revoking closes the door again.
	if rec := call("DELETE", "/api/pages/"+locked+"/shares/"+bob, aliceCookie, ""); rec.Code != 200 {
		t.Fatalf("revoke = %d", rec.Code)
	}
	if s.canRead(bob, locked) {
		t.Error("a revoked grant still reads")
	}

	// Unrestricting the page prunes its grants instead of leaving them armed.
	grant(t, s, locked, bob, grantView)
	if rec := call("PATCH", "/api/pages/"+locked, aliceCookie, `{"visibility":"workspace"}`); rec.Code != 200 {
		t.Fatalf("unrestrict = %d: %s", rec.Code, rec.Body.String())
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM page_grants WHERE page_id = ?`, locked).Scan(&n)
	if n != 0 {
		t.Errorf("%d grants survived unrestricting", n)
	}
}

func TestCreatePageInheritsVisibility(t *testing.T) {
	s := testServer(t)
	ws, open, ids, cookies := accessFixture(t, s)
	aliceCookie := cookies["alice-pa@example.test"]
	bob := ids["bob-pa@example.test"]
	bobCookie := cookies["bob-pa@example.test"]
	carol := ids["carol-pa@example.test"]
	carolCookie := cookies["carol-pa@example.test"]

	// Non-admin member Eve to verify non-admin parent owners can read/write collaborator children.
	eve, eveCookie := signedIn(t, s, "eve-pa@example.test")
	if _, err := s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')`, ws, eve); err != nil {
		t.Fatalf("add eve: %v", err)
	}

	// Create child under open page -> visibility: 'workspace', no inheritedAccess
	rec := requestAs(t, s, aliceCookie, "POST", "/api/pages", `{"parentId":"`+open+`","title":"Open Child"}`)
	if rec.Code != 200 {
		t.Fatalf("create open child: %d %s", rec.Code, rec.Body.String())
	}
	var openChild struct {
		ID         string `json:"id"`
		Visibility string `json:"visibility"`
	}
	json.Unmarshal(rec.Body.Bytes(), &openChild)
	if openChild.Visibility != "workspace" {
		t.Errorf("open child visibility = %s, want workspace", openChild.Visibility)
	}
	rec = requestAs(t, s, aliceCookie, "GET", "/api/pages/"+openChild.ID, "")
	if rec.Code != 200 {
		t.Fatalf("get open child: %d", rec.Code)
	}
	var gotOpen struct {
		InheritedAccess *inheritedAccessInfo `json:"inheritedAccess"`
	}
	json.Unmarshal(rec.Body.Bytes(), &gotOpen)
	if gotOpen.InheritedAccess != nil {
		t.Errorf("open child inheritedAccess = %+v, want nil", gotOpen.InheritedAccess)
	}

	// Create private page
	priv := s.makePage(t, ws, ids["alice-pa@example.test"], "", "Secret", "{}")
	s.db.Exec(`UPDATE pages SET visibility = 'private' WHERE id = ?`, priv)

	// Child & grandchild under private page stay 'workspace' in DB and inherit dynamically.
	rec = requestAs(t, s, aliceCookie, "POST", "/api/pages", `{"parentId":"`+priv+`","title":"Private Child"}`)
	if rec.Code != 200 {
		t.Fatalf("create private child: %d %s", rec.Code, rec.Body.String())
	}
	var privChild struct {
		ID         string `json:"id"`
		Visibility string `json:"visibility"`
	}
	json.Unmarshal(rec.Body.Bytes(), &privChild)
	if privChild.Visibility != "workspace" {
		t.Errorf("private child visibility = %s, want workspace", privChild.Visibility)
	}
	if s.canRead(bob, privChild.ID) || s.canWrite(bob, privChild.ID) {
		t.Errorf("ungranted member gained access to child under private parent")
	}

	rec = requestAs(t, s, aliceCookie, "POST", "/api/pages", `{"parentId":"`+privChild.ID+`","title":"Private Grandchild"}`)
	if rec.Code != 200 {
		t.Fatalf("create private grandchild: %d %s", rec.Code, rec.Body.String())
	}
	var privGrandchild struct {
		ID         string `json:"id"`
		Visibility string `json:"visibility"`
	}
	json.Unmarshal(rec.Body.Bytes(), &privGrandchild)
	if privGrandchild.Visibility != "workspace" {
		t.Errorf("private grandchild visibility = %s, want workspace", privGrandchild.Visibility)
	}
	if s.canRead(bob, privGrandchild.ID) {
		t.Errorf("ungranted member gained access to grandchild under private parent")
	}
	rec = requestAs(t, s, aliceCookie, "GET", "/api/pages/"+privGrandchild.ID, "")
	if rec.Code != 200 {
		t.Fatalf("get private grandchild: %d", rec.Code)
	}
	var gotPriv struct {
		InheritedAccess *inheritedAccessInfo `json:"inheritedAccess"`
	}
	json.Unmarshal(rec.Body.Bytes(), &gotPriv)
	if gotPriv.InheritedAccess == nil || gotPriv.InheritedAccess.Visibility != "private" || gotPriv.InheritedAccess.FromID != priv || gotPriv.InheritedAccess.FromTitle != "Secret" {
		t.Errorf("private grandchild inheritedAccess = %+v, want private from %s", gotPriv.InheritedAccess, priv)
	}

	// Non-admin owner Eve creates a restricted parent and grants Bob edit access.
	restr := s.makePage(t, ws, eve, "", "Restricted", "{}")
	restrict(t, s, restr)
	grant(t, s, restr, bob, grantEdit)

	// Child created by Eve under restricted parent stays 'workspace' in DB…
	rec = requestAs(t, s, eveCookie, "POST", "/api/pages", `{"parentId":"`+restr+`","title":"Restricted Child"}`)
	if rec.Code != 200 {
		t.Fatalf("create restricted child: %d %s", rec.Code, rec.Body.String())
	}
	var restrChild struct {
		ID         string `json:"id"`
		Visibility string `json:"visibility"`
	}
	json.Unmarshal(rec.Body.Bytes(), &restrChild)
	if restrChild.Visibility != "workspace" {
		t.Errorf("restricted child visibility = %s, want workspace", restrChild.Visibility)
	}

	// …ungranted Carol cannot read or write it…
	if s.canRead(carol, restrChild.ID) || s.canWrite(carol, restrChild.ID) {
		t.Errorf("ungranted member reads/writes child under restricted parent")
	}
	if rec := requestAs(t, s, carolCookie, "GET", "/api/pages/"+restrChild.ID, ""); rec.Code != 404 {
		t.Errorf("ungranted Carol GET restricted child = %d, want 404", rec.Code)
	}

	// …while collaborator Bob (edit grant on parent) CAN read and write Eve's child…
	if !s.canRead(bob, restrChild.ID) || !s.canWrite(bob, restrChild.ID) {
		t.Errorf("collaborator Bob cannot read/write Eve's child under restricted parent")
	}
	rec = requestAs(t, s, bobCookie, "GET", "/api/pages/"+restrChild.ID, "")
	if rec.Code != 200 {
		t.Fatalf("Bob GET restricted child = %d: %s", rec.Code, rec.Body.String())
	}
	var gotRestr struct {
		InheritedAccess *inheritedAccessInfo `json:"inheritedAccess"`
	}
	json.Unmarshal(rec.Body.Bytes(), &gotRestr)
	if gotRestr.InheritedAccess == nil || gotRestr.InheritedAccess.Visibility != "restricted" || gotRestr.InheritedAccess.FromID != restr || gotRestr.InheritedAccess.FromTitle != "Restricted" {
		t.Errorf("restricted child inheritedAccess = %+v, want restricted from %s", gotRestr.InheritedAccess, restr)
	}
	if rec := requestAs(t, s, bobCookie, "PATCH", "/api/pages/"+restrChild.ID, `{"title":"Edited by Bob"}`); rec.Code != 200 {
		t.Errorf("Bob PATCH restricted child = %d: %s", rec.Code, rec.Body.String())
	}

	// …and non-admin parent owner Eve CAN read and write Bob's child created inside restr.
	rec = requestAs(t, s, bobCookie, "POST", "/api/pages", `{"parentId":"`+restr+`","title":"Bob Child"}`)
	if rec.Code != 200 {
		t.Fatalf("Bob create child under restricted parent: %d %s", rec.Code, rec.Body.String())
	}
	var bobChild struct {
		ID         string `json:"id"`
		Visibility string `json:"visibility"`
	}
	json.Unmarshal(rec.Body.Bytes(), &bobChild)
	if bobChild.Visibility != "workspace" {
		t.Errorf("bob child visibility = %s, want workspace", bobChild.Visibility)
	}
	if !s.canRead(eve, bobChild.ID) || !s.canWrite(eve, bobChild.ID) {
		t.Errorf("non-admin parent owner Eve cannot read/write Bob's child")
	}
	if rec := requestAs(t, s, eveCookie, "GET", "/api/pages/"+bobChild.ID, ""); rec.Code != 200 {
		t.Errorf("Eve GET Bob's child = %d: %s", rec.Code, rec.Body.String())
	}
	if rec := requestAs(t, s, eveCookie, "PATCH", "/api/pages/"+bobChild.ID, `{"title":"Edited by Eve"}`); rec.Code != 200 {
		t.Errorf("Eve PATCH Bob's child = %d: %s", rec.Code, rec.Body.String())
	}

	// Private ancestor overrides an intermediate restricted ancestor in inheritedAccess.
	nestedRestr := s.makePage(t, ws, ids["alice-pa@example.test"], priv, "Nested Restricted", "{}")
	restrict(t, s, nestedRestr)
	rec = requestAs(t, s, aliceCookie, "POST", "/api/pages", `{"parentId":"`+nestedRestr+`","title":"Under Both"}`)
	if rec.Code != 200 {
		t.Fatalf("create under both: %d %s", rec.Code, rec.Body.String())
	}
	var underBoth struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &underBoth)
	rec = requestAs(t, s, aliceCookie, "GET", "/api/pages/"+underBoth.ID, "")
	if rec.Code != 200 {
		t.Fatalf("get under both: %d", rec.Code)
	}
	var gotBoth struct {
		InheritedAccess *inheritedAccessInfo `json:"inheritedAccess"`
	}
	json.Unmarshal(rec.Body.Bytes(), &gotBoth)
	if gotBoth.InheritedAccess == nil || gotBoth.InheritedAccess.Visibility != "private" || gotBoth.InheritedAccess.FromID != priv {
		t.Errorf("underBoth inheritedAccess = %+v, want private from %s", gotBoth.InheritedAccess, priv)
	}
}

func TestRestrictedRowsHiddenFromExportPublicAndICS(t *testing.T) {
	s := testServer(t)
	ws, _, ids, cookies := accessFixture(t, s)
	alice := ids["alice-pa@example.test"]
	bob := ids["bob-pa@example.test"]
	aliceCookie := cookies["alice-pa@example.test"]
	bobCookie := cookies["bob-pa@example.test"]

	col := s.makeCollection(t, ws, alice, "Salaries", `[{"id":"due","name":"Due","type":"date"}]`)
	s.db.Exec(`UPDATE collections SET views = ? WHERE page_id = ?`, `[{"id":"v1","name":"Table","type":"table"}]`, col)

	s.makeRow(t, ws, alice, col, "Open Row", `{"due":"2026-10-20"}`)
	restrSecret := s.makeRow(t, ws, alice, col, "Restricted Secret Row", `{"due":"2026-10-21"}`)
	restrict(t, s, restrSecret)
	restrGranted := s.makeRow(t, ws, alice, col, "Restricted Granted Row", `{"due":"2026-10-22"}`)
	restrict(t, s, restrGranted)
	grant(t, s, restrGranted, bob, grantView)

	p, err := s.getPage(col)
	if err != nil {
		t.Fatalf("getPage: %v", err)
	}

	// Member Bob sees Open + Granted, never Secret.
	txtBob, err := s.collectionPlainText(p, bob)
	if err != nil {
		t.Fatalf("collectionPlainText(bob): %v", err)
	}
	if !strings.Contains(txtBob, "Open Row") || !strings.Contains(txtBob, "Restricted Granted Row") || strings.Contains(txtBob, "Restricted Secret Row") {
		t.Errorf("collectionPlainText(bob) mismatch:\n%s", txtBob)
	}
	mdBob, err := s.collectionMarkdown(p, bob)
	if err != nil {
		t.Fatalf("collectionMarkdown(bob): %v", err)
	}
	if !strings.Contains(mdBob, "Open Row") || !strings.Contains(mdBob, "Restricted Granted Row") || strings.Contains(mdBob, "Restricted Secret Row") {
		t.Errorf("collectionMarkdown(bob) mismatch:\n%s", mdBob)
	}

	// Anonymous reader sees only Open (neither restricted row).
	txtAnon, err := s.collectionPlainText(p, "")
	if err != nil {
		t.Fatalf("collectionPlainText(anon): %v", err)
	}
	if !strings.Contains(txtAnon, "Open Row") || strings.Contains(txtAnon, "Restricted Secret Row") || strings.Contains(txtAnon, "Restricted Granted Row") {
		t.Errorf("collectionPlainText(anon) leaked restricted row:\n%s", txtAnon)
	}

	// Public collection rows and row detail exclude restricted rows.
	rec := requestAs(t, s, aliceCookie, "POST", "/api/pages/"+col+"/share", `{"allowedViews":["v1"],"allowDetail":true}`)
	if rec.Code != 200 {
		t.Fatalf("share: %d %s", rec.Code, rec.Body.String())
	}
	var share struct {
		Token string `json:"token"`
	}
	json.Unmarshal(rec.Body.Bytes(), &share)

	recRows := requestAs(t, s, "", "GET", "/api/public/c/"+share.Token+"/rows", "")
	if recRows.Code != 200 {
		t.Fatalf("public rows: %d", recRows.Code)
	}
	if !strings.Contains(recRows.Body.String(), "Open Row") || strings.Contains(recRows.Body.String(), "Restricted Secret Row") || strings.Contains(recRows.Body.String(), "Restricted Granted Row") {
		t.Errorf("public collection rows leaked restricted row:\n%s", recRows.Body.String())
	}
	if recDet := requestAs(t, s, "", "GET", "/api/public/c/"+share.Token+"/row/"+restrSecret, ""); recDet.Code != 404 {
		t.Errorf("public collection row detail = %d, want 404", recDet.Code)
	}

	// Named ICS feed for Bob excludes ungranted restricted row, includes granted one.
	recFeed := requestAs(t, s, bobCookie, "POST", "/api/ics/feeds", `{"kind":"collection","refId":"`+col+`","name":"Cal"}`)
	if recFeed.Code != 200 {
		t.Fatalf("create feed: %d %s", recFeed.Code, recFeed.Body.String())
	}
	var feed struct {
		URL string `json:"url"`
	}
	json.Unmarshal(recFeed.Body.Bytes(), &feed)
	path := feed.URL
	if i := strings.Index(path, "/ics/"); i >= 0 {
		path = path[i:]
	}
	recICS := requestAs(t, s, "", "GET", path, "")
	if recICS.Code != 200 {
		t.Fatalf("ics feed: %d %s", recICS.Code, recICS.Body.String())
	}
	if !strings.Contains(recICS.Body.String(), "Open Row") || !strings.Contains(recICS.Body.String(), "Restricted Granted Row") || strings.Contains(recICS.Body.String(), "Restricted Secret Row") {
		t.Errorf("ics feed mismatch:\n%s", recICS.Body.String())
	}
}

func TestUpdatePageRejectsUnsafeBlockURLs(t *testing.T) {
	s := testServer(t)
	ws, _, ids, cookies := accessFixture(t, s)
	alice := ids["alice-pa@example.test"]
	aliceCookie := cookies["alice-pa@example.test"]
	pid := s.makePage(t, ws, alice, "", "Links", "[]")

	badPayloads := []string{
		`{"content":[{"type":"bookmark","props":{"url":"javascript:alert(1)"}}]}`,
		`{"content":[{"type":"bookmark","props":{"url":"  JaVaScRiPt:void(0)"}}]}`,
		`{"content":[{"type":"bookmark","props":{"url":"java\tscript:alert(1)"}}]}`,
		`{"content":[{"type":"paragraph","children":[{"type":"file","props":{"url":"vbscript:msgbox(1)"}}]}]}`,
		`{"content":[{"type":"paragraph","content":[{"type":"link","href":"data:text/html,<script>alert(1)</script>","content":[{"type":"text","text":"x"}]}]}]}`,
		`{"content":[{"type":"table","content":{"type":"tableContent","rows":[{"cells":[[{"type":"link","href":"javascript:alert(1)","content":[{"type":"text","text":"x"}]}]]}]}}]}`,
	}
	for _, payload := range badPayloads {
		rec := requestAs(t, s, aliceCookie, "PATCH", "/api/pages/"+pid, payload)
		if rec.Code != 400 {
			t.Errorf("payload %s got HTTP %d, want 400 (%s)", payload, rec.Code, rec.Body.String())
		}
	}

	goodPayload := `{"content":[
		{"type":"bookmark","props":{"url":"https://example.com"}},
		{"type":"image","props":{"url":"data:image/png;base64,AAAA"}},
		{"type":"file","props":{"url":"/files/abc.pdf"}},
		{"type":"paragraph","content":[
			{"type":"link","href":"mailto:a@example.com","content":[{"type":"text","text":"mail"}]},
			{"type":"link","href":"tel:+123","content":[{"type":"text","text":"call"}]},
			{"type":"link","href":"#section","content":[{"type":"text","text":"jump"}]},
			{"type":"link","href":"","content":[{"type":"text","text":"empty"}]}
		]}
	]}`
	if rec := requestAs(t, s, aliceCookie, "PATCH", "/api/pages/"+pid, goodPayload); rec.Code != 200 {
		t.Errorf("valid URLs rejected with %d: %s", rec.Code, rec.Body.String())
	}
}
