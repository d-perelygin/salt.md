package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Public file URLs: uploads referenced by a shared document.
//
// /files/ requires a signed-in session (server.go), so a standalone public
// document rendered by handlePublicView showed broken images to anonymous
// readers: its <img src="/files/…"> answered 401. Opening /files/ up is not
// an option — the random names only protect as long as nothing lists them.
//
// Instead a shared page mints per-file capability URLs at render time:
//
//	/public/{token}/files/{name}?exp={unix}&sig={hmac}
//
// The signature binds the token, the file name and the expiry to the share's
// file_key (a random per-share secret in share_links, rotated whenever the
// password changes and gone with the row on unshare). The password itself
// never travels into an <img src> — it would sit in view-source, history and
// logs, and ride along when somebody forwards the saved HTML. A leaked
// signature opens one file until exp, never the share and never the password.
//
// Signatures live at most shareFileURLDays and never past the share's own
// expiry; every page view mints fresh ones, so links rotate on their own.

// shareFileURLDays caps how long a minted file URL stays valid. The share's
// own expiry caps it further (see shareFileScope).
const shareFileURLDays = 30

// shareFileScope returns the signing key and expiry of a live read-share.
// Missing file_key values (shares minted before the column existed) are
// backfilled in place.
func (s *Server) shareFileScope(token string) (key, expiresAt string, found bool) {
	var exp sql.NullString
	var fk sql.NullString
	if err := s.db.QueryRow(`SELECT expires_at, file_key FROM share_links WHERE token_hash = ? AND mode != 'form'`,
		tokenHash(token)).Scan(&exp, &fk); err != nil {
		return "", "", false
	}
	if exp.Valid && exp.String != "" {
		if end, err := time.Parse(time.RFC3339Nano, exp.String); err == nil && time.Now().After(end) {
			s.db.Exec(`DELETE FROM share_links WHERE token_hash = ?`, tokenHash(token))
			return "", "", false
		}
		expiresAt = exp.String
	}
	if fk.Valid && fk.String != "" {
		return fk.String, expiresAt, true
	}
	nk := newID() + newID()
	if _, err := s.db.Exec(`UPDATE share_links SET file_key = ? WHERE token_hash = ?`, nk, tokenHash(token)); err != nil {
		return "", "", false
	}
	return nk, expiresAt, true
}

// rotateShareFileKey replaces a share's signing secret, killing every file
// URL minted before. Called whenever the share password is set, changed or
// removed — the old links must not survive a secret the owner just replaced.
func (s *Server) rotateShareFileKey(pageID string) {
	s.db.Exec(`UPDATE share_links SET file_key = ? WHERE page_id = ? AND mode != 'form'`, newID()+newID(), pageID)
}

func signShareFile(key, token, name string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(key))
	fmt.Fprintf(mac, "%s\n%s\n%d", token, name, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// mintShareFileURL builds one capability URL. shareExpiresAt is the share's
// own expiry in RFC3339Nano ("" = never) and caps the signature lifetime.
func mintShareFileURL(key, token, name, shareExpiresAt string) string {
	exp := time.Now().AddDate(0, 0, shareFileURLDays).Unix()
	if shareExpiresAt != "" {
		if end, err := time.Parse(time.RFC3339Nano, shareExpiresAt); err == nil && end.Unix() < exp {
			exp = end.Unix()
		}
	}
	if exp < time.Now().Unix() {
		return "#"
	}
	return "/public/" + token + "/files/" + name +
		"?exp=" + strconv.FormatInt(exp, 10) + "&amp;sig=" + signShareFile(key, token, name, exp)
}

// publicFileRef matches the generated markup's file references: src="/files/…"
// and href="/files/…". Stored names are newID()+ext, so one path segment of a
// narrow charset; anything else is not ours to rewrite. data: URIs and
// absolute URLs never match — the quote must sit right before /files/.
var publicFileRef = regexp.MustCompile(`"/files/([A-Za-z0-9][A-Za-z0-9._%+-]*)"`)

// rewriteShareFiles swaps every /files/… reference in a rendered public
// document for a signed capability URL. Fail closed: without a key the
// reference becomes "#" rather than a link back behind the login.
func (s *Server) rewriteShareFiles(docHTML, token string) string {
	key, shareExp, found := s.shareFileScope(token)
	if !found {
		return docHTML
	}
	if key == "" {
		return publicFileRef.ReplaceAllString(docHTML, `"#"`)
	}
	return publicFileRef.ReplaceAllStringFunc(docHTML, func(m string) string {
		name := m[len(`"/files/`) : len(m)-1]
		return `"` + mintShareFileURL(key, token, name, shareExp) + `"`
	})
}

// validShareFileName rejects anything that is not one path segment of the
// upload charset. The file server below strips the prefix and serves from the
// files directory, so traversal must already be impossible here.
func validShareFileName(name string) bool {
	if name == "" || name == "." || name == ".." || strings.Contains(name, "..") {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '.' || c == '_' || c == '-' || c == '%' || c == '+') {
			return false
		}
	}
	return true
}

