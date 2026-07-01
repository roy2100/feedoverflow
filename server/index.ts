import './load-env.ts'; // must precede ./app.ts so AUTH_* env is set before registerAuth()
import { app, localApp } from './app.ts';
import { startCacheWarming } from './cache.ts';
import { LOCAL_API_PORT, PORT } from './config.ts';
import { logger } from './logger.ts';
import { startPoller } from './poller.ts';
import { startResourceMonitor } from './resource.ts';

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

// Loopback-only companion listener: the full API with no auth gate, plus MCP. Bound
// explicitly to 127.0.0.1 so it never reaches the LAN or the tunnel — that binding is
// what makes it auth-exempt. A bind failure here is fatal too (MCP/local tools depend on it).
const localServer = localApp.listen(LOCAL_API_PORT, '127.0.0.1', () => {
  logger.info('local api started', {
    port: LOCAL_API_PORT,
    url: `http://127.0.0.1:${LOCAL_API_PORT}`,
  });
});
localServer.on('error', (err) => {
  logger.fatal('local api failed to start', { err, port: LOCAL_API_PORT });
  process.exit(1);
});
