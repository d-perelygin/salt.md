package server

import (
	"database/sql"
	"encoding/json"
	"strings"
)

// A handle is a person's stable, readable name inside process code:
//
//	set "Owner" = @d-perelygin
//
// Why not the display name: a name is an attribute of an account, and people
// change it. Code that names a person by their current name has to be rewritten
// whenever an account is renamed — a fan-out across every database in every
// workspace that mentions them. A handle is assigned once, from the account's
// email, and never derived from the name again. Renaming an account then
// changes one row and touches no code at all.
//
// Handles are unique across the instance (a UNIQUE index), readable (an email
// local part, transliterated), and never reassigned: a new account gets a
// suffix instead of a departed colleague's handle, so old code and old history
// cannot quietly point at a different person.

// handleBase wants the email's local part: "d.perelygin@example.com" becomes
// the handle "d-perelygin", the same mnemonic the person already uses.
func handleBase(email string) string {
	local := email
	if i := strings.IndexByte(local, '@'); i >= 0 {
		local = local[:i]
	}
	// A dot is how people separate their name anyway: d.perelygin reads better
	// as @d-perelygin than as @dperelygin.
	local = strings.ReplaceAll(local, ".", "-")
	base := slugID(local, nil)
	if base == "prop" { // slugID's fallback for a local part it could not spell
		return ""
	}
	return base
}

// assignUserHandles gives every account without one a handle. Idempotent, and
// run at startup before any process code is read: code that already names a
// person by handle must find it.
func assignUserHandles(db *sql.DB) error {
	rows, err := db.Query(`SELECT id, COALESCE(email, '') FROM users WHERE handle = '' ORDER BY created_at`)
	if err != nil {
		return err
	}
	type pending struct{ id, email string }
	var todo []pending
	for rows.Next() {
		var p pending
		if rows.Scan(&p.id, &p.email) == nil {
			todo = append(todo, p)
		}
	}
	rows.Close()
	if len(todo) == 0 {
		return nil
	}
	taken := map[string]bool{}
	hrows, err := db.Query(`SELECT handle FROM users WHERE handle <> ''`)
	if err != nil {
		return err
	}
	for hrows.Next() {
		var h string
		if hrows.Scan(&h) == nil && h != "" {
			taken[h] = true
		}
	}
	hrows.Close()
	for _, p := range todo {
		base := handleBase(p.email)
		if base == "" {
			base = "user-" + p.id[:8]
		}
		h := slugID(base, taken)
		taken[h] = true
		if _, err := db.Exec(`UPDATE users SET handle = ? WHERE id = ?`, h, p.id); err != nil {
			return err
		}
	}
	return nil
}

// assignUserHandle is the write-path form: a new account gets its handle at
// creation, so code written before the next restart can already name it.
func (s *Server) assignUserHandle(id, email string) {
	var n int
	if s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE id = ? AND handle <> ''`, id).Scan(&n) != nil || n > 0 {
		return
	}
	var existing int
	s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE handle <> ''`).Scan(&existing)
	if existing == 0 {
		// Fast path for the first account: no collision to look for.
		base := handleBase(email)
		if base == "" {
			base = "user-" + id[:8]
		}
		s.db.Exec(`UPDATE users SET handle = ? WHERE id = ?`, base, id)
		return
	}
	// Let the backfill decide among the handles already in use.
	_ = assignUserHandles(s.db)
}

