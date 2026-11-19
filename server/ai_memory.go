package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Agent memory: small durable notes the agent keeps about the user across
// runs ("prefers concise answers", "writes in German"). Surfaced three ways:
// injected into every run's system prompt, manageable over MCP, and editable
// in the chat UI. Workspace-scoped entries apply only there; blank workspace
// means everywhere.

// aiMemoryBlock renders the user's memory for a workspace as prompt context.
// Capped: the newest entries first, truncated so it stays a reminder, not an
// archive.
func (s *Server) aiMemoryBlock(u *user, workspaceID string) string {
	rows, err := s.db.Query(`SELECT content FROM ai_memory WHERE user_id = ? AND (workspace_id = '' OR workspace_id = ?) ORDER BY created_at DESC LIMIT 20`, u.ID, workspaceID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var items []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err == nil && strings.TrimSpace(c) != "" {
			items = append(items, strings.TrimSpace(c))
		}
	}
	if len(items) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\nAgent memory (durable notes about this user — follow them, and use memory_remember to store new ones worth keeping):\n")
	total := 0
	for _, it := range items {
		if len(it) > 500 {
			it = string([]rune(it)[:500]) + "…"
		}
		if total+len(it) > 4000 {
			break
		}
		total += len(it)
		b.WriteString("- " + it + "\n")
	}
	return b.String()
}

func (s *Server) handleListAIMemory(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	wsID := r.URL.Query().Get("workspace_id")
	q := `SELECT id, workspace_id, content, created_at, updated_at FROM ai_memory WHERE user_id = ?`
	args := []any{u.ID}
	if wsID != "" {
		if wsID == "*" {
			// all workspaces plus global
		} else {
			q += ` AND (workspace_id = '' OR workspace_id = ?)`
			args = append(args, wsID)
		}
	}
	q += ` ORDER BY updated_at DESC LIMIT 100`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type m struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspaceId"`
		Content     string `json:"content"`
		CreatedAt   string `json:"createdAt"`
		UpdatedAt   string `json:"updatedAt"`
	}
	out := []m{}
	for rows.Next() {
		var x m
		rows.Scan(&x.ID, &x.WorkspaceID, &x.Content, &x.CreatedAt, &x.UpdatedAt)
		out = append(out, x)
	}
	writeJSON(w, out)
}

func (s *Server) handleAddAIMemory(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	var body struct {
		Content     string `json:"content"`
		WorkspaceID string `json:"workspaceId"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	content := strings.TrimSpace(body.Content)
	if content == "" {
		httpError(w, 400, "content required")
		return
	}
	if r := []rune(content); len(r) > 2000 {
		content = string(r[:2000])
	}
	id := newID()
	ts := now()
	if _, err := s.db.Exec(`INSERT INTO ai_memory (id, user_id, workspace_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
		id, u.ID, body.WorkspaceID, content, ts, ts); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]string{"id": id})
}

func (s *Server) handleDeleteAIMemory(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	res, err := s.db.Exec(`DELETE FROM ai_memory WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpError(w, 404, "not found")
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// MCP surface for the same store (also what the in-app agent calls, since it
// runs on the mcpTools catalogue).
func (s *Server) mcpMemoryRemember(u *user, content, workspaceID string) (string, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return "", fmt.Errorf("content required")
	}
	if r := []rune(content); len(r) > 2000 {
		content = string(r[:2000])
	}
	if workspaceID != "" && !s.isMember(u.ID, workspaceID) {
		return "", fmt.Errorf("not a member of that workspace")
	}
	id := newID()
	ts := now()
	if _, err := s.db.Exec(`INSERT INTO ai_memory (id, user_id, workspace_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
		id, u.ID, workspaceID, content, ts, ts); err != nil {
		return "", err
	}
	b, _ := json.Marshal(map[string]string{"id": id})
	return string(b), nil
}

func (s *Server) mcpMemoryRecall(u *user, query, workspaceID string, limit int) (string, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	q := `SELECT id, workspace_id, content, updated_at FROM ai_memory WHERE user_id = ?`
	args := []any{u.ID}
	if workspaceID != "" {
		q += ` AND (workspace_id = '' OR workspace_id = ?)`
		args = append(args, workspaceID)
	}
	if query != "" {
		q += ` AND content LIKE ?`
		args = append(args, "%"+query+"%")
	}
	q += ` ORDER BY updated_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	type m struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspaceId,omitempty"`
		Content     string `json:"content"`
		UpdatedAt   string `json:"updatedAt"`
	}
	out := []m{}
	for rows.Next() {
		var x m
		rows.Scan(&x.ID, &x.WorkspaceID, &x.Content, &x.UpdatedAt)
		out = append(out, x)
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

func (s *Server) mcpMemoryForget(u *user, id string) (string, error) {
	res, err := s.db.Exec(`DELETE FROM ai_memory WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", fmt.Errorf("memory not found")
	}
	return `{"ok":true}`, nil
}

// ---- usage stats ----

// AI usage per account: who uses the assistant and how much. Owner or admin
// only — message counts and token sums across accounts are not for members.
func (s *Server) handleAIStats(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if u == nil || (!u.IsAdmin && !s.isOwner(u.ID)) {
		httpError(w, 403, "admin only")
		return
	}
	rows, err := s.db.Query(`SELECT u.id, u.name,
		(SELECT COUNT(*) FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.user_id = u.id) AS messages,
		(SELECT COUNT(*) FROM ai_runs x WHERE x.user_id = u.id) AS runs,
		(SELECT COUNT(*) FROM ai_runs x WHERE x.user_id = u.id AND x.status = 'completed') AS runs_ok,
		(SELECT COUNT(*) FROM ai_runs x WHERE x.user_id = u.id AND x.status = 'failed') AS runs_failed,
		(SELECT COALESCE(SUM(m.tokens_in), 0) FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.user_id = u.id) AS tok_in,
		(SELECT COALESCE(SUM(m.tokens_out), 0) FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.user_id = u.id) AS tok_out,
		(SELECT MAX(m.created_at) FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.user_id = u.id) AS last_active
		FROM users u ORDER BY messages DESC, runs DESC`)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type row struct {
		UserID     string  `json:"userId"`
		Name       string  `json:"name"`
		Messages   int     `json:"messages"`
		Runs       int     `json:"runs"`
		RunsOK     int     `json:"runsOk"`
		RunsFailed int     `json:"runsFailed"`
		TokensIn   int64   `json:"tokensIn"`
		TokensOut  int64   `json:"tokensOut"`
		LastActive *string `json:"lastActive"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		var last sql.NullString
		if err := rows.Scan(&x.UserID, &x.Name, &x.Messages, &x.Runs, &x.RunsOK, &x.RunsFailed, &x.TokensIn, &x.TokensOut, &last); err != nil {
			continue
		}
		if last.Valid {
			x.LastActive = &last.String
		}
		if x.Messages == 0 && x.Runs == 0 {
			continue
		}
		out = append(out, x)
	}
	writeJSON(w, out)
}
