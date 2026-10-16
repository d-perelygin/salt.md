package server

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// Generic OpenID Connect login: "Sign in with ..." for any standards-compliant
// provider (Authelia, Keycloak, Authentik, Zitadel, ...), configured by the
// admin with an issuer URL plus a client ID and secret.
//
// This sits beside the two built-in providers in oauth.go and reuses their
// whole flow (PKCE start, state cookie, token exchange, session creation,
// registration policy). The one thing it does NOT share is how the ID token is
// trusted: Google/Microsoft tokens arrive straight from the token endpoint
// over TLS, while a generic issuer is only as good as its signature — so the
// token is verified against the issuer's JWKS here, and never parsed raw.

// ---- settings ----

// oidcIssuer is the configured issuer URL without a trailing slash, or empty
// when no custom provider is set up.
func (s *Server) oidcIssuer() string {
	return strings.TrimRight(strings.TrimSpace(s.setting("oauth_oidc_issuer", "")), "/")
}

// oidcDisplayName is the label on the login button. It defaults to "SSO" so a
// configured issuer always renders something clickable.
func (s *Server) oidcDisplayName() string {
	if n := strings.TrimSpace(s.setting("oauth_oidc_name", "")); n != "" {
		return n
	}
	return "SSO"
}

// oidcConfigured reports whether the admin stored everything a sign-in needs.
func (s *Server) oidcConfigured() bool {
	id := strings.TrimSpace(s.setting("oauth_oidc_id", ""))
	secret := s.setting("oauth_oidc_secret", "")
	return s.oidcIssuer() != "" && id != "" && secret != ""
}

// ---- discovery ----

type oidcEndpoints struct {
	authURL     string
	tokenURL    string
	userinfoURL string
	jwksURL     string
	issuer      string // the issuer these were discovered for
	fetched     time.Time
}

const oidcCacheTTL = time.Hour

