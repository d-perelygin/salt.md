package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// aiEnabled reports whether AI is turned on for the instance.
func (s *Server) aiEnabled() bool {
	return s.setting("ai_enabled", "1") == "1"
}

// aiHTTPClient returns an *http.Client for AI provider calls. When AI_PROXY_URL
// is set (e.g. http://mihomo:7890) the request is tunnelled through it; otherwise
// a direct client is used. Other outbound traffic in salt does not use this proxy.
func aiHTTPClient() *http.Client {
	c := &http.Client{Timeout: 5 * time.Minute}
	if u := os.Getenv("AI_PROXY_URL"); u != "" {
		if pu, err := url.Parse(u); err == nil {
			c.Transport = &http.Transport{Proxy: http.ProxyURL(pu)}
		}
	}
	return c
}

// aiEnabledForUser reports whether AI is enabled both globally and for the user.
func (s *Server) aiEnabledForUser(u *user) bool {
	return u != nil && !u.AIDisabled && s.aiEnabled()
}

// aiWorkspaceEnabled lets a workspace opt out. Empty means on.
func (s *Server) aiWorkspaceEnabled(wsID string) bool {
	if wsID == "" {
		return true
	}
	var v string
	s.db.QueryRow(`SELECT agent_access FROM workspaces WHERE id = ?`, wsID).Scan(&v)
	// reuse agent_access? no; store separate? We'll just use global for v1.
	return true
}

// ---- encryption helpers ----

func (s *Server) aiKeyPath() string { return filepath.Join(s.dataDir, "ai.key") }

