package server

import (
	"html"
	"io/fs"
	"net/http"
)

// Public share viewer (wave 20): /public/{token} renders the shared page as a
// standalone HTML document — no SPA, no JS required. Previously only the JSON
// API existed and the share URL fell through to the app shell, which showed a
// login screen to anonymous visitors. Password-protected shares render a
// minimal form that POSTs back to the same URL.

func sharePasswordForm(token string, wrong bool) string {
	msg := ""
	if wrong {
		msg = `<p style="color:#c4554d">Wrong password.</p>`
	}
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>salt.md — protected page</title><style>` + htmlDocStyle + `</style></head><body>` +
		`<h1>🔒 Protected page</h1><p>This page is protected by a password.</p>` + msg +
		`<form method="post" action="/public/` + html.EscapeString(token) + `">` +
		`<input type="password" name="pw" placeholder="Password" autofocus style="padding:9px 11px;border:1px solid #ddd;border-radius:8px;font-size:15px"> ` +
		`<button type="submit" style="padding:9px 14px;border:none;border-radius:8px;background:#2f7d4f;color:#fff;font-size:15px;cursor:pointer">Open</button>` +
		`</form></body></html>`
}

func (s *Server) handlePublicView(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	password := ""
	submitted := false
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
		r.ParseForm()
		password = r.PostFormValue("pw")
		submitted = true
	}
	pageID, needPW, pwOK, found := s.resolveShare(token, password)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Robots-Tag", "noindex")
	if !found {
		w.WriteHeader(404)
		w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8"><title>salt.md</title><style>` + htmlDocStyle + `</style></head><body><h1>Not found</h1><p>This link is invalid or has expired.</p></body></html>`))
		return
	}
	if needPW && !pwOK {
		if submitted {
			w.WriteHeader(403)
		}
		w.Write([]byte(sharePasswordForm(token, submitted)))
		return
	}
	p, err := s.getPage(pageID)
	if err != nil || p.Trashed {
		w.WriteHeader(404)
		w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8"><title>salt.md</title><style>` + htmlDocStyle + `</style></head><body><h1>Not found</h1></body></html>`))
		return
	}
	if p.Type == "collection" {
		// Collections render in the SPA (PublicCollection) so the public view
		// looks like the in-app collection: same tabs, same boards/tables.
		// Serve the app shell; the password (if any) is asked inside the app.
		// GET without JS still needs something honest rather than a blank page.
		if r.Method == http.MethodPost {
			// A password POST from an old form: fall through to the app shell
			// too — the SPA reads ?pw= or the password dialog.
			http.Redirect(w, r, "/public/"+token, http.StatusSeeOther)
			return
		}
		s.servePublicAppShell(w, r)
		return
	}
	w.Write([]byte(s.pageHTML(p, false, s.printOptionsFor(p))))
}

// servePublicAppShell serves index.html for the public collection viewer.
func (s *Server) servePublicAppShell(w http.ResponseWriter, r *http.Request) {
	if s.dist == nil {
		httpError(w, 500, "frontend not built")
		return
	}
	b, err := fs.ReadFile(s.dist, "index.html")
	if err != nil {
		httpError(w, 500, "frontend not built")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Robots-Tag", "noindex")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}
