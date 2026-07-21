package store_test

import (
	"testing"

	"rss-reader/server-go/internal/store"
)

// notifyIDs projects article ids for order assertions.
func notifyIDs(arts []store.NewArticle) []string {
	out := make([]string, len(arts))
	for i, a := range arts {
		out[i] = a.ArticleID
	}
	return out
}

func TestSetFeedPushSeedsWatermarkOnEnable(t *testing.T) {
	h := newTestDB(t)
	insertFeed(t, h.Writer(), "f1", "Feed", "http://f", nil)

	const now = int64(1700000000000)
	if _, err := store.SetFeedPush(h.Writer(), "f1", true, now); err != nil {
		t.Fatal(err)
	}
	f, ok, err := store.PushEnabledFeed(h.Reader(), "f1")
	if err != nil || !ok {
		t.Fatalf("PushEnabledFeed: ok=%v err=%v", ok, err)
	}
	// Seeding on enable is what stops switching push on from replaying the whole
	// existing backlog as notifications.
	if !f.LastNotifiedTs.Valid || f.LastNotifiedTs.Int64 != now {
		t.Fatalf("watermark: got %+v, want %d", f.LastNotifiedTs, now)
	}

	// Disabled feeds are invisible to the poller.
	if _, err := store.SetFeedPush(h.Writer(), "f1", false, now+1); err != nil {
		t.Fatal(err)
	}
	if _, ok, err = store.PushEnabledFeed(h.Reader(), "f1"); err != nil || ok {
		t.Fatalf("disabled feed still visible: ok=%v err=%v", ok, err)
	}
}

func TestSetFeedPushUnknownFeed(t *testing.T) {
	h := newTestDB(t)
	n, err := store.SetFeedPush(h.Writer(), "nope", true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("changes: got %d, want 0 (drives the handler's 404)", n)
	}
}

func TestArticlesToNotifyWindow(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Feed", "http://f", nil)
	insertFeed(t, w, "f2", "Other", "http://o", nil)

	const watermark = int64(1000)
	const now = int64(2000)
	insertArticle(t, w, af{id: "old", feedID: "f1", pubTs: 900})     // pre-watermark back-fill
	insertArticle(t, w, af{id: "at", feedID: "f1", pubTs: 1000})     // exactly at watermark
	insertArticle(t, w, af{id: "new1", feedID: "f1", pubTs: 1500})   //
	insertArticle(t, w, af{id: "new2", feedID: "f1", pubTs: 1800})   //
	insertArticle(t, w, af{id: "future", feedID: "f1", pubTs: 5000}) // dated ahead of now
	insertArticle(t, w, af{id: "other", feedID: "f2", pubTs: 1900})  // different feed

	got, err := store.ArticlesToNotify(h.Reader(), "f1", watermark, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	// Newest first; the watermark is exclusive, back-fill and future-dated rows are
	// both excluded, and another feed's rows never leak in.
	eqStrings(t, notifyIDs(got), []string{"new2", "new1"})
}

// A feed carrying a future-dated item (a timezone-mangled or scheduled pub_date —
// dates.PubTs passes those through unclamped) must still notify normally, and the
// future item must be notified exactly once, when its own timestamp comes due.
func TestArticlesToNotifyFutureDatedItemDoesNotPoisonWatermark(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Feed", "http://f", nil)
	insertArticle(t, w, af{id: "real", feedID: "f1", pubTs: 1500})
	insertArticle(t, w, af{id: "ahead", feedID: "f1", pubTs: 9000})

	// Poll 1, at now=2000: only the genuinely-published article is selected.
	got, err := store.ArticlesToNotify(h.Reader(), "f1", 1000, 2000, 10)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, notifyIDs(got), []string{"real"})

	// The caller stamps from the selected rows, so the watermark lands at 1500 —
	// not at the future item's 9000, which would have swallowed everything
	// published between now and then.
	if err := store.StampNotified(w, "f1", got[0].PubTs); err != nil {
		t.Fatal(err)
	}
	var mark int64
	if err := h.Reader().QueryRow(
		`SELECT last_notified_ts FROM feeds WHERE id = 'f1'`).Scan(&mark); err != nil {
		t.Fatal(err)
	}
	if mark != 1500 {
		t.Fatalf("watermark: got %d, want 1500", mark)
	}

	// A later article still notifies (it would not have, had 9000 been stamped).
	insertArticle(t, w, af{id: "later", feedID: "f1", pubTs: 3000})
	got, err = store.ArticlesToNotify(h.Reader(), "f1", mark, 4000, 10)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, notifyIDs(got), []string{"later"})

	// Poll N, once real time passes the future item's own timestamp: it surfaces
	// then, exactly once.
	got, err = store.ArticlesToNotify(h.Reader(), "f1", 3000, 10000, 10)
	if err != nil {
		t.Fatal(err)
	}
	eqStrings(t, notifyIDs(got), []string{"ahead"})
}

