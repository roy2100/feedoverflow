// Package articles holds the parity-critical domain core: article-id derivation,
// pub_ts/date parsing, enrich/dedup, and article_states upserts. Port of
// server/articles.ts + server/dates.ts.
//
// Phase 0: skeleton only — the id/date parity work is Phase 2.
package articles
