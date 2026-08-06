# Plan: per-feed LLM title translation

## Goal

Add an opt-in, per-feed "标题翻译" switch (default off). When it is on, newly fetched article
titles are translated to Chinese by an OpenAI-compatible chat-completions endpoint and stored
alongside the original. The list panes show the translation as the title, with the original
underneath in small grey text; the original is never lost or overwritten.

The LLM endpoint is configuration, not a dependency: base URL, model, and API key are set from the
settings UI, so DeepSeek is a default value rather than something the code knows about.

## Scope

In:
- `feeds.translate_enabled` + `article_states.title_zh` columns.
- `llm_config` table (single row) + `GET`/`PATCH` `/api/llm/config` + `POST /api/llm/config/test`,
  driven by a 翻译服务 section in SettingsModal.
- `internal/translate`: one OpenAI-compatible client translating **one title per request**, plus a
  local "already Chinese" short-circuit.
- A standalone 30s worker in `internal/jobs` that translates pending titles. Decoupled from the
  fetch/persist chain (see Decisions).
- UI: a translate toggle per feed row in ManageFeedsModal (same shape as the push bell);
  two-line title rendering in ArticleList + ArticleReader.
- Search (`/api/search`) matches `title_zh` as well as `title`.

Out:
- Translating `summary` or `content`. Titles only — that is what the list panes render, and a body
  translation is a different order of cost and latency.
- Batching several titles into one request. See Decisions: the token saving is worth ~¥0.02/day and
  costs the single most dangerous failure mode in the feature.
- Any provider abstraction. There is one client speaking `POST {base_url}/chat/completions` with a
  bearer token; DeepSeek, OpenAI, Moonshot, 智谱, SiliconFlow, OpenRouter, Ollama and vLLM all
  answer it. A provider that does not is out of scope, not a reason for an interface.
- Per-feed model/endpoint overrides. One config for the whole app.
- A user-triggered "translate this one now" button. Translation is a background property of a feed,
  not an action.
- Translating anything older than the pending window (see Decisions). A `cmd/` one-shot is the
  answer if that is ever wanted.
- MCP tool changes. An agent reads English fine; `titleZh` rides along in the Article JSON it
  already gets.
- Push notification bodies. They come from `store.NewArticle` in the poller and stay
  original-language: the notification fires before the worker has necessarily run, and chasing that
  ordering would couple push to translation for no gain.

## Decisions

### One title per request, not a batch

Batching 20 titles saves tokens and costs the one failure that must never happen: if the model
drops or merges an element, every following translation is written onto the **wrong article** —
silently, permanently, and indistinguishable from a correct result. Defending against that needs an
index-keyed wire protocol, a tolerant JSON decoder, partial-failure semantics inside a batch, and
tests for all of it.

One title per request makes misalignment structurally impossible: the request contains one title,
the response is one string. The protocol, the decoder, the batch semantics and their tests all
disappear.

The cost is the system prompt resent per call: ~60 tokens × ~300 new articles/day ≈ 18k extra input
tokens/day, on the order of ¥0.02/day. Throughput is a non-issue — 20 sequential calls per 30s tick
is 40/min, far above any real publishing rate. Batching here was premature optimization buying
nothing.

### Pending rows: a recency window, not a watermark and not `title_zh IS NULL`

`WHERE title_zh IS NULL AND translate_enabled = 1` alone is a trap: every existing row has
`title_zh` NULL, so it matches the whole historical table forever.

A per-feed `last_translated_ts` watermark (the push pattern) fixes that but drags in a column, seed
logic on enable, a stamping call, advance-on-success/give-up rules, and a per-feed loop. A fixed
recency window fixes it with no state at all:

```sql
SELECT a.article_id, a.title
FROM article_states a JOIN feeds f ON f.id = a.feed_id
WHERE f.translate_enabled = 1 AND a.title_zh IS NULL AND a.pub_ts > ?   -- now − 7d
ORDER BY a.pub_ts DESC LIMIT 20
```

`idx_article_states_pub (pub_ts)` already exists, so no new index. One global query replaces the
per-feed fan-out. Enabling the switch backfills the last 7 days automatically — no separate
backfill decision — and the historical backlog is out of range by construction.