// migrateProcessHandles rewrites stored code that names a person by display
// name into the handle form. Idempotent and run on every start: an agent may
// have written a name since, and the cost is one parse per block with code.
func migrateProcessHandles(db *sql.DB) error {
	handles := map[string]string{}
	hrows, err := db.Query(`SELECT id, handle FROM users WHERE handle <> ''`)
	if err != nil {
		return err
	}
	for hrows.Next() {
		var id, h string
		if hrows.Scan(&id, &h) == nil {
			handles[id] = h
		}
	}
	hrows.Close()

	// Members per workspace, with the duplicate names a rewrite must refuse to
	// guess about.
	byWorkspace := map[string][]processMember{}
	rows, err := db.Query(`SELECT m.workspace_id, u.id, u.name
		FROM workspace_members m JOIN users u ON u.id = m.user_id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var ws string
		var m processMember
		if rows.Scan(&ws, &m.id, &m.name) == nil {
			byWorkspace[ws] = append(byWorkspace[ws], m)
		}
	}
	rows.Close()

	type job struct{ pageID, workspaceID, workflow string }
	jobs := []job{}
	crows, err := db.Query(`SELECT c.page_id, COALESCE(p.workspace_id, ''), c.workflow
		FROM collections c JOIN pages p ON p.id = c.page_id
		WHERE c.workflow LIKE '%"code"%'`)
	if err != nil {
		return err
	}
	for crows.Next() {
		var j job
		if crows.Scan(&j.pageID, &j.workspaceID, &j.workflow) == nil {
			jobs = append(jobs, j)
		}
	}
	crows.Close()

	for _, j := range jobs {
		cfg := parseWorkflow(j.workflow)
		if cfg == nil || len(cfg.Code) == 0 {
			continue
		}
		changed := false
		for i := range cfg.Code {
			f, diags := parseWorkflowCode(cfg.Code[i].Source)
			if len(diags) > 0 {
				continue // broken code is already flagged; not ours to rewrite
			}
			members := byWorkspace[j.workspaceID]
			schema := []PropSchema{}
			if raw := workflowSchemaOf(db, j.pageID); raw != "" {
				schema = parseSchemaProps(raw)
			}
			status := PropSchema{}
			for _, p := range schema {
				if p.ID == cfg.StatusPropID {
					status = p
					break
				}
			}
			src, n := rewriteNamesToHandles(cfg.Code[i].Source, f, schema, status, members, handles)
			if n > 0 {
				cfg.Code[i].Source = src
				changed = true
			}
		}
		if !changed {
			continue
		}
		raw, err := jsonMarshalWorkflow(cfg)
		if err != nil {
			continue
		}
		db.Exec(`UPDATE collections SET workflow = ? WHERE page_id = ?`, raw, j.pageID)
	}
	return nil
}

func workflowSchemaOf(db *sql.DB, pageID string) string {
	var schema string
	db.QueryRow(`SELECT schema FROM collections WHERE page_id = ?`, pageID).Scan(&schema)
	return schema
}

func jsonMarshalWorkflow(cfg *workflowConfig) (string, error) {
	b, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// rewriteNamesToHandles replaces the person values a block names by display
// name with their handles. Only an exact, unambiguous match is rewritten: a
// workspace with two people called the same thing keeps the name (the resolver
// refuses that ambiguity too, and the rewriter still handles a rename).
func rewriteNamesToHandles(src string, f *codeFile, schema []PropSchema, status PropSchema, members []processMember, handles map[string]string) (string, int) {
	spans := collectCodeSpans(f, schema, status, codeMembersOfList(members))
	type edit struct {
		start, end int
		repl       string
	}
	byLine := map[int][]edit{}
	n := 0
	for _, sp := range spans {
		if sp.kind != "member" || strings.HasPrefix(sp.text, "@") {
			continue
		}
		var found *processMember
		ambiguous := false
		for i, m := range members {
			if m.name != sp.text {
				continue
			}
			if found != nil {
				ambiguous = true
				break
			}
			found = &members[i]
		}
		if found == nil || ambiguous {
			continue
		}
		h := handles[found.id]
		if h == "" {
			continue
		}
		byLine[sp.line] = append(byLine[sp.line], edit{sp.start, sp.end, "@" + h})
		n++
	}
	if n == 0 {
		return src, 0
	}
	lines := strings.Split(src, "\n")
	for ln, edits := range byLine {
		if ln < 1 || ln > len(lines) {
			continue
		}
		raw := lines[ln-1]
		lead := len(raw) - len(strings.TrimLeft(raw, " "))
		for i := len(edits) - 1; i >= 0; i-- {
			e := edits[i]
			a, b := lead+e.start, lead+e.end
			if a < lead || b > len(raw) || a >= b {
				continue
			}
			raw = raw[:a] + e.repl + raw[b:]
		}
		lines[ln-1] = raw
	}
	return strings.Join(lines, "\n"), n
}

type processMember struct{ id, name string }

func codeMembersOfList(members []processMember) []codeMember {
	out := make([]codeMember, 0, len(members))
	for _, m := range members {
		out = append(out, codeMember{ID: m.id, Name: m.name})
	}
	return out
}
