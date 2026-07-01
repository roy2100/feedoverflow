# Plan: Show article "updated" time in the reader (only when genuinely edited)

## Goal

Now that `persistItems` upserts and tracks upstream edits, surface *when* an article was
last updated — but only for articles that were actually edited after first fetch. Plain
`updated_at` can't drive this (it's set on every insert and on starring), so introduce a
dedicated `content_updated_at` marker that is set **only** when real content fields change,
expose it through the API, and render "更新于 <date>" in the reader header next to the
publish date. Never-edited articles show nothing extra.

## Scope

**In scope**
- `article_states.content_updated_at` (INTEGER epoch ms, NULL default) via migration.
- Upsert sets it only when title/summary/content/author/pub_date changed — NOT on first
  insert, NOT on a feed_id/feed_name-only re-home (delete→re-add), NOT on star.
- Expose as `Article.updatedAt: number | null` (server + client types, `rowToArticle`).
- Reader header: conditional "更新于 <full date>" span when `updatedAt` is present.
- Backend tests for the marker semantics.

**Out of scope**
- Showing the update time in the article list rows (kept clean; reader is the metadata home).
- Any change to `updated_at` semantics or the starred-list ordering that uses it.

## Steps

1. `db.ts` — `try { ALTER TABLE article_states ADD COLUMN content_updated_at INTEGER } catch {}`
   (matches the existing migration idiom; NULL for all existing rows = "never edited").
2. `articles.ts` upsert — add to `DO UPDATE SET`:
   `content_updated_at = CASE WHEN <content-changed predicate> THEN @contentUpdatedAt ELSE content_updated_at END`,
   where the predicate is title/summary/content/author/pub_date `<>` excluded. Keep the
   outer `WHERE` guard (which also includes feed_id/feed_name so a re-home still writes).
   Pass `contentUpdatedAt: now` in `run()`.
3. Types — `Article.updatedAt?: number | null` (server `types.ts` + client `types.ts`);
   `ArticleStateRow.content_updated_at?: number | null`. `rowToArticle` maps
   `updatedAt: r.content_updated_at ?? null` (unconditional — it's a tiny int, useful in
   both list and reader payloads).
4. `ArticleReader.tsx` — loosen `formatFullDate(date: string | number)`; after the pubDate
   span, render `{article.updatedAt && <span>更新于 {formatFullDate(article.updatedAt)}</span>}`
   in `--text-tertiary`, matching the existing meta style.
5. Tests (`poller.test.ts`) — first insert leaves `content_updated_at` NULL; a content edit
   sets it; a re-home (same content, new feed id) leaves it NULL while still re-homing.

## Risks & Open Questions

- **Re-home false positive**: a delete→re-add re-persists identical content under a new
  feed id. The `CASE` predicate excludes feed_id/feed_name, so `content_updated_at` stays
  NULL — re-added articles don't all falsely show "updated". Verified by test.
- **Locale**: reader already formats dates with `zh-CN`; reuse `formatFullDate`.
- **Payload**: `updatedAt` is a nullable int; negligible list-size impact.

## Estimated Complexity

Low — one column + upsert tweak + type plumbing + one conditional span + tests. No new deps.

## Outcome

Done as planned, no deviations.

- `server/db.ts` — migration adds `content_updated_at INTEGER` (NULL default).
- `server/articles.ts` — upsert stamps `content_updated_at = CASE WHEN <content changed>
  THEN @contentUpdatedAt ELSE content_updated_at END`; `persistItems` passes
  `contentUpdatedAt: now`; `rowToArticle` maps `updatedAt: r.content_updated_at ?? null`.
- `server/types.ts` — `Article.updatedAt?: number | null`, `ArticleStateRow.content_updated_at?`.
- `client/src/types.ts` — `Article.updatedAt?: number | null`.
- `client/src/components/ArticleReader.tsx` — `formatFullDate` accepts `string | number`;
  a conditional "更新于 <date>" span renders after the pubDate only when `updatedAt` is set.
- `server/test/poller.test.ts` — asserts NULL on first insert, stamped on a real edit, and
  NULL after a re-home.
- Verified: server `npm test` 92/92, client `npm test` 84/84, both typechecks clean,
  `npm run fmt:check` clean, `npm run lint` exit 0.

Note: existing articles all have `content_updated_at = NULL`, so the "更新于" line appears
only once an article is genuinely edited upstream and re-fetched.

## Follow-up revision (re-home dropped)

The re-home path was later removed (feed delete now purges non-starred articles instead),
which *simplified* this feature: since the upsert's `WHERE` guard now fires only on a real
content change, the `content_updated_at` `CASE` was replaced with an unconditional
`= @contentUpdatedAt`. The "re-home false positive" risk no longer exists. Client rendering
is unchanged.
