# Plan: move article LLM calls from DeepSeek to GPT-6-Luna through magpie

## Goal

Point `llm_config` (title translation, AI summary, body translation) at `codex/gpt-6-luna`, served
by the local magpie gateway at `http://127.0.0.1:3425/v1`.

magpie advertises this model's native endpoint as `/v1/responses`, so the open question was whether
`internal/translate` needs a Responses client. Measured below: it does not.

## Scope

In:
- `PATCH /api/llm/config` on the loopback API: `base_url`, `model`, `api_key`.
- A private backup of the existing `llm_config` row, because `GET` never returns the key and the
  `PATCH` overwrites the only copy in the database.
- Correct the `CLAUDE.md` statement that the endpoint runs on Ollama.

Out:
- Any change to `internal/translate`. It stays one plain `/chat/completions` client with no provider
  branch, which is the design `internal/translate/translate.go` already commits to.
- Retranslating existing rows. `title_zh` stays as written; only rows still pending move to Luna.
- Changing the DeepSeek-specific `thinking` field or its comments. magpie accepts it and it remains
  correct for any other endpoint.

## Measurements (2026-11-06, real client code, real titles)

Replayed through the real `Client.Translate` / `Summarize` / `TranslateBody` with an out-of-tree
`go test -overlay` file, against recent articles from the deployed database.

| Check | Result |
|---|---|
| `/v1/chat/completions` serves `codex/gpt-6-luna` | Yes (`chatcmpl-resp_…`: a shim over Responses) |
| `thinking: {type: disabled}` | Accepted, no 400 |
| Empty titles, 80 runs over 73 unique titles | 0 |
| Title latency, first 19 titles | 2.8 s average, 3.8 s max (client timeout is 30 s) |
| Reasoning, sample of 61 titles | 6 titles used any; 353 tokens in total |
| `max_tokens: 20` on a long essay prompt | **Ignored**: 629 completion tokens, `finish_reason: stop` |
| Prompt tokens per title | ~3985, of which ~3479 cached (DeepSeek: ~471) |
| AI summary, 1855-rune article | Correct, 6 s |
| Body translation, same article | 2 pieces, 15.7 s |

Prompt tokens are ~3400 higher than the text this app sends: a one-line prompt reports 3482. The
extra tokens are added behind the gateway and cannot be reduced from this app.

Cost at magpie's listed prices ($0.10/M input, $0.01/M cached, $0.50/M output) is about $0.0001 per
title. At the logged volume of about 400 titles a day, that is about $0.04 a day and 1.6M tokens a
day against whatever quota the Codex provider has.

### Chat shim or native Responses

Two glitch-prone titles, 20 runs each, through three paths: `/chat/completions`, `/responses`, and
`/responses` with `reasoning.effort: low`. All three produced the same class of stray trailing
output, for example `做客}}`, `三分彩`, `❶`, `.title`, `...`, `···`. This is a property of the model,
not the path, so a Responses client would add code without fixing it.

## Steps

1. Back up the `llm_config` row to a mode-600 file outside the deploy sync path.
2. `PATCH /api/llm/config` with the new `base_url`, `model`, and `api_key=magpie`. Do not leave the
   DeepSeek key in place: it would be sent as a bearer token to another service on every call.
3. `POST /api/llm/config/test`, then confirm `GET /api/llm/config`.
4. Confirm in `app.log` that the worker's `translate usage` lines show the new prompt size.
5. Update `CLAUDE.md`.

## Risks / open questions

- **Stray output in stored titles.** `title_zh` is permanent and is the only title the list shows.
  Latin garbage appeared in 1 of 80 sampled runs, but low-information titles fail far more often
  (the JRE title above). `clean()` catches neither `aatsaat` nor `做客}}`, because they fit inside
  `maxGrowth`.
- **`max_tokens` is no longer a backstop on this path.** Nothing truncates a thinking model into
  empty content, which is good, but a runaway answer is bounded only by `maxGrowth`, and only after
  it has been generated and paid for.
- **The gateway must be running.** If magpie is down, requests fail with `ErrConnect` and nothing is
  written. Titles retry until they leave the 24 h window, then stay in their original language.
- **Rollback** is one `PATCH` back to the DeepSeek values, using the key from the backup.

Complexity: Low (configuration only).

## Outcome

Done as planned, with no change to `internal/translate`. `llm_config` now points at
`codex/gpt-6-luna` through magpie, and `POST /api/llm/config/test` passes. The worker translated a
real title through it (`promptTokens: 3955`) with no request failures since the switch. That is one
worker row so far; the rest of the evidence comes from the replay.

The DeepSeek row is backed up at `~/Deploy/feedoverflow/server/llm_config.deepseek.bak.sql`.

One deviation from the plan's expectations: `translate usage` now always logs `cacheHitTokens: 0`.
Caching does work, but this path reports it in `prompt_tokens_details.cached_tokens`, a field the
client does not read.

### Final model: `codex/gpt-6.1-terra`

After the comparison below, `llm_config.model` moved from Luna to `codex/gpt-6.1-terra`. The quota
is a subscription that expires unused, so Terra's higher listed price is not a real cost here, and
its zero stray-output runs matter more because `title_zh` is permanent. DeepSeek was not re-run in
the repeat test, and it remains the rollback through the backup above.

To watch: Terra at ~400 titles a day is about 1.8M tokens a day, mostly cached. How that counts
against the quota is unknown. Exhausted quota would fail requests and leave titles in their original
language after the 24 h window, not store bad translations.

### Comparison: `codex/gpt-6.1-terra`

Measured the same way: 73 unique titles, then each glitch-prone title 20 times.

| | Luna | Terra |
|---|---|---|
| Errors / empties, 73 titles | 0 / 0 | 0 / 0 |
| p50 / max latency (5 concurrent) | 2.0 s / 3.5 s | 1.9 s / 3.2 s |
| Avg prompt / cached / completion tokens | 3986 / 3654 / 26 | 4613 / 4294 / 22 |
| Listed input / cached / output, $ per M | 0.10 / 0.01 / 0.50 | 1.00 / 0.05 / 5.00 |
| Estimated cost per title | ~$0.00008 | ~$0.00064 |
| JRE title, runs with stray trailing output, of 20 | 7 (`做客蓬蓬蓬`, `做客**`, `做客···`) | 0 |
| Hacker News title, runs with stray output, of 20 | 0 | 0 |

Terra is not better across the board. On the 73 titles it produced `米兰称美联储 September 加息是个错误`,
`第 #187 期` (5 of the 20 JRE runs), and dropped parts of some titles. Luna's one clear failure on the
same pass was `做客生死格斗专场`. The stray-output comparison rests on repeats of only two titles.
