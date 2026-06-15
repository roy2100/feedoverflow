# Plan: 无图模式 / 专注阅读内容模式 (Text-Only Reading Mode)

## Goal
Add a toggle that, when enabled, strips images and other non-text "content-irrelevant"
elements (figures, videos, iframes, embeds, SVGs) from the rendered article body so the
reader shows clean, distraction-free text. The preference persists across sessions.

## Naming note (important)
A mode literally called **专注阅读** (`readingMode`) already exists in `App.tsx` /
`ArticleReader.tsx`, but it is a **layout** mode — it widens the reading column and hides
the sidebar + article list. It does **not** touch article content. To avoid collision, this
new content-stripping feature is named **无图模式** (text-only). The two are orthogonal and
can be on at the same time (focus layout + no images).

## Scope
### Included
- A boolean preference `text-only` persisted in `localStorage` (mirrors the existing
  `sidebar-collapsed` pattern in `App.tsx`).
- A toolbar toggle button in `ArticleReader` (desktop reader meta row, next to the existing
  专注阅读 button), plus a mobile-accessible affordance.
- Content filtering in `ArticleReader`: when `text-only` is on, additionally remove
  `<img>`, `<picture>`, `<source>`, `<figure>`, `<figcaption>`, `<video>`, `<audio>`,
  `<iframe>`, `<embed>`, `<object>`, and `<svg>` from the article HTML before render.
- Applies to both RSS content and the "加载全文" (Readability) full-content view.

### Out of scope
- Changing what the backend persists. Stripping is **display-only**; `article_states.content`
  keeps the full HTML so toggling off restores images with no refetch.
- Touching the podcast audio player block (that is app chrome, not article body — it stays).
- Server-side or per-feed configuration. This is a single global client preference.
- Reading-list thumbnails / sidebar — only the reader pane body is affected.

## Steps
1. **State + persistence (`App.tsx`)** — add `const [textOnly, setTextOnly] = useState(() => localStorage.getItem('text-only') === '1')`
   and an effect writing it back, mirroring `sidebarCollapsed` (App.tsx:28-30, 111-113).
   Add a `toggleTextOnly` handler.
2. **Thread the prop** — pass `textOnly` and `onToggleTextOnly` into `ArticleReader`
   (App.tsx:347 area), extend `ArticleReaderProps` (ArticleReader.tsx:44-55).
3. **Filtering logic (`ArticleReader.tsx`)** — add a sibling pure function `stripMedia(html)`
   that uses the browser-native `DOMParser` (`new DOMParser().parseFromString(html, 'text/html')`):
   `doc.querySelectorAll('img, picture, source, figure, figcaption, video, audio, iframe, embed, object, svg').forEach(el => el.remove())`,
   then return `doc.body.innerHTML`. This is more robust against nested/malformed markup than
   regex and needs no dependency (jsdom provides `DOMParser` in vitest too). Run it only when
   `textOnly` is true, composed after the existing `sanitizeHtml`, on `rawContent`
   (ArticleReader.tsx:157 / 674) so it covers both the RSS and full-content paths.
   (The existing `sanitizeHtml` stays regex-based and unchanged — script/style/iframe/`on*`
   stripping — we only add the media strip via DOM.)
4. **Skip the image post-processor** — the `useEffect` that sets `loading=lazy` /
   `aspect-ratio` on `img` (ArticleReader.tsx:98-108) is a no-op when images are stripped;
   no change strictly needed, but verify it doesn't throw on an empty NodeList (it won't).
5. **Toolbar button (desktop)** — add a button next to the 专注阅读 control
   (ArticleReader.tsx:344-372) using a lucide icon (`ImageOff` / `Image`), with active
   color `var(--accent)` when on, tooltip `无图模式` / `显示图片`, matching existing hover
   styling.
6. **Mobile affordance** — surface the same toggle in the mobile back-header row
   (ArticleReader.tsx:178-256) so the feature is reachable on phones.
7. **Lint / format / typecheck** — `npm run fmt && npm run lint:fix`, then
   `cd client && npm run typecheck`. Ensure `fmt:check` and `lint` exit clean.
8. **Tests** — add a `client` vitest covering `stripMedia`: given HTML with `<img>` /
   `<figure>` / `<iframe>`, asserts they are removed and text/`<p>` survive; given the flag
   off, asserts HTML is unchanged. (Extract the strip helper as an exported pure function to
   make it unit-testable.) Test titles in English per repo convention.

## Risks & Open Questions
- **Definition of "内容无关"**: this plan treats it as images + embedded media. Code blocks,
  blockquotes, tables and links are preserved (they are real content). If you also want to
  drop tables/iframtables or social embeds beyond the listed tags, say so.
- **DOM parsing**: the new media strip uses browser-native `DOMParser` (robust, dependency-free,
  available in jsdom for tests). The pre-existing `sanitizeHtml` stays regex-based and untouched;
  only the new media removal goes through the DOM, so this introduces no new dependency.
- **Toggle placement**: plan puts it as a reader toolbar button (most discoverable,
  per-session, matches 专注阅读). Alternative is a switch in `SettingsModal`. Toolbar is
  recommended; confirm if you'd rather it live in Settings only.

## Estimated Complexity
**Low** — one new persisted boolean, prop threading, one string-filter helper, and two small
UI buttons. No backend, schema, or data-flow changes; fully reversible at display time.

## Outcome
Implemented as **无图模式** (text-only reading mode).

- `stripMedia(html)` exported from `ArticleReader.tsx` — DOMParser-based, removes
  `img, picture, source, figure, figcaption, video, audio, iframe, embed, object, svg`,
  falls back to the input string when `DOMParser` is unavailable.
- Preference owned **inside `ArticleReader`** as `textOnly` state, initialised from and
  persisted to `localStorage['text-only']`. Deviation from the plan: kept self-contained in
  the reader instead of lifting to `App.tsx`, because (unlike `readingMode`) it only affects
  the reader body and this makes it work on the mobile `ReaderPage` with zero prop threading.
- Composed after the existing regex `sanitizeHtml` only when enabled; full-content
  (Readability) path covered too. Image lazy-load effect now also re-runs on `textOnly`.
- Toggle UI: a `Image`/`ImageOff` button in the desktop reader toolbar (next to 专注阅读)
  and in the mobile back-header (next to the star).
- Tests: 5 new cases (`stripMedia` units + toggle/persistence behaviour). Full client suite
  passes (84). `fmt:check`, `lint`, and `tsc --noEmit` all clean.
