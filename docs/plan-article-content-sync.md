# Plan: Sync local article_states with upstream edits (and fix delete→re-add empties)

## Goal

Make persisted `article_states` rows track upstream RSS edits instead of freezing at
first-seen. Today `persistItems` uses `INSERT OR IGNORE` (`articles.ts:102`), so once an
article is stored its title/summary/content/author never change even if the source edits
them — and the same freeze makes a deleted+re-added feed appear empty (the re-add's items
collide, by global `article_id` PK, with the orphaned rows left under the old feed_id, so
every insert is ignored). One change fixes both: turn the persist into an **upsert** keyed
on `article_id` that refreshes the mutable content fields while preserving the user's
`is_starred` flag, and re-homes orphaned rows to the current feed.

## Scope

**In scope**
- Replace the `INSERT OR IGNORE` in `persistItems` with `INSERT … ON CONFLICT(article_id)
  DO UPDATE …` that refreshes content fields, re-homes `feed_id`/`feed_name`, and bumps
  `updated_at` — but only when something actually changed (guard clause), and never
  touching `is_starred`.
- Tests: content refresh on re-persist; `is_starred` still preserved; orphaned row
  re-homed to the new feed_id on re-add.
- Docs: `CLAUDE.md` (drop the "frozen at first-seen" invariant, describe the sync).

**Out of scope**
- Persisting Readability full-text back into `content` (it is fetched on-demand and not
  stored — confirmed `routes/content.ts:38` — so the feed remains the sole `content` source).
- Making feed delete purge its articles (unneeded now: auto-sync removes the reason the
  user was deleting+re-adding; orphan cleanup still runs on schedule).
- Any schema/migration change (`article_id` PK + `updated_at` default already exist).

## Steps

1. `articles.ts` — rewrite the prepared statement (rename `insertPolledArticle` →
   `upsertPolledArticle`) to:
   ```sql
   INSERT INTO article_states (…) VALUES (…, 0)
   ON CONFLICT(article_id) DO UPDATE SET
     feed_id, feed_name, title, link, pub_date, pub_ts, summary, content, author,
     audio_url = COALESCE(excluded.audio_url, audio_url),
     audio_duration = COALESCE(excluded.audio_duration, audio_duration),
     updated_at = datetime('now')
   WHERE title<>excluded.title OR summary<>excluded.summary OR content<>excluded.content
      OR author<>excluded.author OR feed_id<>excluded.feed_id OR feed_name<>excluded.feed_name
      OR pub_date<>excluded.pub_date
   ```
   `is_starred` is intentionally absent from the SET. The `WHERE` guard avoids no-op
   writes and spurious `updated_at` bumps (which would otherwise reshuffle the
   `updated_at`-ordered starred list on every poll).
2. Update the comment block above the statement to describe upsert semantics.
3. `test/poller.test.ts` — keep the `is_starred`-preservation test (rename off "INSERT OR
   IGNORE"); add: (a) re-persist with changed content updates the row; (b) re-persist
   under a new feed_id re-homes the row (delete→re-add case).
4. `CLAUDE.md` — replace the `INSERT OR IGNORE` / "frozen at first-seen" wording in the
   Architecture + Server sections with the upsert/sync description; note `is_starred` and
   on-demand full-text are preserved.

## Risks & Open Questions

- **Write churn / ordering**: without the change-guard, every 15-min poll would rewrite
  every row and bump `updated_at`, scrambling the starred list order. The `WHERE` guard
  makes updates fire only on real changes. Accepted.
- **Behavior change**: delete+re-add now *refreshes* a feed rather than clearing it. This
  is the intended outcome — the user was deleting to force fresh content, which auto-sync
  now provides. A true "purge feed history" action, if ever wanted, is a separate feature.
- **NULL comparisons**: guarded columns (`title`, `feed_id`, …) are non-null in practice;
  `feed_id<>excluded.feed_id` reliably drives the re-home. `content` is `''`, not NULL.

## Estimated Complexity

Low — one prepared-statement rewrite + tests + docs. No schema change, no new deps.

## Outcome

Done as planned, no deviations.

- `server/articles.ts` — `insertPolledArticle` (`INSERT OR IGNORE`) → `upsertPolledArticle`
  (`INSERT … ON CONFLICT(article_id) DO UPDATE …` with the change-guard `WHERE`);
  `is_starred` excluded from the SET; `feed_id`/`feed_name` refreshed (re-home). Comment
  block rewritten.
- `server/test/poller.test.ts` — renamed the starred-preservation test off "INSERT OR
  IGNORE"; added "syncs upstream content edits" and "re-homes an orphaned row
  (delete→re-add)".
- `CLAUDE.md` — replaced the `INSERT OR IGNORE` / "frozen at first-seen" wording with the
  upsert/sync description (starred + on-demand full-text preserved).
- Verified: `npm test` 92/92 (typecheck included), `npm run fmt:check` clean, `npm run
  lint` exit 0.

**Net effect for the user:** the local reader now tracks upstream article edits
automatically on each fetch/poll — no need to delete+re-add.

## Follow-up revision (re-home dropped)

Per the user, the re-home path was removed in favor of a simpler model: **`DELETE
/api/feeds/:id` now purges the feed's non-starred articles** (`routes/feeds.ts`,
`deleteFeed` transaction; starred kept), so a re-add starts clean and there is nothing to
re-home. The upsert was simplified accordingly — `feed_id`/`feed_name` dropped from the
`ON CONFLICT DO UPDATE SET` and from the `WHERE` guard (now just
title/summary/content/author/pub_date), and the `content_updated_at` `CASE` collapsed to a
plain `= @contentUpdatedAt` (the guard already guarantees a real content change). The
`poller.test.ts` re-home test was replaced with a no-op-re-persist test; a delete-purge
test was added in `routes.test.ts`. Content-sync for live feeds is unchanged.
