package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// testClient points a client at an httptest.Server's loopback port.
func testClient(t *testing.T, h http.HandlerFunc) *client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	host := strings.TrimPrefix(srv.URL, "http://127.0.0.1:")
	port, err := strconv.Atoi(host)
	if err != nil {
		t.Fatalf("parse port from %q: %v", srv.URL, err)
	}
	return newClient(port)
}

func TestClientGet(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/feeds" {
			t.Errorf("want GET /api/feeds, got %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"1"}]`))
	})
	res, err := c.get(context.Background(), "/api/feeds")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	arr, ok := res.([]any)
	if !ok || len(arr) != 1 {
		t.Fatalf("want 1-element array, got %#v", res)
	}
}

func TestClientPostForwardsBodyAndContentType(t *testing.T) {
	var gotBody map[string]any
	var gotContentType string
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/feeds" {
			t.Errorf("want POST /api/feeds, got %s %s", r.Method, r.URL.Path)
		}
		gotContentType = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &gotBody)
		w.Write([]byte(`{"id":"new"}`))
	})
	_, err := c.post(context.Background(), "/api/feeds", map[string]any{"url": "https://x/rss"})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if gotContentType != "application/json" {
		t.Errorf("want Content-Type application/json, got %q", gotContentType)
	}
	if gotBody["url"] != "https://x/rss" {
		t.Errorf("want body url=https://x/rss, got %#v", gotBody)
	}
}

func TestClientPostDefaultsNilBodyToEmptyObject(t *testing.T) {
	var gotBody string
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte(`{}`))
	})
	if _, err := c.post(context.Background(), "/api/current-article", nil); err != nil {
		t.Fatalf("post: %v", err)
	}
	if gotBody != "{}" {
		t.Errorf("want body {}, got %q", gotBody)
	}
}

func TestClientPatchAndDelete(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/feeds/1":
			if r.Method != http.MethodPatch {
				t.Errorf("want PATCH, got %s", r.Method)
			}
		case "/api/feeds/2":
			if r.Method != http.MethodDelete {
				t.Errorf("want DELETE, got %s", r.Method)
			}
		}
		w.Write([]byte(`{"ok":true}`))
	})
	if _, err := c.patch(context.Background(), "/api/feeds/1", map[string]any{"name": "n"}); err != nil {
		t.Fatalf("patch: %v", err)
	}
	if _, err := c.delete(context.Background(), "/api/feeds/2"); err != nil {
		t.Fatalf("delete: %v", err)
	}
}

func TestClientErrorStatusWithBody(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`url is required`))
	})
	_, err := c.get(context.Background(), "/api/feeds")
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "400") || !strings.Contains(err.Error(), "url is required") {
		t.Errorf("want error to mention status and body, got %q", err.Error())
	}
}

func TestClientErrorStatusNoBody(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	_, err := c.get(context.Background(), "/api/feeds/missing")
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("want error to mention 404, got %q", err.Error())
	}
}

func TestClientEmptyResponseBody(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	res, err := c.delete(context.Background(), "/api/feeds/1")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if res != nil {
		t.Errorf("want nil result for empty body, got %#v", res)
	}
}

func TestClientInvalidJSONResponse(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not json`))
	})
	if _, err := c.get(context.Background(), "/api/feeds"); err == nil {
		t.Fatal("want error decoding invalid JSON, got nil")
	}
}
