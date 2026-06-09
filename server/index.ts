process.title = 'rss-reader';

import { app } from './app.ts';

app.listen(3002, () => console.log('RSS server on http://localhost:3002'));
