package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"testing"

	"rss-reader/server-go/internal/push"
	"rss-reader/server-go/internal/store"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

// pushState reads a feed's opt-in + watermark straight from the DB.
func pushState(t *testing.T, s *Server, id string) (enabled bool, watermarked bool) {
	t.Helper()
	var mark any
	if err := s.DB.Reader().QueryRow(
		`SELECT push_enabled, last_notified_ts FROM feeds WHERE id = ?`, id).
		Scan(&enabled, &mark); err != nil {
		t.Fatalf("pushState %q: %v", id, err)
	}
	return enabled, mark != nil
}

func TestPatchFeedTogglesPush(t *testing.T) {
	s := newFeedsServer(t, fakeParse("F"))
	h := s.NewLocalRouter()
	if _, err := s.DB.Writer().Exec(
		`INSERT INTO feeds (id,name,url) VALUES ('f1','Feed','https://f/rss')`); err != nil {
		t.Fatal(err)
	}

	// Default is off, with no watermark.
	if on, marked := pushState(t, s, "f1"); on || marked {
		t.Fatalf("default state: enabled=%v watermarked=%v, want both false", on, marked)
	}

	// Push-only body: no name required.
	if rec := do(h, "PATCH", "/api/feeds/f1", `{"push_enabled":true}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("enable: got %d", rec.Code)
	}
	on, marked := pushState(t, s, "f1")
	if !on || !marked {
		t.Fatalf("after enable: enabled=%v watermarked=%v, want both true", on, marked)
	}

	// Rename-only body (the original contract, still what MCP rename_feed sends)
	// must leave the push opt-in alone.
	if rec := do(h, "PATCH", "/api/feeds/f1", `{"name":"Renamed"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("rename: got %d", rec.Code)
	}
	if name, _, _ := feedRow(t, s, "f1"); name != "Renamed" {
		t.Fatalf("rename did not apply: %q", name)
	}
	if on, _ = pushState(t, s, "f1"); !on {
		t.Fatal("rename cleared push_enabled")
	}

	// And a push-only body must not disturb the name.
	if rec := do(h, "PATCH", "/api/feeds/f1", `{"push_enabled":false}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("disable: got %d", rec.Code)
	}
	if name, _, _ := feedRow(t, s, "f1"); name != "Renamed" {
		t.Fatalf("push toggle changed the name: %q", name)
	}
	if on, _ = pushState(t, s, "f1"); on {
		t.Fatal("disable did not apply")
	}

	// Empty body is still a 400, and an unknown feed still 404s.
	if rec := do(h, "PATCH", "/api/feeds/f1", `{}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("empty body: want 400, got %d", rec.Code)
	}
	if rec := do(h, "PATCH", "/api/feeds/nope", `{"push_enabled":true}`, jsonHdr()); rec.Code != 404 {
		t.Fatalf("unknown feed: want 404, got %d", rec.Code)
	}
}

func TestPushKeyIsStableAndSubscribeRoundTrips(t *testing.T) {
	s := newFeedsServer(t, fakeParse("F"))
	s.Push = &push.Sender{DB: s.DB, Log: quietLogger(), Subject: "https://example.test"}
	h := s.NewLocalRouter()

	rec := do(h, "GET", "/api/push/key", "", nil)
	if rec.Code != 200 {
		t.Fatalf("key: got %d", rec.Code)
	}
	var first struct {
		PublicKey string `json:"publicKey"`
		Devices   int    `json:"devices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.PublicKey == "" || first.Devices != 0 {
		t.Fatalf("key response: %+v", first)
	}

	// The keypair must survive across calls — regenerating it would invalidate
	// every device already subscribed against the old public key.
	rec = do(h, "GET", "/api/push/key", "", nil)
	var second struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if second.PublicKey != first.PublicKey {
		t.Fatal("public key changed between calls")
	}

	// Incomplete subscriptions are rejected rather than stored half-formed.
	if rec = do(h, "POST", "/api/push/subscribe",
		`{"endpoint":"https://push.example/x"}`, jsonHdr()); rec.Code != 400 {
		t.Fatalf("keyless subscribe: want 400, got %d", rec.Code)
	}

	body := `{"endpoint":"https://push.example/x","keys":{"p256dh":"pk","auth":"au"}}`
	if rec = do(h, "POST", "/api/push/subscribe", body, jsonHdr()); rec.Code != 200 {
		t.Fatalf("subscribe: got %d", rec.Code)
	}
	subs, err := store.ListSubscriptions(s.DB.Reader())
	if err != nil || len(subs) != 1 {
		t.Fatalf("subscriptions: %+v err %v", subs, err)
	}

	if rec = do(h, "POST", "/api/push/unsubscribe",
		`{"endpoint":"https://push.example/x"}`, jsonHdr()); rec.Code != 200 {
		t.Fatalf("unsubscribe: got %d", rec.Code)
	}
	if subs, err = store.ListSubscriptions(s.DB.Reader()); err != nil || len(subs) != 0 {
		t.Fatalf("after unsubscribe: %+v err %v", subs, err)
	}
}

// Without a Sender the push routes must answer 503 rather than panicking.
func TestPushKeyWithoutSender(t *testing.T) {
	s := newFeedsServer(t, fakeParse("F"))
	if rec := do(s.NewLocalRouter(), "GET", "/api/push/key", "", nil); rec.Code != 503 {
		t.Fatalf("want 503, got %d", rec.Code)
	}
}
