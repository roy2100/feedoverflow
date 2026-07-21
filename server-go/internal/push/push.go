// Package push sends Web Push notifications for feed updates.
//
// The transport is standard Web Push (RFC 8291 payload encryption + RFC 8292
// VAPID), which is what both macOS Safari/Chrome and iOS accept — on iOS only
// once the PWA is installed to the home screen. Encryption and the VAPID JWT are
// handled by webpush-go; this package owns the keypair lifecycle, the payload
// shape the service worker expects, fan-out to every registered device, and
// pruning devices whose endpoint has gone away.
package push

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/store"
)

const (
	// MaxPerFeed caps how many individual article notifications one feed may emit
	// per poll. Past that the batch collapses into a single summary so a
	// high-volume feed can't bury the notification centre.
	MaxPerFeed = 3
	// FetchLimit is what the caller should ask ArticlesToNotify for: one more than
	// the cap, so the sender can tell "exactly at the cap" from "over it".
	FetchLimit = MaxPerFeed + 1
	// sendTimeout bounds one endpoint's POST. The poller calls into here inline,
	// so an unresponsive push service must not stall the poll.
	sendTimeout = 10 * time.Second
	// ttl is how long the push service may hold an undelivered message (12h).
	// A feed update is stale after that; better dropped than delivered late.
	ttl = 12 * 60 * 60
	// maxTitleRunes truncates a title so the encrypted payload stays well under
	// the 4KB every push service enforces.
	maxTitleRunes = 120
)

// Sender fans a feed's new articles out to every registered device.
type Sender struct {
	DB  *db.DB
	Log *slog.Logger
	// Subject is the VAPID `sub` claim identifying this deployment — an https URL
	// or mailto: URI. Push services (Apple's especially) reject malformed values.
	Subject string
}

// payload is the JSON the service worker (client/public/push-sw.js) parses. Keep
// the two in sync.
type payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	// URL is what a click opens. Empty means "just open the app".
	URL string `json:"url"`
	// Tag collapses same-tag notifications on the device: per-article tags are
	// unique (so several updates stack), the summary reuses the feed's tag.
	Tag string `json:"tag"`
}

// PublicKey returns the VAPID public key clients subscribe against, generating
// the keypair on first call. Regenerating would invalidate every existing
// subscription, so generation is INSERT OR IGNORE and the stored pair wins.
func (s *Sender) PublicKey() (string, error) {
	pub, _, ok, err := store.VAPIDKeys(s.DB.Reader())
	if err != nil {
		return "", err
	}
	if ok {
		return pub, nil
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return "", fmt.Errorf("generate vapid keys: %w", err)
	}
	if err := store.SaveVAPIDKeys(s.DB.Writer(), pub, priv); err != nil {
		return "", err
	}
	// Re-read rather than returning what we just generated: a concurrent caller's
	// keypair may have won the INSERT OR IGNORE.
	pub, _, _, err = store.VAPIDKeys(s.DB.Reader())
	return pub, err
}

// NotifyFeed pushes a feed's new articles to every device. arts must be newest
// first, as ArticlesToNotify returns them, and may hold up to FetchLimit entries;
// more than MaxPerFeed collapses into one summary. total is how many new articles
// there actually are (arts is capped at FetchLimit, so it can't carry the count).
func (s *Sender) NotifyFeed(ctx context.Context, feedID, feedName string, arts []store.NewArticle, total int) {
	if len(arts) == 0 {
		return
	}
	if len(arts) > MaxPerFeed {
		s.broadcast(ctx, payload{
			Title: feedName,
			Body:  fmt.Sprintf("有 %d 篇新文章", total),
			Tag:   "feed-" + feedID,
		})
		return
	}
	// Oldest first, so the newest article ends up on top of the stack.
	for i := len(arts) - 1; i >= 0; i-- {
		a := arts[i]
		s.broadcast(ctx, payload{
			Title: feedName,
			Body:  truncate(a.Title, maxTitleRunes),
			URL:   a.Link,
			Tag:   "article-" + a.ArticleID,
		})
	}
}

// broadcast encrypts and sends one payload to every registered device, dropping
// devices the push service reports as gone.
func (s *Sender) broadcast(ctx context.Context, p payload) {
	subs, err := store.ListSubscriptions(s.DB.Reader())
	if err != nil {
		s.Log.Warn("push: list subscriptions failed", "err", err)
		return
	}
	if len(subs) == 0 {
		return
	}
	pub, priv, ok, err := store.VAPIDKeys(s.DB.Reader())
	if err != nil || !ok {
		s.Log.Warn("push: no vapid keys", "err", err)
		return
	}
	body, err := json.Marshal(p)
	if err != nil {
		s.Log.Warn("push: marshal payload failed", "err", err)
		return
	}
	for _, sub := range subs {
		s.sendOne(ctx, sub, body, pub, priv)
	}
}

func (s *Sender) sendOne(ctx context.Context, sub store.Subscription, body []byte, pub, priv string) {
	sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()

	resp, err := webpush.SendNotificationWithContext(sendCtx, body, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		Subscriber:      s.Subject,
		VAPIDPublicKey:  pub,
		VAPIDPrivateKey: priv,
		TTL:             ttl,
		Urgency:         webpush.UrgencyNormal,
	})
	if err != nil {
		s.Log.Warn("push: send failed", "endpoint", endpointHost(sub.Endpoint), "err", err)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	// 404/410 is the push service saying this subscription is permanently gone
	// (permission revoked, app uninstalled, browser data cleared). Prune it —
	// nothing else ever tells us a device went away.
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		if err := store.DeleteSubscription(s.DB.Writer(), sub.Endpoint); err != nil {
			s.Log.Warn("push: prune subscription failed", "err", err)
			return
		}
		s.Log.Info("push: pruned dead subscription", "endpoint", endpointHost(sub.Endpoint))
		return
	}
	if resp.StatusCode >= 300 {
		s.Log.Warn("push: endpoint rejected",
			"endpoint", endpointHost(sub.Endpoint), "status", resp.StatusCode)
	}
}

// truncate shortens s to at most n runes, marking the cut with an ellipsis.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// endpointHost reduces an endpoint URL to its host for logging — the full URL is
// a per-device bearer secret and has no business in the log file.
func endpointHost(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return "?"
	}
	return u.Host
}
