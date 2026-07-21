# Plan: per-feed Web Push notifications

## Goal

Add an opt-in, per-feed "更新推送" switch (default off). When a polled feed yields new
articles, push a Web Push notification to every subscribed device. Must work on macOS
(Safari/Chrome) and iOS (PWA installed to home screen, iOS 16.4+).

## Scope

In:
- `feeds.push_enabled` + `feeds.last_notified_ts` columns; toggle via PATCH `/api/feeds/:id`.
- VAPID keypair generated once on first use, stored in its own table.
- `push_subscriptions` table + subscribe/unsubscribe endpoints.
- Notification fan-out from the poller only, using a pub_ts watermark (see Decisions).
- Encrypted send via `github.com/SherClockHolmes/webpush-go`; prune subscriptions on 404/410.
- Service-worker `push` / `notificationclick` handlers, added via workbox `importScripts`
  so the existing generateSW config stays as-is.
- UI: a bell toggle per feed row in ManageFeedsModal — the single entry point, which also
  requests permission + registers the device the first time one is switched on.

Out:
- Push for starred/search/podcast events; digest scheduling; quiet hours.
- Any non-Web-Push transport (APNs direct, email, Bark, …).
- Notification history UI.
- A second UI surface in SettingsModal (deliberately dropped — see Decisions).

## Decisions

**Granularity.** One notification per new article (tapping opens that article), capped at
3 per feed per poll; a 4th or beyond collapses into one `《源名》有 N 篇新文章`.

**New-article detection: a pub_ts watermark, not a persist-chain change.** The obvious
approach — make `persistRows` report which rows were inserted vs. updated and thread that
through `cache.Result` + a notifier hook — touches the one transaction every fetch path
runs through, and couples four packages. Instead `feeds.last_notified_ts` holds the
highest `pub_ts` this feed has already notified about, and after a poll refresh:

```sql
SELECT article_id, title, link, pub_ts FROM article_states
WHERE feed_id = ? AND pub_ts > ? AND pub_ts <= ?   -- watermark, now
ORDER BY pub_ts DESC LIMIT 4
```

then stamp the watermark to the max `pub_ts` **of the rows actually selected**.
`internal/store/persist.go` and all of `internal/cache` stay untouched, and the whole
feature lives in the poller — which is also exactly where it belongs, since an on-demand
refresh triggered by the user reading the app must not notify.

Two consequences, both deliberate:
- *Backdated items don't notify.* An item that appears with a `pub_ts` older than the
  feed's newest already-seen article is skipped. That is a back-fill, not news.
- *Future-dated items can't poison the watermark.* `dates.PubTs` (`internal/dates/dates.go:100`)
  passes an upstream date through unclamped, so a timezone-mangled or deliberately
  scheduled item can carry a `pub_ts` days ahead. Without the `pub_ts <= now` bound and
  the "max of selected rows" stamp, one such item would push the watermark into the future
  and silently swallow every genuine update until real time caught up. With them, the item
  simply waits until its own timestamp is due, and is notified then — exactly once.

**Watermark initialization.** A feed's watermark is seeded to `now` when push is switched
on (and for a brand-new feed on first fetch), so enabling push never replays the backlog.

**VAPID key storage: its own table, not `settings`.** `store.Settings` (`internal/store/store.go:234`)
returns *every* row and `GET /api/settings` serializes the lot, so a private key in that
table would be handed to any authed client. `push_keys` is a dedicated single-row table
that no generic endpoint reads.

**Subscriptions** are device-scoped rows keyed by endpoint; a device that revokes
permission or reinstalls is pruned lazily when its endpoint returns 404/410.

## Steps

1. `internal/db`: add `feeds.push_enabled`, `feeds.last_notified_ts`; create
   `push_subscriptions` and `push_keys`.
2. `internal/model`: `Feed.PushEnabled`.
3. `internal/store/push.go`: feed toggle + watermark read/stamp, the new-articles query,
   subscription CRUD, VAPID key get-or-create.
4. `internal/push`: `Sender` — build payload, encrypt + send to every subscription, prune
   dead endpoints, apply the 3-per-feed cap.
5. `internal/jobs/poller.go`: after a successful refresh of a push-enabled feed, notify.
6. `internal/httpapi`: `GET /api/push/key`, `POST /api/push/subscribe`,
   `POST /api/push/unsubscribe`; `patchFeed` accepts `push_enabled` (name becomes optional
   so the existing rename client + MCP `rename_feed` keep working unchanged).
7. Client: `public/push-sw.js` + workbox `importScripts`; `src/lib/push.ts`; `types.ts`
   `Feed.push_enabled`; store `updateFeed`; the ManageFeedsModal bell.
