import express from 'express';

import { db } from '../db.ts';

export const router = express.Router();

router.get('/api/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

router.patch('/api/settings', (req, res) => {
  const allowed = ['rsshub_base_url'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of allowed) {
    if (key in req.body) upsert.run(key, String(req.body[key]).trim());
  }
  // Clear freshness stamps so the next read re-fetches with the new settings (e.g. a changed
  // rsshub_base_url resolves to different upstream URLs).
  db.prepare('UPDATE feeds SET last_fetched_at = NULL').run();
  res.json({ ok: true });
});
