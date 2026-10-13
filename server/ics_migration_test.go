package server

import (
	"database/sql"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	_ "modernc.org/sqlite"
)

// A pre-hash database migrates to hashes: the plaintext token column goes,
// the legacy per-user token rows are purged, and existing links keep serving
// under their old raw tokens (looked up by hash now).
func TestICSFeedHashMigration(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+dir+"/salt.db?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	// Only the pre-hash tables: everything else openDB creates itself. The
	// feed row dangles (no users row yet) until the account is added below.
	for _, stmt := range []string{
		`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)`,
		`CREATE TABLE ics_feeds (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL DEFAULT 'all', ref_id TEXT NOT NULL DEFAULT '',
			view_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
			past_days INTEGER NOT NULL DEFAULT 90, created_at TEXT NOT NULL
		)`,
		`INSERT INTO app_settings (key, value) VALUES ('ics_token_u1', 'deadbeef')`,
		`INSERT INTO ics_feeds (id, user_id, token, kind, name, created_at)
			VALUES ('f1', 'u1', 'rawtoken123', 'all', 'Old', '2026-01-01')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	dist := fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}
	s, err := New(dir, dist)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	var hash string
	if err := s.db.QueryRow(`SELECT token_hash FROM ics_feeds WHERE id = 'f1'`).Scan(&hash); err != nil {
		t.Fatalf("token_hash missing after migrate: %v", err)
	}
	if hash != tokenHash("rawtoken123") {
		t.Fatalf("hash mismatch")
	}
	rows, err := s.db.Query(`PRAGMA table_info(ics_feeds)`)
	if err != nil {
		t.Fatal(err)
	}
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var nn, pk int
		var d any
		if err := rows.Scan(&cid, &name, &ctype, &nn, &d, &pk); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		cols[name] = true
	}
	rows.Close()
	if cols["token"] {
		t.Errorf("plaintext token column survives the migration")
	}
	if !cols["token_hash"] {
		t.Errorf("token_hash column missing after the migration")
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM app_settings WHERE key LIKE 'ics_token_%'`).Scan(&n)
	if n != 0 {
		t.Fatalf("legacy token rows survive: %d", n)
	}
	// The migrated link keeps serving under its old raw token (looked up by
	// hash now): re-add the owner and fetch.
	if _, err := s.db.Exec(`INSERT INTO users (id, email, name, color, password_hash, is_admin, created_at)
		VALUES ('u1', 'old@example.test', 'Old', '#2f7d4f', ?, 0, ?)`, hashPassword("passwort12345"), now()); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/ics/rawtoken123.ics", nil))
	if rec.Code != 200 {
		t.Fatalf("migrated link: status %d, want 200", rec.Code)
	}
}
