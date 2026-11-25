package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Page version history and comments (W13).
//
// The CRDT update log is compacted away, so version history is a SEPARATE,
// materialized snapshot store: whenever a page's content is written (editor
// materialize, API/MCP), we record a throttled snapshot so a user can browse
// and restore prior versions. Comments live in their own table, page- or
// block-scoped, resolvable, and reachable by agents via MCP.

const (
	revisionThrottle = 2 * time.Minute // at most one content snapshot per page per window
	// Property edits are recorded immediately: "the status changed" is the
	// reason somebody opens this list, and a gate in front of it would hide
	// exactly that. A write that changes nothing stores nothing (see
	// snapshotRevisionForced), so a repeated save costs no revision.
	revisionPropsThrottle = 0
	revisionKeep          = 50 // keep the newest N per page
)

// snapshotRevision records the page's current title+content as a revision,
// unless the newest revision is younger than the content throttle. Best-effort:
// history is a convenience, never blocks the write path.
func (s *Server) snapshotRevision(pageID, authorID, authorName string) {
	s.snapshotRevisionWithin(pageID, authorID, authorName, revisionThrottle)
}

// snapshotRevisionProps records a property write on its own short throttle.
func (s *Server) snapshotRevisionProps(pageID, authorID, authorName string) {
	s.snapshotRevisionWithin(pageID, authorID, authorName, revisionPropsThrottle)
}

func (s *Server) snapshotRevisionWithin(pageID, authorID, authorName string, gap time.Duration) {
	var last string
	if s.db.QueryRow(`SELECT created_at FROM page_revisions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`, pageID).Scan(&last) == nil {
		if t, err := time.Parse(time.RFC3339Nano, last); err == nil && time.Since(t) < gap {
			return
		}
	}
	s.snapshotRevisionForced(pageID, authorID, authorName)
}