func TestStampNotifiedIsMonotonic(t *testing.T) {
	h := newTestDB(t)
	w := h.Writer()
	insertFeed(t, w, "f1", "Feed", "http://f", nil)

	for _, ts := range []int64{500, 900, 700} {
		if err := store.StampNotified(w, "f1", ts); err != nil {
			t.Fatal(err)
		}
	}
	var mark int64
	if err := h.Reader().QueryRow(
		`SELECT last_notified_ts FROM feeds WHERE id = 'f1'`).Scan(&mark); err != nil {
		t.Fatal(err)
	}
	// The 700 must not move the watermark back — that would re-notify 700..900.
	if mark != 900 {
		t.Fatalf("watermark: got %d, want 900", mark)
	}
}

func TestSubscriptionRoundTrip(t *testing.T) {
	h := newTestDB(t)
	sub := store.Subscription{
		Endpoint:  "https://web.push.apple.com/abc",
		P256dh:    "key1",
		Auth:      "auth1",
		UserAgent: "Safari",
	}
	if err := store.SaveSubscription(h.Writer(), sub, 1); err != nil {
		t.Fatal(err)
	}
	// Re-subscribing the same browser yields the same endpoint: an upsert, not a
	// duplicate row, and the refreshed keys win.
	sub.P256dh = "key2"
	if err := store.SaveSubscription(h.Writer(), sub, 2); err != nil {
		t.Fatal(err)
	}
	got, err := store.ListSubscriptions(h.Reader())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].P256dh != "key2" {
		t.Fatalf("subscriptions: got %+v", got)
	}
	n, err := store.SubscriptionCount(h.Reader())
	if err != nil || n != 1 {
		t.Fatalf("count: got %d err %v", n, err)
	}

	if err := store.DeleteSubscription(h.Writer(), sub.Endpoint); err != nil {
		t.Fatal(err)
	}
	if got, err = store.ListSubscriptions(h.Reader()); err != nil || len(got) != 0 {
		t.Fatalf("after delete: got %+v err %v", got, err)
	}
}

func TestSaveVAPIDKeysKeepsFirstPair(t *testing.T) {
	h := newTestDB(t)
	if _, _, ok, err := store.VAPIDKeys(h.Reader()); err != nil || ok {
		t.Fatalf("fresh DB should have no keys: ok=%v err=%v", ok, err)
	}
	if err := store.SaveVAPIDKeys(h.Writer(), "pub1", "priv1"); err != nil {
		t.Fatal(err)
	}
	// Rotating keys would invalidate every device that already subscribed against
	// the old public key, so a second save must not overwrite.
	if err := store.SaveVAPIDKeys(h.Writer(), "pub2", "priv2"); err != nil {
		t.Fatal(err)
	}
	pub, priv, ok, err := store.VAPIDKeys(h.Reader())
	if err != nil || !ok || pub != "pub1" || priv != "priv1" {
		t.Fatalf("keys: %q/%q ok=%v err=%v", pub, priv, ok, err)
	}
}
