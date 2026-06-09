process.title = 'rss-reader';

import { pathToFileURL } from 'node:url';
import { app } from './app.ts';

const PORT = 3002;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => console.log(`RSS server on http://localhost:${PORT}`));
}
