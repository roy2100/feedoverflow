package httpapi

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"rss-reader/server-go/internal/articles"
	"rss-reader/server-go/internal/httpx"
	"rss-reader/server-go/internal/model"
	"rss-reader/server-go/internal/store"
)

// Keyword trend: how many articles mentioned a term on each of the last N local
// days, plus the articles behind the bars. A read over article_states and nothing
// else — no cache, no aggregate table. Rationale: docs/plan-keyword-trend.md.

// trendRanges are the only windows offered. The ceiling is deliberate: full
// history only starts in 2026-06, so a longer range would draw the start of
// persistence as a rise in the topic.
var trendRanges = map[int]bool{7: true, 30: true, 90: true}

const (
	trendDefaultDays = 30
	trendMaxTerms    = 5
	trendMaxLimit    = 500
)

type trendBucket struct {
	Date  string `json:"date"`  // local calendar day, YYYY-MM-DD
	Count int    `json:"count"` // articles matching the query
	Total int    `json:"total"` // all articles that day — the denominator for 占当日
}

// trendTerms splits a query on `|` into OR-synonyms for one series
// (`英伟达|Nvidia`), trimming and dropping empties. Nil means "no usable term".
func trendTerms(q string) []string {
	var out []string
	for _, t := range strings.Split(q, "|") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// getTrend — GET /api/trend?q=Muse|缪斯&days=30[&day=YYYY-MM-DD][&limit=500].
// `day` narrows only the returned articles (the bars always cover the window);
// `matched` is the window's sum, independent of `day` and `limit`.
func (s *Server) getTrend(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()
	q := strings.TrimSpace(qs.Get("q"))
	terms := trendTerms(q)
	if len(terms) == 0 {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少关键词"})
		return
	}
	if len(terms) > trendMaxTerms {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "最多 5 个同义词"})
		return
	}
	days := trendDefaultDays
	if v := qs.Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || !trendRanges[n] {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "days 只能是 7、30 或 90"})
			return
		}
		days = n
	}
	limit := trendMaxLimit
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > trendMaxLimit {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "limit 取值 1–500"})
			return
		}
		limit = n
	}

	// Buckets are local calendar days — the same basis as /api/today's midnight —
	// ending with today, which is still in progress. The upper bound is now, not
	// the end of today: a future-dated item has no day to land in yet.
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	start := today.AddDate(0, 0, -(days - 1))
	buckets := make([]trendBucket, days)
	index := make(map[string]int, days)
	for i := range buckets {
		d := start.AddDate(0, 0, i).Format(time.DateOnly)
		buckets[i].Date = d
		index[d] = i
	}
	bucketOf := func(ts int64) (int, bool) {
		i, ok := index[time.UnixMilli(ts).In(now.Location()).Format(time.DateOnly)]
		return i, ok
	}

	day := qs.Get("day")
	if _, ok := index[day]; day != "" && !ok {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "day 不在所选范围内"})
		return
	}

	rdb := s.DB.Reader()
	since, until := start.UnixMilli(), now.UnixMilli()

	// Synonyms can select the same article; it counts once.
	var hits []store.TrendHit
	seen := map[string]bool{}
	for _, t := range terms {
		hs, err := store.TrendHits(rdb, t, since, until)
		if err != nil {
			serverError(w, err)
			return
		}
		for _, h := range hs {
			if !seen[h.Row.ArticleID] {
				seen[h.Row.ArticleID] = true
				hits = append(hits, h)
			}
		}
	}
	if len(terms) > 1 {
		sort.SliceStable(hits, func(i, j int) bool { return hits[i].PubTs > hits[j].PubTs })
	}

	matched := 0
	arts := []model.Article{}
	for _, h := range hits {
		i, ok := bucketOf(h.PubTs)
		if !ok {
			continue
		}
		buckets[i].Count++
		matched++
		if (day == "" || buckets[i].Date == day) && len(arts) < limit {
			arts = append(arts, articles.RowToArticle(h.Row, false, false))
		}
	}

	all, err := store.PubTimes(rdb, since, until)
	if err != nil {
		serverError(w, err)
		return
	}
	for _, ts := range all {
		if i, ok := bucketOf(ts); ok {
			buckets[i].Total++
		}
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"query":    q,
		"days":     days,
		"matched":  matched,
		"buckets":  buckets,
		"articles": articles.NormalizePubDates(arts),
	})
}