Disabling leaves every stored `title_zh` alone. Rendering keys off `article.titleZh` being
non-empty, not off the feed flag, so turning the switch off stops new translations without blanking
existing ones — a switch that hides existing data reads as data loss.

### `title_zh`: NULL means pending, `''` means settled

- `NULL` — not translated yet, or the request failed. Eligible next tick while inside the window.
- `''` — settled, no translation will come: the title was already Chinese, or the model returned
  nothing usable for it.
- non-empty — the translation.

The UI treats NULL and `''` identically (render the original). Only the worker distinguishes them.

### Failure semantics fall out of that, with no counters

- **Request succeeded** → write the translation, or `''` if the response was empty/unusable. Settled
  in one pass, so a title the model refuses can never be retried forever.
- **Request failed** (network, timeout, 5xx, bad status) → write nothing; retried next tick until
  the article ages out of the 7-day window. That is the correct response to a transient outage, and
  it is self-limiting.

No retry counter, no give-up rule, no watermark bookkeeping. Failures log at warn.

### Skip Chinese titles locally

Before any call, count CJK runes (`unicode.Is(unicode.Han, r)`). Above 30% of the letter runes the
title is already Chinese: write `''` and never send it. ~15 lines that make a Chinese feed with the
switch accidentally on cost exactly nothing.

### Config lives in its own table, not `settings` and not the environment

`GET /api/settings` serializes the whole `settings` table, so a secret there leaks on any ordinary
settings read — which is why the VAPID keypair got `push_keys`. That rules out `settings`, but not
the environment; environment variables were rejected separately, because a model or endpoint change
would then cost a `.env` edit plus a `launchctl kickstart`, and cheap switching is the entire point
of not being married to one provider.

```sql
CREATE TABLE llm_config (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL,
  api_key  TEXT NOT NULL,
  model    TEXT NOT NULL
);
```

- `GET /api/llm/config` → `{"base_url", "model", "key_set": bool}`. **The key is never returned**,
  only whether one exists. A stolen session can overwrite it but cannot read it.
- `PATCH` takes optional `base_url` / `model` / `api_key`; an absent `api_key` preserves the stored
  one, so changing the model does not require re-typing the secret.
- Seeded on first run with `https://api.deepseek.com`, `deepseek-chat`, empty key. Empty key = off.
- `POST /api/llm/config/test` translates one fixed string through the **real** client path and
  returns a normalized result. Not a bespoke health check — the point is to exercise what the worker
  will actually do.

`base_url` is now settable over HTTP, which it was not as env config. Two guards: require an
`https://` scheme or a loopback host, and never echo an upstream response body to the client (the
test endpoint returns 认证失败 / 无法连接 / 模型不可用, not the remote's bytes). Beyond that, whoever
holds the login credential is the operator — the same trust level that already lets the settings
panel repoint `rsshub_base_url`.

### The worker reads config every tick, not at boot

Config is mutable at runtime, so the `Push == nil` boot-time disable does not transfer. The worker
always runs; each tick it loads `llm_config` and returns immediately when the key is empty. One
single-row read per 30s, and a key pasted into settings takes effect within one tick, no restart.

### A standalone worker, not the fetch chain

`internal/cache`'s refresh chain is deliberately untouched by features (push reads a watermark
rather than inspecting what persist inserted — see `docs/plan-push-notifications.md`). Translation
keeps that rule and goes further: push hangs off the poller because an on-demand refresh must *not*
notify, whereas an article fetched by an on-demand read deserves translation just as much as a
polled one. A standalone worker covers every fetch path (poller, `EnsureFresh`, startup warming)
with one code path and keeps upstream latency off the request path entirely — a slow or dead LLM
endpoint degrades to "no translation yet", never to a slow list response.

### Untrusted input

RSS titles are attacker-controlled text entering a prompt. The blast radius is one wrong
translation string, and the mitigations are free: the title goes in as the user message with the
instruction fixed in the system message, the response is accepted only as a plain string, truncated
to 500 chars, stored as data, and rendered as React text (already escaped) — never HTML. No tool
use, no chaining, nothing the model can reach.