func (s *Server) aiEncKey() ([]byte, error) {
	p := s.aiKeyPath()
	b, err := os.ReadFile(p)
	if err == nil && len(b) == 32 {
		return b, nil
	}
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(p, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func encryptSecret(plain string, key []byte) (string, error) {
	if plain == "" {
		return "", nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

func decryptSecret(enc string, key []byte) (string, error) {
	if enc == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ct := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// ---- settings ----

type aiUserSettings struct {
	BaseURL     string  `json:"baseUrl"`
	Model       string  `json:"model"`
	Format      string  `json:"format"`
	Temperature float64 `json:"temperature"`
	HasKey      bool    `json:"hasKey"`
	Approval    string  `json:"approval"`
}

func (s *Server) handleGetAISettings(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	row := s.db.QueryRow(`SELECT base_url, model, format, temperature, api_key_enc, approval FROM user_ai_settings WHERE user_id = ?`, u.ID)
	var bs, model, format, enc, approval string
	var temp float64
	if err := row.Scan(&bs, &model, &format, &temp, &enc, &approval); err != nil {
		bs, model, format, temp, enc, approval = "", "", "chat", 0.7, "", "review"
	}
	if format == "" {
		format = "chat"
	}
	if approval == "" {
		approval = "review"
	}
	if temp == 0 {
		temp = 0.7
	}
	hasKey := enc != ""
	writeJSON(w, aiUserSettings{BaseURL: bs, Model: model, Format: format, Temperature: temp, HasKey: hasKey, Approval: approval})
}

func (s *Server) handlePutAISettings(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	var body struct {
		BaseURL     *string  `json:"baseUrl"`
		Model       *string  `json:"model"`
		Format      *string  `json:"format"`
		Temperature *float64 `json:"temperature"`
		APIKey      *string  `json:"apiKey"`   // "" clears
		Approval    *string  `json:"approval"` // always | review | skip
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	// load existing
	var bs, model, format, enc, approval string
	var temp float64
	s.db.QueryRow(`SELECT base_url, model, format, temperature, api_key_enc, approval FROM user_ai_settings WHERE user_id = ?`, u.ID).Scan(&bs, &model, &format, &temp, &enc, &approval)
	if format == "" {
		format = "chat"
	}
	if approval == "" {
		approval = "review"
	}
	if temp == 0 {
		temp = 0.7
	}
	if body.BaseURL != nil {
		bs = normalizeAIBaseURL(*body.BaseURL)
	}
	if body.Model != nil {
		model = strings.TrimSpace(*body.Model)
	}
	if body.Approval != nil {
		approval = strings.TrimSpace(*body.Approval)
		if approval != "always" && approval != "review" && approval != "skip" {
			approval = "review"
		}
	}
	if body.Format != nil {
		format = strings.TrimSpace(*body.Format)
		if format == "" {
			format = "chat"
		}
	}
	if body.Temperature != nil {
		temp = *body.Temperature
	}
	if body.APIKey != nil {
		key, err := s.aiEncKey()
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		if strings.TrimSpace(*body.APIKey) == "" {
			enc = ""
		} else {
			enc, err = encryptSecret(strings.TrimSpace(*body.APIKey), key)
			if err != nil {
				httpError(w, 500, err.Error())
				return
			}
		}
	}
	s.db.Exec(`INSERT INTO user_ai_settings (user_id, base_url, model, format, temperature, api_key_enc, approval, updated_at)
		VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
		base_url=excluded.base_url, model=excluded.model, format=excluded.format, temperature=excluded.temperature,
		api_key_enc=excluded.api_key_enc, approval=excluded.approval, updated_at=excluded.updated_at`,
		u.ID, bs, model, format, temp, enc, approval, now())
	writeJSON(w, map[string]bool{"ok": true})
}

func normalizeAIBaseURL(raw string) string {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	u = strings.TrimSuffix(u, "/responses")
	u = strings.TrimSuffix(u, "/chat/completions")
	return u
}

// resolveAIConfig returns base_url, model, format, temperature, apiKey, approval for a user.
func (s *Server) resolveAIConfig(u *user) (string, string, string, float64, string, string, error) {
	if !s.aiEnabledForUser(u) {
		return "", "", "", 0, "", "", fmt.Errorf("AI is disabled")
	}
	var bs, model, format, enc, approval string
	var temp float64
	err := s.db.QueryRow(`SELECT base_url, model, format, temperature, api_key_enc, approval FROM user_ai_settings WHERE user_id = ?`, u.ID).Scan(&bs, &model, &format, &temp, &enc, &approval)
	if err != nil {
		bs, model, format, temp, enc, approval = "", "", "chat", 0.7, "", "review"
	}
	if format == "" {
		format = "chat"
	}
	if approval == "" {
		approval = "review"
	}
	if temp == 0 {
		temp = 0.7
	}
	// defaults from instance
	if bs == "" {
		bs = s.setting("ai_default_base_url", "https://api.openai.com/v1")
	}
	bs = normalizeAIBaseURL(bs)
	if model == "" {
		model = s.setting("ai_default_model", "gpt-4o-mini")
	}
	key, err := s.aiEncKey()
	if err != nil {
		return "", "", "", 0, "", "", err
	}
	apiKey, err := decryptSecret(enc, key)
	if err != nil {
		return "", "", "", 0, "", "", err
	}
	if apiKey == "" {
		enc2 := s.setting("ai_instance_key_enc", "")
		if enc2 != "" && (s.setting("ai_allow_instance_key", "1") == "1" || u.IsAdmin) {
			apiKey, _ = decryptSecret(enc2, key)
		}
	}
	if apiKey == "" {
		return "", "", "", 0, "", "", fmt.Errorf("no API key configured")
	}
	return bs, model, format, temp, apiKey, approval, nil
}

// ---- threads & messages ----

func (s *Server) handleListAIThreads(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		writeJSON(w, []any{})
		return
	}
	pageID := r.URL.Query().Get("page_id")
	wsID := r.URL.Query().Get("workspace_id")
	q := `SELECT t.id, t.user_id, t.workspace_id, t.page_id, t.title, t.created_at, t.updated_at, t.last_read_at,
		COALESCE(p.title, '') AS page_title,
		(SELECT COUNT(*) FROM ai_messages m WHERE m.thread_id = t.id) AS msg_count,
		(SELECT m2.content FROM ai_messages m2 WHERE m2.thread_id = t.id ORDER BY m2.created_at DESC LIMIT 1) AS last_preview,
		(SELECT m3.role FROM ai_messages m3 WHERE m3.thread_id = t.id ORDER BY m3.created_at DESC LIMIT 1) AS last_role,
		EXISTS (SELECT 1 FROM ai_runs r WHERE r.thread_id = t.id) AS has_runs
		FROM ai_threads t LEFT JOIN pages p ON p.id = t.page_id WHERE t.user_id = ?`
	args := []any{u.ID}
	if pageID != "" {
		q += ` AND t.page_id = ?`
		args = append(args, pageID)
	}
	if wsID != "" {
		q += ` AND t.workspace_id = ?`
		args = append(args, wsID)
	}
	q += ` ORDER BY t.updated_at DESC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type t struct {
		ID          string `json:"id"`
		UserID      string `json:"userId"`
		WorkspaceID string `json:"workspaceId"`
		PageID      string `json:"pageId"`
		PageTitle   string `json:"pageTitle"`
		Title       string `json:"title"`
		MsgCount    int    `json:"msgCount"`
		LastPreview string `json:"lastPreview"`
		LastRole    string `json:"lastRole"`
		LastReadAt  string `json:"lastReadAt"`
		HasRuns     bool   `json:"hasRuns"`
		CreatedAt   string `json:"createdAt"`
		UpdatedAt   string `json:"updatedAt"`
	}
	out := []t{}
	for rows.Next() {
		var x t
		var preview, lastRole sql.NullString
		rows.Scan(&x.ID, &x.UserID, &x.WorkspaceID, &x.PageID, &x.Title, &x.CreatedAt, &x.UpdatedAt, &x.LastReadAt, &x.PageTitle, &x.MsgCount, &preview, &lastRole, &x.HasRuns)
		if preview.Valid {
			x.LastPreview = preview.String
			if len(x.LastPreview) > 160 {
				x.LastPreview = x.LastPreview[:160] + "…"
			}
		}
		if lastRole.Valid {
			x.LastRole = lastRole.String
		}
		out = append(out, x)
	}
	writeJSON(w, out)
}

// Thread runs feed the "Worked for …" trace and the Artifacts panel with
// history, not just the live run.
func (s *Server) handleListAIThreadRuns(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	threadID := r.PathValue("id")
	var owner string
	if err := s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&owner); err != nil || owner != u.ID {
		httpError(w, 404, "not found")
		return
	}
	rows, err := s.db.Query(`SELECT id, status, task, progress, started_at, finished_at, artifacts FROM ai_runs WHERE thread_id = ? ORDER BY started_at ASC`, threadID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type run struct {
		ID        string `json:"id"`
		Status    string `json:"status"`
		Task      string `json:"task"`
		Progress  string `json:"progress"`
		StartedAt string `json:"startedAt"`
		Finished  string `json:"finishedAt"`
		Artifacts string `json:"artifacts"`
	}
	out := []run{}
	for rows.Next() {
		var x run
		rows.Scan(&x.ID, &x.Status, &x.Task, &x.Progress, &x.StartedAt, &x.Finished, &x.Artifacts)
		out = append(out, x)
	}
	writeJSON(w, out)
}

func (s *Server) handleCreateAIThread(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	var body struct {
		WorkspaceID string `json:"workspaceId"`
		PageID      string `json:"pageId"`
		Title       string `json:"title"`
	}
	decodeJSON(w, r, &body)
	id := newID()
	ts := now()
	s.db.Exec(`INSERT INTO ai_threads (id, user_id, workspace_id, page_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
		id, u.ID, body.WorkspaceID, body.PageID, body.Title, ts, ts)
	writeJSON(w, map[string]string{"id": id})
}

func (s *Server) handleGetAIThreadMessages(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	threadID := r.PathValue("id")
	// ownership
	var owner string
	s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&owner)
	if owner != u.ID {
		httpError(w, 404, "not found")
		return
	}
	rows, err := s.db.Query(`SELECT id, thread_id, role, content, model, tokens_in, tokens_out, attachments, created_at FROM ai_messages WHERE thread_id = ? ORDER BY created_at ASC`, threadID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type m struct {
		ID          string `json:"id"`
		ThreadID    string `json:"threadId"`
		Role        string `json:"role"`
		Content     string `json:"content"`
		Model       string `json:"model"`
		TokensIn    int    `json:"tokensIn"`
		TokensOut   int    `json:"tokensOut"`
		Attachments string `json:"attachments"`
		CreatedAt   string `json:"createdAt"`
	}
	out := []m{}
	for rows.Next() {
		var x m
		rows.Scan(&x.ID, &x.ThreadID, &x.Role, &x.Content, &x.Model, &x.TokensIn, &x.TokensOut, &x.Attachments, &x.CreatedAt)
		out = append(out, x)
	}
	writeJSON(w, out)
}

func (s *Server) handleDeleteAIThread(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	s.db.Exec(`DELETE FROM ai_runs WHERE thread_id = ? AND user_id = ?`, id, u.ID)
	s.db.Exec(`DELETE FROM ai_threads WHERE id = ? AND user_id = ?`, id, u.ID)
	writeJSON(w, map[string]bool{"ok": true})
}

// Rename a thread (title only; ownership-checked).
func (s *Server) handleRenameAIThread(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var body struct {
		Title string `json:"title"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		httpError(w, 400, "title required")
		return
	}
	if len(title) > 120 {
		title = title[:120]
	}
	res, err := s.db.Exec(`UPDATE ai_threads SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`, title, now(), id, u.ID)
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

// Mark a thread read up to now (clears the unread dot).
func (s *Server) handleReadAIThread(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	s.db.Exec(`UPDATE ai_threads SET last_read_at = ? WHERE id = ? AND user_id = ?`, now(), id, u.ID)
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- chat SSE proxy ----

type aiChatRequest struct {
	ThreadID string `json:"threadId"`
	PageID   string `json:"pageId"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	Model       string   `json:"model"`
	IncludePage bool     `json:"includePage"`
	Selection   string   `json:"selection"`
	Mentions    []string `json:"mentions"`
	// Attached files (name + extracted text), from the chat composer.
	ContextTexts []struct {
		Name string `json:"name"`
		Text string `json:"text"`
	} `json:"contextTexts"`
}

// aiAttachmentsContext frames attached files for the system prompt.
func aiAttachmentsContext(files []struct {
	Name string `json:"name"`
	Text string `json:"text"`
}) string {
	if len(files) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\nAttached files:\n")
	for i, f := range files {
		if i >= 3 {
			break
		}
		txt := f.Text
		if len(txt) > 4000 {
			txt = txt[:4000] + "…"
		}
		name := f.Name
		if name == "" {
			name = "file"
		}
		fmt.Fprintf(&sb, "\n--- %s ---\n%s\n", name, txt)
	}
	return sb.String()
}

// aiMentionContext renders @-mentioned pages into the system prompt. Pages the
// user cannot read are silently skipped — the model must never learn they exist.
func (s *Server) aiMentionContext(r *http.Request, pageID string, mentions []string) string {
	var sb strings.Builder
	seen := map[string]bool{pageID: true}
	for _, mid := range mentions {
		mid = strings.TrimSpace(mid)
		if mid == "" || seen[mid] {
			continue
		}
		seen[mid] = true
		if !s.canReadReq(r, mid) {
			continue
		}
		p, err := s.getPage(mid)
		if err != nil {
			continue
		}
		b, _ := json.Marshal(p.Content)
		txt := string(b)
		if len(txt) > 4000 {
			txt = txt[:4000] + "…"
		}
		fmt.Fprintf(&sb, "\n\nReferenced page %q (via @-mention):\n%s", p.Title, txt)
	}
	return sb.String()
}

func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	var req aiChatRequest
	if err := decodeJSON(w, r, &req); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	baseURL, defModel, format, temp, apiKey, _, err := s.resolveAIConfig(u)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = defModel
	}
	// thread
	threadID := req.ThreadID
	if threadID == "" {
		threadID = newID()
		s.db.Exec(`INSERT INTO ai_threads (id, user_id, workspace_id, page_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
			threadID, u.ID, "", req.PageID, "New chat", now(), now())
	}
	// save last user message
	if len(req.Messages) > 0 {
		last := req.Messages[len(req.Messages)-1]
		if last.Role == "user" {
			s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)`,
				newID(), threadID, "user", last.Content, model, now())
		}
	}

	if format == "responses" {
		s.handleAIChatResponses(w, r, u, req, baseURL, model, temp, apiKey, threadID)
		return
	}

	// build messages
	var msgs []map[string]any
	// system
	sys := aiBasePrompt() + "\n" +
		"You answer questions and draft text. You cannot change anything yourself — " +
		"but an agent mode in the same thread can: if the user asks to create, edit, organize or fill anything, " +
		"say briefly what the agent will do and invite them to press Agent."
	if req.PageID != "" {
		if p, err := s.getPage(req.PageID); err == nil {
			sys += "\n\nCurrent page title: " + p.Title
			if req.Selection != "" {
				sys += "\n\nSelected text:\n" + req.Selection
			}
			if req.IncludePage {
				b, _ := json.Marshal(p.Content)
				txt := string(b)
				if len(txt) > 8000 {
					txt = txt[:8000] + "…"
				}
				sys += "\n\nPage content (JSON blocks):\n" + txt
			}
		}
	}
	sys += s.aiMentionContext(r, req.PageID, req.Mentions)
	sys += aiAttachmentsContext(req.ContextTexts)
	var threadWS string
	if threadID != "" {
		s.db.QueryRow(`SELECT workspace_id FROM ai_threads WHERE id = ?`, threadID).Scan(&threadWS)
	}
	sys += s.aiWorkspaceRulesBlock(req.PageID, threadWS)
	msgs = append(msgs, map[string]any{"role": "system", "content": sys})
	for _, m := range req.Messages {
		msgs = append(msgs, map[string]any{"role": m.Role, "content": m.Content})
	}

	body := map[string]any{
		"model":       model,
		"messages":    msgs,
		"temperature": temp,
		"stream":      true,
	}
	b, _ := json.Marshal(body)

	url := strings.TrimRight(baseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())

	client := aiHTTPClient()
	resp, err := client.Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(resp.Body)
		httpError(w, resp.StatusCode, string(rb))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, _ := w.(http.Flusher)

	var assistant strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		c0, _ := choices[0].(map[string]any)
		delta, _ := c0["delta"].(map[string]any)
		if content, ok := delta["content"].(string); ok && content != "" {
			assistant.WriteString(content)
			fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "delta", "content": content}))
			if fl != nil {
				fl.Flush()
			}
		}
	}
	// save assistant message
	msgID := newID()
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)`,
		msgID, threadID, "assistant", assistant.String(), model, now())
	s.db.Exec(`UPDATE ai_threads SET updated_at = ? WHERE id = ?`, now(), threadID)
	fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "done", "threadId": threadID, "messageId": msgID}))
	if fl != nil {
		fl.Flush()
	}
}

// handleAIChatResponses streams an OpenAI Responses API request.
func (s *Server) handleAIChatResponses(w http.ResponseWriter, r *http.Request, u *user, req aiChatRequest, baseURL, model string, temp float64, apiKey, threadID string) {
	sys := aiBasePrompt() + "\n" +
		"You answer questions and draft text. You cannot change anything yourself — " +
		"but an agent mode in the same thread can: if the user asks to create, edit, organize or fill anything, " +
		"say briefly what the agent will do and invite them to press Agent."
	if req.PageID != "" {
		if p, err := s.getPage(req.PageID); err == nil {
			sys += "\n\nCurrent page title: " + p.Title
			if req.Selection != "" {
				sys += "\n\nSelected text:\n" + req.Selection
			}
			if req.IncludePage {
				b, _ := json.Marshal(p.Content)
				txt := string(b)
				if len(txt) > 8000 {
					txt = txt[:8000] + "…"
				}
				sys += "\n\nPage content (JSON blocks):\n" + txt
			}
		}
	}
	sys += s.aiMentionContext(r, req.PageID, req.Mentions)
	sys += aiAttachmentsContext(req.ContextTexts)
	var threadWS string
	if threadID != "" {
		s.db.QueryRow(`SELECT workspace_id FROM ai_threads WHERE id = ?`, threadID).Scan(&threadWS)
	}
	sys += s.aiWorkspaceRulesBlock(req.PageID, threadWS)
	// build input messages
	var input []map[string]any
	for _, m := range req.Messages {
		input = append(input, map[string]any{"role": m.Role, "content": m.Content})
	}
	body := map[string]any{
		"model":        model,
		"instructions": sys,
		"input":        input,
		"temperature":  temp,
		"stream":       true,
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(baseURL, "/") + "/responses"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())

	client := aiHTTPClient()
	resp, err := client.Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(resp.Body)
		httpError(w, resp.StatusCode, string(rb))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, _ := w.(http.Flusher)

	var assistant strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var evt map[string]any
		if err := json.Unmarshal([]byte(data), &evt); err != nil {
			continue
		}
		// Responses API streaming events
		if evt["type"] == "response.output_text.delta" {
			if delta, ok := evt["delta"].(string); ok && delta != "" {
				assistant.WriteString(delta)
				fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "delta", "content": delta}))
				if fl != nil {
					fl.Flush()
				}
			}
		}
	}
	msgID := newID()
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)`,
		msgID, threadID, "assistant", assistant.String(), model, now())
	s.db.Exec(`UPDATE ai_threads SET updated_at = ? WHERE id = ?`, now(), threadID)
	fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "done", "threadId": threadID, "messageId": msgID}))
	if fl != nil {
		fl.Flush()
	}
}

