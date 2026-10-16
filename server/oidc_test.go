package server

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// A stub OpenID provider: discovery, JWKS and a token endpoint that mints an
// ID token signed with the test key. Every URL is loopback http, which the
// server accepts exactly there and nowhere else.
type oidcStub struct {
	t      *testing.T
	key    *rsa.PrivateKey
	url    string
	claims map[string]any
	sign   *rsa.PrivateKey // nil means sign with key
}

func newOIDCStub(t *testing.T, claims map[string]any) *oidcStub {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	st := &oidcStub{t: t, key: key, claims: claims, sign: key}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{
			"issuer":                 st.url,
			"authorization_endpoint": st.url + "/auth",
			"token_endpoint":         st.url + "/token",
			"userinfo_endpoint":      st.url + "/userinfo",
			"jwks_uri":               st.url + "/jwks",
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(st.key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(st.key.E)).Bytes())
		writeJSON(w, map[string]any{"keys": []any{map[string]string{
			"kty": "RSA", "kid": "test-key", "n": n, "e": e,
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{
			"access_token": "stub-access",
			"id_token":     st.mint(),
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	st.url = srv.URL
	return st
}

func (st *oidcStub) mint() string {
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "test-key", "typ": "JWT"})
	claims := map[string]any{
		"iss": st.url, "aud": "salt-client", "exp": time.Now().Add(time.Hour).Unix(),
	}
	for k, v := range st.claims {
		claims[k] = v
	}
	payload, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, st.sign, crypto.SHA256, sum[:])
	if err != nil {
		st.t.Fatalf("sign: %v", err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// configureOIDC points the server at the stub and opens registration so the
// sign-in can provision an account.
func configureOIDC(t *testing.T, s *Server, st *oidcStub) {
	t.Helper()
	s.setSetting("oauth_oidc_issuer", st.url)
	s.setSetting("oauth_oidc_id", "salt-client")
	s.setSetting("oauth_oidc_secret", "stub-secret")
	s.setSetting("signup_mode", "open")
	s.oidcHTTP = &http.Client{Timeout: 10 * time.Second}
}

// oidcCallback runs the callback leg with a forged (but well-formed) state
// cookie and returns the redirect target.
func oidcCallback(t *testing.T, s *Server, code, state string) *http.Response {
	t.Helper()
	tx, _ := json.Marshal(oauthTx{
		Provider: "oidc", State: state, Verifier: "verifier",
		Exp: time.Now().Add(10 * time.Minute).Unix(),
	})
	r := httptest.NewRequest("GET", "/api/oauth/oidc/callback?code="+code+"&state="+state, nil)
	r.AddCookie(&http.Cookie{Name: oauthCookie, Value: b64url(tx)})
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	return rec.Result()
}

func oauthErrorOf(t *testing.T, loc string) string {
	t.Helper()
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("parse redirect %q: %v", loc, err)
	}
	return u.Query().Get("oauthError")
}

func TestOIDCStartRedirectsToDiscoveredIssuer(t *testing.T) {
	s := testServer(t)
	st := newOIDCStub(t, map[string]any{"email": "ada@example.com"})
	configureOIDC(t, s, st)

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/api/oauth/oidc/start", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, st.url+"/auth?") {
		t.Fatalf("redirects to %q, want the stub issuer", loc)
	}
	q, _ := url.ParseQuery(strings.SplitN(loc, "?", 2)[1])
	if q.Get("client_id") != "salt-client" {
		t.Fatalf("client_id = %q", q.Get("client_id"))
	}
	if !strings.HasSuffix(q.Get("redirect_uri"), "/api/oauth/oidc/callback") {
		t.Fatalf("redirect_uri = %q", q.Get("redirect_uri"))
	}
	if q.Get("code_challenge") == "" || q.Get("state") == "" {
		t.Fatal("missing PKCE challenge or state")
	}
}

func TestOIDCCallbackCreatesSession(t *testing.T) {
	s := testServer(t)
	st := newOIDCStub(t, map[string]any{"email": "ada@example.com", "name": "Ada"})
	configureOIDC(t, s, st)

	res := oidcCallback(t, s, "stub-code", "st")
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: %d", res.StatusCode)
	}
	loc, _ := res.Location()
	if loc.Path != "/" {
		t.Fatalf("lands on %q, want /", loc)
	}
	found := false
	for _, c := range res.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			found = true
		}
	}
	if !found {
		t.Fatal("no session cookie")
	}
	var email string
	if err := s.db.QueryRow(`SELECT email FROM users WHERE email = 'ada@example.com'`).Scan(&email); err != nil {
		t.Fatalf("account was not provisioned: %v", err)
	}
}