// snapshotRevisionForced records the page as it is now, ignoring the throttle,
// and returns the new revision's id ("" when there is nothing worth saving).
//
// The throttle exists so a burst of edits leaves one revision instead of ten.
// It must never apply to the state an OVERWRITE is about to throw away: two
// replaces a minute apart used to keep only the state from before the first,
// and the second one's predecessor was gone — the exact loss that made an agent
// report "replace is destructive without a backup".
func (s *Server) snapshotRevisionForced(pageID, authorID, authorName string) string {
	state := s.readRevisionState(pageID)
	emptyDoc := strings.TrimSpace(state.content) == "" || state.content == "[]"
	emptyProps := strings.TrimSpace(state.props) == "" || state.props == "{}"
	if emptyDoc && emptyProps {
		return "" // a blank document with no properties is not a version
	}
	changes := ""
	if prev, ok := s.latestRevisionState(pageID); ok {
		// A write that changed nothing (a save, a repeated set_properties)
		// must not grow the list with a copy of the state above it.
		if prev.title == state.title && prev.content == state.content &&
			prev.props == state.props && prev.icon == state.icon && prev.cover == state.cover {
			return ""
		}
		changes = s.revisionChanges(pageID, prev, state)
	}
	id := newID()
	if _, err := s.db.Exec(`INSERT INTO page_revisions
		(id, page_id, created_at, author_id, author_name, title, content, props, icon, cover, changes, full)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		id, pageID, now(), authorID, authorName, state.title, state.content, state.props, state.icon, state.cover, changes); err != nil {
		return ""
	}
	// Prune to the newest revisionKeep for this page.
	s.db.Exec(`DELETE FROM page_revisions WHERE page_id = ? AND id NOT IN (
		SELECT id FROM page_revisions WHERE page_id = ? ORDER BY created_at DESC LIMIT ?)`, pageID, pageID, revisionKeep)
	return id
}

func (s *Server) readRevisionState(pageID string) revisionState {
	var st revisionState
	if s.db.QueryRow(`SELECT title, content, props, icon, cover FROM pages WHERE id = ?`, pageID).
		Scan(&st.title, &st.content, &st.props, &st.icon, &st.cover) != nil {
		return revisionState{}
	}
	st.full = true
	return st
}

func (s *Server) latestRevisionState(pageID string) (revisionState, bool) {
	var st revisionState
	var full int
	err := s.db.QueryRow(`SELECT title, content, props, icon, cover, full FROM page_revisions
		WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`, pageID).
		Scan(&st.title, &st.content, &st.props, &st.icon, &st.cover, &full)
	if err != nil {
		return revisionState{}, false
	}
	st.full = full != 0
	return st, true
}

func (s *Server) revisionStateByID(pageID, revID string) (revisionState, bool) {
	var st revisionState
	var full int
	err := s.db.QueryRow(`SELECT title, content, props, icon, cover, full FROM page_revisions
		WHERE id = ? AND page_id = ?`, revID, pageID).
		Scan(&st.title, &st.content, &st.props, &st.icon, &st.cover, &full)
	if err != nil {
		return revisionState{}, false
	}
	st.full = full != 0
	return st, true
}

type revisionJSON struct {
	ID         string           `json:"id"`
	CreatedAt  string           `json:"createdAt"`
	AuthorName string           `json:"authorName"`
	Title      string           `json:"title"`
	Changes    []revisionChange `json:"changes"`
	Excerpt    string           `json:"excerpt"`
}

func (s *Server) handleListRevisions(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	if !s.canReadReq(r, pageID) {
		httpError(w, 404, "page not found")
		return
	}
	rows, err := s.db.Query(`SELECT id, created_at, author_name, title, content, props, icon, cover, changes, full
		FROM page_revisions WHERE page_id = ? ORDER BY created_at DESC`, pageID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type listed struct {
		x  revisionJSON
		st revisionState
	}
	kept := []listed{}
	for rows.Next() {
		var it listed
		var changes string
		var full int
		if err := rows.Scan(&it.x.ID, &it.x.CreatedAt, &it.x.AuthorName, &it.x.Title,
			&it.st.content, &it.st.props, &it.st.icon, &it.st.cover, &changes, &full); err != nil {
			httpError(w, 500, err.Error())
			return
		}
		it.st.title = it.x.Title
		it.st.full = full != 0
		if changes != "" {
			json.Unmarshal([]byte(changes), &it.x.Changes)
		}
		it.x.Excerpt = pageExcerpt(it.st.content, 320)
		kept = append(kept, it)
	}
	// A version written before changes were recorded carries none — but the
	// two states are both here, so the difference can be worked out on the way
	// out instead of leaving every older version saying "Changes were not
	// recorded". That answer is an excuse, not a history: the reader came to
	// see what changed.
	list := []revisionJSON{}
	for i, it := range kept {
		if len(it.x.Changes) == 0 && i+1 < len(kept) {
			if raw := s.revisionChanges(pageID, kept[i+1].st, it.st); raw != "" {
				json.Unmarshal([]byte(raw), &it.x.Changes)
			}
		}
		if it.x.Changes == nil {
			it.x.Changes = []revisionChange{}
		}
		list = append(list, it.x)
	}
	writeJSON(w, list)
}

// handleGetRevision returns a single revision's full state.
func (s *Server) handleGetRevision(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	if !s.canReadReq(r, pageID) {
		httpError(w, 404, "page not found")
		return
	}
	st, ok := s.revisionStateByID(pageID, r.PathValue("revId"))
	if !ok {
		httpError(w, 404, "revision not found")
		return
	}
	var changes string
	s.db.QueryRow(`SELECT changes FROM page_revisions WHERE id = ? AND page_id = ?`, r.PathValue("revId"), pageID).Scan(&changes)
	out := map[string]any{
		"title":      st.title,
		"content":    json.RawMessage(st.content),
		"props":      json.RawMessage(st.props),
		"icon":       st.icon,
		"cover":      st.cover,
		"full":       st.full,
		"excerpt":    pageExcerpt(st.content, 2000),
		"createdAt":  "",
		"authorName": "",
	}
	if changes != "" {
		out["changes"] = json.RawMessage(changes)
	}
	var created, author string
	if s.db.QueryRow(`SELECT created_at, author_name FROM page_revisions WHERE id = ? AND page_id = ?`, r.PathValue("revId"), pageID).Scan(&created, &author) == nil {
		out["createdAt"] = created
		out["authorName"] = author
	}
	writeJSON(w, out)
}

// handleRestoreRevision snapshots the current state (so the restore is itself
// undoable) then overwrites the page with the chosen revision and resets the
// live CRDT doc so open editors reload.
func (s *Server) handleRestoreRevision(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	u := requestUser(r)
	if !s.canWriteReq(r, pageID) {
		httpError(w, 403, "forbidden")
		return
	}
	st, ok := s.revisionStateByID(pageID, r.PathValue("revId"))
	if !ok {
		httpError(w, 404, "revision not found")
		return
	}
	// Capture the pre-restore state first so a restore can be undone. Forced:
	// the throttle must never swallow the state an overwrite throws away.
	s.snapshotRevisionForced(pageID, u.ID, u.Name)
	sets := []string{"title = ?", "content = ?", "updated_at = ?", bumpDocGen}
	args := []any{st.title, st.content, now()}
	// A revision written before properties were captured knows nothing about
	// them; restoring it must not wipe every column of a live row.
	if st.full {
		sets = []string{"title = ?", "content = ?", "props = ?", "icon = ?", "cover = ?", "updated_at = ?", bumpDocGen}
		args = []any{st.title, st.content, st.props, st.icon, st.cover, now()}
	}
	args = append(args, pageID)
	if _, err := s.db.Exec(`UPDATE pages SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	s.reindexPage(pageID)
	s.resetYjsDoc(pageID)
	s.pagesChanged()
	s.rowChanged(pageID)
	writeJSON(w, map[string]bool{"ok": true})
}

// handleCopyRevision writes a chosen version into a NEW page next to the
// original, so a version can be kept or worked from without overwriting what
// is there now. Notion offers exactly this beside Restore.
func (s *Server) handleCopyRevision(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	u := requestUser(r)
	if !s.canWriteReq(r, pageID) {
		httpError(w, 403, "forbidden")
		return
	}
	st, ok := s.revisionStateByID(pageID, r.PathValue("revId"))
	if !ok {
		httpError(w, 404, "revision not found")
		return
	}
	var parentID, workspaceID, visibility string
	var position float64
	if s.db.QueryRow(`SELECT COALESCE(parent_id, ''), workspace_id, visibility, position FROM pages WHERE id = ?`, pageID).
		Scan(&parentID, &workspaceID, &visibility, &position) != nil {
		httpError(w, 404, "page not found")
		return
	}
	// A row's copy lands in the same database, so the caller needs to be able
	// to add rows there.
	if parentID != "" && !s.canWrite(u.ID, parentID) {
		httpError(w, 403, "forbidden")
		return
	}
	var newPos float64
	s.db.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE COALESCE(parent_id, '') = ?`, parentID).Scan(&newPos)
	id := newID()
	props := "{}"
	if st.full && strings.TrimSpace(st.props) != "" {
		props = st.props
	}
	_, err := s.db.Exec(`INSERT INTO pages
		(id, parent_id, title, icon, cover, content, position, created_at, updated_at, type, props, workspace_id, owner_id, visibility)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		// Always a document: a copy of a database's page must not claim to be a
		// database itself, because nothing would answer for its schema.
		id, nullIfEmpty(parentID), st.title, st.icon, st.cover, st.content, newPos, now(), now(), "doc", props, workspaceID, u.ID, visibility)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	s.reindexPage(id)
	s.pagesChanged()
	if parentID != "" {
		s.rowChanged(id)
	}
	writeJSON(w, map[string]any{"id": id, "parentId": parentID})
}

