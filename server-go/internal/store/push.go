package store

import (
	"database/sql"
)

// Subscription is one registered device's Web Push endpoint, the server-side half
// of a browser PushSubscription. Endpoint is the primary key: re-subscribing the
// same browser yields the same endpoint, so registration is an upsert.
type Subscription struct {
	Endpoint  string
	P256dh    string
	Auth      string
	UserAgent string
}

// NewArticle is the notification-shaped view of an article_states row: just what
// a push payload needs (id for the deep link, title for the body).
type NewArticle struct {
	ArticleID string
	Title     string
	Link      string
	PubTs     int64
}

// PushFeed is a feed the poller may notify for: the watermark travels with it so
// the caller needs one query, not two.
type PushFeed struct {
	ID             string
	Name           string
	LastNotifiedTs sql.NullInt64
}

// SetFeedPush flips a feed's push opt-in. Switching push ON also seeds the
// watermark to now, so enabling never replays the feed's existing backlog as a
// burst of notifications. Switching OFF leaves the watermark alone — re-enabling
// later then re-seeds it. Returns the affected row count (0 = feed not found).
func SetFeedPush(w *sql.DB, id string, enabled bool, now int64) (int64, error) {
	var res sql.Result
	var err error
	if enabled {
		res, err = w.Exec(
			`UPDATE feeds SET push_enabled = 1, last_notified_ts = ? WHERE id = ?`, now, id)
	} else {
		res, err = w.Exec(`UPDATE feeds SET push_enabled = 0 WHERE id = ?`, id)
	}
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PushEnabledFeed returns the feed's push state + watermark, or ok=false when the
// feed is gone or has push off — the poller's single pre-notify lookup.
func PushEnabledFeed(r *sql.DB, id string) (PushFeed, bool, error) {
	var f PushFeed
	err := r.QueryRow(
		`SELECT id, name, last_notified_ts FROM feeds WHERE id = ? AND push_enabled = 1`, id).
		Scan(&f.ID, &f.Name, &f.LastNotifiedTs)
	if err == sql.ErrNoRows {
		return PushFeed{}, false, nil
	}
	if err != nil {
		return PushFeed{}, false, err
	}
	return f, true, nil
}

// ArticlesToNotify returns the feed's articles published after the watermark and
// not in the future, newest first, capped at limit.
//
// The `pub_ts <= now` bound is load-bearing, not defensive: dates.PubTs passes an
// upstream pub_date through unclamped, so a timezone-mangled or deliberately
// scheduled item can carry a pub_ts days ahead. Without the bound such an item
// would be selected immediately and — since the caller stamps the watermark from
// the selected rows — push the watermark into the future, silently swallowing
// every genuine update until real time caught up. Bounded, the item simply waits
// until its own timestamp is due and is notified once, then.
//
// Articles older than the watermark (upstream back-fill) are skipped by design.
func ArticlesToNotify(r *sql.DB, feedID string, after, now int64, limit int) ([]NewArticle, error) {
	rows, err := r.Query(
		`SELECT article_id, title, link, pub_ts FROM article_states
		  WHERE feed_id = ? AND pub_ts > ? AND pub_ts <= ?
		  ORDER BY pub_ts DESC LIMIT ?`, feedID, after, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NewArticle
	for rows.Next() {
		var a NewArticle
		var link sql.NullString
		if err := rows.Scan(&a.ArticleID, &a.Title, &link, &a.PubTs); err != nil {
			return nil, err
		}
		a.Link = link.String
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountArticlesToNotify counts what ArticlesToNotify would return unbounded —
// only needed when the batch overflows the per-feed cap and collapses into a
// "有 N 篇新文章" summary, which needs the true N.
func CountArticlesToNotify(r *sql.DB, feedID string, after, now int64) (int, error) {
	var n int
	err := r.QueryRow(
		`SELECT COUNT(*) FROM article_states WHERE feed_id = ? AND pub_ts > ? AND pub_ts <= ?`,
		feedID, after, now).Scan(&n)
	return n, err
}

// StampNotified advances a feed's watermark. Callers pass the max pub_ts of the
// rows they actually notified about (never a bare MAX(pub_ts) over the table —
// see ArticlesToNotify). Monotonic: never moves the watermark backwards.
func StampNotified(w *sql.DB, feedID string, ts int64) error {
	_, err := w.Exec(
		`UPDATE feeds SET last_notified_ts = ?
		  WHERE id = ? AND (last_notified_ts IS NULL OR last_notified_ts < ?)`,
		ts, feedID, ts)
	return err
}

// SaveSubscription registers (or refreshes) a device's push endpoint.
func SaveSubscription(w *sql.DB, s Subscription, now int64) error {
	_, err := w.Exec(
		`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at)
		 VALUES (?,?,?,?,?)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
		s.Endpoint, s.P256dh, s.Auth, s.UserAgent, now)
	return err
}

// DeleteSubscription removes one endpoint — called both by the client's explicit
// unsubscribe and by the sender when an endpoint reports itself dead (404/410).
func DeleteSubscription(w *sql.DB, endpoint string) error {
	_, err := w.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint)
	return err
}

// ListSubscriptions returns every registered device.
func ListSubscriptions(r *sql.DB) ([]Subscription, error) {
	rows, err := r.Query(
		`SELECT endpoint, p256dh, auth, COALESCE(user_agent, '') FROM push_subscriptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Subscription
	for rows.Next() {
		var s Subscription
		if err := rows.Scan(&s.Endpoint, &s.P256dh, &s.Auth, &s.UserAgent); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// SubscriptionCount reports how many devices are registered (the toggle UI needs
// to know whether pushing anywhere is even possible).
func SubscriptionCount(r *sql.DB) (int, error) {
	var n int
	err := r.QueryRow(`SELECT COUNT(*) FROM push_subscriptions`).Scan(&n)
	return n, err
}

// VAPIDKeys reads the stored keypair. ok=false means none generated yet.
//
// These live in their own single-row table rather than `settings` on purpose:
// Settings() returns every settings row and GET /api/settings serializes the lot,
// so a private key there would be handed to any authed client.
func VAPIDKeys(r *sql.DB) (pub, priv string, ok bool, err error) {
	err = r.QueryRow(`SELECT public_key, private_key FROM push_keys WHERE id = 1`).Scan(&pub, &priv)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return pub, priv, true, nil
}

// SaveVAPIDKeys stores a freshly generated keypair, keeping any existing one (the
// INSERT OR IGNORE loses a race rather than rotating keys out from under devices
// that already subscribed against the old public key).
func SaveVAPIDKeys(w *sql.DB, pub, priv string) error {
	_, err := w.Exec(
		`INSERT OR IGNORE INTO push_keys (id, public_key, private_key) VALUES (1, ?, ?)`, pub, priv)
	return err
}
