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

// The standalone password gate for server-rendered document shares. It
// mirrors the SPA lock dialog (PublicCollection) so a password prompt looks
// the same on every public link: centered card, lock heading, full-width
// password field and green Open button, with a dark mode. Documents keep the
// working no-JS POST flow — only the look matches the app.
func sharePasswordForm(token string, wrong bool) string {
	msg := ""
	if wrong {
		msg = `<p class="pw-error">Wrong password.</p>`
	}
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>salt.md — protected page</title><style>
.pw-page{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1f1d;background:#e9e8e4}
.pw-card{background:#fff;border:1px solid #e3e2df;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:32px;width:100%;max-width:400px}
.pw-head{display:flex;align-items:center;gap:12px;margin:0 0 4px}
.pw-head h1{font-size:1.35em;margin:0;font-weight:700}
.pw-lock{flex:none;width:30px;height:30px;color:#2f7d4f}
.pw-desc{margin:.4em 0 1.2em;color:#5b5b57}
.pw-error{color:#c4554d;margin:.4em 0 1em}
.pw-input{display:block;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d8d7d3;border-radius:8px;font-size:15px;margin-bottom:12px;background:#fff;color:inherit}
.pw-input:focus{outline:2px solid #2f7d4f;outline-offset:-1px;border-color:#2f7d4f}
.pw-btn{display:block;width:100%;padding:10px 14px;border:none;border-radius:8px;background:#2f7d4f;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.pw-btn:hover{background:#276b43}
@media (prefers-color-scheme:dark){
.pw-page{color:#e8e7e3;background:#191918}
.pw-card{background:#222221;border-color:#35352f;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.pw-desc{color:#a5a49e}
.pw-input{background:#191918;border-color:#3d3d37}
}</style></head><body class="pw-page">` +
		`<div class="pw-card"><div class="pw-head">` +
		`<svg class="pw-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>` +
		`<h1>Protected page</h1></div>` +
		`<p class="pw-desc">This page is protected by a password.</p>` + msg +
		`<form method="post" action="/public/` + html.EscapeString(token) + `">` +
		`<input class="pw-input" type="password" name="pw" placeholder="Password" autofocus> ` +
		`<button class="pw-btn" type="submit">Open</button>` +
		`</form></div></body></html>`
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
	p, err := s.getPage(pageID)
	if err != nil || p.Trashed {
		w.WriteHeader(404)
		w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8"><title>salt.md</title><style>` + htmlDocStyle + `</style></head><body><h1>Not found</h1></body></html>`))
		return
	}
	if p.Type == "collection" {
		// Collections render in the SPA (PublicCollection) so the public view
		// looks like the in-app collection: same tabs, same boards/tables.
		// The password (if any) is asked inside the app: the legacy no-JS
		// form below cannot complete the flow for a collection — its POST
		// redirects back to GET and drops the password, so a correct password
		// looped forever. Collections always get the shell, password or not.
		s.servePublicAppShell(w, r)
		return
	}
	if needPW && !pwOK {
		if submitted {
			w.WriteHeader(403)
		}
		w.Write([]byte(sharePasswordForm(token, submitted)))
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