### Storage: a column on `article_states`, not a side table

A side table means a JOIN in all 13 list queries built from `articleColsNoContent`. A column means
one more scan slot in `scanArticleRows`, and every caller follows automatically.

The measured perf note in `CLAUDE.md` says a list query already pays the full overflow-page walk
because it references columns stored *after* `content` (`author`, `audio_url`, `is_starred`,
`content_updated_at`). `ALTER TABLE ADD COLUMN` appends `title_zh` after those, inside a chain
already being walked: **no additional page reads**, only the materialization of one short string per
row. The unclaimed column-order win described there is unaffected — already blocked by the four
columns above; this adds a fifth.

## Steps

1. **Schema.** `db.go`: add `llm_config` to the base `CREATE TABLE` block (seed the row with the
   DeepSeek defaults + empty key); `execIgnore` two `ALTER TABLE`s — `article_states.title_zh TEXT`
   and `feeds.translate_enabled INTEGER DEFAULT 0` — appended at the end of the existing migration
   chain (order is load-bearing). No new index, no config.go change.

2. **Model + read path.** `model.Feed` gains `TranslateEnabled bool \`json:"translate_enabled"\``;
   `model.Article` gains `TitleZh string \`json:"titleZh"\`` (empty string, not null — the client
   only tests truthiness). `articles.Row` gains `TitleZh sql.NullString`; append `title_zh` to both
   `articleCols` and `articleColsNoContent` and add the scan slot in `scanArticleRows`.
   `RowToArticle` copies it unconditionally (~30 bytes; no `withTitleZh` flag). `ListFeeds` /
   `GetFeed` select `COALESCE(translate_enabled, 0)`.

3. **`internal/translate`** (~120 lines). `Translator` interface
   (`Translate(ctx, Config, title string) (string, error)`) so jobs tests use a fake and nothing
   offline touches the network. `client.go`: the OpenAI-compatible call (30s timeout, bearer auth,
   system prompt in one const, response trimmed of quotes/whitespace and truncated).
   `detect.go`: `IsMostlyChinese(string) bool`. `Check(ctx, Config) error` for 测试连接, calling
   `Translate` on a fixed string and normalizing the error. Unit tests: detector thresholds,
   response trimming/truncation, error normalization (401 / connection refused / 404 model).

4. **`internal/store/translate.go`** (3 functions). `LLMConfig(r)` / `SaveLLMConfig(w, ...)` (partial
   update, key preserved when absent); `PendingTranslations(r, cutoff, limit)` → the window query
   above returning `[]PendingTitle{ArticleID, Title}`; `SaveTranslation(w, id, text)`.
   `SetFeedTranslate(w, id, enabled)` goes in `feeds_write.go` next to `SetFeedPush`.

5. **`internal/jobs/translator.go`** (~60 lines). `Runner.Translator translate.Translator`,
   `StartTranslator(ctx)` on a 30s tick under `safeRun`. Per tick: load config → return if key empty
   → `PendingTranslations(now−7d, 20)` → for each row: Chinese → save `''`; else translate → save
   result or `''`; on request error log and skip. Wire into `Start()` and `main.go`.

6. **API.** `patchFeed` gains `TranslateEnabled *bool` — the same optional-pointer shape as
   `PushEnabled`, so a rename-only body still cannot clear it. New `internal/httpapi/llm.go` with
   `GET`/`PATCH` `/api/llm/config` and `POST /api/llm/config/test`, mounted on both routers.
   `search.go` extends its LIKE to `title_zh`.

7. **Client.** `types.ts`: `Feed.translate_enabled?`, `Article.titleZh?`, `LLMConfig`. `store.ts`:
   pass `translate_enabled` through `updateFeed`; load the LLM config so ManageFeedsModal knows
   whether a key is set. `SettingsModal`: a 翻译服务 section (API 地址 / 模型 / API Key with a 更改
   affordance, since the current value is never fetched, plus 测试连接), following the existing
   rsshub section's save/saved/error pattern. `ManageFeedsModal`: a `Languages` (lucide) toggle next
   to the bell, same visibility rule (`hovered || translateOn || isMobile`), disabled with a tooltip
   pointing at settings when `key_set` is false. `ArticleList`: render `article.titleZh ||
   article.title` in the title slot, and when `titleZh` is non-empty add a 12px
   `var(--text-tertiary)` line with the original — in **both** branches (`hideFeedName` and the
   feed-name branch). `ArticleReader`: same treatment on the header title.

