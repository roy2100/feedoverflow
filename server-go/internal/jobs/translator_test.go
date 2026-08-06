package jobs_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"rss-reader/server-go/internal/db"
	"rss-reader/server-go/internal/jobs"
	"rss-reader/server-go/internal/translate"
)

// fakeTranslator records every title it was asked to translate and replays a
// scripted answer, so the worker's decisions are testable without a network.
type fakeTranslator struct {
	seen []string
	out  string
	err  error
}

func (f *fakeTranslator) Translate(_ context.Context, _ translate.Config, title string) (string, error) {
	f.seen = append(f.seen, title)
	if f.err != nil {
		return "", f.err
	}
	return f.out, nil
}

// translateDB gives a DB with one feed, translation switched on, and a watermark
// far enough back that the seeded articles are in range.
func translateDB(t *testing.T, key string) *db.DB {
	t.Helper()
	handle := newTestDB(t)
	if _, err := handle.Writer().Exec(`DELETE FROM feeds`); err != nil {
		t.Fatal(err)
	}
	seedFeed(t, handle.Writer(), "f1")
	since := time.Now().Add(-24 * time.Hour).UnixMilli()
	if _, err := handle.Writer().Exec(
		`UPDATE llm_config SET api_key = ?, enabled = 1, translate_since = ? WHERE id = 1`,
		key, since); err != nil {
		t.Fatal(err)
	}
	return handle
}

