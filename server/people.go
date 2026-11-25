package server

import (
	"net/http"
)

// Account pages: the view behind a person's name.
//
// The roster that a person field prints is enough to pick somebody, but not to
// answer "who is this, what are they up to, and where did they write about
// it". Notion gives every account a page (cover, name, About, recent activity,
// their pages); this is the same idea with what salt.md already knows: the
// profile fields, the workspaces you share, the versions they wrote and the
// pages they own.
//
// Visibility follows the product's own rule: an account is visible to the
// people who work with it. Somebody outside every shared workspace gets the
// same 404 as a page they cannot read — an account id is not a way around the
// permission model. Instance admins can look anyway (that is what the account
// list already gives them).

type personWorkspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type personPage struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
	Type  string `json:"type"`
}

type personActivity struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
	At    string `json:"at"`
}

// sharedWorkspaceIDs lists the workspaces two accounts both belong to.
func (s *Server) sharedWorkspaceIDs(a, b string) []string {
	rows, err := s.db.Query(`SELECT m1.workspace_id FROM workspace_members m1
		JOIN workspace_members m2 ON m2.workspace_id = m1.workspace_id
		WHERE m1.user_id = ? AND m2.user_id = ?`, a, b)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

// personWorkspaceRows reads every membership of an account. Each helper reads
// its result set to the end before returning: the handler then asks canRead,
// which needs the database, and a result set still open next door would hold
// the connection (the pool is small by design).
func (s *Server) personWorkspaceRows(userID string) []personWorkspace {
	rows, err := s.db.Query(`SELECT w.id, w.name, m.role FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? ORDER BY w.name`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []personWorkspace{}
	for rows.Next() {
		var ws personWorkspace
		if rows.Scan(&ws.ID, &ws.Name, &ws.Role) == nil {
			out = append(out, ws)
		}
	}
	return out
}

// personActivityRows: one entry per page (the newest version), because
// "Edited X" on a list means the page, not every save.
func (s *Server) personActivityRows(userID string, limit int) []personActivity {
	rows, err := s.db.Query(`SELECT r.page_id, p.title, p.icon, MAX(r.created_at) AS at
		FROM page_revisions r JOIN pages p ON p.id = r.page_id
		WHERE r.author_id = ? AND p.trashed_at IS NULL
		GROUP BY r.page_id ORDER BY at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []personActivity{}
	for rows.Next() {
		var a personActivity
		if rows.Scan(&a.ID, &a.Title, &a.Icon, &a.At) == nil {
			out = append(out, a)
		}
	}
	return out
}

// personPageRows: top-level pages they own. Rows live inside a database and
// are reached from there, so they are not a person's "pages" here.
func (s *Server) personPageRows(userID string, limit int) []personPage {
	rows, err := s.db.Query(`SELECT id, COALESCE(title, ''), COALESCE(icon, ''), type FROM pages
		WHERE owner_id = ? AND trashed_at IS NULL AND COALESCE(parent_id, '') = '' AND type != 'collection'
		ORDER BY updated_at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []personPage{}
	for rows.Next() {
		var p personPage
		if rows.Scan(&p.ID, &p.Title, &p.Icon, &p.Type) == nil {
			out = append(out, p)
		}
	}
	return out
}

func (s *Server) handlePersonProfile(w http.ResponseWriter, r *http.Request) {
	me := requestUser(r)
	targetID := r.PathValue("id")
	target := s.userByID(targetID)
	if target == nil || target.Disabled {
		httpError(w, http.StatusNotFound, "person not found")
		return
	}
	self := me.ID == targetID
	shared := s.sharedWorkspaceIDs(me.ID, targetID)
	if !self && !me.IsAdmin && len(shared) == 0 {
		httpError(w, http.StatusNotFound, "person not found")
		return
	}
	// Self and admins see the whole membership list; everybody else sees only
	// the workspaces they themselves are in, or the page would hand out the
	// names of areas somebody cannot open.
	visible := map[string]bool{}
	for _, id := range shared {
		visible[id] = true
	}
	workspaces := []personWorkspace{}
	for _, ws := range s.personWorkspaceRows(targetID) {
		if self || me.IsAdmin || visible[ws.ID] {
			workspaces = append(workspaces, ws)
		}
	}

	recent := []personActivity{}
	for _, a := range s.personActivityRows(targetID, 24) {
		if len(recent) >= 10 {
			break
		}
		if s.canRead(me.ID, a.ID) {
			recent = append(recent, a)
		}
	}

	pages := []personPage{}
	for _, p := range s.personPageRows(targetID, 12) {
		if s.canRead(me.ID, p.ID) {
			pages = append(pages, p)
		}
	}

	var handle string
	_ = s.db.QueryRow(`SELECT COALESCE(handle, '') FROM users WHERE id = ?`, targetID).Scan(&handle)

	writeJSON(w, map[string]any{
		"user": map[string]any{
			"id":       target.ID,
			"name":     target.Name,
			"nickname": target.Nickname,
			"about":    target.About,
			"email":    target.Email,
			"color":    target.Color,
			"avatar":   target.Avatar,
			"orgRole":  target.OrgRole,
			"handle":   handle,
		},
		"isYou":      self,
		"workspaces": workspaces,
		"recent":     recent,
		"pages":      pages,
	})
}
