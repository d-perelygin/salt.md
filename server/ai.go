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
	"errors"
	"fmt"
	"io"
	"log"
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

const maxAIResponseBody = 4 << 20

type errRoundTripper struct{ err error }

func (e errRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, e.err
}

type aiTransportKey struct {
	proxyURL      string
	userCustomURL bool
}

var (
	aiTransportMu        sync.Mutex
	aiTransports         = map[aiTransportKey]http.RoundTripper{}
	aiInvalidProxyLogged = map[string]bool{}
)

func aiHTTPTransport(userCustomURL bool) http.RoundTripper {
	proxyRaw := strings.TrimSpace(os.Getenv("AI_PROXY_URL"))
	key := aiTransportKey{proxyURL: proxyRaw, userCustomURL: userCustomURL}

	aiTransportMu.Lock()
	defer aiTransportMu.Unlock()
	if rt, ok := aiTransports[key]; ok {
		return rt
	}

	base := http.DefaultTransport.(*http.Transport).Clone()
	if proxyRaw != "" {
		pu, err := url.Parse(proxyRaw)
		validScheme := err == nil && (pu.Scheme == "http" || pu.Scheme == "https" || pu.Scheme == "socks5" || pu.Scheme == "socks5h")
		if !validScheme || pu.Host == "" || pu.Hostname() == "" {
			if !aiInvalidProxyLogged[proxyRaw] {
				aiInvalidProxyLogged[proxyRaw] = true
				log.Printf("invalid AI_PROXY_URL %q: refusing direct AI egress", proxyRaw)
			}
			rt := errRoundTripper{err: fmt.Errorf("invalid AI_PROXY_URL")}
			aiTransports[key] = rt
			return rt
		}
		base.Proxy = http.ProxyURL(pu)
	}
	if userCustomURL {
		base.DialContext = safeDial
	}
	aiTransports[key] = base
	return base
}

// aiHTTPClient returns an *http.Client for AI provider calls. When AI_PROXY_URL
// is set (e.g. http://mihomo:7890) the request is tunnelled through it; otherwise
// a direct client is used. Other outbound traffic in salt does not use this proxy.
func aiHTTPClient() *http.Client {
	return aiHTTPClientFor(false)
}

func aiHTTPClientFor(userCustomURL bool) *http.Client {
	return &http.Client{
		Timeout:   5 * time.Minute,
		Transport: aiHTTPTransport(userCustomURL),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("AI endpoint must not redirect")
		},
	}
}

// aiEnabledForUser reports whether AI is enabled both globally and for the user.
func (s *Server) aiEnabledForUser(u *user) bool {
	return u != nil && !u.AIDisabled && s.aiEnabled()
}

// aiAuth requires an authenticated user with AI enabled both globally and for their account.
func (s *Server) aiAuth(next http.HandlerFunc) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request) {
		if !s.aiEnabledForUser(requestUser(r)) {
			httpError(w, 403, "AI is disabled")
			return
		}
		next(w, r)
	})
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i] + "…"
		}
		n++
	}
	return s
}

func formatToolStepBody(argsStr, result string) string {
	a := truncateRunes(strings.TrimSpace(argsStr), 800)
	r := truncateRunes(strings.TrimSpace(result), 1200)
	if a == "" {
		return r
	}
	if r == "" {
		return "Args:\n" + a
	}
	return truncateRunes("Args:\n"+a+"\n\nResult:\n"+r, 2000)
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
		norm, err := validateAIBaseURL(*body.BaseURL)
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		bs = norm
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

func validateAIBaseURL(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	norm := normalizeAIBaseURL(raw)
	u, err := url.Parse(norm)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" {
		return "", fmt.Errorf("invalid base URL")
	}
	return norm, nil
}

// resolveAIConfig returns base_url, model, format, temperature, apiKey, approval for a user.
func (s *Server) resolveAIConfig(u *user) (string, string, string, float64, string, string, error) {
	bs, model, format, temp, apiKey, approval, _, err := s.resolveAIConfigWithOrigin(u)
	return bs, model, format, temp, apiKey, approval, err
}