func TestOIDCCallbackRejectsBadSignature(t *testing.T) {
	s := testServer(t)
	st := newOIDCStub(t, map[string]any{"email": "mallory@example.com"})
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	st.sign = other // minted with a key the JWKS never names
	configureOIDC(t, s, st)

	res := oidcCallback(t, s, "stub-code", "st")
	loc, _ := res.Location()
	if got := oauthErrorOf(t, loc.String()); got != "oauth_failed" {
		t.Fatalf("oauthError = %q, want oauth_failed", got)
	}
}

func TestOIDCCallbackRejectsWrongAudience(t *testing.T) {
	s := testServer(t)
	st := newOIDCStub(t, map[string]any{"email": "ada@example.com", "aud": "someone-else"})
	configureOIDC(t, s, st)

	res := oidcCallback(t, s, "stub-code", "st")
	loc, _ := res.Location()
	if got := oauthErrorOf(t, loc.String()); got != "oauth_failed" {
		t.Fatalf("oauthError = %q, want oauth_failed", got)
	}
}

func TestOIDCCallbackRejectsExpiredToken(t *testing.T) {
	s := testServer(t)
	st := newOIDCStub(t, map[string]any{
		"email": "ada@example.com", "exp": time.Now().Add(-time.Hour).Unix(),
	})
	configureOIDC(t, s, st)

	res := oidcCallback(t, s, "stub-code", "st")
	loc, _ := res.Location()
	if got := oauthErrorOf(t, loc.String()); got != "oauth_failed" {
		t.Fatalf("oauthError = %q, want oauth_failed", got)
	}
}

func TestOIDCCallbackRejectsUnverifiedEmail(t *testing.T) {
	s := testServer(t)
	st := newOIDCStub(t, map[string]any{"email": "ada@example.com", "email_verified": false})
	configureOIDC(t, s, st)

	res := oidcCallback(t, s, "stub-code", "st")
	loc, _ := res.Location()
	if got := oauthErrorOf(t, loc.String()); got != "oauth_unverified_email" {
		t.Fatalf("oauthError = %q, want oauth_unverified_email", got)
	}
}

func TestOIDCStartFailsWhenIssuerIsDown(t *testing.T) {
	s := testServer(t)
	s.setSetting("oauth_oidc_issuer", "http://127.0.0.1:1")
	s.setSetting("oauth_oidc_id", "salt-client")
	s.setSetting("oauth_oidc_secret", "stub-secret")

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/api/oauth/oidc/start", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("start: %d", rec.Code)
	}
	loc, _ := url.Parse(rec.Header().Get("Location"))
	if loc.Path != "/" {
		t.Fatalf("redirects to %q, want the login page", loc)
	}
	if got := oauthErrorOf(t, loc.String()); got != "oauth_failed" {
		t.Fatalf("oauthError = %q, want oauth_failed", got)
	}
}

func TestAudienceContainsBothShapes(t *testing.T) {
	str, _ := json.Marshal("salt-client")
	if !audienceContains(str, "salt-client") {
		t.Fatal("single-string aud not accepted")
	}
	if audienceContains(str, "someone-else") {
		t.Fatal("wrong single-string aud accepted")
	}
	list, _ := json.Marshal([]string{"other", "salt-client"})
	if !audienceContains(list, "salt-client") {
		t.Fatal("aud list not accepted")
	}
	if audienceContains(list, "absent") {
		t.Fatal("wrong aud list accepted")
	}
}
