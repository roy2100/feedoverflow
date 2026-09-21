# Plan: On-demand article summary + body translation, and OPML export

## Goal

Two independent features, shipped as two commits:

1. **Article AI (on-demand)** — from the reader, a user can ask for a Chinese **summary** of the
   open article, or a Chinese **translation of its body**. Both run through the existing
   `llm_config` endpoint (the same OpenAI-compatible client that translates titles), are
   generated only when asked, and are persisted in a side table so a second request is instant.
2. **OPML export** — `GET /api/feeds/export-opml` returns the subscription list as an OPML
   file; a button in the 管理 → 订阅源 panel downloads it. Import has existed since the start;
   this is the exit door.

## Scope

### In

- `article_ai(article_id, kind, source_hash, model, content, created_at)` side table,
  `PRIMARY KEY (article_id, kind)`. Kinds: `summary`, `translation`.
- `POST /api/articles/:id/ai` with `{ kind, text }`: the **client sends the plain text it is
  currently showing** (RSS body, or the Readability 全文 when loaded — that one is never
  persisted server-side, so the client is the only party that has it). The server hashes the
  text; a stored row with the same hash is returned as-is, otherwise it generates, upserts and
  returns. Response is **SSE** (`text/event-stream`): one `data:` line per generated piece,
  then `{"done":true}` — a local 8B model takes a minute or more on a long article and the
  reader must show progress rather than a spinner.
- No separate GET for the cached row: the POST covers the reader and returns a cached row
  without calling the endpoint.
- Chunked translation: the body is split at blank lines into pieces of ≤ ~1200 runes (long
  paragraphs split on sentence ends), one request per piece, sequential, each answered with a
  bare translation. Output pieces are joined with blank lines. Summary: one request over the
  first ~6000 runes.
- Two new fixed system prompts in `internal/translate` (byte-identical across calls, same rule
  as the title prompt). The text goes only in the user message. Output validation: empty →
  error (not persisted, so a retry is possible); translation piece > 3× source runes →
  rejected as an explanation.