func (s *Server) resolveAIConfigWithOrigin(u *user) (string, string, string, float64, string, string, bool, error) {
	if !s.aiEnabledForUser(u) {
		return "", "", "", 0, "", "", false, fmt.Errorf("AI is disabled")
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
	defBase := normalizeAIBaseURL(s.setting("ai_default_base_url", "https://api.openai.com/v1"))
	rawUserBS := normalizeAIBaseURL(bs)
	userCustomURL := rawUserBS != "" && rawUserBS != defBase
	if rawUserBS != "" {
		bs = rawUserBS
	} else {
		bs = defBase
	}
	bs, err = validateAIBaseURL(bs)
	if err != nil || bs == "" {
		return "", "", "", 0, "", "", userCustomURL, fmt.Errorf("invalid base URL")
	}
	if model == "" {
		model = s.setting("ai_default_model", "gpt-4o-mini")
	}
	key, err := s.aiEncKey()
	if err != nil {
		return "", "", "", 0, "", "", userCustomURL, err
	}
	apiKey, err := decryptSecret(enc, key)
	if err != nil {
		return "", "", "", 0, "", "", userCustomURL, err
	}
	if apiKey == "" && !userCustomURL {
		enc2 := s.setting("ai_instance_key_enc", "")
		if enc2 != "" && (s.setting("ai_allow_instance_key", "0") == "1" || u.IsAdmin) {
			apiKey, _ = decryptSecret(enc2, key)
		}
	}
	if apiKey == "" {
		return "", "", "", 0, "", "", userCustomURL, fmt.Errorf("no API key configured")
	}
	return bs, model, format, temp, apiKey, approval, userCustomURL, nil
}

// ---- threads & messages ----

func (s *Server) handleListAIThreads(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	pageID := r.URL.Query().Get("page_id")
	wsID := r.URL.Query().Get("workspace_id")
	arch := r.URL.Query().Get("archived")
	q := `SELECT t.id, t.user_id, t.workspace_id, t.page_id, t.title, t.created_at, t.updated_at, t.last_read_at,
		COALESCE(p.title, '') AS page_title,
		(SELECT COUNT(*) FROM ai_messages m WHERE m.thread_id = t.id) AS msg_count,
		(SELECT m2.content FROM ai_messages m2 WHERE m2.thread_id = t.id ORDER BY m2.created_at DESC LIMIT 1) AS last_preview,
		(SELECT m3.role FROM ai_messages m3 WHERE m3.thread_id = t.id ORDER BY m3.created_at DESC LIMIT 1) AS last_role,
		EXISTS (SELECT 1 FROM ai_runs r WHERE r.thread_id = t.id) AS has_runs
		FROM ai_threads t LEFT JOIN pages p ON p.id = t.page_id WHERE t.user_id = ? AND t.archived = ?`
	args := []any{u.ID, 0}
	if arch == "1" {
		args[1] = 1
	}
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
			x.LastPreview = truncateRunes(preview.String, 160)
		}
		if lastRole.Valid {
			x.LastRole = lastRole.String
		}
		out = append(out, x)
	}
	rows.Close()
	for i := range out {
		if out[i].PageID != "" && !s.canRead(u.ID, out[i].PageID) {
			out[i].PageTitle = ""
		}
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
	rows, err := s.db.Query(`SELECT r.id, r.status, r.task, r.progress, r.error, r.started_at, r.finished_at, r.artifacts, (SELECT COUNT(*) FROM ai_steps s WHERE s.run_id = r.id) AS step_count FROM ai_runs r WHERE r.thread_id = ? ORDER BY r.started_at ASC`, threadID)
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
		Error     string `json:"error,omitempty"`
		StartedAt string `json:"startedAt"`
		Finished  string `json:"finishedAt"`
		Artifacts string `json:"artifacts"`
		StepCount int    `json:"stepCount"`
	}
	out := []run{}
	for rows.Next() {
		var x run
		rows.Scan(&x.ID, &x.Status, &x.Task, &x.Progress, &x.Error, &x.StartedAt, &x.Finished, &x.Artifacts, &x.StepCount)
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
	if err := decodeJSON(w, r, &body); err != nil && !errors.Is(err, io.EOF) {
		httpError(w, 400, "invalid JSON")
		return
	}
	if body.PageID != "" && !s.canReadReq(r, body.PageID) {
		httpError(w, 404, "not found")
		return
	}
	if body.WorkspaceID != "" && (!s.isMember(u.ID, body.WorkspaceID) || !s.credentialMayEnter(u, body.WorkspaceID)) {
		httpError(w, 404, "not found")
		return
	}
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
	rows, err := s.db.Query(`SELECT id, thread_id, role, content, model, tokens_in, tokens_out, attachments, created_at, COALESCE(run_id,'') FROM ai_messages WHERE thread_id = ? ORDER BY created_at ASC`, threadID)
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
		RunID       string `json:"runId"`
	}
	out := []m{}
	for rows.Next() {
		var x m
		rows.Scan(&x.ID, &x.ThreadID, &x.Role, &x.Content, &x.Model, &x.TokensIn, &x.TokensOut, &x.Attachments, &x.CreatedAt, &x.RunID)
		out = append(out, x)
	}
	writeJSON(w, out)
}

