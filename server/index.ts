import './load-env.ts'; // must precede ./app.ts so AUTH_* env is set before registerAuth()
import { app } from './app.ts';
import { PORT } from './config.ts';
import { logger } from './logger.ts';

process.title = 'rss-reader';

// Last-resort handlers so crashes land in the structured log, not just stderr.
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { err: reason }));
process.on('uncaughtException', (err) => {
  logger.fatal('uncaught exception', { err });
  process.exit(1); // let launchd (KeepAlive) restart a clean process
});

app.listen(PORT, () => logger.info('server started', { port: PORT, url: `http://localhost:${PORT}` }));
