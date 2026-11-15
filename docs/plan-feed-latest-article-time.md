# Plan: Show each feed's latest article time

## Goal

Show the publication time of the newest stored article for each feed in Manage → Feeds, so a user can spot sources that have stopped producing articles.

## Scope

In scope:
- Add nullable `latest_article_at` (epoch milliseconds) to the feed list response.
- Read the latest publication timestamp from persisted articles using the existing `(feed_id, pub_ts)` index.
- Show a local date and time beneath each feed name, with the full timestamp in a tooltip.
- Cover per-feed aggregation, missing timestamps, and feeds without articles in backend tests.

Out of scope:
- Fetch error tracking, health classifications, alerts, or automatic failure detection.
- Schema changes, upstream requests, or changes to polling and article persistence.
- Changing feed order or adding sorting controls.

## Steps

1. Extend the server feed model and `ListFeeds` query with a nullable latest article timestamp, treating zero publication timestamps as unknown.
2. Add a backend regression test proving that timestamps belong to the correct feed and do not use fetch or content-edit times.
3. Extend the client feed type and display the timestamp beneath the feed name, retaining truncation and room for row actions on mobile. Refresh these timestamps when management opens so a long-running browser session does not show its startup snapshot.
4. Run backend checks, client tests and type checking, formatting, and linting. Provide manual UI verification steps without browser automation.
5. Record the outcome and any deviations here.

## Risks and Open Questions

- Publication time indicates freshness of stored content, not successful polling or source health. The UI must label it as the latest article time.
- Missing or zero publication timestamps should show an explicit unknown state rather than the Unix epoch.
- Future-dated articles remain visible with their upstream publication date; this display does not reinterpret source dates.
- Feed list reads must use an indexed per-feed maximum and never load article bodies.
- Older servers or newly added feeds can omit the new field; the client must handle that without failing.

## Complexity

Low: one indexed query extension, API/client type changes, and a small existing-row UI change. No dependencies or migration.

## Outcome

Implemented as planned.

- `ListFeeds` exposes nullable `latest_article_at` using a per-feed indexed maximum of `pub_ts`. Missing and zero timestamps return null; starred articles remain eligible. Fetch timestamps, content-edit timestamps, and orphaned articles do not affect the result.
- Feed rows show `最新文章：` followed by a relative local calendar date (`今天`, `昨天`, or `N 天前`) beneath the source name, with a full timestamp tooltip and a semantic `time` element. Future dates show `明天` or `N 天后`; unknown timestamps show `暂无文章时间`. Calendar-date comparison is independent of daylight-saving day length.
- Opening management refreshes timestamps through the store. Only timestamp fields are merged, preserving concurrent feed additions, deletions, and edits. Failed requests preserve existing values.
- Backend regression coverage verifies per-feed maxima and unknown timestamps. Store regression coverage verifies refresh races and failed requests.
- Validation passed: `make -C server-go check`; all 21 client test files / 283 tests; client TypeScript checks; formatting and lint checks; `git diff --check`.
- SQLite `EXPLAIN QUERY PLAN` on an in-memory schema confirms the timestamp subquery uses the covering `idx_article_states_feed_pub` index.
- Follow-up UI changes requested by the user make feed and collection action buttons always visible and remove row-wide hover backgrounds. Button hover feedback and two-step deletion remain intact; leaving a row cancels a pending delete.
- Follow-up validation passed: all 25 feed-panel/style-scale tests and all 13 management-modal/style-scale tests, plus TypeScript, formatting, lint, and diff checks.
- No browser automation or screenshots were used. The subsequent release and deployment results are recorded in `docs/plan-relative-feed-time-release.md`.

### Manual UI Verification

1. Run `npm run dev` and open `http://localhost:3000`.
2. Open Manage → Feeds. Verify that each source shows its newest stored article's publication date and time, and hover the time to see the complete local timestamp.
3. Compare a source's timestamp with its newest article. Verify that unknown timestamps show `暂无文章时间`.
4. Check a phone-width viewport: long source names should truncate, timestamps should remain readable, and push/copy/edit/delete actions should remain usable.
5. After new articles have been fetched, close and reopen management. Verify that the timestamp updates without reloading the page.