// runAIBackgroundResponses runs the agent using OpenAI Responses API.
func (s *Server) runAIBackgroundResponses(ctx context.Context, u *user, runID, threadID, task, pageID, baseURL, model string, temp float64, apiKey, approvalMode, sys, userMsgID string) {
	// Build tools in Responses format.
	tools := make([]map[string]any, 0, len(mcpTools))
	for _, t := range mcpTools {
		tools = append(tools, map[string]any{
			"type":        "function",
			"name":        t["name"],
			"description": t["description"],
			"parameters":  t["inputSchema"],
		})
	}
	for _, t := range aiAgentExtraTools {
		tools = append(tools, map[string]any{
			"type":        "function",
			"name":        t["name"],
			"description": t["description"],
			"parameters":  t["inputSchema"],
		})
	}
	// input accumulates items; the thread history goes first so follow-ups,
	// corrections and answers to the agent's questions carry over.
	input := []map[string]any{}
	for _, h := range s.aiThreadHistory(threadID, userMsgID, 8) {
		input = append(input, map[string]any{"role": h[0], "content": h[1]})
	}
	input = append(input, map[string]any{"role": "user", "content": task})
	client := aiHTTPClient()
	var finalContent string
	rejected := false
	s.aiAddStep(runID, threadID, u.ID, "thinking", "Planning", task, "running")
	for iter := 0; iter < 20; iter++ {
		select {
		case <-ctx.Done():
			s.db.Exec(`UPDATE ai_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runID)
			return
		default:
		}
		body := map[string]any{
			"model":        model,
			"instructions": sys,
			"input":        input,
			"tools":        tools,
			"temperature":  temp,
			"stream":       false,
		}
		b, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(baseURL, "/")+"/responses", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("x-opencode-session", newID())
		resp, err := client.Do(req)
		if err != nil {
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		rb, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, string(rb), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		var out map[string]any
		json.Unmarshal(rb, &out)
		output, _ := out["output"].([]any)
		// collect function calls and text
		hasTool := false
		stopped := false
		for _, item := range output {
			it, _ := item.(map[string]any)
			typ, _ := it["type"].(string)
			if typ == "function_call" {
				hasTool = true
				name, _ := it["name"].(string)
				callID, _ := it["call_id"].(string)
				argsStr, _ := it["arguments"].(string)
				if argsStr == "" {
					argsStr = "{}"
				}
				if name == "ask_user" {
					answer, ok := s.aiAskUser(ctx, u, runID, threadID, argsStr)
					if !ok {
						finalContent = "Stopped: the user did not answer the question."
						rejected = true
						stopped = true
						break
					}
					s.db.Exec(`UPDATE ai_runs SET progress=? WHERE id=?`, "user answered", runID)
					input = append(input, it)
					input = append(input, map[string]any{
						"type":    "function_call_output",
						"call_id": callID,
						"output":  answer,
					})
					continue
				}
				if !s.aiGateToolCall(ctx, u, runID, threadID, name, argsStr, approvalMode) {
					finalContent = "Stopped: the action was not approved."
					rejected = true
					stopped = true
					break
				}
				s.db.Exec(`UPDATE ai_runs SET progress=? WHERE id=?`, "calling "+name, runID)
				s.aiAddStep(runID, threadID, u.ID, "tool_call", "Script · "+name, argsStr, "running")
				var args json.RawMessage = json.RawMessage(argsStr)
				result, err := s.mcpCall(u, name, args, "")
				if err != nil {
					result = "error: " + err.Error()
				}
				s.aiAddStep(runID, threadID, u.ID, "tool_result", "Result · "+name, result, "done")
				s.aiRecordArtifacts(runID, name, result)
				// append function_call and output to input
				input = append(input, it)
				input = append(input, map[string]any{
					"type":    "function_call_output",
					"call_id": callID,
					"output":  result,
				})
			}
			if typ == "message" {
				if content, ok := it["content"].([]any); ok {
					for _, c := range content {
						cm, _ := c.(map[string]any)
						if t, _ := cm["type"].(string); t == "output_text" {
							if txt, ok := cm["text"].(string); ok {
								finalContent = txt
							}
						}
					}
				}
			}
		}
		if stopped {
			break
		}
		if !hasTool {
			// maybe text in output_text
			if finalContent == "" {
				if txt, ok := out["output_text"].(string); ok {
					finalContent = txt
				}
			}
			break
		}
	}
	s.aiAddStep(runID, threadID, u.ID, "thinking", "Done", finalContent, "done")
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)`,
		newID(), threadID, "assistant", finalContent, model, now())
	if rejected {
		s.db.Exec(`UPDATE ai_runs SET status='cancelled', progress='rejected', finished_at=? WHERE id=?`, now(), runID)
	} else {
		s.db.Exec(`UPDATE ai_runs SET status='completed', progress='done', finished_at=? WHERE id=?`, now(), runID)
	}
	s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
	if pageID != "" {
		s.db.Exec(`DELETE FROM agent_presence WHERE page_id=? AND account_id=? AND agent='salt-ai'`, pageID, u.ID)
	}
}

func mustJSONStr(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// ---- run steps (agent trace) ----

type aiStep struct {
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	ThreadID  string `json:"threadId"`
	Seq       int    `json:"seq"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

// aiAddStep appends one visible trace row for a run. Body is truncated: a tool
// result can be a whole page dump, and the trace is a summary, not a copy.
func (s *Server) aiAddStep(runID, threadID, userID, kind, title, body, status string) string {
	id := newID()
	if len(body) > 2000 {
		body = body[:2000] + "…"
	}
	if status == "" {
		status = "done"
	}
	var maxSeq sql.NullInt64
	s.db.QueryRow(`SELECT MAX(seq) FROM ai_steps WHERE run_id = ?`, runID).Scan(&maxSeq)
	seq := 0
	if maxSeq.Valid {
		seq = int(maxSeq.Int64) + 1
	}
	s.db.Exec(`INSERT INTO ai_steps (id, run_id, thread_id, user_id, seq, kind, title, body, status, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, id, runID, threadID, userID, seq, kind, title, body, status, now())
	return id
}

func (s *Server) aiRunOwnedBy(runID, userID string) (threadID string, ok bool) {
	var uid string
	if err := s.db.QueryRow(`SELECT user_id, thread_id FROM ai_runs WHERE id = ?`, runID).Scan(&uid, &threadID); err != nil {
		return "", false
	}
	return threadID, uid == userID
}

func (s *Server) handleListAIRunSteps(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	runID := r.PathValue("id")
	threadID, ok := s.aiRunOwnedBy(runID, u.ID)
	if !ok {
		httpError(w, 404, "not found")
		return
	}
	_ = threadID
	rows, err := s.db.Query(`SELECT id, run_id, thread_id, seq, kind, title, body, status, created_at FROM ai_steps WHERE run_id = ? ORDER BY seq ASC`, runID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []aiStep{}
	for rows.Next() {
		var x aiStep
		rows.Scan(&x.ID, &x.RunID, &x.ThreadID, &x.Seq, &x.Kind, &x.Title, &x.Body, &x.Status, &x.CreatedAt)
		out = append(out, x)
	}
	writeJSON(w, out)
}

// handleGetAIRunEvents streams the run's trace as SSE: one event per step plus
// status events. The browser's fetch reader parses the same data: envelope as
// the chat stream. Polls the DB so it works across restarts and reconnects.
func (s *Server) handleGetAIRunEvents(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	runID := r.PathValue("id")
	if _, ok := s.aiRunOwnedBy(runID, u.ID); !ok {
		httpError(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, _ := w.(http.Flusher)
	seen := map[string]bool{}
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.After(10 * time.Minute)
	for {
		// new steps
		rows, err := s.db.Query(`SELECT id, run_id, thread_id, seq, kind, title, body, status, created_at FROM ai_steps WHERE run_id = ? ORDER BY seq ASC`, runID)
		if err == nil {
			for rows.Next() {
				var x aiStep
				rows.Scan(&x.ID, &x.RunID, &x.ThreadID, &x.Seq, &x.Kind, &x.Title, &x.Body, &x.Status, &x.CreatedAt)
				if !seen[x.ID] {
					seen[x.ID] = true
					fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "step", "step": x}))
					if fl != nil {
						fl.Flush()
					}
				}
			}
			rows.Close()
		}
		var status, progress, runErr, pendingTool, pendingArgs string
		s.db.QueryRow(`SELECT status, progress, error, pending_tool, pending_args FROM ai_runs WHERE id = ?`, runID).Scan(&status, &progress, &runErr, &pendingTool, &pendingArgs)
		fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "status", "status": status, "progress": progress, "error": runErr, "pendingTool": pendingTool, "pendingArgs": pendingArgs}))
		if fl != nil {
			fl.Flush()
		}
		if status == "completed" || status == "failed" || status == "cancelled" {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-timeout:
			return
		case <-ticker.C:
		}
	}
}

