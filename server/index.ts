import './load-env.ts'; // must precede ./app.ts so AUTH_* env is set before registerAuth()
import { app } from './app.ts';

process.title = 'rss-reader';

app.listen(3002, () => console.log('RSS server on http://localhost:3002'));
