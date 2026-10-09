package server

import (
	"net/http"
	"strings"
)

// Restricted pages with direct user grants (fork).
//
// The workspace stays the primary isolation boundary: every check below runs
// only after membership (or a running emergency grant) is established. A page
// with visibility='restricted' then narrows further — readable only by its
// owner, the workspace admins, and explicitly granted members. A grant covers
// the whole subtree until a nested 'restricted' page narrows it again.
//
// Two deliberate limits, matching the workspace role table:
//   - a grant never raises the workspace role: a viewer stays read-only;
//   - an emergency grant (break_glass) reads open pages but not restricted
//     ones, exactly like it never read other people's private pages.

const (
	grantView = "view"
	grantEdit = "edit"
)

// restrictedChain returns the restricted ancestors-or-self of pageID, each
// with its owner and the caller's grant on it ("" when none). Empty when the
// page sits under no restricted node. One query: the ancestor walk plus the
// grant join, so the per-hit cost in search stays a single round trip.
type restrictedNode struct {
	id    string
	owner string
	grant string
}

func (s *Server) restrictedChain(userID, pageID string) []restrictedNode {
	rows, err := s.db.Query(`
		WITH RECURSIVE anc(id, parent_id, visibility, owner_id) AS (
			SELECT id, parent_id, visibility, owner_id FROM pages WHERE id = ?
			UNION
			SELECT p.id, p.parent_id, p.visibility, p.owner_id
			FROM pages p JOIN anc ON p.id = anc.parent_id
		) SELECT anc.id, anc.owner_id, COALESCE(g.access, '')
		FROM anc LEFT JOIN page_grants g
			ON g.page_id = anc.id AND g.user_id = ? AND g.subject_type = 'user'
		WHERE anc.visibility = 'restricted'`, pageID, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []restrictedNode
	for rows.Next() {
		var n restrictedNode
		if rows.Scan(&n.id, &n.owner, &n.grant) == nil {
			out = append(out, n)
		}
	}
	return out
}

// restrictedReadable reports whether userID passes every restricted node on
// the path: owner, workspace admin, or an explicit view-or-edit grant.
func (s *Server) restrictedReadable(userID, pageID, ws string) bool {
	if s.isWorkspaceAdmin(userID, ws) {
		return true
	}
	for _, n := range s.restrictedChain(userID, pageID) {
		if n.owner == userID || n.grant == grantView || n.grant == grantEdit {
			continue
		}
		return false
	}
	return true
}

// restrictedWritable is the write half: owner or an explicit edit grant on
// every restricted node. The workspace role cap (viewer stays read-only) and
// the membership demand live in canWrite, not here.
func (s *Server) restrictedWritable(userID, pageID, ws string) bool {
	if s.isWorkspaceAdmin(userID, ws) {
		return true
	}
	for _, n := range s.restrictedChain(userID, pageID) {
		if n.owner == userID || n.grant == grantEdit {
			continue
		}
		return false
	}
	return true
}

// hasRestrictedInWorkspace reports whether the workspace holds any restricted
// page at all. The SQL filters consult it first so workspaces that never use
// the feature pay nothing — no extra condition, no extra cost.
func (s *Server) hasRestrictedInWorkspace(ws string) bool {
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM pages WHERE workspace_id = ? AND visibility = 'restricted'`, ws).Scan(&n)
	return n > 0
}

// pageGrants lists the user grants on one page, newest last.
type pageGrantJSON struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Access string `json:"access"`
}

func (s *Server) listPageGrants(pageID string) []pageGrantJSON {
	rows, err := s.db.Query(`
		SELECT g.user_id, u.name, u.email, g.access FROM page_grants g
		JOIN users u ON u.id = g.user_id
		WHERE g.page_id = ? AND g.subject_type = 'user' ORDER BY g.created_at`, pageID)
	if err != nil {
		return []pageGrantJSON{}
	}
	defer rows.Close()
	out := []pageGrantJSON{}
	for rows.Next() {
		var g pageGrantJSON
		if rows.Scan(&g.UserID, &g.Name, &g.Email, &g.Access) == nil {
			out = append(out, g)
		}
	}
	return out
}

// canManageShares reports whether userID may read or change the shares of
// pageID: a workspace admin of its workspace, or the page's owner. Sharing is
// content administration for one page — narrower than workspace membership,
// wider than nothing.
func (s *Server) canManageShares(userID, pageID string) bool {
	var ws, owner string
	if err := s.db.QueryRow(`SELECT workspace_id, owner_id FROM pages WHERE id = ?`, pageID).Scan(&ws, &owner); err != nil {
		return false
	}
	if !s.isMember(userID, ws) {
		return false
	}
	return s.isWorkspaceAdmin(userID, ws) || owner == userID
}

// handleListPageShares lists who a restricted page is shared with. Managing
// shares discloses the access list itself, so this is not a membership-wide
// read — only the people who could change it see it.
func (s *Server) handleListPageShares(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	if !s.tokenReachesWorkspace(r, s.pageWorkspace(pageID)) || !s.canManageShares(requestUser(r).ID, pageID) {
		httpError(w, 404, "page not found")
		return
	}
	writeJSON(w, s.listPageGrants(pageID))
}

// handleGrantPageShare gives a workspace member view or edit access to a
// restricted page (upsert). Granting on an open page is refused — there is
// nothing to grant while everyone can already read it; restrict it first.
func (s *Server) handleGrantPageShare(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	me := requestUser(r)
	if !s.tokenReachesWorkspace(r, s.pageWorkspace(pageID)) || !s.canManageShares(me.ID, pageID) {
		httpError(w, 404, "page not found")
		return
	}
	var body struct {
		UserID string `json:"userId"`
		Access string `json:"access"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, 400, "invalid JSON")
		return
	}
	access := strings.ToLower(strings.TrimSpace(body.Access))
	if access != grantView && access != grantEdit {
		httpError(w, 400, "access must be 'view' or 'edit'")
		return
	}
	var ws, vis string
	s.db.QueryRow(`SELECT workspace_id, visibility FROM pages WHERE id = ?`, pageID).Scan(&ws, &vis)
	if vis != "restricted" {
		httpErrorCode(w, 400, "not_restricted", "Only a restricted page can be shared — restrict it first.")
		return
	}
	if s.userByID(body.UserID) == nil || !s.isMember(body.UserID, ws) {
		httpError(w, 404, "user is not a member of this workspace")
		return
	}
	if _, err := s.db.Exec(`INSERT INTO page_grants (page_id, user_id, subject_type, access, created_at)
		VALUES (?, ?, 'user', ?, ?) ON CONFLICT(page_id, user_id, subject_type) DO UPDATE SET access = excluded.access`,
		pageID, body.UserID, access, now()); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	s.audit("human", me.ID, me.Name, "grant_page_share", pageID, ws, access)
	writeJSON(w, map[string]bool{"ok": true})
}

// handleRevokePageShare removes one member's access to a restricted page.
func (s *Server) handleRevokePageShare(w http.ResponseWriter, r *http.Request) {
	pageID := r.PathValue("id")
	target := r.PathValue("userId")
	me := requestUser(r)
	if !s.tokenReachesWorkspace(r, s.pageWorkspace(pageID)) || !s.canManageShares(me.ID, pageID) {
		httpError(w, 404, "page not found")
		return
	}
	if _, err := s.db.Exec(`DELETE FROM page_grants WHERE page_id = ? AND user_id = ? AND subject_type = 'user'`,
		pageID, target); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	s.audit("human", me.ID, me.Name, "revoke_page_share", pageID, s.pageWorkspace(pageID), "")
	writeJSON(w, map[string]bool{"ok": true})
}