// ---- approvals ----

// Read-only tools never change anything, so they never ask.
var aiReadTools = map[string]bool{
	"list": true, "search": true, "get_page": true, "query_rows": true,
	"get_collection": true, "get_links": true, "whoami": true,
	"get_workspace": true, "get_permissions": true, "revisions": true,
	"get_import_status": true,
}

// Destructive tools: deleting, trashing, sharing, governance. "Review for me"
// asks about exactly these; "Always ask" asks about every write.
var aiDestructiveTools = map[string]bool{
	"delete_comment": true, "delete_view": true, "set_trashed": true,
	"set_sharing": true, "propose_workspace_rules": true,
	"update_schema": true, "workspace": true,
}

func toolNeedsApproval(name, mode string) bool {
	if mode == "skip" {
		return false
	}
	if aiReadTools[name] {
		return false
	}
	if mode == "review" {
		return aiDestructiveTools[name]
	}
	// "always": every write asks.
	return true
}

// aiWaitApproval blocks until the user approves (true) or rejects (false) the
// pending tool call, the run is cancelled, or ctx dies. The decision travels
// through the ai_runs row so the browser needs no socket of its own.
func (s *Server) aiWaitApproval(ctx context.Context, runID string) bool {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.After(15 * time.Minute)
	for {
		var approved, cancel int
		s.db.QueryRow(`SELECT approved, cancel_requested FROM ai_runs WHERE id = ?`, runID).Scan(&approved, &cancel)
		if approved == 1 {
			return true
		}
		if approved == -1 || cancel == 1 {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-timeout:
			return false
		case <-ticker.C:
		}
	}
}