// ---- Comments ----

type commentJSON struct {
	ID         string          `json:"id"`
	BlockID    string          `json:"blockId"`
	AuthorID   string          `json:"authorId"`
	AuthorName string          `json:"authorName"`
	Body       string          `json:"body"`
	CreatedAt  string          `json:"createdAt"`
	ResolvedAt *string         `json:"resolvedAt"`
	Anchor     json.RawMessage `json:"anchor,omitempty"`
	// The author's colour/picture, so the same person looks the same
	// everywhere — the comment column used to roll a colour out of the name
	// that had nothing to do with the real user colour.
	AuthorColor  string `json:"authorColor"`
	AuthorAvatar string `json:"authorAvatar"`
	// The agent that wrote it, when one did. A claim, shown beside the account
	// that vouches for it, exactly as on the note trail.
	Agent      string `json:"agent,omitempty"`
	AgentLabel string `json:"agentLabel,omitempty"`
}

func (s *Server) pageComments(pageID string) ([]commentJSON, error) {
	// LEFT JOIN: the author may be deleted — the comment stays.
	rows, err := s.db.Query(`SELECT c.id, c.block_id, c.author_id, c.author_name, c.body, c.created_at, c.resolved_at, c.anchor,
		COALESCE(u.color, ''), COALESCE(u.avatar, ''), c.agent, c.agent_label
		FROM comments c LEFT JOIN users u ON u.id = c.author_id
		WHERE c.page_id = ? ORDER BY c.created_at`, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []commentJSON{}
	for rows.Next() {
		var c commentJSON
		var resolved sql.NullString
		var anchor string
		if err := rows.Scan(&c.ID, &c.BlockID, &c.AuthorID, &c.AuthorName, &c.Body, &c.CreatedAt, &resolved, &anchor, &c.AuthorColor, &c.AuthorAvatar, &c.Agent, &c.AgentLabel); err != nil {
			return nil, err
		}
		if anchor != "" {
			c.Anchor = json.RawMessage(anchor)
		}
		if resolved.Valid {
			c.ResolvedAt = &resolved.String
		}
		list = append(list, c)
	}
	return list, rows.Err()
}

func (s *Server) handleListComments(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	if !s.canReadReq(r, pageID) {
		httpError(w, 404, "page not found")
		return
	}
	list, err := s.pageComments(pageID)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, list)
}