- Reader: two entries in the overflow `ActionMenu` — `AI 摘要` and `翻译正文`. Summary renders
  as a boxed block above the body with a dismiss control; translation swaps the body for the
  translated paragraphs with a `原文 / 译文` toggle. `翻译正文` is hidden when the shown text is
  already mostly Han. Both entries are hidden until the store knows an endpoint is configured
  (`GET /api/llm/config` → `key_set` + `base_url` + `model`; the global `enabled` switch is the
  *title-worker's* intent and does not gate an explicit click).
- Maintenance: orphan cleanup also drops `article_ai` rows whose article is gone.
- `GET /api/feeds/export-opml` (`application/xml`, `Content-Disposition: attachment`),
  round-trips through `feeds.ParseOPML`. Button in `FeedsPanel`, above the list, next to the
  device row. Download is fetch → blob → `<a download>` so an iOS standalone PWA never
  navigates away.
- Tests: store round trip + hash-miss regeneration; handler SSE framing with a fake generator;
  chunker on paragraph and sentence boundaries; OPML round trip; a client test for the
  summary/translation reader states.

### Out

- No MCP tools for either (not asked; export is trivial to add later).
- No "regenerate" control. A stale cache only arises when the shown text changes (RSS body →
  全文), and the hash handles that.
- No streaming of tokens *within* a piece — piece granularity is enough progress.
- No change to `article_states`; CLAUDE.md forbids a body-sized column there.
- No per-feed configuration.

## Steps

1. Schema: `article_ai` table in `internal/db`; store functions `ArticleAI(r, id, kind)` and
   `SaveArticleAI(w, row)`; maintenance purge.
2. `internal/translate`: `Summarize(ctx, cfg, text)` and `TranslateBody(ctx, cfg, text,
   emit func(piece string) error)` on `Client`, plus the chunker and the two prompts; a
   `BodyWorker` interface for the handler seam. Its HTTP client gets a longer per-request
   timeout (120 s) than the title client's 30 s — a 1200-rune piece is several hundred output
   tokens on a local model.
3. `POST /api/articles/:id/ai` handler with SSE writer; 503 when no `Translator`, 400 on bad
   kind / empty text, 409-style `{"error"}` event when the endpoint is not configured.
4. Client: `lib/articleAI.ts` (SSE reader over `fetch`), store flag `llmReady`, reader menu
   items + summary block + translation view, Han check for hiding `翻译正文`.
5. Export: `feeds.BuildOPML(feeds)`; handler; `FeedsPanel` button.
6. `make check`, `npm test`, `npm run typecheck`, `npm run lint`; two commits.

## Risks / open questions

- **Latency on the local model.** Title translation measured 1.2–2 s warm. A 30-piece article
  is 1–2 min. SSE keeps it honest; the client shows pieces as they land. Caddy flushes SSE
  immediately by default; `main.go` sets no `WriteTimeout`, so nothing on the path cuts a long
  response.
- **Context window.** Ollama's default `num_ctx` is 4096. Pieces of ≤ 1200 source runes plus a
  short system prompt stay well inside it without changing the Modelfile; the summary input is
  capped at 6000 runes (~1500 tokens) for the same reason. Raising `num_ctx` in
  `Modelfile.translate` would allow a longer summary input and is left as a later, manual step.
- **Formatting loss.** Translation output is plain paragraphs — links, images and headings from
  the source are not preserved. Deliberate: asking an 8B model to round-trip HTML is where it
  fails, and the original is one toggle away.
- **Summary vs. translation of the 摘要 line.** The failure catalogued for Hunyuan (translating
  the summary instead of the title) does not apply: these prompts carry one text and one task.
- Assumption: `enabled` (title switch) does not gate on-demand actions. If the user wants one
  switch for all LLM use, flip `Ready()` → `Active()` in the handler.

## Complexity

Medium. Backend is mostly additive; the one non-trivial piece is SSE + the chunker. Client
work is in one already-large component (`ArticleReader.tsx`).

## Outcome

Shipped as two commits, in the planned shape. Deviations from the plan:

- **Store name**: `store.GetArticleAI` / `SaveArticleAI` / `ArticleExists` / `PurgeOrphanAI`
  (`internal/store/article_ai.go`); the purge runs at the end of `RunMaintenance`, after both
  the orphan cleanup and the size cap, so one sweep covers either source of deletions.
- **Client refactor**: `translate.Client.post` (title path) now delegates to a new
  `chat(ctx, cfg, httpClient, msgs, disableThinking, maxTokens)`; the body methods call the
  same function with their own prompts and a 120 s `BodyHTTP` client. The title path's wire
  shape is unchanged and still pinned by its tests.
- **Error surface**: everything before the first SSE frame is a JSON status (400 bad kind /
  blank text, 404 unknown article, 503 no worker *or* no endpoint configured — the latter
  with a 「请先在设置中配置翻译服务」 hint). After the stream starts, failure is an `error` frame
  reduced to the normalized translate messages (`userFacing`), so a dial error's host name
  never reaches the browser.
- **Reader state**: a translation is dropped when 全文 is loaded or restored (the original it
  was a translation of changed); the summary stays. The server keeps both, so asking again
  replays. `AI 摘要` toggles (second click dismisses); `翻译正文` toggles between 译文 and 原文
  once a translation exists, and re-requests only after an error.
- **Han check** exists on both sides: the reader hides 翻译正文 via `isMostlyHan` (same 30%
  rule as `translate.IsMostlyChinese`); the server refuses with `ErrAlreadyChinese`; a
  letterless or Chinese *piece* inside a foreign body is passed through without a request.
- **OPML export** landed exactly as planned: `feeds.BuildOPML` (round-trip pinned against
  `ParseOPML`), `GET /api/feeds/export-opml` as `text/x-opml` attachment, and a 导出 OPML
  button in the 订阅源 footer (hidden with no feeds) that downloads via fetch → blob.
- Not done, still open: raising `num_ctx` in `Modelfile.translate` would let the summary see
  more than 6000 runes; left as a manual step since it changes the model artifact.