// aiAskUser pauses the run for a user answer (the ask_user tool). It returns
// the answer text and true, or "", false when the run must stop
// (cancelled/timeout/no answer). The answer re-enters the model as this tool
// call's result only — no separate chat message is stored.
func (s *Server) aiAskUser(ctx context.Context, u *user, runID, threadID, argsStr string) (string, bool) {
	var q struct {
		Question string `json:"question"`
		Options  []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
		} `json:"options"`
		Multiple bool `json:"multiple"`
	}
	if err := json.Unmarshal([]byte(argsStr), &q); err != nil || strings.TrimSpace(q.Question) == "" || len(q.Options) < 2 {
		return "error: ask_user needs a single question and 2-4 concrete answer options", true
	}
	for _, opt := range q.Options {
		lbl := strings.TrimSpace(opt.Label)
		if lbl == "" || strings.HasSuffix(lbl, "?") {
			return "error: invalid ask_user options: each option.label must be a concrete selectable answer to the question (e.g. 'Russian', 'German', 'English'), NEVER a sub-question ending with '?'. Ask one single question in 'question' and provide 2-4 concrete answer choices in 'options'.", true
		}
	}
	s.aiAddStep(runID, threadID, u.ID, "question_request", "Question", q.Question, "pending")
	s.db.Exec(`UPDATE ai_runs SET status='waiting_user', pending_tool='ask_user', pending_args=?, approved=0, progress=? WHERE id=?`,
		argsStr, "waiting for answer", runID)
	answer := s.aiWaitUser(ctx, runID)
	s.db.Exec(`UPDATE ai_runs SET pending_tool='', pending_args='' WHERE id=?`, runID)
	if answer == "" {
		s.aiAddStep(runID, threadID, u.ID, "question_result", "Unanswered", "", "rejected")
		return "", false
	}
	s.aiAddStep(runID, threadID, u.ID, "question_result", "Answered", answer, "done")
	s.db.Exec(`UPDATE ai_runs SET status='running', approved=0 WHERE id=?`, runID)
	return answer, true
}

// aiWaitUser blocks until the user answers the pending ask_user question,
// the run is cancelled, or ctx dies. The answer travels through the ai_runs
// row so the browser needs no socket of its own.
func (s *Server) aiWaitUser(ctx context.Context, runID string) string {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.After(15 * time.Minute)
	for {
		var answer string
		var cancel int
		s.db.QueryRow(`SELECT pending_answer, cancel_requested FROM ai_runs WHERE id = ?`, runID).Scan(&answer, &cancel)
		if answer != "" {
			s.db.Exec(`UPDATE ai_runs SET pending_answer='' WHERE id=?`, runID)
			return answer
		}
		if cancel == 1 {
			return ""
		}
		select {
		case <-ctx.Done():
			return ""
		case <-timeout:
			return ""
		case <-ticker.C:
		}
	}
}

// aiGateToolCall pauses the run for approval when the mode demands it. It
// returns false when the run must stop (rejected/cancelled/timeout).
func (s *Server) aiGateToolCall(ctx context.Context, u *user, runID, threadID, name, argsStr, mode string) bool {
	if !toolNeedsApproval(name, mode) {
		return true
	}
	s.aiAddStep(runID, threadID, u.ID, "approval_request", "Approval · "+name, argsStr, "pending")
	s.db.Exec(`UPDATE ai_runs SET status='waiting_approval', pending_tool=?, pending_args=?, approved=0, progress=? WHERE id=?`,
		name, argsStr, "waiting for approval: "+name, runID)
	ok := s.aiWaitApproval(ctx, runID)
	s.db.Exec(`UPDATE ai_runs SET pending_tool='', pending_args='' WHERE id=?`, runID)
	if !ok {
		s.aiAddStep(runID, threadID, u.ID, "approval_result", "Rejected · "+name, "", "rejected")
		return false
	}
	s.aiAddStep(runID, threadID, u.ID, "approval_result", "Approved · "+name, "", "approved")
	s.db.Exec(`UPDATE ai_runs SET status='running', approved=0 WHERE id=?`, runID)
	return true
}

// aiCreatedPageID extracts the created page id from tool results. The server
// formats these strings itself ("Created page %q with id %s"), so the first
// 32-hex token is the new page; for duplicate_page it precedes "from template".
var aiCreatedIDRe = regexp.MustCompile(`\b[0-9a-f]{32}\b`)

func aiArtifactTools(name string) bool {
	return name == "create_page" || name == "create_database" || name == "duplicate_page"
}

// aiRecordArtifacts remembers pages an agent run created, for the Artifacts
// panel. Best-effort: unparsable results are simply skipped.
func (s *Server) aiRecordArtifacts(runID, tool, result string) {
	if !aiArtifactTools(tool) || strings.HasPrefix(result, "error:") {
		return
	}
	id := aiCreatedIDRe.FindString(result)
	if id == "" {
		return
	}
	var cur []string
	var raw string
	s.db.QueryRow(`SELECT artifacts FROM ai_runs WHERE id = ?`, runID).Scan(&raw)
	json.Unmarshal([]byte(raw), &cur)
	for _, x := range cur {
		if x == id {
			return
		}
	}
	cur = append(cur, id)
	b, _ := json.Marshal(cur)
	s.db.Exec(`UPDATE ai_runs SET artifacts = ? WHERE id = ?`, string(b), runID)
}

