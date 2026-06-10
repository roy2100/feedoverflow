// Load server/.env (if present) BEFORE app.ts is evaluated, so registerAuth()
// sees AUTH_USER/AUTH_PASS at import time. This module is a side-effect import
// and MUST be listed before `./app.ts` in index.ts — ESM evaluates static
// imports in source order, which is what guarantees the env is populated first.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
