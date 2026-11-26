package server

import (
	"testing"
	"time"
)

// The retention sweep deletes pages for good; the search index is virtual and
// has no foreign keys, so it has to be cleared by hand or every swept page
// leaves its passages behind for ever.
func TestPurgeTrashedClearsSearchIndex(t *testing.T) {
	s := testServer(t)
	uid, _ := signedIn(t, s, "purge-fts@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Old draft", "[]")

	if _, err := s.db.Exec(`INSERT INTO pages_fts (id, title, body) VALUES (?, ?, ?)`, page, "Old draft", "body"); err != nil {
		t.Fatalf("pages_fts: %v", err)
	}
	chunk := newID()
	if _, err := s.db.Exec(`INSERT INTO page_chunks (id, page_id, workspace_id, ord, heading, text) VALUES (?, ?, ?, ?, ?, ?)`,
		chunk, page, ws, 1, "", "body"); err != nil {
		t.Fatalf("page_chunks: %v", err)
	}
	if _, err := s.db.Exec(`INSERT INTO chunks_fts (chunk_id, title, heading, text) VALUES (?, ?, ?, ?)`,
		chunk, "Old draft", "", "body"); err != nil {
		t.Fatalf("chunks_fts: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE pages SET trashed_at = ? WHERE id = ?`,
		time.Now().Add(-48*time.Hour).Format(time.RFC3339Nano), page); err != nil {
		t.Fatalf("trash: %v", err)
	}

	s.purgeTrashed([]string{page})

	for _, q := range []struct {
		name string
		sql  string
		arg  any
	}{
		{"pages_fts", `SELECT COUNT(*) FROM pages_fts WHERE id = ?`, page},
		{"chunks_fts", `SELECT COUNT(*) FROM chunks_fts WHERE chunk_id = ?`, chunk},
		{"page_chunks", `SELECT COUNT(*) FROM page_chunks WHERE page_id = ?`, page},
		{"pages", `SELECT COUNT(*) FROM pages WHERE id = ?`, page},
	} {
		var n int
		if err := s.db.QueryRow(q.sql, q.arg).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q.name, err)
		}
		if n != 0 {
			t.Errorf("%s still holds %d row(s) after the sweep", q.name, n)
		}
	}
}
