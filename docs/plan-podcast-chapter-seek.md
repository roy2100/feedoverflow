# Plan: click a timestamp in a podcast description to seek there

## Goal

Podcast show notes routinely carry a chapter list — `(04:41) Signing in and the onboarding
flow`, `(1:52) Impact of Meta's data center…`. Today those are inert text; the listener has
to read the minute, then drag the seek bar. Make every such timestamp in the reader a
button that starts (or moves) playback of that episode at that offset.

## Scope

In:

- Detect `m:ss`, `mm:ss` and `h:mm:ss` timestamps in the rendered description of an
  article that has an `audioUrl`. Both reader branches: the HTML body (rendered through
  `dangerouslySetInnerHTML`) and the plain-text fallback (React `<p>` per line).
- Clicking one seeks the audio owner (`App.tsx`) to that offset: if the episode is already
  loaded it seeks in place and resumes if paused; otherwise it loads the episode and starts
  it at the offset instead of at the stored resume position.
- Tests: the parser, the reader (button rendered, click → `onPlay(article, seconds)`,
  no button on a non-podcast article), and the whole-app path (offset wins over stored
  progress; in-place seek while playing).

Out:

- Chapter metadata from the feed itself (`<podcast:chapters>`, ID3 chapters). Text
  timestamps are what the two sample feeds actually ship, and they need no server change.
- A chapter list in the player, or "now playing chapter" highlighting.
- Timestamps in the *article list* row summaries — there is no player context there.

## Design

**Detection is a pure function** (`client/src/lib/timestamps.ts`): `splitTimestamps(text)`
returns runs of plain text and `{ text, seconds }` segments. One regexp, no lookbehind
(older iOS Safari), with a manual check that the match isn't glued to a digit or colon on
either side, so `127.0.0.1:8080`, `12:345` and `2024:12` never become chapters. Minutes and
seconds are bounded at 59. Both reader branches call this one function, so the HTML walker
and the React branch can't drift.

**The HTML branch mutates the DOM in the existing post-render effect**, next to the lazy
image and `target=_blank` passes, rather than regex-editing the HTML string before it is
set — a string pass would happily match inside `href` attributes. A `TreeWalker` visits
text nodes, skipping `a`, `button`, `pre`, `code`, `script` and `style` ancestors, and
replaces each match with `<button type="button" data-seek="N">`. React resets `innerHTML`
whenever the string changes, which discards the buttons and re-runs the effect, so the pass
is naturally idempotent.

**The plain-text branch renders buttons as React elements** from the same split. It must
not go through the DOM walker: React owns those text nodes and would keep updating a
detached node after the walker replaced it.

**One delegated click handler** on the content container, in both branches, reads
`data-seek` from the nearest button and calls `onPlay(article, seconds)`. This keeps the
audio wiring identical to the existing play button: `onPlay` grows an optional second
argument instead of the reader learning a new callback.

**Seeking lives in `App.handlePlay`**, the audio owner. `startAt` overrides the stored
resume position on a fresh load, and on the already-loaded episode it seeks in place. If
metadata hasn't landed yet (`readyState === HAVE_NOTHING`), the seek is parked on the
same `pendingResumeRef` hook the resume uses, so switching episodes mid-load still cancels
it. The offset is clamped to `duration` when known; otherwise the browser clamps.

Only articles with an `audioUrl` get the treatment: a "10:30" in a newsletter must stay
text.

## Steps

1. `lib/timestamps.ts` — parser + `splitTimestamps`, with unit tests.
2. `types.ts` / `App.tsx` — `onPlay(article, startAt?)`; `handlePlay` honours `startAt`
   on both the same-episode and new-episode paths.
3. `ArticleReader.tsx` — walker in the post-render effect, React linkify in the text
   branch, delegated click handler, `.rss-article button[data-seek]` style.
4. Tests: `timestamps.test.ts`, cases in `ArticleReader.test.tsx`, cases in
   `playbackResume.test.tsx`.
5. `npm run typecheck`, `npm test`, `npm run fmt && npm run lint:fix`; CLAUDE.md line.

## Risks / open questions

- Times of day in show notes ("recorded at 10:30") become chapter links. Accepted: the
  cost is one wrong seek, and there is no reliable way to tell them apart.
- A chapter beyond the real duration: `currentTime` is clamped, so the worst case is a
  jump to the end.

Complexity: Low–Medium (client only, three files plus tests).

## Outcome

Implemented as planned, client only:

- `client/src/lib/timestamps.ts` — `splitTimestamps` / `parseTimestamp`. A `hasTimestamp`
  helper was drafted and dropped: both callers already have the split in hand.
- `client/src/App.tsx` — `handlePlay(article, startAt?)`; the metadata-gated seek was pulled
  out into `seekWhenReady` so the resume and the chapter seek share one path (and one
  cancellation hook). Clamps to `duration` when the element reports one.
- `client/src/components/ArticleReader.tsx` — `linkifyTimestamps` walker in the post-render
  effect, `renderTimestamps` for the plain-text branch, one delegated `onClick`, and a
  `.rss-article button[data-seek]` chip style.
- Tests: `timestamps.test.ts` (parser), five cases in `ArticleReader.test.tsx` (HTML + text
  bodies, link exclusion, no-audio guard, click → `onPlay(article, 281)`), four cases in
  `playbackResume.test.tsx` (chapter beats stored resume; in-place seek doesn't toggle pause;
  paused episode resumes at the chapter; clamp past the end).

One deviation from the first draft of the app test: selecting the article must wait for the
initial list load, or the store's startup reset clobbers the selection — nothing about the
feature, just test sequencing.

Follow-up after the first screenshot: the chip held only the clock, leaving `(` and `)` as
body-size text on either side. `splitTimestamps` now absorbs a *matching* bracket pair
(`(…)` or `[…]`) into the segment, so the whole `(04:41)` marker is the button. A mismatched
or unclosed bracket stays outside.

Follow-up (2026-09-21, Lenny's Newsletter episode): none of the chapter marks were
clickable. Substack emits each one as `(<a href="youtube…&t=155s">02:35</a>) Intro` — the
clock is the *entire* text of a link to another player, and the walker's `a` exclusion
skipped it wholesale. The exclusion exists so a button never nests inside a link, not to
protect clocks that happen to be linked. `unwrapChapterLinks` now runs before the text
walk: a link whose whole trimmed text parses as one timestamp is replaced *by* the seek
button (ours is the player that is actually playing), and a bracket pair hugging the link
from the sibling text nodes is folded into the chip so it still reads `(02:35)`. A link
with a clock among other words (`<a>12:34 in the video</a>`) is still left alone — that is
a sentence, not a chapter mark. One more case in `ArticleReader.test.tsx` pins the shape.
