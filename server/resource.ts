import { logger } from './logger.ts';

const log = logger.child({ mod: 'resource' });

// One structured sample per window. 5 min keeps the log light while still surfacing a
// slow memory leak or runaway CPU on the long-running launchd process.
const SAMPLE_INTERVAL = 5 * 60 * 1000;

const MB = 1024 * 1024;
const toMb = (bytes: number): number => Math.round((bytes / MB) * 10) / 10; // 0.1 MB

// cpuPercent is the user+system CPU time consumed over the elapsed wall time, as a
// percent of ONE core: ~100 means one core fully busy, >100 means multiple cores.
// `cpuPercent: null` flags the boot sample, which has no prior window to rate against.
function logSample(cpuPercent: number | null): void {
  const m = process.memoryUsage();
  log.info('resource sample', {
    rssMb: toMb(m.rss),
    heapUsedMb: toMb(m.heapUsed),
    heapTotalMb: toMb(m.heapTotal),
    externalMb: toMb(m.external),
    cpuPercent,
    uptimeSec: Math.round(process.uptime()),
  });
}

// Sample memory + CPU on an interval. Fires once on boot (baseline only, cpuPercent
// null) then every SAMPLE_INTERVAL. Skipped under TEST_DB so test/dev runs stay quiet,
// matching the other background services (cache warming, poller).
export function startResourceMonitor(): void {
  if (process.env.TEST_DB) return;

  // Cumulative CPU (microseconds) + monotonic wall clock (nanoseconds) anchors for the
  // next interval's rate. Seeded by the boot sample below.
  let prevCpu = process.cpuUsage();
  let prevHr = process.hrtime.bigint();

  // Boot: seed the baseline and log without a CPU rate — a computed percent here would
  // be a meaningless multi-core spike against the process's whole (short) lifetime.
  logSample(null);

  setInterval(() => {
    const cpu = process.cpuUsage();
    const hr = process.hrtime.bigint();
    const cpuMicros = cpu.user - prevCpu.user + (cpu.system - prevCpu.system);
    const wallMicros = Number(hr - prevHr) / 1000;
    prevCpu = cpu;
    prevHr = hr;
    const cpuPercent = wallMicros > 0 ? Math.round((cpuMicros / wallMicros) * 1000) / 10 : 0;
    logSample(cpuPercent);
  }, SAMPLE_INTERVAL);
}
