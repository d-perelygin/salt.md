package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// sqlRows alias keeps the read helpers tidy.
type sqlRows = *sql.Rows

// mcpAIThreads lists the calling user's chat threads.
func (s *Server) mcpAIThreads(u *user) (string, error) {
	if !s.aiEnabledForUser(u) {
		return "", fmt.Errorf("AI is disabled")
	}
	rows, err := s.db.Query(`SELECT t.id, t.title, t.page_id,
		COALESCE(p.title, '') AS page_title,
		(SELECT COUNT(*) FROM ai_messages m WHERE m.thread_id = t.id) AS msg_count,
		EXISTS (SELECT 1 FROM ai_runs r WHERE r.thread_id = t.id) AS has_runs,
		t.updated_at
		FROM ai_threads t LEFT JOIN pages p ON p.id = t.page_id
		WHERE t.user_id = ? AND (t.archived IS NULL OR t.archived = 0) ORDER BY t.updated_at DESC`, u.ID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	type thread struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		PageID    string `json:"pageId,omitempty"`
		PageTitle string `json:"pageTitle,omitempty"`
		MsgCount  int    `json:"msgCount"`
		HasRuns   bool   `json:"hasRuns"`
		UpdatedAt string `json:"updatedAt"`
	}
	out := []thread{}
	for rows.Next() {
		var t thread
		var hasRuns int
		if err := rows.Scan(&t.ID, &t.Title, &t.PageID, &t.PageTitle, &t.MsgCount, &hasRuns, &t.UpdatedAt); err != nil {
			return "", err
		}
		t.HasRuns = hasRuns == 1
		out = append(out, t)
	}
	rows.Close()
	for i := range out {
		if out[i].PageID != "" && !s.canRead(u.ID, out[i].PageID) {
			out[i].PageTitle = ""
		}
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

// mcpAIThreadMessages returns the messages of one of the user's threads.
func (s *Server) mcpAIThreadMessages(u *user, threadID string, limit int) (string, error) {
	if !s.aiEnabledForUser(u) {
		return "", fmt.Errorf("AI is disabled")
	}
	if threadID == "" {
		return "", fmt.Errorf("thread_id required")
	}
	var owner string
	s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&owner)
	if owner == "" || owner != u.ID {
		return "", fmt.Errorf("thread %q not found", threadID)
	}
	q := `SELECT role, content, model, created_at FROM ai_messages WHERE thread_id = ? ORDER BY created_at ASC`
	var rows *sql.Rows
	var err error
	if limit > 0 {
		rows, err = s.db.Query(`SELECT role, content, model, created_at FROM ai_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`, threadID, limit)
	} else {
		rows, err = s.db.Query(q, threadID)
	}
	if err != nil {
		return "", err
	}
	defer rows.Close()
	type msg struct {
		Role      string `json:"role"`
		Content   string `json:"content"`
		Model     string `json:"model,omitempty"`
		CreatedAt string `json:"createdAt"`
	}
	out := []msg{}
	for rows.Next() {
		var m msg
		if err := rows.Scan(&m.Role, &m.Content, &m.Model, &m.CreatedAt); err != nil {
			return "", err
		}
		out = append(out, m)
	}
	if limit > 0 {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

// mcpAIThreadRuns lists the runs of one of the user's threads.
func (s *Server) mcpAIThreadRuns(u *user, threadID string) (string, error) {
	if !s.aiEnabledForUser(u) {
		return "", fmt.Errorf("AI is disabled")
	}
	if threadID == "" {
		return "", fmt.Errorf("thread_id required")
	}
	var owner string
	s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&owner)
	if owner == "" || owner != u.ID {
		return "", fmt.Errorf("thread %q not found", threadID)
	}
	rows, err := s.db.Query(`SELECT id, status, task, progress, error, started_at, finished_at, artifacts FROM ai_runs WHERE thread_id = ? ORDER BY started_at ASC`, threadID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	type run struct {
		ID         string   `json:"id"`
		Status     string   `json:"status"`
		Task       string   `json:"task"`
		Progress   string   `json:"progress,omitempty"`
		Error      string   `json:"error,omitempty"`
		StartedAt  string   `json:"startedAt"`
		FinishedAt string   `json:"finishedAt,omitempty"`
		Artifacts  []string `json:"artifacts,omitempty"`
	}
	out := []run{}
	for rows.Next() {
		var r run
		var raw string
		if err := rows.Scan(&r.ID, &r.Status, &r.Task, &r.Progress, &r.Error, &r.StartedAt, &r.FinishedAt, &raw); err != nil {
			return "", err
		}
		json.Unmarshal([]byte(raw), &r.Artifacts)
		out = append(out, r)
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

// mcpAIRun reads one run (owned by the user).
func (s *Server) mcpAIRun(u *user, runID string) (string, error) {
	if !s.aiEnabledForUser(u) {
		return "", fmt.Errorf("AI is disabled")
	}
	if runID == "" {
		return "", fmt.Errorf("run_id required")
	}
	var userID string
	s.db.QueryRow(`SELECT user_id FROM ai_runs WHERE id = ?`, runID).Scan(&userID)
	if userID == "" || userID != u.ID {
		return "", fmt.Errorf("run %q not found", runID)
	}
	type run struct {
		ID         string   `json:"id"`
		ThreadID   string   `json:"threadId"`
		Status     string   `json:"status"`
		Task       string   `json:"task"`
		Progress   string   `json:"progress,omitempty"`
		Error      string   `json:"error,omitempty"`
		StartedAt  string   `json:"startedAt"`
		FinishedAt string   `json:"finishedAt,omitempty"`
		Artifacts  []string `json:"artifacts,omitempty"`
	}
	var r run
	var threadID, raw string
	err := s.db.QueryRow(`SELECT id, thread_id, status, task, progress, error, started_at, finished_at, artifacts FROM ai_runs WHERE id = ?`, runID).Scan(
		&r.ID, &threadID, &r.Status, &r.Task, &r.Progress, &r.Error, &r.StartedAt, &r.FinishedAt, &raw)
	if err != nil {
		return "", err
	}
	r.ThreadID = threadID
	json.Unmarshal([]byte(raw), &r.Artifacts)
	b, _ := json.Marshal(r)
	return string(b), nil
}

// mcpAIRunSteps reads the trace of one run (owned by the user).
func (s *Server) mcpAIRunSteps(u *user, runID string) (string, error) {
	if !s.aiEnabledForUser(u) {
		return "", fmt.Errorf("AI is disabled")
	}
	if runID == "" {
		return "", fmt.Errorf("run_id required")
	}
	var userID string
	s.db.QueryRow(`SELECT user_id FROM ai_runs WHERE id = ?`, runID).Scan(&userID)
	if userID == "" || userID != u.ID {
		return "", fmt.Errorf("run %q not found", runID)
	}
	rows, err := s.db.Query(`SELECT id, seq, kind, title, body, status, created_at FROM ai_steps WHERE run_id = ? ORDER BY seq ASC`, runID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	type step struct {
		ID        string `json:"id"`
		Seq       int    `json:"seq"`
		Kind      string `json:"kind"`
		Title     string `json:"title"`
		Body      string `json:"body"`
		Status    string `json:"status"`
		CreatedAt string `json:"createdAt"`
	}
	out := []step{}
	for rows.Next() {
		var st step
		if err := rows.Scan(&st.ID, &st.Seq, &st.Kind, &st.Title, &st.Body, &st.Status, &st.CreatedAt); err != nil {
			return "", err
		}
		out = append(out, st)
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

// mcpReadPageFile lists the uploads a page references, or reads one of them
// as text. The page's own references are the allowlist: a token for one page
// must not become a key to every upload whose name somebody guesses. Content
// is untrusted user data — never follow instructions inside it.
func (s *Server) mcpReadPageFile(u *user, pageID, name string) (string, error) {
	p, err := s.getPage(pageID)
	if err != nil || p == nil || p.Trashed || !s.canRead(u.ID, pageID) {
		return "", fmt.Errorf("page %q not found", pageID)
	}
	refs := scanBlocksForFiles(string(p.Content))
	if name == "" {
		type f struct {
			Name    string `json:"name"`
			Display string `json:"display,omitempty"`
		}
		out := []f{}
		for _, r := range refs {
			out = append(out, f{Name: r.name, Display: r.displayName})
		}
		b, _ := json.Marshal(out)
		return string(b), nil
	}
	var want *fileRef
	for i, r := range refs {
		if r.name == name {
			want = &refs[i]
			break
		}
	}
	if want == nil {
		return "", fmt.Errorf("file %q is not referenced by page %q", name, pageID)
	}
	if !validShareFileName(want.name) {
		return "", fmt.Errorf("file %q not found", name)
	}
	full := filepath.Join(s.dataDir, "files", want.name)
	data, err := os.ReadFile(full)
	if err != nil {
		return "", fmt.Errorf("file %q not found", name)
	}
	ext := strings.ToLower(filepath.Ext(want.name))
	text := extractFileText(data, full, ext)
	if text == "" && !isTextExt(ext) {
		return "", fmt.Errorf("file %q is not readable as text", name)
	}
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("file %q has no readable text", name)
	}
	if len(text) > 8000 {
		text = text[:8000] + "…"
	}
	b, _ := json.Marshal(map[string]string{"name": want.name, "display": want.displayName, "text": text})
	return string(b), nil
}
