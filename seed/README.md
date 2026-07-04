# Demo seed database

`demo-seed.db` is the curated snapshot the demo instance is reset to every 6 hours
(`scripts/demo-reset.sh` copies it over `~/Deploy/rss-demo/data/demo.db`). Build it once by
hand; rebuild only when you want to change the demo's feed set or after a schema change.

> The seed DB itself is **not committed** (it can be large and is environment-specific). It lives
> at `~/Deploy/rss-demo/data/demo-seed.db` on the demo host. This directory only documents how to
> produce it.

## Build it

1. Pick a handful of clean, English-friendly feeds and put them in an OPML file, e.g.
   `~/demo-feeds.opml` (or add them one by one via the UI in the next step).

2. Warm a fresh DB with the demo binary (no auth, a scratch DB, on the demo ports):

   ```bash
   cd ~/Deploy/rss-demo
   RSS_DB=data/demo-seed.db PORT=3013 LOCAL_API_PORT=4013 \
     CLIENT_DIST=client/dist ./rss-reader &
   ```

3. Load the feeds against the loopback API and let the poller pull content:

   ```bash
   # import an OPML…
   curl -sS -F file=@$HOME/demo-feeds.opml http://127.0.0.1:4013/api/feeds/import-opml
   # …or add individually:
   curl -sS -H 'content-type: application/json' \
     -d '{"url":"https://example.com/feed.xml"}' http://127.0.0.1:4013/api/feeds

   # optional: point RSSHub at your instance so rsshub:// feeds resolve
   curl -sS -X PATCH -H 'content-type: application/json' \
     -d '{"rsshub_base_url":"http://localhost:1200"}' http://127.0.0.1:4013/api/settings

   # star a few nice articles so the Starred view isn't empty. The star endpoint
   # wants the whole article object under "article", not a bare id:
   curl -sS "http://127.0.0.1:4013/api/all-articles" \
     | jq -c '{article: .articles[0], starred: true}' \
     | curl -sS -H 'content-type: application/json' -d @- \
         http://127.0.0.1:4013/api/articles/star
   ```

   Give the poller a couple of minutes to fill `article_states`.

4. Checkpoint the WAL so the snapshot is a single self-contained file, then stop the binary:

   ```bash
   sqlite3 data/demo-seed.db 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'
   kill %1
   rm -f data/demo-seed.db-wal data/demo-seed.db-shm
   ```

`data/demo-seed.db` is now ready. The next `demo-reset.sh` run (or a manual invocation) will
restore the live demo to exactly this state.

## Notes

- Migrations run on open, so an older seed still upgrades to the current schema. A seed built by a
  **newer** binary than the running one will not downgrade — rebuild after rolling the demo back.
- Keep the feed set small and reputable: the demo is public and every feed URL becomes an outbound
  fetch from your Mac.