func (s *Server) handleApproveAIRun(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var userID string
	s.db.QueryRow(`SELECT user_id FROM ai_runs WHERE id=?`, id).Scan(&userID)
	if userID == "" || userID != u.ID {
		httpError(w, 404, "not found")
		return
	}
	var body struct {
		Approved bool `json:"approved"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	v := -1
	if body.Approved {
		v = 1
	}
	s.db.Exec(`UPDATE ai_runs SET approved=? WHERE id=?`, v, id)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleAnswerAIRun(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var userID, status string
	s.db.QueryRow(`SELECT user_id, status FROM ai_runs WHERE id=?`, id).Scan(&userID, &status)
	if userID == "" || userID != u.ID {
		httpError(w, 404, "not found")
		return
	}
	if status != "waiting_user" {
		httpError(w, 409, "run is not waiting for an answer")
		return
	}
	var body struct {
		Answer string `json:"answer"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Answer) == "" {
		httpError(w, 400, "answer required")
		return
	}
	s.db.Exec(`UPDATE ai_runs SET pending_answer=? WHERE id=?`, body.Answer, id)
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- ephemeral generation (AI Block / inline, never saved to chats) ----

type aiGenerateRequest struct {
	Prompt      string   `json:"prompt"`
	Selection   string   `json:"selection"`
	PageID      string   `json:"pageId"`
	IncludePage bool     `json:"includePage"`
	Model       string   `json:"model"`
	Mentions    []string `json:"mentions"`
}

// handleAIGenerate streams one answer without touching threads or messages.
// Document interactions (AI Block, inline rewrite) stay out of the chat list.
func (s *Server) handleAIGenerate(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	var req aiGenerateRequest
	if err := decodeJSON(w, r, &req); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" && strings.TrimSpace(req.Selection) == "" {
		httpError(w, 400, "prompt required")
		return
	}
	baseURL, defModel, format, temp, apiKey, _, err := s.resolveAIConfig(u)
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = defModel
	}
	sys := "You are a writing assistant inside salt.md. Follow the instruction. Reply with only the resulting text, no preamble. " +
		"Match the language of the instruction (or of the selected text, if the instruction has none)."
	if req.PageID != "" {
		if p, err := s.getPage(req.PageID); err == nil {
			sys += "\n\nCurrent page title: " + p.Title
			if req.Selection != "" {
				sys += "\n\nSelected text:\n" + req.Selection
			}
			if req.IncludePage {
				b, _ := json.Marshal(p.Content)
				txt := string(b)
				if len(txt) > 8000 {
					txt = txt[:8000] + "…"
				}
				sys += "\n\nPage content (JSON blocks):\n" + txt
			}
		} else if req.Selection != "" {
			sys += "\n\nSelected text:\n" + req.Selection
		}
	} else if req.Selection != "" {
		sys += "\n\nSelected text:\n" + req.Selection
	}
	sys += s.aiMentionContext(r, req.PageID, req.Mentions)
	userMsg := req.Prompt
	if userMsg == "" {
		userMsg = "Process the selected text."
	}
	if format == "responses" {
		s.streamResponses(w, baseURL, model, temp, apiKey, sys, map[string]any{"role": "user", "content": userMsg})
		return
	}
	msgs := []map[string]any{
		{"role": "system", "content": sys},
		{"role": "user", "content": userMsg},
	}
	s.streamChat(w, baseURL, model, temp, apiKey, msgs)
}

// streamChat proxies one OpenAI chat-completions stream as our SSE envelope.
func (s *Server) streamChat(w http.ResponseWriter, baseURL, model string, temp float64, apiKey string, msgs []map[string]any) {
	body := map[string]any{
		"model":       model,
		"messages":    msgs,
		"temperature": temp,
		"stream":      true,
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(baseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())
	resp, err := aiHTTPClient().Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(resp.Body)
		httpError(w, resp.StatusCode, string(rb))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		c0, _ := choices[0].(map[string]any)
		delta, _ := c0["delta"].(map[string]any)
		if content, ok := delta["content"].(string); ok && content != "" {
			fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "delta", "content": content}))
			if fl != nil {
				fl.Flush()
			}
		}
	}
	fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "done"}))
	if fl != nil {
		fl.Flush()
	}
}

// streamResponses proxies one OpenAI Responses stream as our SSE envelope.
func (s *Server) streamResponses(w http.ResponseWriter, baseURL, model string, temp float64, apiKey, instructions string, input any) {
	inArr, ok := input.([]map[string]any)
	if !ok {
		if single, ok := input.(map[string]any); ok {
			inArr = []map[string]any{single}
		}
	}
	body := map[string]any{
		"model":        model,
		"instructions": instructions,
		"input":        inArr,
		"temperature":  temp,
		"stream":       true,
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(baseURL, "/") + "/responses"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())
	resp, err := aiHTTPClient().Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(resp.Body)
		httpError(w, resp.StatusCode, string(rb))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var evt map[string]any
		if err := json.Unmarshal([]byte(data), &evt); err != nil {
			continue
		}
		if evt["type"] == "response.output_text.delta" {
			if delta, ok := evt["delta"].(string); ok && delta != "" {
				fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "delta", "content": delta}))
				if fl != nil {
					fl.Flush()
				}
			}
		}
	}
	fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "done"}))
	if fl != nil {
		fl.Flush()
	}
}

// ---- prompts: how the in-app agent behaves ----
//
// Shaped after OpenChamber/OpenCode session goals: the agent works toward a
// stated outcome (goal → plan → act → verify → report), asks instead of
// guessing when a critical detail is missing, and always proposes the next
// sensible actions rather than going silent.

// aiBasePrompt is shared by chat, runs and generation: identity, date,
// language and output shape.
func aiBasePrompt() string {
	now := time.Now()
	return "You are Salt, the in-app AI of salt.md — a collaborative docs/databases workspace.\n" +
		"Today is " + now.Format("2006-01-02") + " (" + now.Format("Monday") + ").\n" +
		"Reply in the user's language: match the language of their last message.\n" +
		"Be concise. Use Markdown (GFM: headings, bold, lists, tables, fenced code blocks)."
}

// aiWorkspaceRulesBlock injects the workspace's working conventions (the same
// rules external MCP agents get). Resolved from the thread first, then the
// page — threads created before workspaces were stored only carry the page.
func (s *Server) aiWorkspaceRulesBlock(pageID, threadWS string) string {
	wsID := threadWS
	if wsID == "" && pageID != "" {
		if p, err := s.getPage(pageID); err == nil {
			wsID = p.WorkspaceID
		}
	}
	if wsID == "" {
		return ""
	}
	var rules string
	if err := s.db.QueryRow(`SELECT rules FROM workspaces WHERE id = ?`, wsID).Scan(&rules); err != nil || rules == "" {
		return ""
	}
	return wrapWorkspaceRules(rules)
}

