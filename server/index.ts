import './load-env.ts'; // must precede ./app.ts so AUTH_* env is set before registerAuth()
import { app } from './app.ts';
import { PORT } from './config.ts';

process.title = 'rss-reader';

app.listen(PORT, () => console.log(`RSS server on http://localhost:${PORT}`));
