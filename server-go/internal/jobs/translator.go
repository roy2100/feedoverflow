package jobs

import (
	"context"
	"time"

	"rss-reader/server-go/internal/store"
	"rss-reader/server-go/internal/translate"
)

const (
	translateInterval = 30 * time.Second
	// translateWindow bounds what counts as pending. It is the whole of the
	// worker's state: enabling a feed backfills this much history, an article older
	// than this is never translated, and a request that keeps failing gives up when
	// its article ages out. The alternative — a per-feed watermark — buys finer
	// behaviour at the cost of a column, seed/stamp calls and advance rules.
	translateWindow = 7 * 24 * time.Hour
	// translateBatch caps titles per tick. Requests are sequential, so this is also
	// the ceiling on how long one tick can run against a slow endpoint.
	translateBatch = 20
)

// StartTranslator runs the title-translation worker until ctx is cancelled.
//
// It is deliberately not a poller callback (the way push notification fan-out is).
// Push must fire only from the poller, because an on-demand refresh must never
// notify about the article someone is reading. Translation has the opposite
// requirement: an article pulled in by an on-demand read deserves a translation
// just as much as a polled one. A standalone worker covers every fetch path —
// poller, EnsureFresh, startup warming — with one code path, and keeps upstream
// latency off the request path entirely: a dead LLM endpoint degrades to "no
// translation yet", never to a slow list response.
func (r *Runner) StartTranslator(ctx context.Context) {
	if r.Translator == nil {
		return
	}
	go r.tick(ctx, "translate", translateInterval, func() { r.translatePending(ctx) })
}

// translatePending handles one tick's worth of untranslated titles.
//
// Config is read here rather than at startup because llm_config is editable at
// runtime from the settings panel — there is no boot-time "translator is nil"
// disable the way Push has one. An empty API key is how the feature is off, so
// the common case costs one single-row read per tick.
func (r *Runner) translatePending(ctx context.Context) {
	cfg, err := store.LLMConfig(r.DB.Reader())
	if err != nil {
		r.Log.Warn("translate: config read failed", "err", err)
		return
	}
	if !cfg.Ready() {
		return
	}
	cutoff := time.Now().Add(-translateWindow).UnixMilli()
	pending, err := store.PendingTranslations(r.DB.Reader(), cutoff, translateBatch)
	if err != nil {
		r.Log.Warn("translate: select pending failed", "err", err)
		return
	}
	for _, p := range pending {
		if ctx.Err() != nil {
			return
		}
		// Skipping Chinese titles locally is what keeps a Chinese-language feed with
		// the switch accidentally on from costing anything.
		if translate.IsMostlyChinese(p.Title) {
			r.saveTranslation(p.ArticleID, "")
			continue
		}
		out, err := r.Translator.Translate(ctx, cfg, p.Title)
		if err != nil {
			// Write nothing: the row stays NULL and is retried next tick, until it
			// ages out of the window. Abort the rest of the batch rather than
			// continuing — a failure here almost always means the endpoint is down,
			// and the remaining 19 titles would each burn the full request timeout
			// before reaching the same conclusion.
			r.Log.Warn("translate: request failed", "articleId", p.ArticleID, "err", err)
			return
		}
		// out == "" means the endpoint answered with nothing usable. Store it as the
		// settled sentinel so the title drops out of the pending set after one pass
		// instead of being retried for a week.
		r.saveTranslation(p.ArticleID, out)
	}
}

func (r *Runner) saveTranslation(articleID, titleZh string) {
	if err := store.SaveTranslation(r.DB.Writer(), articleID, titleZh); err != nil {
		r.Log.Warn("translate: save failed", "articleId", articleID, "err", err)
	}
}