// aiAgentSystemPrompt is the goal-oriented loop: plan, explore, act small,
// verify by reading back, report — and ask instead of guessing.
func aiAgentSystemPrompt(today string) string {
	return "You are Salt, an AI agent inside salt.md — a collaborative docs/databases workspace. " +
		"Today is " + today + ". Reply in the user's language.\n" +
		"Work in a goal-directed loop, like an engineer, not a chatbot:\n" +
		"1. PLAN first: restate the goal and what 'done' means in one or two lines, then list the concrete steps. Keep it short.\n" +
		"2. EXPLORE before acting: never guess ids, titles or structure — search, list and read first (list, search, get_page, query_rows). One read to confirm beats one wrong write.\n" +
		"3. ACT with the smallest sufficient change. Prefer creating over deleting; never delete, trash, share or move anything unless the task explicitly says so.\n" +
		"4. VERIFY what you changed: read it back (get_page / query_rows) before reporting success.\n" +
		"5. REPORT: what changed (reference every created page as a Markdown link [title](/p/id)), what you verified, and what is still open. " +
		"ALWAYS end with a short message to the user, even when there is nothing to report (for example the task was only to put text into a document): say what you did in a few words, like 'Done, inserted'. Never finish with an empty reply.\n" +
		"If the task is ambiguous or a critical detail is missing (e.g. target language, which database, which rows), do NOT guess and do NOT stall: " +
		"ask through the ask_user tool instead — strictly ONE single question per call, with 2-4 concrete selectable answers in 'options' (never put a question as an option label, never combine two questions in one call, and never add an 'other' option since the UI always provides a free-text input). The UI lets the user pick several options at once, so set 'multiple': true when more than one answer is valid. " +
		"When 'Currently open page in the editor' is present below, phrases like 'this page', 'current page', or 'this collection' ALREADY refer to that page id — read it directly with get_page / query_rows and NEVER ask which page.\n" +
		"Plain-text questions stall the run; ask_user pauses it and resumes with the answer. Only put questions in your final summary when no safe step exists at all.\n" +
		"Resolve relative dates (today, next week) against today yourself, in ISO format.\n" +
		"Keep tool arguments small: prefer limit 20 or less and narrow queries."
}

