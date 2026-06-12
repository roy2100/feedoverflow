/**
 * slog — single-file structured logger for single-machine, personal apps.
 *
 * Vendor it: copy this file into your project (e.g. `vendor/slog.ts`) and import.
 * Zero dependencies (Node built-ins only). Requires Node.js >= 24 (native TS execution,
 * util.styleText for color). File output uses node:fs.
 *
 * ── QUICKSTART ──────────────────────────────────────────────────────────────
 *   import { createLogger } from "./vendor/slog.ts";
 *
 *   const log = createLogger({ dir: "./logs", level: "info", base: { app: "myapp" } });
 *
 *   log.info("server started", { port: 8080 });   // msg first, then a fields object
 *   log.warn("slow query", { ms: 412 });
 *
 *   // Errors: put the Error in the `err` field — it is auto-serialized (stack + cause).
 *   try { risky(); } catch (err) { log.error("request failed", { err, status: 500 }); }
 *
 *   // Child logger: binds context onto every record it emits (and its own children).
 *   const reqLog = log.child({ requestId });
 *   reqLog.debug("handling", { method: "GET" });   // ctx includes app + requestId + method
 *
 *   log.close();   // optional: flush+close the file before a clean shutdown
 *
 * API surface:
 *   createLogger(options?) -> Logger          // default export is createLogger too
 *   Logger.trace|debug|info|warn|error|fatal(msg: string, fields?: object): void
 *   Logger.child(bindings: object): Logger
 *   Logger.close(): void
 *   Levels (low->high): trace < debug < info < warn < error < fatal
 *   Every option is documented on the `SlogOptions` interface below.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Output contract (NDJSON, one self-contained JSON object per line):
 *   The first line of every file is a schema header `{ _meta: "slog", ... }` describing
 *   the format (so a log-reading agent self-orients); skip lines that have `_meta`.
 *   Every other line is a log record:
 *   { ts, t, level, lvl, msg, pid, host, ctx?, err?, src? }
 *   - ts:    ISO-8601 timestamp with milliseconds (human + machine)
 *   - t:     epoch milliseconds (sortable)
 *   - level: "trace" | "debug" | "info" | "warn" | "error" | "fatal"
 *   - lvl:   numeric severity (10..60), for range filters
 *   - msg:   short human message
 *   - ctx:   merged base + child + per-call structured fields
 *   - err:   serialized Error (name, message, stack, cause chain)
 *   - src:   { file, line, fn? } when source capture is enabled
 *
 * Designed so an AI agent can grep/stream/parse logs line-by-line, and so that a
 * long-running process never fills the disk (size rotation + gzip + retention pruning).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { styleText } from "node:util";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVELS: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const LEVEL_NAMES = Object.keys(LEVELS) as Level[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: unknown;
  cause?: SerializedError | string;
}

export interface LogRecord {
  ts: string;
  t: number;
  level: Level;
  lvl: number;
  msg: string;
  pid: number;
  host: string;
  ctx?: Record<string, unknown>;
  err?: SerializedError;
  src?: { file: string; line: number; fn?: string };
}

export interface SlogOptions {
  /** Minimum level to emit. Default "info". */
  level?: Level;
  /** Directory for log files. Default "./logs". Set `file:false` to disable file output. */
  dir?: string;
  /** Base filename (without extension). Default "app" → "app.log". */
  filename?: string;
  /** Write to a file. Default true. */
  file?: boolean;
  /** Write to console. "auto" = only when stdout is a TTY. Default "auto". */
  console?: boolean | "auto";
  /** Pretty (colorized) console. "auto" = pretty when stdout is a TTY. Default "auto". */
  pretty?: boolean | "auto";
  /** Rotate when the active file would exceed this many bytes. Default 10 MiB. */
  maxFileSize?: number;
  /** Number of rotated files to keep. Default 5. */
  maxFiles?: number;
  /** Delete rotated files older than this many days. Default 14. */
  maxAgeDays?: number;
  /** Gzip rotated files. Default true. */
  gzip?: boolean;
  /** Capture { file, line } from the call stack. Default false (perf cost). */
  captureSource?: boolean;
  /** Fields merged into every record. */
  base?: Record<string, unknown>;
  /** Synchronous appends (crash-safe). Default true. */
  sync?: boolean;
  /** Write a self-describing schema header as the first line of each file. Default true. */
  schemaHeader?: boolean;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeError(err: unknown, depth = 0): SerializedError {
  if (depth > 5) return { name: "Error", message: "[cause chain too deep]" };
  if (!(err instanceof Error)) {
    return { name: "NonError", message: safeToString(err) };
  }
  const out: SerializedError = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    out.cause =
      cause instanceof Error ? serializeError(cause, depth + 1) : safeToString(cause);
  }
  return out;
}