8. Tests: Go — watermark selection (incl. future-dated and backdated cases), subscription
   store, feed toggle round-trip, payload capping. Vitest — the push helper's key
   conversion + subscribe flow.
9. `make check`, `npm test`, `npm run typecheck`, `npm run fmt && npm run lint`.

## Risks / open questions

- **iOS cannot be verified from here.** Web Push requires the PWA installed to the home
  screen, iOS 16.4+, HTTPS, and a permission request inside a user gesture. Manual test
  steps ship with the final report.
- Payload size limit (~4KB encrypted): truncate title/summary before sending.
- The Mac needs outbound access to Apple/Google push endpoints. Nothing new is exposed
  inbound — the push service calls the *browser*, not this server.
- Sending happens inside the poller's goroutine per feed; a slow push endpoint must not
  stall the poll. Bound it with a per-send timeout.

## Complexity

Medium-High (crypto dependency + schema + service worker + UI, ~10 files, no changes to
the fetch/persist hot path).

## Outcome

Implemented on `feat/push-notifications`, following the plan. Files:

| File | Change |
|---|---|
| `server-go/internal/db/db.go` | `feeds.push_enabled`, `feeds.last_notified_ts`, `push_subscriptions`, `push_keys` |
| `server-go/internal/store/push.go` | new — toggle, watermark, notify-window queries, subscription CRUD, VAPID keys |
| `server-go/internal/push/push.go` | new — VAPID lifecycle, payload, fan-out, dead-endpoint pruning |
| `server-go/internal/jobs/poller.go` | `notifyNewArticles` after a successful poll refresh; `Notifier` interface |
| `server-go/internal/httpapi/push.go` | new — `GET /api/push/key`, `POST /api/push/{subscribe,unsubscribe}` |
| `server-go/internal/httpapi/feeds.go` | `patchFeed` takes optional `name` / `push_enabled` |
| `server-go/internal/{model,config}` | `Feed.PushEnabled`; `PUSH_SUBJECT` |
| `client/public/push-sw.js` | new — `push` + `notificationclick` |
| `client/src/lib/push.ts` | new — permission, subscribe, unsubscribe, key decoding |
| `client/src/components/ManageFeedsModal.tsx` | per-row bell toggle + inline error |
| `client/src/{types,store}.ts` | `push_enabled` through the store |

Deviations from the plan:

- **`jobs.Notifier` interface.** The poller depends on an interface rather than
  `*push.Sender` directly, so its notify decisions (which feeds, which articles, capped
  vs. summary) are testable without a push service. Five lines, and it removed the need
  for any network-touching test.
- **Notification click opens the article's original link, not an in-app deep link.** The
  app has no router (`store.ts` holds `selectedArticle` in state) and no
  get-article-by-id endpoint, so an in-app deep link would have meant a new endpoint plus
  URL-param handling in `App.tsx` — scope beyond this feature. The service worker focuses
  an already-open app window when there is one, and otherwise opens the link.
- **`window.matchMedia` is optional-chained** in `pushBlocker()`. A test surfaced that
  jsdom lacks it; some embedded webviews do too, and the crash would have taken out the
  whole modal.

Tests: 5 store tests (watermark window incl. future-dated + back-fill, monotonic stamping,
count parity, subscription upsert, key stability), 5 poller tests (default-off, no backlog
replay, notify + no re-notify, cap vs. true total, missing-watermark seeding), 3 httpapi
tests (PATCH field independence, key stability + subscribe round-trip, 503 without a
sender), 11 vitest cases for the client helper. `make check`, `npm test`, `tsc --noEmit`,
`oxlint`, `oxfmt --check`, and `vite build` all pass; the built `sw.js` carries
`importScripts("push-sw.js")`.

Not verified from here (needs real devices):

1. **macOS** — open `https://rss.royl.uk:8443` in Safari or Chrome, 管理订阅源 → click a
   feed's bell → allow notifications. Wait for a poll (≤15 min) or restart the server.
2. **iOS** — Safari → Share → 添加到主屏幕, open the installed icon, then the same bell.
   Tapping the bell in a plain Safari tab should say 请先将本站添加到主屏幕. Requires iOS
   16.4+.
3. Check `SELECT endpoint, user_agent FROM push_subscriptions` to confirm the device
   registered, and `SELECT id, push_enabled, last_notified_ts FROM feeds` to watch the
   watermark advance.
4. The Mac needs outbound HTTPS to `*.push.apple.com` / `fcm.googleapis.com`.
