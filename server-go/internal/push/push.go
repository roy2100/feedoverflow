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
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/store"
)

const (
	// MaxPerFeed caps how many notifications one feed may emit per poll. Anything
	// past the newest 3 is dropped silently — deliberately not collapsed into a
	// "有 N 篇新文章" summary, which is an unread count, the one thing this reader
	// has no concept of. A notification's job is "here is something worth reading
	// now", not "here is how far behind you are"; the remaining articles are in
	// the app, one scroll away, owing the reader nothing.
	MaxPerFeed = 3
	// FetchLimit is what the caller should ask ArticlesToNotify for. It equals the
	// cap: nothing beyond it is ever sent, or counted.
	FetchLimit = MaxPerFeed
	// sendTimeout bounds one endpoint's POST. The poller calls into here inline,
	// so an unresponsive push service must not stall the poll.
	sendTimeout = 10 * time.Second
	// ttl is how long the push service may hold an undelivered message (12h).
	// A feed update is stale after that; better dropped than delivered late.
	ttl = 12 * 60 * 60
	// maxTitleRunes truncates a title so the encrypted payload stays well under
	// the 4KB every push service enforces.
	maxTitleRunes = 120
	// maxBodyBytes bounds how much of a rejection response is read, and
	// maxBodyRunes how much of it reaches the log. Error bodies are a short JSON
	// object; anything longer is a push service misbehaving, not a diagnosis.
	maxBodyBytes = 512
	maxBodyRunes = 200
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
	// Tag collapses same-tag notifications on the device. Per-article tags are
	// unique, so several updates stack rather than replacing each other.
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

// NotifyFeed pushes a feed's new articles to every device, one notification per
// article. arts must be newest first, as ArticlesToNotify returns them, and is
// capped at MaxPerFeed by the query itself — a busier poll is simply not reported
// in full, and the reader is never told a count (see MaxPerFeed).
func (s *Sender) NotifyFeed(ctx context.Context, feedID, feedName string, arts []store.NewArticle) {
	// Oldest first, so the newest article ends up on top of the stack.
	for i := len(arts) - 1; i >= 0; i-- {
		a := arts[i]
		s.broadcast(ctx, payload{
			Title: feedName,
			Body:  truncate(a.Title, maxTitleRunes),
			// Deep link into the app, not out to the publisher: the service worker
			// hands the id to an already-open app window, and only falls back to
			// opening this URL when there is no window to hand it to.
			URL: "/?article=" + a.ArticleID,
			Tag: "article-" + a.ArticleID,
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
		Subscriber:      vapidSubscriber(s.Subject),
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
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
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
			"endpoint", endpointHost(sub.Endpoint), "status", resp.StatusCode,
			// The body carries the only machine-readable reason a push service ever
			// gives (Apple's {"reason":"BadJwtToken"}, for one). Without it a
			// rejection is a bare status code and the cause has to be guessed at.
			"body", truncate(string(respBody), maxBodyRunes))
	}
}

// vapidSubscriber normalises the configured `sub` claim for webpush-go, which
// prefixes "mailto:" onto anything that is not an https URL — including a value
// that already is a mailto: URI, producing "mailto:mailto:you@example.com". Apple
// rejects that JWT with 403 BadJwtToken and drops every notification, so the
// scheme is stripped here and handed over as the bare address.
func vapidSubscriber(subject string) string {
	return strings.TrimPrefix(subject, "mailto:")
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