func (s *Server) handleDeleteAIThread(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var owner, pageID string
	if err := s.db.QueryRow(`SELECT user_id, page_id FROM ai_threads WHERE id = ?`, id).Scan(&owner, &pageID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpError(w, 404, "not found")
			return
		}
		httpError(w, 500, err.Error())
		return
	}
	if owner != u.ID {
		httpError(w, 404, "not found")
		return
	}

	var runIDs []string
	if rows, err := s.db.Query(`SELECT id FROM ai_runs WHERE thread_id = ? AND user_id = ?`, id, u.ID); err == nil {
		for rows.Next() {
			var rid string
			if rows.Scan(&rid) == nil {
				runIDs = append(runIDs, rid)
			}
		}
		rows.Close()
	}
	runMu.Lock()
	for _, rid := range runIDs {
		if c, ok := runCancel[rid]; ok {
			c()
		}
	}
	runMu.Unlock()

	var attFiles []string
	if rows, err := s.db.Query(`SELECT file_name FROM ai_attachments WHERE thread_id = ? AND user_id = ?`, id, u.ID); err == nil {
		for rows.Next() {
			var fn string
			if rows.Scan(&fn) == nil && fn != "" {
				attFiles = append(attFiles, fn)
			}
		}
		rows.Close()
	}

	tx, err := s.db.Begin()
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()

	if pageID != "" && len(runIDs) > 0 {
		tx.Exec(`DELETE FROM agent_presence WHERE page_id = ? AND account_id = ? AND agent = 'salt-ai'`, pageID, u.ID)
	}
	tx.Exec(`DELETE FROM ai_steps WHERE thread_id = ? OR run_id IN (SELECT id FROM ai_runs WHERE thread_id = ? AND user_id = ?)`, id, id, u.ID)
	tx.Exec(`DELETE FROM ai_attachments WHERE thread_id = ? AND user_id = ?`, id, u.ID)
	tx.Exec(`DELETE FROM ai_runs WHERE thread_id = ? AND user_id = ?`, id, u.ID)
	tx.Exec(`DELETE FROM ai_messages WHERE thread_id = ?`, id)
	tx.Exec(`DELETE FROM ai_threads WHERE id = ? AND user_id = ?`, id, u.ID)

	var toRemove []string
	for _, fn := range attFiles {
		if filepath.Base(fn) != fn {
			continue
		}
		like := "%" + fn + "%"
		var refs int
		tx.QueryRow(`SELECT
			(SELECT COUNT(*) FROM ai_attachments WHERE file_name = ?) +
			(SELECT COUNT(*) FROM pages WHERE content LIKE ? OR props LIKE ? OR cover LIKE ?) +
			(SELECT COUNT(*) FROM page_revisions WHERE content LIKE ?) +
			(SELECT COUNT(*) FROM comments WHERE body LIKE ?) +
			(SELECT COUNT(*) FROM workspaces WHERE image LIKE ?) +
			(SELECT COUNT(*) FROM users WHERE avatar LIKE ?)`,
			fn, like, like, like, like, like, like, like).Scan(&refs)
		if refs == 0 {
			tx.Exec(`DELETE FROM files WHERE file_name = ?`, fn)
			toRemove = append(toRemove, fn)
		}
	}

	if err := tx.Commit(); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	for _, fn := range toRemove {
		if err := os.Remove(filepath.Join(s.dataDir, "files", fn)); err != nil && !os.IsNotExist(err) {
			log.Printf("remove ai attachment %s: %v", fn, err)
		}
	}
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
	title = truncateRunes(title, 120)
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

// ---- thread titles ----

// autoTitleSlice mirrors the browser's creation title: the first message,
// cut at 40 characters. A thread whose title still equals that slice (or has
// none) was never renamed by a person — safe to re-title from the content.
func autoTitleSlice(content string) string {
	r := []rune(strings.TrimSpace(content))
	if len(r) > 40 {
		r = r[:40]
	}
	return string(r)
}