8. **Tests + docs.** Offline jobs tests with a fake translator: Chinese title short-circuits without
   a call; a successful translation is stored; an empty response stores `''`; a failed request stores
   nothing and the row is picked up again next tick; a row older than the window is never selected;
   an empty key no-ops. An httpapi test asserting `GET /api/llm/config` never contains the key. An
   `itest`-tagged live test. A vitest for the two-line row. Update `CLAUDE.md` (schema, API table,
   feature note) and append `## Outcome` here.

## Files touched

```
server-go/internal/db/db.go                 llm_config + 2 ALTER
server-go/internal/model/model.go           +2 fields
server-go/internal/articles/articles.go     Row.TitleZh, RowToArticle
server-go/internal/store/store.go           articleCols(NoContent), scanArticleRows, ListFeeds
server-go/internal/store/feeds_write.go     GetFeed, SetFeedTranslate
server-go/internal/store/translate.go       NEW (llm_config + pending window)
server-go/internal/translate/               NEW (client.go, detect.go + tests)
server-go/internal/jobs/translator.go       NEW
server-go/internal/jobs/jobs.go             Runner.Translator, Start
server-go/internal/httpapi/feeds.go         patchFeed
server-go/internal/httpapi/llm.go           NEW
server-go/internal/httpapi/httpapi.go       routes
server-go/internal/httpapi/search.go        LIKE title_zh
server-go/main.go                           construct translator
client/src/types.ts                         Feed/Article fields, LLMConfig
client/src/store.ts                         updateFeed patch, llm config
client/src/components/SettingsModal.tsx     翻译服务 section
client/src/components/ManageFeedsModal.tsx  toggle
client/src/components/ArticleList.tsx       two-line title
client/src/components/ArticleReader.tsx     two-line title
```

## Risks / open questions

- **The 7-day window is a real cutoff.** A feed switched on today gets 7 days of backfill and no
  more; an article that fails for 7 straight days is never translated. Both are deliberate — the
  alternative is per-row state — but if a feed publishes something long-dated the translation
  silently never arrives. Acceptable: the original title is always there.
- **Provider variance.** Error-body shapes and rejected parameters differ across
  OpenAI-compatible endpoints. Dropping batching removed the worst of it (no `response_format`, no
  JSON parsing at all), and 测试连接 exists so what remains surfaces at config time rather than as
  silently missing translations.
- **`base_url` is settable over HTTP.** Restricted to https/loopback, upstream bodies never echoed
  back. Residual: a session holder can point the app at an endpoint of their choosing — the same
  trust level as `rsshub_base_url`, which settings already exposes.
- **Cost.** ~300 new articles/day × (~80 in + ~30 out) tokens ≈ ¥0.05/day at DeepSeek's published
  rates. Unverified — check the actual bill after a week rather than trusting this line.
- **Translation quality on headlines.** Headlines are terse, pun-heavy and context-free; some
  translations will be bad. That is exactly why the display choice was 译文主、原文次 — the original
  stays on screen as the check.
- **SSRF guard.** Deliberately not applied to the LLM call — `internal/ssrf` guards fetches of URLs
  coming from subscriptions and feed items. The LLM endpoint is operator config, guarded by the
  scheme/host restriction instead.

## Manual test steps

1. 设置 → 翻译服务 shows `https://api.deepseek.com` / `deepseek-chat` / empty key. Paste a key, save,
   click 测试连接 → 成功.
2. Reload and reopen 设置: the key shows `••••••••` with a 更改 button, never the value. Confirm
   `curl localhost:4002/api/llm/config` contains no `sk-`.
3. 管理订阅源: hover an English feed's row → a 译 icon appears next to the bell. Click it; the icon
   stays lit after the hover ends.
