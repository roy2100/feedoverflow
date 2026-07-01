// Package auth is the Go port of server/auth.ts: session login/logout, the
// per-request /api gate, the login rate-limit, and timing-safe credential compare.
// Wired only onto the public listener; the loopback listener stays un-gated (the
// socket decides whether auth applies, never a header).
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/httpx"
)

// SessionTTL — 30 days in ms (created_at is stored as epoch ms, like Node).
const SessionTTL int64 = 30 * 24 * 60 * 60 * 1000

// cookieMaxAge — 30 days in seconds (the login cookie's Max-Age).
const cookieMaxAge = 2592000

// exempt paths that must stay reachable without a session (registered before the
// gate in Node; here the gate skips them explicitly).
var exemptPaths = map[string]bool{
	"/api/login":      true,
	"/api/logout":     true,
	"/api/auth-check": true,
}

// Authenticator carries the auth state. When user & pass are both non-empty auth
// is enabled (gate + login/logout); otherwise it is disabled (open, auth-check
// always true), matching registerAuth.
type Authenticator struct {
	db      *db.DB
	user    string
	pass    string
	limiter *rateLimiter
}

// New builds an Authenticator. chi requires middleware before routes, so callers
// add Gate via r.Use first, then RegisterRoutes.
func New(handle *db.DB, user, pass string) *Authenticator {
	a := &Authenticator{db: handle, user: user, pass: pass}
	if a.enabled() {
		a.limiter = newRateLimiter(15*time.Minute, 10)
	}
	return a
}

func (a *Authenticator) enabled() bool { return a.user != "" && a.pass != "" }

// Gate is the /api gate middleware. A no-op when auth is disabled.
func (a *Authenticator) Gate(next http.Handler) http.Handler {
	if !a.enabled() {
		return next
	}
	return a.gate(next)
}

// RegisterRoutes adds the auth endpoints. Enabled: login/logout/auth-check.
// Disabled: only the always-authed auth-check fallback.
func (a *Authenticator) RegisterRoutes(r chi.Router) {
	if !a.enabled() {
		r.Get("/api/auth-check", func(w http.ResponseWriter, _ *http.Request) {
			httpx.WriteJSON(w, http.StatusOK, map[string]any{"authed": true})
		})
		return
	}
	r.Post("/api/login", a.login)
	r.Post("/api/logout", a.logout)
	r.Get("/api/auth-check", a.authCheck)
}

type authed = Authenticator

// gate mirrors the app.use gate: only guards /api/*, exempts the auth endpoints,
// requires a valid unexpired session otherwise.
func (a *authed) gate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || exemptPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		if a.validSession(parseCookies(r)["session"]) {
			next.ServeHTTP(w, r)
			return
		}
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]any{"error": "Unauthorized"})
	})
}

func (a *authed) login(w http.ResponseWriter, r *http.Request) {
	if !a.limiter.allow(clientIP(r)) {
		httpx.WriteJSON(w, http.StatusTooManyRequests,
			map[string]any{"error": "Too many login attempts, please try again later"})
		return
	}
	var body struct {
		User *string `json:"user"`
		Pass *string `json:"pass"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.User == nil || body.Pass == nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "Missing credentials"})
		return
	}
	userOk := subtle.ConstantTimeCompare([]byte(*body.User), []byte(a.user)) == 1
	passOk := subtle.ConstantTimeCompare([]byte(*body.Pass), []byte(a.pass)) == 1
	if !userOk || !passOk {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid credentials"})
		return
	}
	token := newToken()
	now := time.Now().UnixMilli()
	if _, err := a.db.Writer().Exec(
		`INSERT OR REPLACE INTO sessions (token, created_at) VALUES (?, ?)`, token, now); err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	_, _ = a.db.Writer().Exec(`DELETE FROM sessions WHERE created_at < ?`, now-SessionTTL)
	w.Header().Set("Set-Cookie", cookieString(isSecure(r), token, cookieMaxAge))
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *authed) logout(w http.ResponseWriter, r *http.Request) {
	if token := parseCookies(r)["session"]; token != "" {
		_, _ = a.db.Writer().Exec(`DELETE FROM sessions WHERE token = ?`, token)
	}
	w.Header().Set("Set-Cookie", cookieString(isSecure(r), "", 0))
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *authed) authCheck(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK,
		map[string]any{"authed": a.validSession(parseCookies(r)["session"])})
}

// validSession returns true for a known, unexpired session token.
func (a *authed) validSession(token string) bool {
	if token == "" {
		return false
	}
	var createdAt int64
	err := a.db.Reader().QueryRow(`SELECT created_at FROM sessions WHERE token = ?`, token).Scan(&createdAt)
	if err != nil {
		return false
	}
	return time.Now().UnixMilli()-createdAt < SessionTTL
}

// parseCookies mirrors auth.ts parseCookies (URL-decodes values).
func parseCookies(r *http.Request) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(r.Header.Get("Cookie"), ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		if dec, err := url.QueryUnescape(v); err == nil {
			out[strings.TrimSpace(k)] = dec
		} else {
			out[strings.TrimSpace(k)] = v
		}
	}
	return out
}

// cookieString builds the session cookie exactly like sessionCookie in auth.ts.
func cookieString(secure bool, token string, maxAge int) string {
	sec := ""
	if secure {
		sec = "Secure; "
	}
	return "session=" + token + "; HttpOnly; " + sec +
		"SameSite=Lax; Max-Age=" + strconv.Itoa(maxAge) + "; Path=/"
}

// isSecure reports whether the request effectively arrived over HTTPS. TLS is
// terminated upstream (Caddy) and reaches us over the loopback rathole hop, so —
// like Express `trust proxy = loopback` — we trust X-Forwarded-Proto only from a
// loopback peer.
func isSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if isLoopbackAddr(r.RemoteAddr) {
		return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	}
	return false
}

// clientIP is the rate-limit key: the real client IP, read from X-Forwarded-For
// when the immediate peer is loopback (trust-proxy=loopback), else the peer IP.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if isLoopbackAddr(r.RemoteAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	return host
}

func isLoopbackAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func newToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
