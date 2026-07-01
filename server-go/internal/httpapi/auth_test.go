package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rss-reader/server-go/internal/db"
)

func testDB(t *testing.T) *db.DB {
	t.Helper()
	path := t.TempDir() + "/t.db"
	handle, err := db.OpenHandle(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.InitSchema(handle.Writer()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	t.Cleanup(func() { handle.Close() })
	return handle
}

// do runs a request against a handler with a loopback RemoteAddr (and optional
// headers/cookie) and returns the recorder.
func do(h http.Handler, method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.RemoteAddr = "127.0.0.1:5555"
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func sessionCookieFrom(setCookie string) string {
	// "session=<tok>; HttpOnly; ..." → "session=<tok>"
	return strings.SplitN(setCookie, ";", 2)[0]
}

func TestAuthGate(t *testing.T) {
	srv := &Server{DB: testDB(t), AuthUser: "u", AuthPass: "p"}
	pub := srv.NewPublicRouter()
	local := srv.NewLocalRouter()

	// No cookie → 401 on a gated endpoint.
	if rec := do(pub, "GET", "/api/settings", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-cookie: want 401, got %d", rec.Code)
	}
	// Invalid cookie → 401.
	if rec := do(pub, "GET", "/api/settings", "", map[string]string{"Cookie": "session=deadbeef"}); rec.Code != 401 {
		t.Fatalf("bad-cookie: want 401, got %d", rec.Code)
	}
	// Loopback listener serves the same request with NO cookie → 200.
	if rec := do(local, "GET", "/api/settings", "", nil); rec.Code != 200 {
		t.Fatalf("loopback: want 200, got %d", rec.Code)
	}
	// Wrong creds → 401.
	if rec := do(pub, "POST", "/api/login", `{"user":"u","pass":"WRONG"}`, jsonHdr()); rec.Code != 401 {
		t.Fatalf("wrong-creds: want 401, got %d", rec.Code)
	}
	// Correct creds → 200 + Set-Cookie; then authed request → 200.
	rec := do(pub, "POST", "/api/login", `{"user":"u","pass":"p"}`, jsonHdr())
	if rec.Code != 200 {
		t.Fatalf("login: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	cookie := sessionCookieFrom(rec.Header().Get("Set-Cookie"))
	if !strings.HasPrefix(cookie, "session=") || len(cookie) < 20 {
		t.Fatalf("login cookie malformed: %q", cookie)
	}
	if rec := do(pub, "GET", "/api/settings", "", map[string]string{"Cookie": cookie}); rec.Code != 200 {
		t.Fatalf("authed: want 200, got %d", rec.Code)
	}
	// auth-check reflects the session.
	if rec := do(pub, "GET", "/api/auth-check", "", map[string]string{"Cookie": cookie}); !strings.Contains(rec.Body.String(), `"authed":true`) {
		t.Fatalf("auth-check authed: %s", rec.Body.String())
	}
	if rec := do(pub, "GET", "/api/auth-check", "", nil); !strings.Contains(rec.Body.String(), `"authed":false`) {
		t.Fatalf("auth-check unauthed: %s", rec.Body.String())
	}
	// logout clears the session → cookie no longer valid.
	if rec := do(pub, "POST", "/api/logout", "", map[string]string{"Cookie": cookie}); rec.Code != 200 {
		t.Fatalf("logout: want 200, got %d", rec.Code)
	}
	if rec := do(pub, "GET", "/api/settings", "", map[string]string{"Cookie": cookie}); rec.Code != 401 {
		t.Fatalf("post-logout: want 401, got %d", rec.Code)
	}
}

func TestSecureCookieFromProto(t *testing.T) {
	srv := &Server{DB: testDB(t), AuthUser: "u", AuthPass: "p"}
	pub := srv.NewPublicRouter()

	// With X-Forwarded-Proto: https from a loopback peer → Secure present.
	rec := do(pub, "POST", "/api/login", `{"user":"u","pass":"p"}`,
		map[string]string{"Content-Type": "application/json", "X-Forwarded-Proto": "https"})
	if !strings.Contains(rec.Header().Get("Set-Cookie"), "Secure;") {
		t.Fatalf("expected Secure with https proto: %q", rec.Header().Get("Set-Cookie"))
	}
	// Without the proto header → no Secure.
	rec = do(pub, "POST", "/api/login", `{"user":"u","pass":"p"}`, jsonHdr())
	if strings.Contains(rec.Header().Get("Set-Cookie"), "Secure") {
		t.Fatalf("did not expect Secure over plain http: %q", rec.Header().Get("Set-Cookie"))
	}
}

func TestLoginRateLimit(t *testing.T) {
	srv := &Server{DB: testDB(t), AuthUser: "u", AuthPass: "p"}
	pub := srv.NewPublicRouter()
	var last int
	for i := 0; i < 11; i++ {
		last = do(pub, "POST", "/api/login", `{"user":"u","pass":"WRONG"}`, jsonHdr()).Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("11th login: want 429, got %d", last)
	}
}

func TestAuthDisabled(t *testing.T) {
	srv := &Server{DB: testDB(t)} // no creds → disabled
	pub := srv.NewPublicRouter()
	// Gated endpoint reachable without a cookie.
	if rec := do(pub, "GET", "/api/settings", "", nil); rec.Code != 200 {
		t.Fatalf("auth-disabled settings: want 200, got %d", rec.Code)
	}
	// auth-check always true.
	if rec := do(pub, "GET", "/api/auth-check", "", nil); !strings.Contains(rec.Body.String(), `"authed":true`) {
		t.Fatalf("auth-disabled auth-check: %s", rec.Body.String())
	}
}

func jsonHdr() map[string]string { return map[string]string{"Content-Type": "application/json"} }