// aiShortCompletion asks the model for a small non-streamed answer, for
// housekeeping like titles — never for content the user reads as prose.
func (s *Server) aiShortCompletion(baseURL, model, format, apiKey, sys, user string) string {
	client := aiHTTPClient()
	var body map[string]any
	var url string
	if format == "responses" {
		url = strings.TrimRight(baseURL, "/") + "/responses"
		body = map[string]any{
			"model":        model,
			"instructions": sys,
			"input":        user,
			"temperature":  0.3,
			"stream":       false,
		}
	} else {
		url = strings.TrimRight(baseURL, "/") + "/chat/completions"
		body = map[string]any{
			"model":       model,
			"messages":    []any{map[string]any{"role": "system", "content": sys}, map[string]any{"role": "user", "content": user}},
			"temperature": 0.3,
			"stream":      false,
		}
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode >= 300 {
		return ""
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return ""
	}
	var text string
	if format == "responses" {
		if arr, ok := out["output"].([]any); ok {
			for _, it := range arr {
				m, _ := it.(map[string]any)
				if m["type"] != "message" {
					continue
				}
				if content, ok := m["content"].([]any); ok {
					for _, c := range content {
						cm, _ := c.(map[string]any)
						if cm["type"] == "output_text" {
							if t, _ := cm["text"].(string); t != "" {
								text = t
							}
						}
					}
				}
			}
		}
		if text == "" {
			text, _ = out["output_text"].(string)
		}
	} else {
		if arr, ok := out["choices"].([]any); ok && len(arr) > 0 {
			m, _ := arr[0].(map[string]any)
			mm, _ := m["message"].(map[string]any)
			text, _ = mm["content"].(string)
		}
	}
	// One line, no quotes, capped like a manual rename.
	line := strings.TrimSpace(text)
	if i := strings.Index(line, "\n"); i >= 0 {
		line = line[:i]
	}
	line = strings.Trim(strings.TrimSpace(line), "\"'«»„“”")
	r := []rune(line)
	if len(r) > 120 {
		r = r[:120]
	}
	return strings.TrimSpace(string(r))
}

// maybeAutoThreadTitle generates the thread's title from its recent messages.
// With force it always generates; otherwise only when the title is still
// automatic (empty or the creation slice) — never over a manual rename.
func (s *Server) maybeAutoThreadTitle(u *user, threadID string, force bool) (string, bool) {
	var title, owner string
	if err := s.db.QueryRow(`SELECT title, user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&title, &owner); err != nil || owner != u.ID {
		return "", false
	}
	var first string
	s.db.QueryRow(`SELECT content FROM ai_messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`, threadID).Scan(&first)
	if !force && title != "" && title != autoTitleSlice(first) {
		return title, false
	}
	rows, err := s.db.Query(`SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 6`, threadID)
	if err != nil {
		return title, false
	}
	type msg struct{ role, content string }
	msgs := []msg{}
	for rows.Next() {
		var m msg
		if err := rows.Scan(&m.role, &m.content); err == nil {
			msgs = append(msgs, m)
		}
	}
	rows.Close()
	if len(msgs) == 0 {
		return title, false
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	baseURL, model, format, _, apiKey, _, err := s.resolveAIConfig(u)
	if err != nil {
		return title, false
	}
	var b strings.Builder
	for _, m := range msgs {
		t := m.content
		if tr := []rune(t); len(tr) > 500 {
			t = string(tr[:500]) + "…"
		}
		b.WriteString(m.role + ": " + t + "\n")
	}
	next := s.aiShortCompletion(baseURL, model, format, apiKey,
		"You name chats. Reply with only a very short title (max 6 words, no quotes, no trailing period), in the same language as the conversation.",
		b.String())
	if next == "" {
		return title, false
	}
	s.db.Exec(`UPDATE ai_threads SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`, next, now(), threadID, u.ID)
	return next, true
}

func (s *Server) handleGenerateAIThreadTitle(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	id := r.PathValue("id")
	var body struct {
		Force bool `json:"force"`
	}
	_ = decodeJSON(w, r, &body)
	title, generated := s.maybeAutoThreadTitle(u, id, body.Force)
	if title == "" {
		var owner string
		s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, id).Scan(&owner)
		if owner != u.ID {
			httpError(w, 404, "not found")
			return
		}
	}
	writeJSON(w, map[string]any{"title": title, "generated": generated})
}

// Mark a thread read up to now (clears the unread dot).
// Archive (or restore) a thread. Archived chats leave every list but stay
// readable, restorable and searchable by their owner.
func (s *Server) handleArchiveAIThread(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	id := r.PathValue("id")
	var body struct {
		Archived bool `json:"archived"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	v := 0
	if body.Archived {
		v = 1
	}
	res, err := s.db.Exec(`UPDATE ai_threads SET archived = ?, updated_at = ? WHERE id = ? AND user_id = ?`, v, now(), id, u.ID)
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
		txt := truncateRunes(f.Text, 4000)
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
		txt := truncateRunes(string(b), 4000)
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
	if req.PageID != "" && !s.canReadReq(r, req.PageID) {
		httpError(w, 404, "not found")
		return
	}
	if req.ThreadID != "" {
		var owner string
		if err := s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, req.ThreadID).Scan(&owner); err != nil || owner != u.ID {
			httpError(w, 404, "not found")
			return
		}
	}
	baseURL, defModel, format, temp, apiKey, _, userCustomURL, err := s.resolveAIConfigWithOrigin(u)
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
		wsID := ""
		if req.PageID != "" {
			if p, err := s.getPage(req.PageID); err == nil {
				wsID = p.WorkspaceID
			}
		}
		s.db.Exec(`INSERT INTO ai_threads (id, user_id, workspace_id, page_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
			threadID, u.ID, wsID, req.PageID, "New chat", now(), now())
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
		s.handleAIChatResponses(w, r, u, req, baseURL, model, temp, apiKey, threadID, userCustomURL)
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
				txt := truncateRunes(string(b), 8000)
				sys += "\n\nPage content (JSON blocks):\n" + txt
			}
		}
	}
	sys += s.aiMentionContext(r, req.PageID, req.Mentions)
	sys += aiAttachmentsContext(req.ContextTexts)
	var threadWS string
	if threadID != "" {
		s.db.QueryRow(`SELECT workspace_id FROM ai_threads WHERE id = ?`, threadID).Scan(&threadWS)
		if threadWS != "" && !s.isMember(u.ID, threadWS) {
			threadWS = ""
		}
	}
	sys += s.aiWorkspaceRulesBlock(req.PageID, threadWS)
	sys += s.aiMemoryBlock(u, threadWS)
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
	httpReq, err := http.NewRequestWithContext(r.Context(), "POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())

	client := aiHTTPClientFor(userCustomURL)
	resp, err := client.Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, maxAIResponseBody))
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
func (s *Server) handleAIChatResponses(w http.ResponseWriter, r *http.Request, u *user, req aiChatRequest, baseURL, model string, temp float64, apiKey, threadID string, userCustomURL bool) {
	if req.PageID != "" && !s.canReadReq(r, req.PageID) {
		httpError(w, 404, "not found")
		return
	}
	if req.ThreadID != "" {
		var owner string
		if err := s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, req.ThreadID).Scan(&owner); err != nil || owner != u.ID {
			httpError(w, 404, "not found")
			return
		}
	}
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
				txt := truncateRunes(string(b), 8000)
				sys += "\n\nPage content (JSON blocks):\n" + txt
			}
		}
	}
	sys += s.aiMentionContext(r, req.PageID, req.Mentions)
	sys += aiAttachmentsContext(req.ContextTexts)
	var threadWS string
	if threadID != "" {
		s.db.QueryRow(`SELECT workspace_id FROM ai_threads WHERE id = ?`, threadID).Scan(&threadWS)
		if threadWS != "" && !s.isMember(u.ID, threadWS) {
			threadWS = ""
		}
	}
	sys += s.aiWorkspaceRulesBlock(req.PageID, threadWS)
	sys += s.aiMemoryBlock(u, threadWS)
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
	httpReq, err := http.NewRequestWithContext(r.Context(), "POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())

	client := aiHTTPClientFor(userCustomURL)
	resp, err := client.Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, maxAIResponseBody))
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
func (s *Server) runAIBackgroundResponses(ctx context.Context, u *user, runID, threadID, task, pageID, baseURL, model string, temp float64, apiKey, approvalMode, sys, userMsgID string, userCustomURL bool) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("ai run %s (responses) panic: %v", runID, rec)
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=? AND status IN ('queued','running','waiting_approval','waiting_user')`,
				fmt.Sprintf("internal error: %v", rec), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
		}
	}()
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
	client := aiHTTPClientFor(userCustomURL)
	var finalContent string
	rejected := false
	planStepID := s.aiAddStep(runID, threadID, u.ID, "thinking", "Planning", task, "running")
	finishPlan := func(status string) {
		if planStepID != "" {
			s.db.Exec(`UPDATE ai_steps SET status=? WHERE id=? AND status='running'`, status, planStepID)
			planStepID = ""
		}
	}
	for iter := 0; iter < 20; iter++ {
		select {
		case <-ctx.Done():
			finishPlan("done")
			s.db.Exec(`UPDATE ai_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runID)
			return
		default:
		}
		if !s.aiEnabledForUser(s.userByID(u.ID)) {
			finishPlan("done")
			s.db.Exec(`UPDATE ai_runs SET status='cancelled', error='AI is disabled', finished_at=? WHERE id=?`, now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
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
		req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(baseURL, "/")+"/responses", bytes.NewReader(b))
		if err != nil {
			finishPlan("error")
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("x-opencode-session", newID())
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				finishPlan("done")
				s.db.Exec(`UPDATE ai_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runID)
			} else {
				finishPlan("error")
				s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
			}
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, maxAIResponseBody))
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			finishPlan("error")
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, string(rb), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		var out map[string]any
		json.Unmarshal(rb, &out)
		finishPlan("done")
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
				if name == "propose_workflow_code" {
					// In-app only: the proposal lives in this server's memory
					// and reaches the open editor through the event stream.
					var spec struct {
						PageID  string `json:"page_id"`
						Source  string `json:"source"`
						Summary string `json:"summary"`
					}
					_ = json.Unmarshal([]byte(argsStr), &spec)
					out, perr := s.aiProposeWorkflowCode(u, spec.PageID, spec.Source, spec.Summary)
					if perr != nil {
						out = "error: " + perr.Error()
					}
					input = append(input, it)
					input = append(input, map[string]any{
						"type":    "function_call_output",
						"call_id": callID,
						"output":  out,
					})
					continue
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
				if !s.aiEnabledForUser(s.userByID(u.ID)) {
					s.db.Exec(`UPDATE ai_runs SET status='cancelled', error='AI is disabled', finished_at=? WHERE id=?`, now(), runID)
					s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
					return
				}
				s.db.Exec(`UPDATE ai_runs SET progress=? WHERE id=?`, "calling "+name, runID)
				stepID := s.aiAddStep(runID, threadID, u.ID, "tool_call", "Script · "+name, argsStr, "running")
				var args json.RawMessage = json.RawMessage(argsStr)
				result, err := s.mcpCall(u, name, args, "")
				stepStatus := "done"
				if err != nil {
					result = "error: " + err.Error()
					stepStatus = "error"
				}
				stepBody := formatToolStepBody(argsStr, result)
				s.db.Exec(`UPDATE ai_steps SET status=?, body=? WHERE id=?`, stepStatus, stepBody, stepID)
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
	finishPlan("done")
	s.aiAddStep(runID, threadID, u.ID, "thinking", "Done", finalContent, "done")
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at, run_id) VALUES (?,?,?,?,?,?,?)`,
		newID(), threadID, "assistant", finalContent, model, now(), runID)
	if rejected {
		s.db.Exec(`UPDATE ai_runs SET status='cancelled', progress='rejected', finished_at=? WHERE id=?`, now(), runID)
	} else {
		s.db.Exec(`UPDATE ai_runs SET status='completed', progress='done', finished_at=? WHERE id=?`, now(), runID)
	}
	s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
	if pageID != "" && s.canRead(u.ID, pageID) {
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
	body = truncateRunes(body, 2000)
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
	seen := map[string]string{}
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
				if cur := x.Status + "|" + x.Body; seen[x.ID] != cur {
					seen[x.ID] = cur
					fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "step", "step": x}))
					if fl != nil {
						fl.Flush()
					}
				}
			}
			rows.Close()
		}
		var status, progress, runErr, pendingTool, pendingArgs string
		err = s.db.QueryRow(`SELECT status, progress, error, pending_tool, pending_args FROM ai_runs WHERE id = ?`, runID).Scan(&status, &progress, &runErr, &pendingTool, &pendingArgs)
		if errors.Is(err, sql.ErrNoRows) {
			fmt.Fprintf(w, "data: %s\n\n", mustJSONStr(map[string]any{"type": "status", "status": "cancelled", "progress": "", "error": "", "pendingTool": "", "pendingArgs": ""}))
			if fl != nil {
				fl.Flush()
			}
			return
		}
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

// ---- runs owned by this process ----

// aiMarkRunLive records that this process owns the run's goroutine. The mark
// is what lets the answer route tell a live question from a leftover: a run row
// says "waiting_user" long after the goroutine that waits for the answer is
// gone, and an answer written into that row reaches nobody.
func (s *Server) aiMarkRunLive(runID string) {
	s.aiLiveMu.Lock()
	s.aiLive[runID] = true
	s.aiLiveMu.Unlock()
}

func (s *Server) aiMarkRunDone(runID string) {
	s.aiLiveMu.Lock()
	delete(s.aiLive, runID)
	s.aiLiveMu.Unlock()
}

func (s *Server) aiRunLive(runID string) bool {
	s.aiLiveMu.Lock()
	defer s.aiLiveMu.Unlock()
	return s.aiLive[runID]
}

// aiInterruptStaleRuns closes every run a previous process left unfinished.
// Nothing can resume one: the goroutine that would read an answer, an approval
// or the next model call lived in that process. Left alone, such a row answers
// "waiting_user" forever, the chat re-offers the same question on every visit,
// and every answer is written into a column no one reads.
func (s *Server) aiInterruptStaleRuns() {
	res, err := s.db.Exec(`UPDATE ai_runs SET status='failed',
		error='The server restarted while this run was working. Start it again.',
		progress='interrupted', finished_at=?, pending_tool='', pending_args='', pending_answer='', approved=0
		WHERE status IN ('queued','running','waiting_approval','waiting_user')`, now())
	if err != nil {
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("ai: closed %d run(s) interrupted by the restart", n)
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
	"update_schema": true, "workspace": true, "set_workflow_code": true,
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
		if err := s.db.QueryRow(`SELECT approved, cancel_requested FROM ai_runs WHERE id = ?`, runID).Scan(&approved, &cancel); errors.Is(err, sql.ErrNoRows) {
			return false
		}
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
		if err := s.db.QueryRow(`SELECT pending_answer, cancel_requested FROM ai_runs WHERE id = ?`, runID).Scan(&answer, &cancel); errors.Is(err, sql.ErrNoRows) {
			return ""
		}
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
	if !s.aiRunLive(id) {
		s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, progress='interrupted', finished_at=?,
			pending_tool='', pending_args='', approved=0 WHERE id=?`,
			"The server restarted while this run was working. Start it again.", now(), id)
		httpError(w, 409, "this run was interrupted by a server restart — start it again")
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
	// A run left "waiting_user" by a previous process has nobody reading the
	// answer: writing it would look like success and change nothing. Say so,
	// and close the row so the question stops coming back.
	if !s.aiRunLive(id) {
		s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, progress='interrupted', finished_at=?,
			pending_tool='', pending_args='', pending_answer='' WHERE id=?`,
			"The server restarted while this run was waiting. Start it again.", now(), id)
		httpError(w, 409, "this run was interrupted by a server restart — start it again")
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
	if req.PageID != "" && !s.canReadReq(r, req.PageID) {
		httpError(w, 404, "not found")
		return
	}
	baseURL, defModel, format, temp, apiKey, _, userCustomURL, err := s.resolveAIConfigWithOrigin(u)
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
				txt := truncateRunes(string(b), 8000)
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
		s.streamResponses(r.Context(), w, baseURL, model, temp, apiKey, sys, map[string]any{"role": "user", "content": userMsg}, userCustomURL)
		return
	}
	msgs := []map[string]any{
		{"role": "system", "content": sys},
		{"role": "user", "content": userMsg},
	}
	s.streamChat(r.Context(), w, baseURL, model, temp, apiKey, msgs, userCustomURL)
}

// streamChat proxies one OpenAI chat-completions stream as our SSE envelope.
func (s *Server) streamChat(ctx context.Context, w http.ResponseWriter, baseURL, model string, temp float64, apiKey string, msgs []map[string]any, userCustomURL bool) {
	body := map[string]any{
		"model":       model,
		"messages":    msgs,
		"temperature": temp,
		"stream":      true,
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(baseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())
	resp, err := aiHTTPClientFor(userCustomURL).Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, maxAIResponseBody))
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
func (s *Server) streamResponses(ctx context.Context, w http.ResponseWriter, baseURL, model string, temp float64, apiKey, instructions string, input any, userCustomURL bool) {
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
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("x-opencode-session", newID())
	resp, err := aiHTTPClientFor(userCustomURL).Do(httpReq)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, maxAIResponseBody))
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
		"ask through the ask_user tool instead — strictly ONE single question per call, with 2-4 concrete selectable answers in 'options' (never put a question as an option label, never combine two questions in one call, and never add an 'other' option since the UI always provides a free-text input). By default the UI is single-select (one click submits), so set 'multiple': true whenever more than one answer could be valid. " +
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
		var cutoff string
		var cutoffRowID int64
		if qErr := s.db.QueryRow(`SELECT created_at, rowid FROM ai_messages WHERE id = ? AND thread_id = ?`, excludeMsgID, threadID).Scan(&cutoff, &cutoffRowID); qErr == nil {
			rows, err = s.db.Query(`SELECT role, content FROM ai_messages WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
				threadID, cutoff, cutoff, cutoffRowID, limit)
		} else {
			rows, err = s.db.Query(`SELECT role, content FROM ai_messages WHERE thread_id = ? AND created_at < (SELECT created_at FROM ai_messages WHERE id = ?) ORDER BY created_at DESC LIMIT ?`,
				threadID, excludeMsgID, limit)
		}
	} else {
		rows, err = s.db.Query(`SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, threadID, limit)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	var rev [][2]string
	for rows.Next() {
		var role, content string
		rows.Scan(&role, &content)
		content = truncateRunes(content, 1500)
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

func (s *Server) cancelAIRunsByQuery(query string, args ...any) {
	rows, err := s.db.Query(query, args...)
	if err == nil {
		var runIDs []string
		for rows.Next() {
			var rid string
			if rows.Scan(&rid) == nil {
				runIDs = append(runIDs, rid)
			}
		}
		rows.Close()
		runMu.Lock()
		for _, rid := range runIDs {
			if c, ok := runCancel[rid]; ok {
				c()
			}
		}
		runMu.Unlock()
	}
}

func (s *Server) cancelAIRunsForUser(userID string) {
	if userID == "" {
		return
	}
	s.cancelAIRunsByQuery(`SELECT id FROM ai_runs WHERE user_id = ? AND status IN ('queued','running','waiting_approval','waiting_user')`, userID)
	s.db.Exec(`UPDATE ai_runs SET cancel_requested=1, status='cancelled', finished_at=? WHERE user_id = ? AND status IN ('queued','running','waiting_approval','waiting_user')`, now(), userID)
	s.db.Exec(`DELETE FROM agent_presence WHERE account_id = ? AND agent = 'salt-ai'`, userID)
}

func (s *Server) cancelAllAIRuns() {
	s.cancelAIRunsByQuery(`SELECT id FROM ai_runs WHERE status IN ('queued','running','waiting_approval','waiting_user')`)
	s.db.Exec(`UPDATE ai_runs SET cancel_requested=1, status='cancelled', finished_at=? WHERE status IN ('queued','running','waiting_approval','waiting_user')`, now())
	s.db.Exec(`DELETE FROM agent_presence WHERE agent = 'salt-ai'`)
}

func (s *Server) handleCreateAIRun(w http.ResponseWriter, r *http.Request) {
	u := requestUser(r)
	if !s.aiEnabledForUser(u) {
		httpError(w, 403, "AI is disabled")
		return
	}
	var body struct {
		ThreadID string `json:"threadId"`
		Task     string `json:"task"`
		Prompt   string `json:"prompt"`
		Retry    bool   `json:"retry"`
		PageID   string `json:"pageId"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Task) == "" {
		httpError(w, 400, "task required")
		return
	}
	if body.PageID != "" && !s.canReadReq(r, body.PageID) {
		httpError(w, 404, "not found")
		return
	}
	threadID := body.ThreadID
	if threadID != "" {
		var owner string
		if err := s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&owner); err != nil || owner != u.ID {
			httpError(w, 404, "not found")
			return
		}
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		prompt = strings.TrimSpace(body.Task)
	}
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
	s.aiMarkRunLive(runID)
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
		s.aiMarkRunDone(runID)
	}()
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("ai run %s panic: %v", runID, rec)
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=? AND status IN ('queued','running','waiting_approval','waiting_user')`,
				fmt.Sprintf("internal error: %v", rec), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
		}
	}()
	s.db.Exec(`UPDATE ai_runs SET status='running', started_at=? WHERE id=?`, now(), runID)
	effectivePageID := pageID
	if effectivePageID != "" && !s.canRead(u.ID, effectivePageID) {
		effectivePageID = ""
	}
	// presence
	if effectivePageID != "" {
		s.db.Exec(`INSERT INTO agent_presence (page_id, account_id, agent, label, note, started_at, last_seen) VALUES (?,?,?,?,?,?,?)
			ON CONFLICT(page_id, account_id, agent) DO UPDATE SET last_seen=excluded.last_seen`,
			effectivePageID, u.ID, "salt-ai", "AI agent", task, now(), now())
		defer s.db.Exec(`DELETE FROM agent_presence WHERE page_id=? AND account_id=? AND agent='salt-ai'`, effectivePageID, u.ID)
	}
	baseURL, model, format, temp, apiKey, approvalMode, userCustomURL, err := s.resolveAIConfigWithOrigin(u)
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
	if effectivePageID != "" {
		if p, err := s.getPage(effectivePageID); err == nil {
			sys += fmt.Sprintf("\nCurrently open page in the editor (when the user says 'this page', 'current page', or 'this collection', it always refers to this page — do NOT ask which page): id=%s, type=%s, title=%q", p.ID, p.Type, p.Title)
		}
	}
	var threadWS string
	s.db.QueryRow(`SELECT workspace_id FROM ai_threads WHERE id = ?`, threadID).Scan(&threadWS)
	if threadWS != "" && !s.isMember(u.ID, threadWS) {
		threadWS = ""
	}
	sys += s.aiWorkspaceRulesBlock(effectivePageID, threadWS)
	sys += s.aiMemoryBlock(u, threadWS)
	if format == "responses" {
		s.runAIBackgroundResponses(ctx, u, runID, threadID, task, effectivePageID, baseURL, model, temp, apiKey, approvalMode, sys, userMsgID, userCustomURL)
		return
	}
	messages := []map[string]any{
		{"role": "system", "content": sys},
	}
	for _, h := range s.aiThreadHistory(threadID, userMsgID, 8) {
		messages = append(messages, map[string]any{"role": h[0], "content": h[1]})
	}
	messages = append(messages, map[string]any{"role": "user", "content": task})
	client := aiHTTPClientFor(userCustomURL)
	var finalContent string
	rejected := false
	planStepID := s.aiAddStep(runID, threadID, u.ID, "thinking", "Planning", task, "running")
	finishPlan := func(status string) {
		if planStepID != "" {
			s.db.Exec(`UPDATE ai_steps SET status=? WHERE id=? AND status='running'`, status, planStepID)
			planStepID = ""
		}
	}
	for iter := 0; iter < 20; iter++ {
		select {
		case <-ctx.Done():
			finishPlan("done")
			s.db.Exec(`UPDATE ai_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runID)
			return
		default:
		}
		if !s.aiEnabledForUser(s.userByID(u.ID)) {
			finishPlan("done")
			s.db.Exec(`UPDATE ai_runs SET status='cancelled', error='AI is disabled', finished_at=? WHERE id=?`, now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		body := map[string]any{
			"model":       model,
			"messages":    messages,
			"temperature": temp,
			"stream":      false,
			"tools":       tools,
		}
		b, _ := json.Marshal(body)
		req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(b))
		if err != nil {
			finishPlan("error")
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("x-opencode-session", newID())
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				finishPlan("done")
				s.db.Exec(`UPDATE ai_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runID)
			} else {
				finishPlan("error")
				s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, err.Error(), now(), runID)
			}
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, maxAIResponseBody))
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			finishPlan("error")
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, string(rb), now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		var out map[string]any
		json.Unmarshal(rb, &out)
		choices, _ := out["choices"].([]any)
		if len(choices) == 0 {
			finishPlan("error")
			s.db.Exec(`UPDATE ai_runs SET status='failed', error=?, finished_at=? WHERE id=?`, "no choices", now(), runID)
			s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
			return
		}
		finishPlan("done")
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
				if name == "propose_workflow_code" {
					// In-app only: the proposal lives in this server's memory
					// and reaches the open editor through the event stream.
					var spec struct {
						PageID  string `json:"page_id"`
						Source  string `json:"source"`
						Summary string `json:"summary"`
					}
					_ = json.Unmarshal([]byte(argsStr), &spec)
					proposal, perr := s.aiProposeWorkflowCode(u, spec.PageID, spec.Source, spec.Summary)
					if perr != nil {
						proposal = "error: " + perr.Error()
					}
					messages = append(messages, map[string]any{
						"role":         "tool",
						"tool_call_id": id,
						"content":      proposal,
					})
					continue
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
				if !s.aiEnabledForUser(s.userByID(u.ID)) {
					s.db.Exec(`UPDATE ai_runs SET status='cancelled', error='AI is disabled', finished_at=? WHERE id=?`, now(), runID)
					s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
					return
				}
				s.db.Exec(`UPDATE ai_runs SET progress=? WHERE id=?`, "calling "+name, runID)
				stepID := s.aiAddStep(runID, threadID, u.ID, "tool_call", "Script · "+name, argsStr, "running")
				var args json.RawMessage = json.RawMessage(argsStr)
				if len(args) == 0 {
					args = json.RawMessage("{}")
				}
				result, err := s.mcpCall(u, name, args, "")
				stepStatus := "done"
				if err != nil {
					result = "error: " + err.Error()
					stepStatus = "error"
				}
				stepBody := formatToolStepBody(argsStr, result)
				s.db.Exec(`UPDATE ai_steps SET status=?, body=? WHERE id=?`, stepStatus, stepBody, stepID)
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
	finishPlan("done")
	s.aiAddStep(runID, threadID, u.ID, "thinking", "Done", finalContent, "done")
	s.db.Exec(`INSERT INTO ai_messages (id, thread_id, role, content, model, created_at, run_id) VALUES (?,?,?,?,?,?,?)`,
		newID(), threadID, "assistant", finalContent, model, now(), runID)
	if rejected {
		s.db.Exec(`UPDATE ai_runs SET status='cancelled', progress='rejected', finished_at=? WHERE id=?`, now(), runID)
	} else {
		s.db.Exec(`UPDATE ai_runs SET status='completed', progress='done', finished_at=? WHERE id=?`, now(), runID)
	}
	s.db.Exec(`UPDATE ai_threads SET updated_at=? WHERE id=?`, now(), threadID)
	if effectivePageID != "" {
		s.db.Exec(`DELETE FROM agent_presence WHERE page_id=? AND account_id=? AND agent='salt-ai'`, effectivePageID, u.ID)
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
	maxUpload := s.maxUploadBytes()
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	maxMem := int64(32 << 20)
	if maxUpload < maxMem {
		maxMem = maxUpload
	}
	if err := r.ParseMultipartForm(maxMem); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) || strings.Contains(err.Error(), "too large") {
			httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large — max %d MB", maxUpload>>20))
		} else {
			httpError(w, 400, err.Error())
		}
		return
	}
	threadID := r.FormValue("threadId")
	if threadID != "" {
		var owner string
		if err := s.db.QueryRow(`SELECT user_id FROM ai_threads WHERE id = ?`, threadID).Scan(&owner); err != nil || owner != u.ID {
			httpError(w, 404, "not found")
			return
		}
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpError(w, 400, "file required")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxUpload+1))
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	if int64(len(data)) > maxUpload {
		httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large — max %d MB", maxUpload>>20))
		return
	}
	// save file
	extRaw := filepath.Ext(filepath.Base(hdr.Filename))
	fname := newID() + extRaw
	saved := filepath.Join(s.dataDir, "files", fname)
	if err := os.WriteFile(saved, data, 0o644); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	s.db.Exec(`INSERT INTO files (file_name, display_name, ext, size, created_at) VALUES (?,?,?,?,?)`,
		fname, filepath.Base(hdr.Filename), extRaw, len(data), now())
	// extract text (best effort) — one extractor for chat and read_page_file
	// (filetext.go), so the two paths cannot disagree about a format again.
	ext := strings.ToLower(extRaw)
	text := extractFileText(data, saved, ext)
	if text == "" && ext == ".pdf" {
		// pdftotext stays as a fallback for PDFs the Go parser cannot read.
		if out, err := exec.Command("pdftotext", "-layout", saved, "-").Output(); err == nil {
			text = string(out)
		}
	}
	attID := newID()
	status := "done"
	if text == "" && !isTextExt(ext) && ext != ".pdf" {
		status = "unsupported"
	}
	// Cap what travels back to the browser; the full text stays in the DB.
	preview := truncateRunes(text, 8000)
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
