package feed_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"rss-reader/server-go/internal/feed"
)

type feedTransport func(*http.Request) (*http.Response, error)

func (f feedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestParseURLFetchDeadline(t *testing.T) {
	// Inspect the actual outbound context without making the suite wait for a
	// cold RSSHub request. Both Zaobao routes were measured above 13 seconds.
	for _, shorterCaller := range []bool{false, true} {
		name := "cold RSSHub budget"
		if shorterCaller {
			name = "shorter caller deadline"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			if shorterCaller {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, time.Second)
				defer cancel()
			}
			original := http.DefaultClient
			t.Cleanup(func() { http.DefaultClient = original })
			http.DefaultClient = &http.Client{Transport: feedTransport(func(r *http.Request) (*http.Response, error) {
				deadline, ok := r.Context().Deadline()
				if !ok {
					t.Fatal("outbound feed request has no deadline")
				}
				if shorterCaller {
					want, _ := ctx.Deadline()
					if !deadline.Equal(want) {
						t.Fatalf("caller deadline changed: got %v, want %v", deadline, want)
					}
				} else if budget := time.Until(deadline); budget < 20*time.Second || budget > 30*time.Second {
					t.Fatalf("cold RSSHub fetch budget = %v, want 20–30s", budget)
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(`<rss version="2.0"><channel><title>Test feed</title></channel></rss>`)),
					Header:     make(http.Header),
				}, nil
			})}
			parsed, err := feed.ParseURL(ctx, "http://rsshub.test/zaobao/realtime")
			if err != nil || parsed.Title != "Test feed" {
				t.Fatalf("ParseURL: parsed=%+v, err=%v", parsed, err)
			}
		})
	}
}

func TestParseURLCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := feed.ParseURL(ctx, "http://127.0.0.1:1/feed")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ParseURL: got %v, want caller cancellation", err)
	}
}