// aiThreadHistory returns the thread's recent messages, truncated, so a run
// continues the conversation: the user's answers to the agent's questions,
// corrections, and follow-ups.
func (s *Server) aiThreadHistory(threadID, excludeMsgID string, limit int) [][2]string {
	var rows *sql.Rows
	var err error
	if excludeMsgID != "" {
		rows, err = s.db.Query(`SELECT role, content FROM ai_messages WHERE thread_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?`, threadID, excludeMsgID, limit)
	} else {
		rows, err = s.db.Query(`SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`, threadID, limit)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	var rev [][2]string
	for rows.Next() {
		var role, content string
		rows.Scan(&role, &content)
		if len(content) > 1500 {
			content = content[:1500] + "…"
		}
		rev = append(rev, [2]string{role, content})
	}
	// chronological order
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

// ---- runs (background agent) minimal ----

type aiRun struct {
	ID          string `json:"id"`
	UserID      string `json:"userId"`
	ThreadID    string `json:"threadId"`
	Status      string `json:"status"`
	Task        string `json:"task"`
	Plan        string `json:"plan"`
	Progress    string `json:"progress"`
	Error       string `json:"error"`
	PendingTool string `json:"pendingTool"`
	PendingArgs string `json:"pendingArgs"`
	StartedAt   string `json:"startedAt"`
	FinishedAt  string `json:"finishedAt"`
}

var runMu sync.Mutex
var runCancel = map[string]context.CancelFunc{}

func (s *Server) handleCreateAIRun(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI disabled")
		return
	}
	var body struct {
		ThreadID string `json:"threadId"`
		Task     string `json:"task"`
		Prompt   string `json:"prompt"`
		Retry    bool   `json:"retry"`
		PageID   string `json:"pageId"`
	}
	decodeJSON(w, r, &body)
	if strings.TrimSpace(body.Task) == "" {
		httpError(w, 400, "task required")
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		prompt = strings.TrimSpace(body.Task)
	}
	threadID := body.ThreadID
	if threadID == "" {
		threadID = newID()
		wsID := ""
		if body.PageID != "" {
			if p, err := s.getPage(body.PageID); err == nil {
				wsID = p.WorkspaceID
			}
		}
		s.db.Exec(`INSERT INTO ai_threads (id, user_id, workspace_id, page_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
			threadID, u.ID, wsID, body.PageID, prompt, now(), now())
	}
	var userMsgID string
	if body.Retry {
		s.db.QueryRow(`SELECT id FROM ai_messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`, threadID).Scan(&userMsgID)
	}
	if userMsgID == "" {
		userMsgID = newID()
		s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)`,
			userMsgID, threadID, "user", prompt, "", now())
	}
	runID := newID()
	s.db.Exec(`INSERT INTO ai_runs (id, user_id, thread_id, status, task, started_at) VALUES (?,?,?,?,?,?)`,
		runID, u.ID, threadID, "queued", body.Task, now())
	// launch
	go s.runAIBackground(u, runID, threadID, body.Task, body.PageID, userMsgID)
	writeJSON(w, map[string]string{"id": runID, "threadId": threadID})
}

func (s *Server) runAIBackground(u *user, runID, threadID, task, pageID, userMsgID string) {
	ctx, cancel := context.WithCancel(context.Background())
	runMu.Lock()
	runCancel[runID] = cancel
	runMu.Unlock()
	defer func() {
		runMu.Lock()
		delete(runCancel, runID)
		runMu.Unlock()
	}()
	s.db.Exec(`UPDATE ai_runs SET status='running', started_at=? WHERE id=?`, now(), runID)
	// presence
	if pageID != "" {
		s.db.Exec(`INSERT INTO agent_presence (page_id, account_id, agent, label, note, started_at, last_seen) VALUES (?,?,?,?,?,?,?)
			ON CONFLICT(page_id, account_id, agent) DO UPDATE SET last_seen=excluded.last_seen`,
			pageID, u.ID, "salt-ai", "AI agent", task, now(), now())
		defer s.db.Exec(`DELETE FROM agent_presence WHERE page_id=? AND account_id=? AND agent='salt-ai'`, pageID, u.ID)
	}
	baseURL, model, format, temp, apiKey, approvalMode, err := s.resolveAIConfig(u)
	if err != nil {
		s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
		s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
		return
	}
	// Build OpenAI tool list from MCP catalogue.
	tools := make([]map[string]any, 0, len(mcpTools))
	for _, t := range mcpTools {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t["name"],
				"description": t["description"],
				"parameters":  t["inputSchema"],
			},
		})
	}
	for _, t := range aiAgentExtraTools {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t["name"],
				"description": t["description"],
				"parameters":  t["inputSchema"],
			},
		})
	}
	today := time.Now().Format("2006-01-02")
	sys := aiAgentSystemPrompt(today)
	if pageID != "" {
		if p, err := s.getPage(pageID); err == nil {
			sys += fmt.Sprintf("\nCurrently open page in the editor (when the user says 'this page', 'current page', or 'this collection', it always refers to this page — do NOT ask which page): id=%s, type=%s, title=%q", p.ID, p.Type, p.Title)
		}
	}
	var threadWS string
	s.db.QueryRow(`SELECT workspace_id FROM ai_threads WHERE id = ?`, threadID).Scan(&threadWS)
	sys += s.aiWorkspaceRulesBlock(pageID, threadWS)
	if format == "responses" {
		s.runAIBackgroundResponses(ctx, u, runID, threadID, task, pageID, baseURL, model, temp, apiKey, approvalMode, sys, userMsgID)
		return
	}
	messages := []map[string]any{
		{"role": "system", "content": sys},
	}
	for _, h := range s.aiThreadHistory(threadID, userMsgID, 8) {
		messages = append(messages, map[string]any{"role": h[0], "content": h[1]})
	}
	messages = append(messages, map[string]any{"role": "user", "content": task})
	client := aiHTTPClient()
	var finalContent string
	rejected := false
	s.aiAddStep(runID, threadID, u.ID, "thinking", "Planning", task, "running")
	for iter := 0; iter < 20; iter++ {
		select {
		case <-ctx.Done():
			s.db.Exec(`UPDATE ai_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runID)
			return
		default:
		}
		body := map[string]any{
			"model":       model,
			"messages":    messages,
			"temperature": temp,
			"stream":      false,
			"tools":       tools,
		}
		b, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("x-opencode-session", newID())
		resp, err := client.Do(req)
		if err != nil {
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		rb, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, string(rb), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		var out map[string]any
		json.Unmarshal(rb, &out)
		choices, _ := out["choices"].([]any)
		if len(choices) == 0 {
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, "no choices", now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		c0, _ := choices[0].(map[string]any)
		msg, _ := c0["message"].(map[string]any)
		// tool calls?
		if tcs, ok := msg["tool_calls"].([]any); ok && len(tcs) > 0 {
			messages = append(messages, msg)
			stopped := false
			for _, tc := range tcs {
				tcm, _ := tc.(map[string]any)
				id, _ := tcm["id"].(string)
				fn, _ := tcm["function"].(map[string]any)
				name, _ := fn["name"].(string)
				argsStr, _ := fn["arguments"].(string)
				if name == "ask_user" {
					answer, ok := s.aiAskUser(ctx, u, runID, threadID, argsStr)
					if !ok {
						finalContent = "Stopped: the user did not answer the question."
						rejected = true
						stopped = true
						break
					}
					s.db.Exec(`UPDATE ai_runs SET progress=? WHERE id=?`, "user answered", runID)
					messages = append(messages, map[string]any{
						"role":         "tool",
						"tool_call_id": id,
						"content":      answer,
					})
					continue
				}
				if !s.aiGateToolCall(ctx, u, runID, threadID, name, argsStr, approvalMode) {
					finalContent = "Stopped: the action was not approved."
					rejected = true
					stopped = true
					break
				}
				s.db.Exec(`UPDATE ai_runs SET progress=? WHERE id=?`, "calling "+name, runID)
				s.aiAddStep(runID, threadID, u.ID, "tool_call", "Script · "+name, argsStr, "running")
				var args json.RawMessage = json.RawMessage(argsStr)
				if len(args) == 0 {
					args = json.RawMessage("{}")
				}
				result, err := s.mcpCall(u, name, args, "")
				if err != nil {
					result = "error: " + err.Error()
				}
				s.aiAddStep(runID, threadID, u.ID, "tool_result", "Result · "+name, result, "done")
				s.aiRecordArtifacts(runID, name, result)

				messages = append(messages, map[string]any{
					"role":         "tool",
					"tool_call_id": id,
					"content":      result,
				})
			}
			if stopped {
				break
			}
			continue
		}
		if content, ok := msg["content"].(string); ok {
			finalContent = content
		}
		break
	}
	s.aiAddStep(runID, threadID, u.ID, "thinking", "Done", finalContent, "done")
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)`,
		newID(), threadID, "assistant", finalContent, model, now())
	if rejected {
		s.db.Exec(`UPDATE ai_runs SET status='cancelled', progress='rejected', finished_at=? WHERE id=?`, now(), runID)
	} else {
		s.db.Exec(`UPDATE ai_runs SET status='completed', progress='done', finished_at=? WHERE id=?`, now(), runID)
	}
	s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
	if pageID != "" {
		s.db.Exec(`DELETE FROM agent_presence WHERE page_id=? AND account_id=? AND agent='salt-ai'`, pageID, u.ID)
	}
}

func (s *Server) handleGetAIRun(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var run aiRun
	var threadID string
	err := s.db.QueryRow(`SELECT id, user_id, thread_id, status, task, plan, progress, error, pending_tool, pending_args, started_at, finished_at FROM ai_runs WHERE id=?`, id).Scan(
		&run.ID, &run.UserID, &threadID, &run.Status, &run.Task, &run.Plan, &run.Progress, &run.Error, &run.PendingTool, &run.PendingArgs, &run.StartedAt, &run.FinishedAt)
	if err != nil || run.UserID != u.ID {
		httpError(w, 404, "not found")
		return
	}
	run.ThreadID = threadID
	writeJSON(w, run)
}

func (s *Server) handleCancelAIRun(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var userID string
	s.db.QueryRow(`SELECT user_id FROM ai_runs WHERE id=?`, id).Scan(&userID)
	if userID != u.ID {
		httpError(w, 404, "not found")
		return
	}
	runMu.Lock()
	if c, ok := runCancel[id]; ok {
		c()
	}
	runMu.Unlock()
	s.db.Exec(`UPDATE ai_runs SET cancel_requested=1 WHERE id=?`, id)
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- attachments ----

func (s *Server) handleUploadAIAttachment(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	// reuse multipart file
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpError(w, 400, "file required")
		return
	}
	defer file.Close()
	data, _ := io.ReadAll(file)
	threadID := r.FormValue("threadId")
	// save file
	fname := newID() + filepath.Ext(hdr.Filename)
	os.WriteFile(filepath.Join(s.dataDir, "files", fname), data, 0o644)
	s.db.Exec(`INSERT INTO files (file_name, display_name, ext, size, created_at) VALUES (?,?,?,?,?)`,
		fname, hdr.Filename, filepath.Ext(hdr.Filename), len(data), now())
	// extract text (best effort)
	text := ""
	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	switch ext {
	case ".txt", ".md", ".csv", ".json":
		text = string(data)
	case ".pdf":
		// Best-effort: use pdftotext if present on the host.
		tmp, _ := os.CreateTemp("", "salt-ai-*.pdf")
		if tmp != nil {
			tmp.Write(data)
			tmp.Close()
			if out, err := exec.Command("pdftotext", "-layout", tmp.Name(), "-").Output(); err == nil {
				text = string(out)
			}
			os.Remove(tmp.Name())
		}
	}
	attID := newID()
	status := "done"
	if text == "" && ext == ".pdf" {
		status = "unsupported"
	}
	// Cap what travels back to the browser; the full text stays in the DB.
	preview := text
	if len(preview) > 8000 {
		preview = preview[:8000] + "…"
	}
	s.db.Exec(`INSERT INTO ai_attachments (id, user_id, thread_id, file_name, extracted_text, status, created_at) VALUES (?,?,?,?,?,?,?)`,
		attID, u.ID, threadID, fname, text, status, now())
	writeJSON(w, map[string]any{"id": attID, "fileName": hdr.Filename, "status": status, "textLength": len(text), "text": preview})
}

// ---- admin settings extension (handled in admin.go separately) ----
func (s *Server) aiAdminSettings() map[string]any {
	return map[string]any{
		"aiEnabled":          s.aiEnabled(),
		"aiDefaultBaseUrl":   s.setting("ai_default_base_url", "https://api.openai.com/v1"),
		"aiDefaultModel":     s.setting("ai_default_model", "gpt-4o-mini"),
		"aiAllowInstanceKey": s.setting("ai_allow_instance_key", "0") == "1",
		"aiInstanceKeySet":   s.setting("ai_instance_key_enc", "") != "",
	}
}
