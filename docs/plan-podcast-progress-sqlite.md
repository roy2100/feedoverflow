# Plan: move podcast playback progress from localStorage to SQLite

## Goal

Per-episode playback position currently lives in `localStorage['podcast-progress']`
(`client/src/lib/playbackProgress.ts`). Move the durable copy into SQLite so a resume
survives a browser-data wipe and follows the listener across devices — start an episode on
the Mac, pick it up on the phone.

## Scope

In:

- Two additive columns on `article_states` (`play_position`, `play_updated_at`).
- Three endpoints: read the recent positions, upsert one, clear one.
- Rewire `lib/playbackProgress.ts` onto them, keeping its current sync call signatures.
- Tests (Go store + handler, client unit + the whole-app resume suite), CLAUDE.md tables.

Out:

- Any UI for progress (no "resume from 10:30" label, no list progress bar). This is a
  storage swap, not a feature.
- Cross-device *live* sync (no polling/push while playing). Hydration happens once at
  startup; a position written on another device shows up on the next load.
- Migrating the positions already in `localStorage`. They are per-browser, unreachable
  from the server, and a mid-episode position is worth ~nothing a week later. The old key
  is simply abandoned.

## Design decisions

**Columns on `article_states`, not a new table.** A position is per-article state, exactly
like `is_starred`, and it is meaningless once the article row is gone — so riding along
with the row is the correct lifecycle. A standalone `playback_progress` table would need
its own orphan cleanup in `internal/jobs/maintenance.go` for no gain. Consequence,
accepted: the DB size cap trims oldest non-starred rows and takes their positions with
them; those episodes are no longer listable anyway.

**The upsert is an `UPDATE`, never an insert.** A progress ping carries an id and a number,
nothing else. Inserting on a miss would mint a title-less, content-less `article_states`
row — a fake article in every list. An episode can only be played from a list served out
of `article_states`, so the row always exists; 0 rows affected is a no-op, not an error.

**No `duration` column; the "finished" test moves to write time.** Today `saveProgress`
records the raw position plus the duration and `loadProgress` decides an episode within
20s of its end starts over. Server-side, that duration exists only to answer one yes/no
question, so answer it in the client on the way out: past the end margin ⇒ *clear* the row
instead of writing it. What the DB holds is then exactly "positions worth resuming", and
`GET` is a plain id → seconds map. The `MIN_RESUME_SECONDS` floor stays on the read side —
a save of 4s must still overwrite a stored 600s (a refused seek that restarted playback
should not leave a stale resume point behind).

**`loadProgress` stays synchronous, backed by a map hydrated at startup.** The resume seek
runs inside `handlePlay`, in the same task as `audio.play()`; awaiting a fetch there would
break the user-gesture attribution Safari's autoplay policy requires. So `hydrate()` runs
once alongside `init()` and fills an in-memory `Map`, and `loadProgress` reads that map.
Accepted limitation: an episode started in the first few hundred ms after load — before
hydration lands — starts from the top.

**Writes go out via `sendBeacon`, falling back to `keepalive` fetch.** The save that
matters most fires from `visibilitychange: hidden` — an iOS PWA being backgrounded and then
killed, which is the whole reason the periodic write exists. A plain `fetch` from that
handler can be dropped when the page freezes; `sendBeacon` is queued by the browser and
survives. Both carry same-origin cookies, so the auth gate is satisfied either way.

**`GET` is bounded to the 200 most recent positions** (`ORDER BY play_updated_at DESC`),
which is what `play_updated_at` is for. The DB keeps every position; the client only ever
needs the recent tail, and an unbounded map would grow with years of listening. This is the
same 200 the old `MAX_ENTRIES` prune enforced, moved from "what is stored" to "what is
shipped".

## Steps

1. **Schema** (`internal/db/db.go`) — append two `execIgnore` ALTERs: `play_position
   INTEGER` (seconds) and `play_updated_at INTEGER` (epoch ms). Both NULL = no position.
   Verify the two upserts in `internal/store/{write,persist}.go` use explicit column lists
   (they do), so neither a poll nor a star can touch the new columns.
2. **Store** (`internal/store/progress.go`) — `PlaybackProgress(r, limit)` →
   `map[string]int`, `SavePlaybackProgress(w, id, seconds, now)`, `ClearPlaybackProgress(w,
   id)`. All keyed on `article_id`, all `UPDATE`.
