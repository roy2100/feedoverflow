import express from 'express';

import { clearCache } from '../cache.ts';
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
  clearCache.run();
  res.json({ ok: true });
});