// seedTitled inserts one article with an explicit title and publish time.
func seedTitled(t *testing.T, w *sql.DB, id, feedID, title string, pub time.Time) {
	t.Helper()
	_, err := w.Exec(
		`INSERT INTO article_states
		   (article_id, feed_id, feed_name, title, link, pub_date, pub_ts, summary, content, is_starred, updated_at)
		 VALUES (?, ?, 'F', ?, ?, ?, ?, '', '', 0, datetime('now'))`,
		id, feedID, title, "https://x/"+id, pub.Format(time.RFC1123Z), pub.UnixMilli())
	if err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

func titleZh(t *testing.T, r *sql.DB, id string) (string, bool) {
	t.Helper()
	var v sql.NullString
	if err := r.QueryRow(`SELECT title_zh FROM article_states WHERE article_id = ?`, id).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v.String, v.Valid
}

func runTranslator(handle *db.DB, tr translate.Translator) {
	r := &jobs.Runner{DB: handle, Log: quietLog(), Translator: tr}
	r.TranslatePendingForTest(context.Background())
}

func TestTranslatorStoresTranslation(t *testing.T) {
	handle := translateDB(t, "sk-test")
	seedTitled(t, handle.Writer(), "a1", "f1", "Apple unveils M5 chip", time.Now())

	tr := &fakeTranslator{out: "苹果发布 M5 芯片"}
	runTranslator(handle, tr)

	got, valid := titleZh(t, handle.Reader(), "a1")
	if !valid || got != "苹果发布 M5 芯片" {
		t.Fatalf("title_zh = %q valid=%v, want the translation", got, valid)
	}
	if len(tr.seen) != 1 || tr.seen[0] != "Apple unveils M5 chip" {
		t.Fatalf("translator saw %v", tr.seen)
	}
}

// A Chinese title must never reach the API: that short-circuit is what keeps a
// Chinese feed with the switch on from costing anything.
func TestTranslatorSkipsChineseWithoutCalling(t *testing.T) {
	handle := translateDB(t, "sk-test")
	seedTitled(t, handle.Writer(), "a1", "f1", "苹果发布 M5 芯片，性能提升 40%", time.Now())

	tr := &fakeTranslator{out: "should not be used"}
	runTranslator(handle, tr)

	if len(tr.seen) != 0 {
		t.Fatalf("translator was called for a Chinese title: %v", tr.seen)
	}
	got, valid := titleZh(t, handle.Reader(), "a1")
	if !valid || got != "" {
		t.Fatalf("title_zh = %q valid=%v, want the settled empty sentinel", got, valid)
	}
}

// An empty answer settles the row as ” rather than leaving it NULL: a title the
// model cannot handle must drop out of the pending set after one pass instead of
// being retried every 30s until it ages out of the window.
func TestTranslatorEmptyAnswerSettlesRow(t *testing.T) {
	handle := translateDB(t, "sk-test")
	seedTitled(t, handle.Writer(), "a1", "f1", "Apple unveils M5 chip", time.Now())

	runTranslator(handle, &fakeTranslator{out: ""})

	got, valid := titleZh(t, handle.Reader(), "a1")
	if !valid || got != "" {
		t.Fatalf("title_zh = %q valid=%v, want ''", got, valid)
	}
	// And the settled row is no longer pending.
	tr := &fakeTranslator{out: "x"}
	runTranslator(handle, tr)
	if len(tr.seen) != 0 {
		t.Fatalf("settled row was retried: %v", tr.seen)
	}
}

// A failed request must write nothing, so the row is picked up again next tick.
func TestTranslatorFailureLeavesRowPending(t *testing.T) {
	handle := translateDB(t, "sk-test")
	seedTitled(t, handle.Writer(), "a1", "f1", "Apple unveils M5 chip", time.Now())

	runTranslator(handle, &fakeTranslator{err: errors.New("boom")})
	if _, valid := titleZh(t, handle.Reader(), "a1"); valid {
		t.Fatal("failed request wrote a value; the row must stay NULL")
	}

	tr := &fakeTranslator{out: "苹果发布 M5 芯片"}
	runTranslator(handle, tr)
	if len(tr.seen) != 1 {
		t.Fatalf("row was not retried after a failure: %v", tr.seen)
	}
}

// One failure aborts the rest of the tick: a down endpoint would otherwise burn
// the full request timeout on every remaining title before reaching the same
// conclusion.
func TestTranslatorFailureAbortsTick(t *testing.T) {
	handle := translateDB(t, "sk-test")
	now := time.Now()
	seedTitled(t, handle.Writer(), "a1", "f1", "First headline", now)
	seedTitled(t, handle.Writer(), "a2", "f1", "Second headline", now.Add(-time.Minute))

	tr := &fakeTranslator{err: errors.New("boom")}
	runTranslator(handle, tr)

	if len(tr.seen) != 1 {
		t.Fatalf("tick continued past a failure, saw %d titles: %v", len(tr.seen), tr.seen)
	}
}

// The give-up bound: a row older than translateWindow is never selected, so a
// request that keeps failing cannot sit at the head of a newest-first queue
// forever and block everything behind it.
func TestTranslatorIgnoresRowsOutsideWindow(t *testing.T) {
	handle := translateDB(t, "sk-test")
	// Push the enable watermark back too, so the window is the only thing excluding
	// this row.
	old := time.Now().Add(-jobs.TranslateWindowForTest - time.Hour)
	if _, err := handle.Writer().Exec(
		`UPDATE llm_config SET translate_since = ? WHERE id = 1`, old.Add(-time.Hour).UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}
	seedTitled(t, handle.Writer(), "a1", "f1", "Ancient headline", old)

	tr := &fakeTranslator{out: "x"}
	runTranslator(handle, tr)

	if len(tr.seen) != 0 {
		t.Fatalf("a row outside the window was translated: %v", tr.seen)
	}
	if _, valid := titleZh(t, handle.Reader(), "a1"); valid {
		t.Fatal("a row outside the window was written")
	}
}

// The enable watermark is the other lower bound, and it is the one that stops
// switching translation on from reaching back over the whole archive.
func TestTranslatorIgnoresRowsBeforeEnable(t *testing.T) {
	handle := translateDB(t, "sk-test")
	seedTitled(t, handle.Writer(), "old", "f1", "Published before enabling", time.Now().Add(-48*time.Hour))
	seedTitled(t, handle.Writer(), "new", "f1", "Published after enabling", time.Now())

	tr := &fakeTranslator{out: "译文"}
	runTranslator(handle, tr)

	if len(tr.seen) != 1 || tr.seen[0] != "Published after enabling" {
		t.Fatalf("watermark not honoured, translator saw %v", tr.seen)
	}
	if _, valid := titleZh(t, handle.Reader(), "old"); valid {
		t.Fatal("a row published before the switch was turned on was written")
	}
}

// The switch is off by default; flipping it off must stop new work even though
// the key is still stored.
func TestTranslatorNoOpsWhenDisabled(t *testing.T) {
	handle := translateDB(t, "sk-test")
	if _, err := handle.Writer().Exec(`UPDATE llm_config SET enabled = 0 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	seedTitled(t, handle.Writer(), "a1", "f1", "Apple unveils M5 chip", time.Now())

	tr := &fakeTranslator{out: "x"}
	runTranslator(handle, tr)

	if len(tr.seen) != 0 {
		t.Fatalf("worker ran with the switch off: %v", tr.seen)
	}
}

// A key is a capability and the switch is an intent; on without a key must not
// dial out with an empty bearer token. Config is read per tick, so this also
// covers a key cleared while the server is running.
func TestTranslatorNoOpsWithoutKey(t *testing.T) {
	handle := translateDB(t, "")
	seedTitled(t, handle.Writer(), "a1", "f1", "Apple unveils M5 chip", time.Now())

	tr := &fakeTranslator{out: "x"}
	runTranslator(handle, tr)

	if len(tr.seen) != 0 {
		t.Fatalf("worker ran without an API key: %v", tr.seen)
	}
}