3. **Handlers** (`internal/httpapi/progress.go`) — `GET /api/podcast-progress`,
   `POST /api/podcast-progress`, `DELETE /api/podcast-progress/{id}`; register in
   `mountAPIRoutes`. Reject a non-positive/non-finite position with 400.
4. **Client lib** (`client/src/lib/playbackProgress.ts`) — rewrite around the map +
   `hydrate()` + beacon writes, keeping `saveProgress` / `loadProgress` / `clearProgress`
   signatures so `App.tsx` needs one added `hydrate()` call and nothing else.
5. **App wiring** (`client/src/App.tsx`) — call `hydrate()` in the auth-check effect next
   to `init()`.
6. **Tests** — Go: handler round-trip, unknown-id no-op, 400s, the 200 cap. Client:
   rewrite `playbackProgress.test.ts` against a stubbed fetch/beacon; update
   `playbackResume.test.tsx` to seed via the `GET` response and assert on posted bodies.
7. **Docs** — CLAUDE.md schema line for `article_states` + three API rows.

## Risks / open questions

- **Live DB migration.** Two additive ALTERs on a ~440MB `article_states`. SQLite's
  `ADD COLUMN` with a NULL default is O(1) metadata-only (no table rewrite), so this is
  safe on the live DB. No backfill needed — NULL is the correct "never played" value.
- **Progress is now shared, not per-device.** Deliberate (it is the point of the change),
  but it does mean two devices playing the same episode will fight over the position, last
  write wins. For a single-user reader that is the desired behavior.
- **Write volume.** One `UPDATE` per episode per 5s while playing, on the single-writer
  pool. Negligible next to the poller's transactions, and it touches one row by primary key.
- **A dropped beacon loses at most 5s of position.** No retry, no queue — progress is a
  nicety and must never surface an error to the listener.

## Complexity

Medium — two-language change across schema, API, and client, but no new subsystem and no
data migration.

## Outcome

All seven steps landed as designed. Details and small deviations worth recording:

- **`GET` returns an envelope**, `{ progress: { "<id>": seconds } }`, not a bare map —
  consistent with every other list endpoint (`{ articles: [...] }`) and leaves room to add
  a field without breaking the shape.
- **`POST` accepts `{ id, position, duration }`** but the server ignores `duration`
  entirely. It is on the wire so the payload is self-describing; the finished/not-finished
  decision is the client's, per the design above, and shows up as `DELETE` instead of
  `POST`. The handler rejects a missing id or a non-positive/NaN/Inf position with 400 and
  rounds the position to whole seconds.
- **The near-end clear is guarded on the in-memory map** (`positions.has(id)`), so the
  5-second periodic save doesn't re-send the same `DELETE` through the closing credits.
  The `ended` handler's `clearProgress` stays unguarded — it is the one signal that is
  always true, and an id this session never hydrated is no evidence the server has nothing.
- **`lib/playbackProgress.ts` kept all three call signatures** (`saveProgress`,
  `loadProgress`, `clearProgress`), so `App.tsx` needed exactly one new call: `hydrate()`
  in the auth-check effect, folded into a `start()` helper shared by the authed and
  auth-disabled paths. It also exports `__resetProgressCache()` purely as a test seam.
- **Tests.** Go: `internal/store/progress_test.go` (read/write/clear, the newest-first
  limit, and — the load-bearing one — that a re-poll and a star both leave `play_position`
  alone) and `internal/httpapi/progress_test.go` (round-trip, rounding, 400s, the 200 cap,
  and that no ping can create or clobber an `article_states` row). Client:
  `playbackProgress.test.ts` rewritten against a stubbed fetch, with a separate `describe`
  for the sendBeacon-vs-fetch transport choice; `playbackResume.test.tsx` now seeds through
  the `GET` response and asserts on the requests the app sent.
- **Not migrated, as planned:** whatever is in `localStorage['podcast-progress']` today
  stays there, unread. The first play after this ships starts from the top.
- Verified: `cd server-go && make check` (plus `gofmt -l`), `cd client && npm test`,
  `npm run typecheck`, and root `npm run fmt:check && npm run lint` — all clean.