function safeToString(v: unknown): string {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Stringify a record into one NDJSON line; tolerant of BigInt, cycles, functions. */
function safeStringify(record: LogRecord): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString() + "n";
    if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  };
  try {
    return JSON.stringify(record, replacer);
  } catch (e) {
    // Last resort: never throw from the logger.
    return JSON.stringify({
      ts: record.ts,
      t: record.t,
      level: record.level,
      lvl: record.lvl,
      msg: record.msg,
      pid: record.pid,
      host: record.host,
      _serializeError: (e as Error).message,
    });
  }
}

const SRC_FRAME = /\(?(.+?):(\d+):(\d+)\)?$/;

function captureSource(): LogRecord["src"] | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split("\n").slice(1);
  for (const raw of lines) {
    const line = raw.trim();
    // Skip frames inside this module.
    if (line.includes("slog.ts") || line.includes("slog.js")) continue;
    if (line.startsWith("at node:") || line.includes("node:internal")) continue;
    const m = line.match(SRC_FRAME);
    if (!m) continue;
    const fnMatch = line.match(/^at\s+(.+?)\s+\(/);
    let file = m[1]
      .replace(/^at\s+/, "")
      .replace(/^.*\(/, "")
      .replace(/^file:\/\//, "");
    try {
      file = path.relative(process.cwd(), file) || file;
    } catch {
      /* keep as-is */
    }
    return {
      file,
      line: Number(m[2]),
      ...(fnMatch ? { fn: fnMatch[1] } : {}),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schema header
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "0.1";

/**
 * First line written to every log file: a self-describing record so a log-reading
 * agent learns the format from the file itself. Distinguished by the `_meta` key;
 * any line without `_meta` is a normal log record.
 */
function schemaHeaderLine(file: string): string {
  const header = {
    _meta: "slog",
    v: SCHEMA_VERSION,
    format: "ndjson",
    note: "One JSON object per line. Lines with _meta are metadata; all others are log records.",
    levels: LEVELS,
    fields: {
      ts: "ISO-8601 timestamp with milliseconds",
      t: "epoch milliseconds (sortable)",
      level: "level name: trace|debug|info|warn|error|fatal",
      lvl: "numeric severity 10..60 (use for range filters)",
      msg: "human-readable message",
      pid: "process id",
      host: "hostname",
      ctx: "structured fields: base + child bindings + per-call (optional)",
      err: "serialized error: { name, message, stack, code?, cause? } (optional)",
      src: "call site: { file, line, fn? } when source capture is enabled (optional)",
    },
    file: path.basename(file),
    host: os.hostname(),
    pid: process.pid,
    opened: new Date().toISOString(),
  };
  return JSON.stringify(header) + "\n";
}

// ---------------------------------------------------------------------------
// File sink: append + size rotation + gzip + retention pruning
// ---------------------------------------------------------------------------

class FileSink {
  private readonly dir: string;
  private readonly base: string;
  private readonly active: string;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly gzip: boolean;
  private readonly sync: boolean;
  private readonly header: boolean;

  private size = 0;
  private fd: number | null = null;
  private stream: fs.WriteStream | null = null;
  private closed = false;

  constructor(opts: Required<Pick<SlogOptions,
    "dir" | "filename" | "maxFileSize" | "maxFiles" | "maxAgeDays" | "gzip" | "sync"
    | "schemaHeader">>) {
    this.dir = opts.dir;
    this.base = opts.filename;
    this.active = path.join(this.dir, `${this.base}.log`);
    this.maxFileSize = opts.maxFileSize;
    this.maxFiles = opts.maxFiles;
    this.maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000;
    this.gzip = opts.gzip;
    this.sync = opts.sync;
    this.header = opts.schemaHeader;

    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.size = fs.statSync(this.active).size;
    } catch {
      this.size = 0;
    }
    this.open();
    this.prune();
    this.installExitHooks();
  }

  private open(): void {
    if (this.sync) {
      this.fd = fs.openSync(this.active, "a");
    } else {
      this.stream = fs.createWriteStream(this.active, { flags: "a" });
    }
    // A fresh (empty) file gets a self-describing schema header as its first line.
    if (this.header && this.size === 0) {
      this.append(schemaHeaderLine(this.active));
    }
  }

  /** Low-level write that updates the byte counter; never throws. */
  private append(line: string): void {
    try {
      if (this.sync && this.fd !== null) {
        fs.writeSync(this.fd, line);
      } else if (this.stream) {
        this.stream.write(line);
      }
      this.size += Buffer.byteLength(line);
    } catch {
      // Never let logging crash the app.
    }
  }

  write(line: string): void {
    if (this.closed) return;
    if (this.size > 0 && this.size + Buffer.byteLength(line) > this.maxFileSize) {
      this.rotate();
    }
    this.append(line);
  }

  private rotate(): void {
    try {
      this.closeHandle();
      const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .replace(/\..+/, (m) => "-" + m.slice(1, 4));
      const rotated = path.join(this.dir, `${this.base}-${ts}.log`);
      fs.renameSync(this.active, rotated);
      if (this.gzip) this.gzipFile(rotated);
    } catch {
      // If rotation fails, keep going on the existing file.
    } finally {
      this.size = 0;
      this.open();
      this.prune();
    }
  }

  private gzipFile(file: string): void {
    try {
      const gz = file + ".gz";
      const data = fs.readFileSync(file);
      fs.writeFileSync(gz, zlib.gzipSync(data));
      fs.unlinkSync(file);
    } catch {
      // Leave the uncompressed rotated file in place on failure.
    }
  }

  /** Keep newest `maxFiles` rotated artifacts; drop anything older than maxAgeMs. */
  private prune(): void {
    try {
      const prefix = `${this.base}-`;
      const now = Date.now();
      const entries = fs
        .readdirSync(this.dir)
        .filter(
          (f) =>
            f.startsWith(prefix) &&
            (f.endsWith(".log") || f.endsWith(".log.gz")),
        )
        .map((f) => {
          const full = path.join(this.dir, f);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first

      const toDelete = new Set<string>();
      entries.forEach((e, i) => {
        if (i >= this.maxFiles) toDelete.add(e.full);
        if (now - e.mtime > this.maxAgeMs) toDelete.add(e.full);
      });
      for (const f of toDelete) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private closeHandle(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
  }

  private exitHooks: Array<[NodeJS.Signals | "exit" | "beforeExit", (...a: never[]) => void]> = [];

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Remove our process listeners so many short-lived loggers don't leak them.
    for (const [event, handler] of this.exitHooks) {
      process.removeListener(event, handler as (...a: unknown[]) => void);
    }
    this.exitHooks = [];
    this.closeHandle();
  }

  private installExitHooks(): void {
    const onExit = () => this.close();
    const on = (event: NodeJS.Signals | "exit" | "beforeExit", handler: (...a: never[]) => void) => {
      process.on(event, handler as (...a: unknown[]) => void);
      this.exitHooks.push([event, handler]);
    };
    on("exit", onExit);
    on("beforeExit", onExit);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      on(sig, () => {
        this.close();
        // Re-raise default behaviour after flushing.
        process.exit(process.exitCode ?? 0);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Console pretty formatter (TTY-aware)
// ---------------------------------------------------------------------------

// Color via node:util styleText (Node >= 24): auto-detects TTY color support and
// honors NO_COLOR / FORCE_COLOR. Falls back to plain text when color is unsupported.
type Format = Parameters<typeof styleText>[0];

const LEVEL_FORMAT: Record<Level, Format> = {
  trace: "gray",
  debug: "cyan",
  info: "green",
  warn: "yellow",
  error: "red",
  fatal: ["bgRed", "whiteBright"],
};

function paint(format: Format, text: string): string {
  try {
    return styleText(format, text, { stream: process.stdout });
  } catch {
    return text;
  }
}

function prettyFormat(r: LogRecord): string {
  const time = r.ts.slice(11, 23); // HH:mm:ss.SSS
  const label = r.level.toUpperCase().padEnd(5);
  let line = `${paint("dim", time)} ${paint(LEVEL_FORMAT[r.level], label)} ${r.msg}`;
  if (r.ctx && Object.keys(r.ctx).length) {
    const kv = Object.entries(r.ctx)
      .map(([k, v]) => `${paint("dim", k)}=${formatVal(v)}`)
      .join(" ");
    line += ` ${kv}`;
  }
  if (r.src) line += ` ${paint("dim", `(${r.src.file}:${r.src.line})`)}`;
  if (r.err) {
    line += `\n  ${paint("red", `${r.err.name}: ${r.err.message}`)}`;
    if (r.err.stack) {
      const rest = r.err.stack.split("\n").slice(1).join("\n");
      if (rest) line += `\n${paint("dim", rest)}`;
    }
  }
  return line;
}

function formatVal(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  private readonly minLevel: number;
  private readonly bound: Record<string, unknown>;
  private readonly captureSrc: boolean;
  private readonly sink: FileSink | null;
  private readonly toConsole: boolean;
  private readonly pretty: boolean;
  private readonly host: string;
  private readonly pid: number;

  constructor(opts: SlogOptions, shared?: {
    sink: FileSink | null;
    toConsole: boolean;
    pretty: boolean;
    host: string;
    pid: number;
  }) {
    this.minLevel = LEVELS[opts.level ?? "info"];
    this.bound = { ...(opts.base ?? {}) };
    this.captureSrc = opts.captureSource ?? false;

    if (shared) {
      this.sink = shared.sink;
      this.toConsole = shared.toConsole;
      this.pretty = shared.pretty;
      this.host = shared.host;
      this.pid = shared.pid;
    } else {
      const isTTY = Boolean(process.stdout && process.stdout.isTTY);
      this.toConsole =
        opts.console === undefined || opts.console === "auto"
          ? isTTY
          : opts.console;
      this.pretty =
        opts.pretty === undefined || opts.pretty === "auto" ? isTTY : opts.pretty;
      this.host = os.hostname();
      this.pid = process.pid;
      const fileEnabled = opts.file !== false;
      this.sink = fileEnabled
        ? new FileSink({
            dir: opts.dir ?? "./logs",
            filename: opts.filename ?? "app",
            maxFileSize: opts.maxFileSize ?? 10 * 1024 * 1024,
            maxFiles: opts.maxFiles ?? 5,
            maxAgeDays: opts.maxAgeDays ?? 14,
            gzip: opts.gzip ?? true,
            sync: opts.sync ?? true,
            schemaHeader: opts.schemaHeader ?? true,
          })
        : null;
    }
  }

  /** Create a child logger with additional bound context. Shares sinks/output. */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger(
      {
        level: levelName(this.minLevel),
        captureSource: this.captureSrc,
        base: { ...this.bound, ...bindings },
      },
      {
        sink: this.sink,
        toConsole: this.toConsole,
        pretty: this.pretty,
        host: this.host,
        pid: this.pid,
      },
    );
  }

  private emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
    const lvl = LEVELS[level];
    if (lvl < this.minLevel) return;

    let err: SerializedError | undefined;
    let ctx: Record<string, unknown> | undefined;

    const merged = { ...this.bound, ...(fields ?? {}) };
    for (const [k, v] of Object.entries(merged)) {
      if (v instanceof Error) {
        // Conventional slot `err`, but serialize any Error-valued field.
        if (k === "err" && !err) {
          err = serializeError(v);
        } else {
          (ctx ??= {})[k] = serializeError(v);
        }
        continue;
      }
      (ctx ??= {})[k] = v;
    }

    const now = new Date();
    const record: LogRecord = {
      ts: now.toISOString(),
      t: now.getTime(),
      level,
      lvl,
      msg,
      pid: this.pid,
      host: this.host,
      ...(ctx && Object.keys(ctx).length ? { ctx } : {}),
      ...(err ? { err } : {}),
      ...(this.captureSrc ? { src: captureSource() } : {}),
    };

    if (this.sink) this.sink.write(safeStringify(record) + "\n");
    if (this.toConsole) {
      const out = this.pretty ? prettyFormat(record) : safeStringify(record);
      const target = lvl >= LEVELS.error ? process.stderr : process.stdout;
      target.write(out + "\n");
    }
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.emit("trace", msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }
  fatal(msg: string, fields?: Record<string, unknown>): void {
    this.emit("fatal", msg, fields);
  }

  /** Flush and close the file sink. Call before a clean shutdown if desired. */
  close(): void {
    this.sink?.close();
  }
}

function levelName(n: number): Level {
  return LEVEL_NAMES.find((name) => LEVELS[name] === n) ?? "info";
}

/**
 * Create a logger. This is the only entry point you need.
 *
 * @example
 * const log = createLogger({ dir: "./logs", level: "info", base: { app: "myapp" } });
 * log.info("started", { port: 8080 });
 * log.error("failed", { err });            // Error in `err` is auto-serialized
 * const reqLog = log.child({ requestId }); // binds context onto every record
 *
 * @param options See {@link SlogOptions}; all fields optional with sensible defaults
 *   (level "info", dir "./logs", 10 MiB rotation, keep 5 files, 14-day retention).
 */
export function createLogger(options: SlogOptions = {}): Logger {
  return new Logger(options);
}

export default createLogger;
