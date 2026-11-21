# Plan: Upgrade RSSHub and repair failing subscriptions

## Goal

Upgrade the local RSSHub container and resolve the reported subscription fetch errors where a verified fix is available.

## Scope

In scope:
- Inspect the existing OrbStack RSSHub service, application fetch logs, and all reported failing subscriptions.
- Pull and recreate `scripts/rsshub/compose.yml` using the current official image; preserve the previous image for rollback.
- Diagnose upstream HTTP errors, timeouts, and feed parsing errors separately.
- Apply the smallest verified deployment, feed URL, or application fix needed, preserving feed IDs, starred articles, and history.
- Verify RSSHub feeds and affected direct feeds through the application's shared refresh chain.

Out of scope:
- New health-monitoring features, UI changes, unrelated refactoring, and changes to the public demo/VPS.
- Deleting subscriptions or replacing them with unrelated sources.

## Affected surfaces

- Deployment config: `scripts/rsshub/compose.yml` and its running container.
- Callers: the existing poller, on-demand reads, and cache warming share `internal/cache` and `internal/feed`.
- Data: existing feed rows via the validated PATCH API only if a replacement URL is necessary; preserve IDs and history.
- Tests/fixtures/exports: unchanged unless diagnosis requires an application code change; inspect associated tests before editing.
- Documentation: this plan and deployment notes if configuration changes.

## Steps

1. Record current container revision, resource limits, subscription URLs, and recent failure evidence.
2. Pull the latest official RSSHub image, record its revision, recreate the service, and verify readiness and memory.
3. Probe the reported routes and direct feeds with bounded concurrency; inspect RSSHub error details and application parsing failures.
4. Apply verified targeted fixes, checking all affected callers, tests, fixtures, configuration, and exports before code changes.
5. Recheck affected subscriptions through application refreshes and confirm successful persistence timestamps and container stability.
6. Append the actual outcome, remaining upstream failures, rollback information, and any deviations.

## Risks / open questions

- Recreating the container briefly interrupts RSSHub and clears its memory cache; the existing image remains available for rollback.
- External websites can rate-limit or change markup; a successful one-off probe does not prove lasting recovery.
- Direct podcast feeds may have independent transport or malformed XML errors unrelated to RSSHub.
- The application has a 10-second fetch timeout; measure cold requests before deciding whether a code change is justified.
- Keep the loopback-only binding, 320 MiB hard memory cap, and existing authentication boundaries.

## Confirmed repair scope

- Both Zaobao routes return valid feeds after 13–14 seconds, while the shared parser cancels after 10 seconds. Raise its bounded fetch timeout to 30 seconds, preserving shorter caller deadlines. Callers are cache refreshes (poller, warming, reads) and feed add/edit validation. Add offline transport/deadline regression coverage in `internal/feed`; no model, schema, fixture, or export changes.
- Jiemian's commercial/news category pages render article cards but their legacy load-more API intermittently returns 404. A Referer sometimes makes it succeed, so this is not a permanently removed endpoint. Build a small local image from the pinned official release with an exact-match patch: send the category Referer and, on that 404 only, reuse the rendered category cards through RSSHub's existing parser and full-text extractor. Preserve route URLs and feed IDs. Fail the build if the bundled source no longer matches; do not silently carry patches across upgrades.
- Before changing the container config, check the patched image's feed output, resource limits, and rollback path. Record its rebuild/update commands in the existing scripts README.
- Investigate 36kr's verification response separately; do not substitute a different ranking or publication stream. It recovered after RSSHub's existing WAF-cookie handshake; treat it as intermittent until repeated cold requests pass.
- The two `feed.xyzfm.space` podcast URLs redirect to an IP-ACL denial page (HTML with a 200 response), explaining `Failed to detect feed type`. Switch the existing feed rows through PATCH to the verified Xiaoyuzhou RSSHub routes for the same shows. Before switching, patch RSSHub episode links to retain the original `?utm_source=rss`: article IDs hash the complete link, so this preserves existing stars and playback positions instead of creating duplicates. Compare returned links against persisted rows. RSSHub exposes the newest 15 episodes; older persisted articles remain available.
- Start RSSHub directly with Node's header-size flag so its existing `NODE_OPTIONS=--max-old-space-size=256` survives; upstream `npm start` overwrites that variable. Preserve the 320 MiB hard container cap.

## Complexity

Medium: operational upgrade plus targeted upstream compatibility and fetch deadline repairs.

## Outcome

Completed on 2026-11-21. RSSHub and the backend changes are deployed locally. Delivery follows the requested direct-to-main commit and push workflow.

### Upgrade and repairs