// bareShareFile reports whether a bare page field (icon, cover) is one of our
// uploads rather than an emoji, a data: URI or an external link.
func bareShareFile(v string) (string, bool) {
	if !strings.HasPrefix(v, "/files/") {
		return "", false
	}
	name := strings.TrimPrefix(v, "/files/")
	if name == "" || strings.ContainsAny(name, "/?#") || !validShareFileName(name) {
		return "", false
	}
	return name, true
}

// shareFileAllowlist is the exact set of uploads a share token may serve: the
// files the page's blocks reference, plus an uploaded page icon. Nothing
// else — a token for one page must not become a key to every upload whose
// name somebody guesses. (The cover is not rendered into the public document,
// so it grants nothing.)
func shareFileAllowlist(p *page) map[string]bool {
	allow := map[string]bool{}
	for _, ref := range scanBlocksForFiles(string(p.Content)) {
		if validShareFileName(ref.name) {
			allow[ref.name] = true
		}
	}
	if name, ok := bareShareFile(p.Icon); ok {
		allow[name] = true
	}
	return allow
}

// handlePublicFile serves one upload through a share token. The token IS the
// credential for finding the share, the signature is the proof its page was
// opened legitimately: it binds this file and this expiry to the share's
// secret, which no anonymous reader ever sees. No password, no session, no
// X-Share-Password — an <img> sends none of those.
func (s *Server) handlePublicFile(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	name := r.PathValue("name")
	if !validShareFileName(name) {
		httpError(w, 404, "not found")
		return
	}
	q := r.URL.Query()
	exp, err := strconv.ParseInt(q.Get("exp"), 10, 64)
	sig := q.Get("sig")
	if err != nil || sig == "" || exp < time.Now().Unix() {
		httpError(w, 403, "forbidden")
		return
	}
	var pageID, expiresAt, key string
	var expCol, keyCol sql.NullString
	if err := s.db.QueryRow(`SELECT page_id, expires_at, file_key FROM share_links WHERE token_hash = ? AND mode != 'form'`,
		tokenHash(token)).Scan(&pageID, &expCol, &keyCol); err != nil {
		httpError(w, 404, "not found")
		return
	}
	if expCol.Valid && expCol.String != "" {
		expiresAt = expCol.String
		if end, err := time.Parse(time.RFC3339Nano, expiresAt); err == nil && time.Now().After(end) {
			s.db.Exec(`DELETE FROM share_links WHERE token_hash = ?`, tokenHash(token))
			httpError(w, 404, "not found")
			return
		}
	}
	if !keyCol.Valid || keyCol.String == "" {
		httpError(w, 403, "forbidden")
		return
	}
	key = keyCol.String
	want, err := hex.DecodeString(signShareFile(key, token, name, exp))
	if err != nil {
		httpError(w, 403, "forbidden")
		return
	}
	got, err := hex.DecodeString(sig)
	if err != nil || subtle.ConstantTimeCompare(got, want) != 1 {
		httpError(w, 403, "forbidden")
		return
	}
	p, err := s.getPage(pageID)
	if err != nil || p.Trashed {
		httpError(w, 404, "not found")
		return
	}
	if !shareFileAllowlist(p)[name] {
		httpError(w, 404, "not found")
		return
	}
	f, err := os.Open(filepath.Join(s.dataDir, "files", name))
	if err != nil {
		httpError(w, 404, "not found")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		httpError(w, 404, "not found")
		return
	}
	// Uploads are user-controlled: sandbox them exactly like /files/ so an
	// uploaded .html/.svg can never run scripts on the app origin (stored
	// XSS) — now reachable without signing in, so the sandbox matters more,
	// not less.
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	serveSeekContent(w, r, name, fi.ModTime(), f)
}

// serveSeekContent streams a file with range support. http.ServeContent takes
// an io.ReadSeeker; *os.File already is one.
func serveSeekContent(w http.ResponseWriter, r *http.Request, name string, modtime time.Time, f io.ReadSeeker) {
	http.ServeContent(w, r, name, modtime, f)
}