// oidcHTTPClient is the client discovery and JWKS fetches go through. Tests
// point it at a stub issuer; every real build leaves it nil.
func (s *Server) oidcHTTPClient() *http.Client {
	if s.oidcHTTP != nil {
		return s.oidcHTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// oidcDiscover resolves the issuer to its endpoints via
// /.well-known/openid-configuration, cached for an hour. Discovery documents
// carry no secrets, so caching them in memory is safe.
func (s *Server) oidcDiscover() (oidcEndpoints, error) {
	issuer := s.oidcIssuer()
	if issuer == "" {
		return oidcEndpoints{}, fmt.Errorf("no issuer configured")
	}
	s.oidcDiscMu.Lock()
	defer s.oidcDiscMu.Unlock()
	if s.oidcDisc != nil && s.oidcDisc.issuer == issuer && time.Since(s.oidcDisc.fetched) < oidcCacheTTL {
		return *s.oidcDisc, nil
	}
	req, err := http.NewRequest("GET", issuer+"/.well-known/openid-configuration", nil)
	if err != nil {
		return oidcEndpoints{}, fmt.Errorf("bad issuer URL")
	}
	resp, err := s.oidcHTTPClient().Do(req)
	if err != nil {
		return oidcEndpoints{}, fmt.Errorf("the identity provider could not be reached")
	}
	defer resp.Body.Close()
	var doc struct {
		Issuer                string `json:"issuer"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserinfoEndpoint      string `json:"userinfo_endpoint"`
		JWKSURI               string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc); err != nil {
		return oidcEndpoints{}, fmt.Errorf("the identity provider sent an unreadable discovery document")
	}
	if strings.TrimRight(doc.Issuer, "/") != issuer {
		return oidcEndpoints{}, fmt.Errorf("the identity provider names a different issuer")
	}
	if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" || doc.JWKSURI == "" {
		return oidcEndpoints{}, fmt.Errorf("the discovery document is missing endpoints")
	}
	for _, u := range []string{doc.AuthorizationEndpoint, doc.TokenEndpoint, doc.JWKSURI} {
		if !isHTTPSURL(u) {
			return oidcEndpoints{}, fmt.Errorf("the identity provider must use HTTPS")
		}
	}
	ep := oidcEndpoints{
		authURL: doc.AuthorizationEndpoint, tokenURL: doc.TokenEndpoint,
		userinfoURL: doc.UserinfoEndpoint, jwksURL: doc.JWKSURI,
		issuer: issuer, fetched: time.Now(),
	}
	s.oidcDisc = &ep
	return ep, nil
}

// isHTTPSURL accepts https everywhere and plain http only on loopback, so
// tests can stub an issuer with httptest while a real deployment can never be
// downgraded to cleartext.
func isHTTPSURL(raw string) bool {
	if strings.HasPrefix(raw, "https://") {
		return true
	}
	for _, loop := range []string{"http://localhost", "http://127.", "http://[::1]"} {
		if strings.HasPrefix(raw, loop) {
			return true
		}
	}
	return false
}

// ---- JWKS ----

type oidcKeySet struct {
	keys    map[string]json.RawMessage // kid -> JWK
	fetched time.Time
}

// oidcKeys returns the issuer's signing keys, refetching at most hourly — or
// immediately when force is set, which the verifier does once if the token's
// kid is unknown (key rotation must not brick every sign-in for an hour).
func (s *Server) oidcKeys(ep oidcEndpoints, force bool) (map[string]json.RawMessage, error) {
	s.oidcJWKSMu.Lock()
	defer s.oidcJWKSMu.Unlock()
	if !force && s.oidcJWKS != nil && time.Since(s.oidcJWKS.fetched) < oidcCacheTTL {
		return s.oidcJWKS.keys, nil
	}
	req, err := http.NewRequest("GET", ep.jwksURL, nil)
	if err != nil {
		return nil, fmt.Errorf("bad JWKS URL")
	}
	resp, err := s.oidcHTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("the signing keys could not be fetched")
	}
	defer resp.Body.Close()
	var set struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil || len(set.Keys) == 0 {
		return nil, fmt.Errorf("the signing keys are unreadable")
	}
	keys := make(map[string]json.RawMessage, len(set.Keys))
	for _, raw := range set.Keys {
		var hdr struct {
			Kid string `json:"kid"`
		}
		if json.Unmarshal(raw, &hdr) != nil {
			continue
		}
		keys[hdr.Kid] = raw
	}
	s.oidcJWKS = &oidcKeySet{keys: keys, fetched: time.Now()}
	return keys, nil
}

// ---- verification ----

// verifyOIDCIDToken checks the ID token's signature against the issuer's JWKS
// and returns the caller's email and name. verified is false only when the
// provider explicitly says the address is unverified — a missing claim counts
// as verified, because providers like Authelia simply do not send one and
// their word after a successful sign-in is the verification.
func (s *Server) verifyOIDCIDToken(idToken string) (email, name string, verified bool, err error) {
	issuer := s.oidcIssuer()
	clientID := strings.TrimSpace(s.setting("oauth_oidc_id", ""))
	if issuer == "" || clientID == "" {
		return "", "", false, fmt.Errorf("not configured")
	}
	email, name, verified, err = s.verifyOIDCIDTokenWith(idToken, issuer, clientID)
	return email, name, verified, err
}

func (s *Server) verifyOIDCIDTokenWith(idToken, issuer, clientID string) (email, name string, verified bool, err error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return "", "", false, fmt.Errorf("malformed token")
	}
	signingInput := parts[0] + "." + parts[1]
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", false, fmt.Errorf("malformed token")
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if json.Unmarshal(headerJSON, &header) != nil {
		return "", "", false, fmt.Errorf("malformed token")
	}
	if header.Alg != "RS256" && header.Alg != "ES256" {
		return "", "", false, fmt.Errorf("unsupported signing algorithm")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", "", false, fmt.Errorf("malformed token")
	}
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", "", false, fmt.Errorf("malformed token")
	}

	ep, err := s.oidcDiscover()
	if err != nil {
		return "", "", false, err
	}
	keys, err := s.oidcKeys(ep, false)
	if err != nil {
		return "", "", false, err
	}
	jwk, ok := keys[header.Kid]
	if !ok && header.Kid == "" && len(keys) == 1 {
		for _, v := range keys {
			jwk = v
		}
		ok = true
	}
	if !ok {
		// Possibly rotated since the cache was filled — one forced refetch,
		// then give up rather than hammering the issuer.
		keys, err = s.oidcKeys(ep, true)
		if err != nil {
			return "", "", false, err
		}
		if jwk, ok = keys[header.Kid]; !ok {
			return "", "", false, fmt.Errorf("unknown signing key")
		}
	}
	if err := verifyJWSSignature(header.Alg, jwk, signingInput, sig); err != nil {
		return "", "", false, fmt.Errorf("bad signature")
	}

	var claims struct {
		Issuer            string          `json:"iss"`
		Audience          json.RawMessage `json:"aud"`
		Expiry            int64           `json:"exp"`
		Email             string          `json:"email"`
		EmailVerified     any             `json:"email_verified"`
		Name              string          `json:"name"`
		PreferredUsername string          `json:"preferred_username"`
	}
	if json.Unmarshal(payloadJSON, &claims) != nil {
		return "", "", false, fmt.Errorf("unreadable claims")
	}
	if strings.TrimRight(claims.Issuer, "/") != strings.TrimRight(issuer, "/") {
		return "", "", false, fmt.Errorf("wrong issuer")
	}
	if !audienceContains(claims.Audience, clientID) {
		return "", "", false, fmt.Errorf("wrong audience")
	}
	if claims.Expiry == 0 || time.Now().Unix() > claims.Expiry+120 {
		return "", "", false, fmt.Errorf("token expired")
	}
	email = strings.TrimSpace(claims.Email)
	if email == "" && strings.Contains(claims.PreferredUsername, "@") {
		email = strings.TrimSpace(claims.PreferredUsername)
	}
	verified = true
	switch v := claims.EmailVerified.(type) {
	case bool:
		verified = v
	case string:
		verified = v != "false"
	}
	return email, claims.Name, verified, nil
}

// audienceContains reads the aud claim in both its legal shapes: a single
// string or a list of them (RFC 7519 §4.1.3).
func audienceContains(raw json.RawMessage, clientID string) bool {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == clientID
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		for _, a := range list {
			if a == clientID {
				return true
			}
		}
	}
	return false
}

// verifyJWSSignature checks a JWS signature for the two algorithms small
// deployments actually use: RS256 (RSA PKCS#1 v1.5 over SHA-256) and ES256
// (ECDSA over P-256 with a raw R||S signature). Anything else is refused
// rather than half-supported.
func verifyJWSSignature(alg string, jwk json.RawMessage, signingInput string, sig []byte) error {
	var base struct {
		Kty string `json:"kty"`
	}
	if json.Unmarshal(jwk, &base) != nil {
		return fmt.Errorf("unreadable key")
	}
	sum := sha256.Sum256([]byte(signingInput))
	switch alg {
	case "RS256":
		if base.Kty != "RSA" {
			return fmt.Errorf("algorithm/key mismatch")
		}
		var key struct {
			N string `json:"n"`
			E string `json:"e"`
		}
		if json.Unmarshal(jwk, &key) != nil || key.N == "" || key.E == "" {
			return fmt.Errorf("unreadable key")
		}
		nb, err := base64.RawURLEncoding.DecodeString(key.N)
		if err != nil {
			return fmt.Errorf("unreadable key")
		}
		eb, err := base64.RawURLEncoding.DecodeString(key.E)
		if err != nil {
			return fmt.Errorf("unreadable key")
		}
		e := 0
		for _, b := range eb {
			e = e<<8 + int(b)
		}
		if e == 0 {
			return fmt.Errorf("unreadable key")
		}
		pub := rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}
		return rsa.VerifyPKCS1v15(&pub, crypto.SHA256, sum[:], sig)
	case "ES256":
		if base.Kty != "EC" {
			return fmt.Errorf("algorithm/key mismatch")
		}
		var key struct {
			Crv string `json:"crv"`
			X   string `json:"x"`
			Y   string `json:"y"`
		}
		if json.Unmarshal(jwk, &key) != nil || key.Crv != "P-256" || key.X == "" || key.Y == "" {
			return fmt.Errorf("unreadable key")
		}
		xb, err := base64.RawURLEncoding.DecodeString(key.X)
		if err != nil {
			return fmt.Errorf("unreadable key")
		}
		yb, err := base64.RawURLEncoding.DecodeString(key.Y)
		if err != nil {
			return fmt.Errorf("unreadable key")
		}
		if len(sig) != 64 {
			return fmt.Errorf("bad signature")
		}
		pub := ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xb), Y: new(big.Int).SetBytes(yb)}
		r := new(big.Int).SetBytes(sig[:32])
		sv := new(big.Int).SetBytes(sig[32:])
		if !ecdsa.Verify(&pub, sum[:], r, sv) {
			return fmt.Errorf("bad signature")
		}
		return nil
	}
	return fmt.Errorf("unsupported signing algorithm")
}