- Upgraded official RSSHub revision `2340a032022c4382b2f5a165a2e3d3665ec06d89` (2026-11-15) to release `v2026.11.21-8713.53e83fa`, revision `53e83fae40ca35c0e77639634e2d261dd8133968`. The running locally built image pins the official digest and applies the two documented compatibility patches.
- Jiemian: adding Referer alone was inconsistent. The legacy API still returned 404 during staged testing; the rendered-category fallback executed successfully. Commercial/news/technology routes returned valid feeds with 20/16/9 items and full article bodies in that test.
- Zaobao: measured valid cold feeds at 13.63s and 13.02s before the timeout repair. Raised the shared Go fetch budget from 10s to 30s while preserving cancellation and shorter caller deadlines. After deployment, a fresh China feed took 11s and successfully persisted, demonstrating recovery beyond the old limit.
- Podcasts: replaced the two blocked xyzfm subscription URLs through the validated PATCH API, retaining feed IDs:
  - `1779940295895`: `rsshub://xiaoyuzhou/podcast/665ff98194977a26ef5490e8`.
  - `1eb9f9e0-dc17-4c7a-8961-040cb7ab7d68`: `rsshub://xiaoyuzhou/podcast/5e4ee557418a84a0466737b7`.
- Each new podcast feed contained 14 existing episodes with byte-identical article links/IDs plus one new episode. After application persistence, all 70/657 original rows remained, counts became 71/658, and all starred flags and playback positions (including six stored resume positions for the second show) matched the pre-edit snapshot.
- 36kr: initial cold requests received a WAF page, then RSSHub's existing cookie handshake recovered the original hot-list route. Repeated application requests succeeded; no ranking substitution or challenge-specific application code was added.
- Started Node directly to preserve the existing 256 MiB heap cap. Kept the loopback binding and 320 MiB memory/swap limits. Final container sample was 157.7 MiB / 320 MiB, with zero restarts and no OOM kill.

### Validation

- `make -C server-go check`: formatting, go vet, staticcheck, and all offline backend suites passed, including fetch deadline and cancellation regressions.
- Repository formatting/autofix followed by `npm run fmt:check`, `npm run lint`, and `git diff --check`: passed.
- Built the patched image, tested it on temporary loopback port 1201, then removed the staging container.
- All 49 subscriptions obtained persisted success timestamps after the backend deployment, including all nine sources highlighted in the report. One additional YouTube TLS handshake timeout recovered on retry before the final check.
- Loopback health returned `200 ok`; public API without a session still returned 401.
- Deployed only the backend binary for the timeout change; client assets were not rebuilt because no UI changed.

### Rollback evidence

- Previous official image remains locally available as `sha256:4d354c13613048e9be9be7d14436ae520d7178f6b684cf24b2c463c755417564` (untagged; do not prune before rollback decisions).
- Previous deployed backend binary: `/var/folders/80/dlqgdmjj5c94mwz_8l_ry1l80000gn/T/feedoverflow-fetch-repair-rollback-u6x7kox_/feedoverflow`.
- Pre-switch feed URLs and complete podcast ID/star/playback snapshot: `/var/folders/80/dlqgdmjj5c94mwz_8l_ry1l80000gn/T/podcast-feed-repair-state-_hw6c6jc/before.json`.
- Do not revert to an unpatched RSSHub image while keeping the new podcast routes: losing `?utm_source=rss` would create duplicate article IDs. Retain that link patch when backing out the Jiemian change; restore original podcast URLs only after their upstream is accessible and passes feed validation.

### Skipped and remaining risks

- No frontend changes, browser automation, VPS/proxy changes, database schema changes, subscription deletions, or changes to unrelated feeds.
- The broad live-network integration suite was skipped; the deployed application's actual persistence path was checked for all subscriptions instead.
- Historical 24-hour failure counts remain until their log window expires. A new successful refresh resolves the current failure; it does not erase past errors.
- Xiaoyuzhou supplies only its latest 15 episodes, so an outage spanning more than that window could miss episodes never fetched. Previously persisted history is retained.
- 36kr verification pages and transient upstream/TLS failures can recur. This run proves current recovery, not permanent upstream availability.
- Future RSSHub upgrades require rebuilding and reviewing exact-match patches against the newly pinned source.

### Manual checks

1. Open `https://rss.royl.uk:8443`, sign in, and open Manage feeds; confirm recent fetches for the affected subscriptions.
2. Open the Jiemian commercial/news feeds and inspect an article body.
3. Open the two podcasts: confirm the new episodes appear and resume an existing episode with saved progress.
4. Regenerate the RSS audit report; distinguish remaining historical failure counts from the latest-success evidence.