4. Within ~30s, reload that feed's list: recent rows show a Chinese title with the English original
   in small grey text below. Articles older than 7 days stay English.
5. Publish upstream (or wait for a poll) → the new row is translated within ~30s.
6. Turn the toggle off → existing translations remain; a newly published article stays English.
7. Turn it on for a Chinese-language feed → nothing changes and the log shows no API calls.
8. Search a Chinese word that appears only in a translated title → the article is found.
9. Set 模型 to a nonexistent name, save, 测试连接 → 模型不可用; new articles stop getting translations
   with no other breakage. Restore.
10. Repoint API 地址 at a second provider (Moonshot / OpenRouter / local Ollama) with its key and
    model → translations resume, no restart.
11. Clear the API Key → the worker no-ops and the 译 toggle greys out with a tooltip.

## Complexity

**Low-Medium.** Every piece has a working precedent in the repo (per-feed toggle = push; background
worker = poller/maintenance; single-row secret table = `push_keys`; nullable article column =
`play_position`). The backend is small — one 60-line worker, a ~120-line client, three store
functions — because dropping batching and the watermark removed the only intricate parts. The
remaining bulk is the settings UI section and the shared column list that 13 queries depend on,
both mechanical.

## Outcome

Implemented as planned. `cd server-go && make check` (fmt + staticcheck + tests) and
`npm run fmt:check && npm run lint`, `cd client && npm run typecheck && npm test` all pass;
the client suite went 197 → 204 tests.

Deviations from the plan:

- **`SetFeedTranslate` lives in `store/feeds_write.go`, not `store/translate.go`** — next to
  `SetFeedPush`, which it mirrors. `store/translate.go` holds only the config accessors and the
  pending-window query.
- **`translate.Checker` was split out of `Translator`.** The plan had one interface; the handler
  for 测试连接 takes only `Check`, so the request path cannot be handed something meant for the
  worker. `*translate.Client` implements both.
- **`clean()` rejects a runaway answer** (>4× the input in runes) as "nothing usable" rather than
  storing it. Not in the plan, but models routinely answer a translate instruction with an
  explanation, and an essay in the headline slot is worse than no translation. Covered by
  `TestCleanRejectsRunawayAnswer`.
- **A failing request aborts the rest of the tick** instead of continuing to the next title. A
  failure almost always means the endpoint is down, and the remaining 19 titles would each burn
  the full 30s timeout to reach the same conclusion. `TestTranslatorFailureAbortsTick` pins it.
- **`ValidateBaseURL` accepts `http://` only for loopback**, as planned, and this is exercised by
  `TestLLMConfigRejectsPlaintextRemoteBaseURL` including the cloud-metadata address.
- **SettingsModal grew shared style constants** (`sectionStyle` / `labelStyle` / `inputStyle` /
  `primaryBtnStyle` / `secondaryBtnStyle`). Three more fields' worth of the file's existing inline
  style blocks would have been unreadable; the RSSHub section was migrated onto the same constants
  where the object was already identical.
- **测试连接 is disabled while there are unsaved edits** (tooltip 请先保存). It tests what is
  *stored*, so testing a dirty form would report on the wrong config.
- **The `itest`-tagged live test was not written.** Everything it would cover offline is covered by
  `internal/translate`'s httptest suite; what it would add is confirmation that a specific real
  provider behaves, which 测试连接 gives interactively and more usefully. Flagged rather than
  silently dropped — manual step 1 is the substitute.

Not yet verified: the cost estimate (~¥0.05/day) and real-provider behaviour beyond DeepSeek. Both
need a week of live use, not a test.

### Post-implementation fix: the first API key was never sent

Found in local testing: 测试连接 stayed greyed out no matter what was entered.

`handleSaveLLM` attached `api_key` to the PATCH only when `editingKey` was true, and `editingKey`
is set only by clicking 更改. But 更改 exists only once a key is *stored* — the initial empty state
shows the input directly. So the very first key entered was silently dropped: the PATCH carried
`base_url` and `model` only, the server kept `api_key` empty, `key_set` stayed false, and the test
button's `!keySet` guard never lifted.

