import './load-env.ts'; // must precede ./app.ts so AUTH_* env is set before registerAuth()
import { app } from './app.ts';
import { startCacheWarming } from './cache.ts';
import { startPoller } from './poller.ts';
import { startResourceMonitor } from './resource.ts';
import { PORT } from './config.ts';
import { logger } from './logger.ts';

process.title = 'rss-reader';

// Last-resort handlers so crashes land in the structured log, not just stderr.
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { err: reason }));
process.on('uncaughtException', (err) => {
  logger.fatal('uncaught exception', { err });
  process.exit(1); // let launchd (KeepAlive) restart a clean process
});

const server = app.listen(PORT, () => {
  logger.info('server started', { port: PORT, url: `http://localhost:${PORT}` });
  // Only start background work (cache warming, polling, the destructive DB maintenance
  // pass) once the port is actually bound — a failed bind must not mutate the DB.
  startCacheWarming();
  startPoller();
  startResourceMonitor();
});

// A bind failure (e.g. EADDRINUSE) would otherwise surface as an uncaughtException after
// background services already ran. Log and exit cleanly so launchd restarts a fresh process.
server.on('error', (err) => {
  logger.fatal('server failed to start', { err, port: PORT });
  process.exit(1);
});
