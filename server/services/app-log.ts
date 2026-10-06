import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { getRouboDir } from "./state.js";
import { redactSecrets } from "./log-redaction.js";

// Roubo's first on-disk application log (AP-NFR-003-adjacent, TODO: cite
// tracking issue once filed).
//
// Electron runs the server in-process (electron/src/bootstrap.ts), so every
// server console.warn/console.error already flows through the Electron main
// process's own stdout/stderr. For a Finder-launched packaged app that goes
// nowhere a user can read it: there is no terminal attached, and nothing was
// ever written to disk. This tees both levels to a file under the user's Roubo
// directory, so a warning that would otherwise vanish stays inspectable.
//
// Deliberately synchronous: console.warn/console.error are not a hot path, and
// the uncaughtExceptionMonitor handler below needs the bytes to have landed on
// disk before the process can exit, which only a synchronous write guarantees.

const LOG_ROTATION_BYTES = 5 * 1024 * 1024;

let installed = false;
let logBytes = 0;
let dirEnsured = false;
let savedWarn: typeof console.warn | undefined;
let savedError: typeof console.error | undefined;
let monitorHandler: ((err: unknown) => void) | undefined;

function logDir(): string {
  // Tests redirect here directly, the same way plugin-manager's
  // ROUBO_USER_PLUGINS_DIR redirects its own log root.
  const override = process.env.ROUBO_APP_LOG_DIR;
  if (override) return override;
  return path.join(getRouboDir(), "logs");
}

function currentLogPath(): string {
  return path.join(logDir(), "current.log");
}

function previousLogPath(): string {
  return path.join(logDir(), "previous.log");
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLine(level: "warn" | "error", args: unknown[]): string {
  const ts = new Date().toISOString();
  const text = args.map(describe).join(" ");
  // The single chokepoint every line passes through, same guarantee
  // plugin-manager's formatLogLine gives its own logs.
  return `${ts} [${level}] ${redactSecrets(text)}\n`;
}

function rotateIfNeeded(addedBytes: number): void {
  logBytes += addedBytes;
  if (logBytes < LOG_ROTATION_BYTES) return;
  logBytes = 0;
  dirEnsured = false;
  try {
    renameSync(currentLogPath(), previousLogPath());
  } catch {
    // best-effort
  }
}

function writeLine(line: string): void {
  try {
    if (!dirEnsured) {
      mkdirSync(logDir(), { recursive: true });
      dirEnsured = true;
    }
    appendFileSync(currentLogPath(), line);
    rotateIfNeeded(Buffer.byteLength(line, "utf8"));
  } catch {
    // The log file is a diagnostic aid, not a dependency: a write failure here
    // (disk full, permissions) must never break the console output it mirrors.
  }
}

/**
 * Tees `console.warn` and `console.error` to `<rouboDir>/logs/current.log`
 * (rotating to `previous.log` past `LOG_ROTATION_BYTES`), and observes
 * uncaught exceptions so a crash lands in the file too. Idempotent: safe to
 * call from every server entry point.
 *
 * No-ops under `NODE_ENV=test` unless `ROUBO_APP_LOG_DIR` is set, mirroring
 * plugin-manager's guard against polluting the real `~/.roubo` during tests.
 */
export function installAppLogging(): void {
  if (installed) return;
  if (process.env.NODE_ENV === "test" && !process.env.ROUBO_APP_LOG_DIR) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  savedWarn = originalWarn;
  savedError = originalError;

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    writeLine(formatLine("warn", args));
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    writeLine(formatLine("error", args));
  };

  // Observes every uncaught exception, and (Node 15+ runs with
  // --unhandled-rejections=throw) every unhandled rejection, without changing
  // crash behaviour: Node's default uncaughtException handler still runs
  // afterward and the process still exits. A handler on `uncaughtException`
  // itself would suppress that default and leave the process running in a
  // corrupted state, which is worse than the crash it would be logging, so
  // this deliberately uses the monitor event instead.
  monitorHandler = (err: unknown) => {
    writeLine(formatLine("error", [err]));
  };
  process.on("uncaughtExceptionMonitor", monitorHandler);
}

// Test-only teardown. `installAppLogging` mutates the shared global `console`
// object, which `vi.resetModules()` does not touch, so a test must undo that
// itself rather than rely on module isolation: restores the console methods
// and uncaughtExceptionMonitor listener this module replaced, and clears the
// rotation counter, so a later installAppLogging() in the same process starts
// clean instead of wrapping an already-wrapped console.
export const __test = {
  reset(): void {
    if (savedWarn) console.warn = savedWarn;
    if (savedError) console.error = savedError;
    if (monitorHandler) process.removeListener("uncaughtExceptionMonitor", monitorHandler);
    installed = false;
    logBytes = 0;
    dirEnsured = false;
    savedWarn = undefined;
    savedError = undefined;
    monitorHandler = undefined;
  },
};