func (s *Server) handleCreateComment(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	u := requestUser(r)
	if !s.canWriteReq(r, pageID) {
		httpError(w, 403, "forbidden")
		return
	}
	var body struct {
		Body    string          `json:"body"`
		BlockID string          `json:"blockId"`
		Agent   string          `json:"agent"`
		Label   string          `json:"label"`
		Anchor  json.RawMessage `json:"anchor"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		httpError(w, 400, "comment body is required")
		return
	}
	if len([]rune(body.Body)) > maxCommentLen {
		httpError(w, 400, "comment is too long")
		return
	}
	anchor := ""
	var gen *int64
	if len(body.Anchor) > 0 && string(body.Anchor) != "null" {
		var a struct {
			Gen   *int64          `json:"gen"`
			Quote string          `json:"quote"`
			From  json.RawMessage `json:"from"`
			To    json.RawMessage `json:"to"`
		}
		if len(body.Anchor) > 32000 || json.Unmarshal(body.Anchor, &a) != nil || a.Gen == nil || *a.Gen < 0 || *a.Gen > 1<<53-1 || strings.TrimSpace(a.Quote) == "" || len([]rune(a.Quote)) > 2000 || !validCommentPosition(a.From) || !validCommentPosition(a.To) {
			httpError(w, 400, "invalid comment anchor")
			return
		}
		gen = a.Gen
		anchor = string(body.Anchor)
	}
	// A comment that arrives with an API token or a signed-in agent's key came
	// through an agent, whether or not it says which: marked, so the panel
	// does not present it as typed by the person. A browser session cannot
	// claim to be an agent.
	agent, label := "", ""
	if u.TokenKind != "" {
		agent, label = commentAgent(body.Agent, body.Label)
	}
	id := newID()
	result, err := s.db.Exec(`INSERT INTO comments (id, page_id, block_id, author_id, author_name, body, created_at, agent, agent_label, anchor)
		SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM pages WHERE id = ? AND (? IS NULL OR doc_gen = ?)`,
		id, body.BlockID, u.ID, u.Name, strings.TrimSpace(body.Body), now(), agent, label, anchor, pageID, gen, gen)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	if n, err := result.RowsAffected(); err != nil {
		httpError(w, 500, err.Error())
		return
	} else if n == 0 {
		httpErrorCode(w, 409, "comment_anchor_stale", "The page changed. Select the text again.")
		return
	}
	writeJSON(w, map[string]string{"id": id})
}

// commentQuote is the passage a comment was written on. A page comment has none.
func commentQuote(anchor json.RawMessage) string {
	var a struct {
		Quote string `json:"quote"`
	}
	if len(anchor) > 0 {
		json.Unmarshal(anchor, &a)
	}
	return a.Quote
}

// Yjs relative positions name a shared type and, optionally, an item in it.
// Validate their shape here; only the collaborative editor can resolve them.
func validCommentPosition(raw json.RawMessage) bool {
	type itemID struct {
		Client *uint64 `json:"client"`
		Clock  *uint64 `json:"clock"`
	}
	var p struct {
		Type  *itemID `json:"type"`
		TName *string `json:"tname"`
		Item  *itemID `json:"item"`
		Assoc int64   `json:"assoc"`
	}
	validID := func(id *itemID) bool {
		return id != nil && id.Client != nil && id.Clock != nil && *id.Client <= 1<<53-1 && *id.Clock <= 1<<53-1
	}
	return json.Unmarshal(raw, &p) == nil && ((p.Type != nil && p.TName == nil && validID(p.Type)) || (p.Type == nil && p.TName != nil && *p.TName != "")) && (p.Item == nil || validID(p.Item))
}

// commentAgent turns what a caller says about itself into the stored pair,
// the way a note does: a known agent key or "generic", and a label that falls
// back to whatever it called itself.
func commentAgent(agent, label string) (string, string) {
	label = strings.TrimSpace(label)
	if label == "" {
		label = strings.TrimSpace(agent)
	}
	if r := []rune(label); len(r) > 60 {
		label = string(r[:60])
	}
	return normalizeAgent(agent), label
}

// handleResolveComment toggles a comment's resolved state.
func (s *Server) handleResolveComment(w http.ResponseWriter, r *http.Request) {
	commentID := r.PathValue("id")
	var pageID string
	if s.db.QueryRow(`SELECT page_id FROM comments WHERE id = ?`, commentID).Scan(&pageID) != nil {
		httpError(w, 404, "comment not found")
		return
	}
	if !s.canWriteReq(r, pageID) {
		httpError(w, 403, "forbidden")
		return
	}
	var body struct {
		Resolved bool `json:"resolved"`
	}
	decodeJSON(w, r, &body)
	var resolvedAt any
	if body.Resolved {
		resolvedAt = now()
	}
	s.db.Exec(`UPDATE comments SET resolved_at = ? WHERE id = ?`, resolvedAt, commentID)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	commentID := r.PathValue("id")
	var pageID, authorID string
	if s.db.QueryRow(`SELECT page_id, author_id FROM comments WHERE id = ?`, commentID).Scan(&pageID, &authorID) != nil {
		httpError(w, 404, "comment not found")
		return
	}
	// Author or a workspace admin may delete.
	u := requestUser(r)
	var ws string
	s.db.QueryRow(`SELECT workspace_id FROM pages WHERE id = ?`, pageID).Scan(&ws)
	// And the credential has to be allowed into that workspace: the request
	// names a comment, not a page, so no page check covered it, and a token
	// deleted comments wherever its person had written one (delete_comment over
	// MCP had the same hole).
	if !s.credentialMayEnter(u, ws) {
		httpError(w, 404, "comment not found")
		return
	}
	if authorID != u.ID && !s.isWorkspaceAdmin(u.ID, ws) {
		httpError(w, 403, "forbidden")
		return
	}
	s.db.Exec(`DELETE FROM comments WHERE id = ?`, commentID)
	writeJSON(w, map[string]bool{"ok": true})
}

// handleCommentCounts returns the number of OPEN comments per page of a
// workspace, in one go.
//
// Why its own endpoint and not a column in pageMetaCols: the page list is the
// hottest path in the whole application and is loaded on every navigation — a
// JOIN over comments would hang off it permanently, even though the number
// interests only two views (board and page header). Resolved ones do not
// count: a ticked-off thread is no longer an open task, and a counter that
// never goes down gets ignored.
func (s *Server) handleCommentCounts(w http.ResponseWriter, r *http.Request) {
	userID := requestUser(r).ID
	ws := r.URL.Query().Get("workspaceId")
	if ws == "" || !s.isMember(userID, ws) || !s.tokenReachesWorkspace(r, ws) {
		httpError(w, 404, "workspace not found")
		return
	}
	rows, err := s.db.Query(`SELECT c.page_id, COUNT(*) FROM comments c
		JOIN pages p ON p.id = c.page_id
		WHERE p.workspace_id = ? AND p.trashed_at IS NULL AND c.resolved_at IS NULL
		GROUP BY c.page_id`, ws)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	type row struct {
		id string
		n  int
	}
	var list []row
	for rows.Next() {
		var it row
		if err := rows.Scan(&it.id, &it.n); err != nil {
			rows.Close()
			httpError(w, 500, err.Error())
			return
		}
		list = append(list, it)
	}
	rows.Close() // drain first — a single DB connection

	out := map[string]int{}
	for _, it := range list {
		// Other people's private pages must not give themselves away through a counter.
		if s.canRead(userID, it.id) {
			out[it.id] = it.n
		}
	}
	writeJSON(w, out)
}
