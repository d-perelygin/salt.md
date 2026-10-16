package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Fork-only Russian stemming (see stemRu): word forms must meet through the
// stem variant ftsMatch adds, the same way German inflection already does.
func TestFtsMatchRussianStem(t *testing.T) {
	if got := stemRu("договоры"); got != "договор" {
		t.Errorf(`stemRu("договоры") = %q, want "договор"`, got)
	}
	if got := stemRu("задачи"); got != "задач" {
		t.Errorf(`stemRu("задачи") = %q, want "задач"`, got)
	}
	if got := stemRu("договор"); got != "договор" {
		t.Errorf(`stemRu("договор") = %q, want it unchanged`, got)
	}
	// Latin words pass through untouched.
	if got := stemRu("contracts"); got != "contracts" {
		t.Errorf(`stemRu("contracts") = %q, want it unchanged`, got)
	}
	// Short words are left alone: cutting "иде" off "идея" would only add noise.
	if got := stemRu("идея"); got != "идея" {
		t.Errorf(`stemRu("идея") = %q, want it unchanged`, got)
	}
	if got := foldQuery("ЁЛКА"); got != "елка" {
		t.Errorf(`foldQuery("ЁЛКА") = %q, want "елка"`, got)
	}
	m := ftsMatch("договоры")
	if !strings.Contains(m, `"договор"*`) {
		t.Errorf(`ftsMatch("договоры") = %q, want it to carry the "договор"* stem variant`, m)
	}
}

// The workspace filter on /api/search: empty means everywhere the caller may
// see, a named workspace narrows to it, and a foreign id narrows to nothing
// rather than leaking across the boundary.
func TestHandleSearchWorkspaceFilter(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "ru-search@example.com")
	var ws1 string
	if err := s.db.QueryRow(`SELECT id FROM workspaces LIMIT 1`).Scan(&ws1); err != nil {
		t.Fatal(err)
	}
	ws2 := newID()
	if _, err := s.db.Exec(`INSERT INTO workspaces (id, name, created_at, owner_id) VALUES (?, 'Second', ?, ?)`,
		ws2, now(), uid); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')`,
		ws2, uid); err != nil {
		t.Fatal(err)
	}

	mkPage := func(ws, title, text string) {
		id := newID()
		content, _ := json.Marshal([]any{map[string]any{
			"type": "paragraph",
			"content": []any{map[string]any{
				"type": "text", "text": text,
			}},
		}})
		if _, err := s.db.Exec(`INSERT INTO pages (id, parent_id, workspace_id, title, type, content, position, created_at, updated_at)
			VALUES (?, NULL, ?, ?, 'doc', ?, 1, ?, ?)`, id, ws, title, string(content), now(), now()); err != nil {
			t.Fatal(err)
		}
		if err := s.reindexPage(id); err != nil {
			t.Fatal(err)
		}
	}
		mkPage(ws1, "Договор поставки", "условия договора")
	mkPage(ws2, "Список покупок", "купить молоко и хлеб")

	search := func(q string) []searchResult {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/search?"+q, nil)
		req.Header.Set("Cookie", cookie)
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /api/search?%s: got %d", q, rec.Code)
		}
		var out []searchResult
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}

	// The inflected form meets the indexed one through the stem variant.
	res := search("q=" + "договоры")
	if len(res) == 0 {
		t.Fatalf(`unfiltered search for "договоры" found nothing — the Russian stem variant does not bite`)
	}
	if res[0].Title != "Договор поставки" {
		t.Errorf("unfiltered search: got %q, want the contract page", res[0].Title)
	}

	// Narrowed to the page's own workspace: still there.
	res = search("q=" + "договоры" + "&ws=" + ws1)
	if len(res) == 0 || res[0].Title != "Договор поставки" {
		t.Errorf("ws=%s search: got %+v, want the contract page", ws1, res)
	}

	// Narrowed to the other workspace: gone.
	if res := search("q=" + "договоры" + "&ws=" + ws2); len(res) != 0 {
		t.Errorf("ws=%s search: got %+v, want nothing", ws2, res)
	}

	// A foreign workspace id narrows to nothing instead of leaking.
	if res := search("q=" + "договоры" + "&ws=does-not-exist"); len(res) != 0 {
		t.Errorf("foreign ws search: got %+v, want nothing", res)
	}
}
