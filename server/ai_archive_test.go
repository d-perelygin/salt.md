package server

import (
	"net/http"
	"testing"
)

// Archiving is where a chat is put, not a change to it: the unread dot is
// computed from updated_at against last_read_at, so moving a fully read chat
// out of the archive must not bring it back as unread.
func TestArchiveDoesNotMarkAReadChatUnread(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "archive-unread@example.test")
	ws := s.firstWorkspaceOf(t, uid)
	page := s.makePage(t, ws, uid, "", "Chat page", "[]")
	tid := newID()
	readAt := now()
	if _, err := s.db.Exec(`INSERT INTO ai_threads (id, user_id, workspace_id, page_id, title, created_at, updated_at, last_read_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, tid, uid, ws, page, "Talk", readAt, readAt, readAt); err != nil {
		t.Fatalf("thread: %v", err)
	}

	for _, archived := range []string{`{"archived":true}`, `{"archived":false}`} {
		rec := doReq(t, s, "POST", "/api/ai/threads/"+tid+"/archive", cookie, archived)
		if rec.Code != http.StatusOK {
			t.Fatalf("archive %s: %d %s", archived, rec.Code, rec.Body)
		}
	}
	var updated, read string
	if err := s.db.QueryRow(`SELECT updated_at, last_read_at FROM ai_threads WHERE id = ?`, tid).Scan(&updated, &read); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if updated > read {
		t.Errorf("unarchiving moved updated_at past last_read_at: %q > %q (the chat reads as unread)", updated, read)
	}
}
