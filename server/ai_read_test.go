package server

import (
	"net/http"
	"testing"
)

// Opening a chat marks it read by loading its messages: that is the one path
// every surface shares (the side panel's switcher, a copied link, a reload),
// and only the sidebar row used to clear the dot itself.
func TestFetchingMessagesMarksTheChatRead(t *testing.T) {
	s := testServer(t)
	uid, cookie := signedIn(t, s, "chat-read@example.test")
	tid := newID()
	if _, err := s.db.Exec(`INSERT INTO ai_threads (id, user_id, title, created_at, updated_at, last_read_at)
		VALUES (?, ?, 'Talk', ?, ?, '')`, tid, uid, now(), now()); err != nil {
		t.Fatalf("thread: %v", err)
	}
	if _, err := s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, created_at)
		VALUES (?, ?, 'assistant', 'An answer', ?)`, newID(), tid, now()); err != nil {
		t.Fatalf("message: %v", err)
	}
	rec := doReq(t, s, "GET", "/api/ai/threads/"+tid+"/messages", cookie, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("messages: %d %s", rec.Code, rec.Body)
	}
	var lastRead string
	if err := s.db.QueryRow(`SELECT last_read_at FROM ai_threads WHERE id = ?`, tid).Scan(&lastRead); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if lastRead == "" {
		t.Errorf("fetching the messages left last_read_at empty")
	}
}