Fixed by deriving `keyEditable = !keySet || editingKey` and using it both to render the input and to
decide whether the save carries the key — one condition instead of two that could disagree.
`src/__tests__/SettingsModal.test.tsx` now pins all four states (first key sent, model-only edit
omits the key, 更改 re-sends it, dirty form disables the test button); the first of those fails
against the old code.

## Revision: global switch instead of a per-feed opt-in

The per-feed toggle was retired before this ever shipped. The reasoning that put it there was
borrowed from push, and it does not transfer.

**Why per-feed did not hold up.** Its main justification was "don't spend money on Chinese feeds" —
and `IsMostlyChinese` already solves that, for free, with no clicks: a Chinese feed with the switch
on issues zero requests and changes nothing on screen. Push genuinely needs per-source decisions
(which feeds are worth interrupting you), but whether a feed needs translating is a property of its
script, which is *detectable* rather than something to declare 30 times. Cost is not a granularity
driver either at ~¥0.1/day fully on. The one real residual — "this English feed I read fine, the
extra line is noise" — did not justify a column, a PATCH field, a control on every row, and their
tests. Adding it back later is purely additive.

**The future-capabilities argument cuts the same way.** Body translation and summarisation are
~100× the tokens of a title (~4000 vs ~40 per article), and unlike titles they are only needed for
the article you actually open — a list pane renders titles, not bodies. So they want a different
mechanism entirely: on-demand from the reader, where the click *is* the switch and cost is bounded
by what you read. They would not reuse a feed flag. Their output also does not belong on
`article_states`: body-sized columns are exactly what the `articleColsNoContent` perf note warns
about, so a side table (`article_ai(article_id, kind, text, …)`) is the right home, never joined by
list queries. Recorded here rather than built — no abstraction was added for it.

**Backfill on enable was cut to 24h, not to zero.** Zero has a real failure mode: feed items
routinely carry a `pub_date` hours older than the moment they are fetched, so a watermark pinned at
`now` would let the next several polls arrive untranslated with no explanation. 24h is ~300 titles,
on the order of ¥0.05, and makes "switch it on and the visible list translates" true. (For scale:
the 7-day backfill this replaced was only ~¥0.1–0.3 one-time, so this was never really a cost
decision.)

**The 7-day window stays, with a different job.** It was doing two things; only one was backfill.
The other is the give-up bound: a failed request writes nothing and the queue is newest-first, so a
permanently-failing row would otherwise sit at the head forever and block everything behind it. The
cutoff is now `max(translate_since, now − 7d)` — two bounds, one job each, same query.

### Changes

- `feeds.translate_enabled` dropped; `llm_config` gains `enabled` + `translate_since`.
  `InitSchema` carries a previously-set per-feed flag over to the global switch before dropping the
  column (`adoptFeedTranslateFlag`), so a DB from the intermediate build does not silently lose it.
- `store.SetFeedTranslate`, the `translate_enabled` field on `PATCH /api/feeds/:id`, and
  `model.Feed.TranslateEnabled` are gone. `PendingTranslations` no longer joins `feeds` — it is now
  a plain indexed scan over `pub_ts`.
- `store.TranslateConfig` wraps the connection (`translate.Config`) with `Enabled`/`Since`, so the
  client package still knows nothing about policy.
- `GET /api/llm/config` gains `enabled`; `PATCH` accepts it. The watermark is stamped **only on an
  off→on transition** (`CASE WHEN enabled = 1 THEN translate_since ELSE ? END`) — the settings form
  sends `enabled` with every save, so stamping unconditionally would let an unrelated model edit
  move the watermark forward and silently skip everything published since.
- UI: the per-row 译 toggle is gone from ManageFeedsModal; SettingsModal's 翻译服务 section gains a
  「翻译文章标题」 checkbox, disabled until a key is stored.
- Tests: `internal/db/migrate_test.go` covers the adoption path, a fresh DB staying off, and
  InitSchema idempotence; `internal/jobs` gains a watermark test; `internal/httpapi` gains three
  (stamp 24h back, re-stamp on re-enable, no move on a no-op enable).
