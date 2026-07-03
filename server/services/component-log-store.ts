import type { ComponentLogLine } from "@roubo/shared";
import { MAX_LOG_LINES } from "./process-manager.js";

/**
 * Structured per-(projectId, benchId, componentName) log store for plugin-backed
 * components (FR-014, NFR-004).
 *
 * A component plugin pushes log lines via host.component.reportLog, which the
 * host appends here. GET /components/:name/logs reads the tail. The store mirrors
 * the built-in process-manager buffer so both surfaces return the identical
 * { source, text, ts } shape, the same MAX_LOG_LINES cap, and the same ring-
 * buffer eviction behaviour.
 *
 * Restart semantics (AC4): the store is the durable side of a plugin component's
 * log history. It is NOT cleared on a Stop -> Start cycle, so logs from before a
 * restart survive alongside logs appended after it. Each appended line's
 * timestamp is clamped to be non-decreasing relative to the last retained line,
 * so a plugin that restarts and re-clocks cannot make the tail go backwards
 * (monotonic ts). Exact-duplicate consecutive lines (same source, text, ts) are
 * dropped so a plugin that re-emits its buffered backlog on reconnect does not
 * double-log. Clearing is explicit (component teardown / workspace removal).
 */

interface StoredComponent {
  lines: ComponentLogLine[];
}

const stores = new Map<string, StoredComponent>();

function key(projectId: string, benchId: number, componentName: string): string {
  return `${projectId}:${benchId}:${componentName}`;
}

function ensure(projectId: string, benchId: number, componentName: string): StoredComponent {
  const k = key(projectId, benchId, componentName);
  let store = stores.get(k);
  if (!store) {
    store = { lines: [] };
    stores.set(k, store);
  }
  return store;
}

/**
 * Append one structured log line for a plugin-backed component. The timestamp is
 * clamped forward so the retained tail is always monotonically non-decreasing
 * (AC4), and an exact consecutive duplicate (source + text + clamped ts) is
 * dropped so a reconnecting plugin re-emitting its backlog does not duplicate.
 */
export function appendComponentLog(
  projectId: string,
  benchId: number,
  componentName: string,
  line: ComponentLogLine,
): void {
  const store = ensure(projectId, benchId, componentName);
  const last = store.lines[store.lines.length - 1];

  // Clamp ts forward: never let the tail's timestamps go backwards, even if the
  // plugin re-clocks across a restart.
  let ts = line.ts;
  if (last && last.ts > ts) {
    ts = last.ts;
  }

  // Drop an exact consecutive duplicate (the backlog-replay case).
  if (last && last.source === line.source && last.text === line.text && last.ts === ts) {
    return;
  }

  store.lines.push({ source: line.source, text: line.text, ts });
  if (store.lines.length > MAX_LOG_LINES) {
    store.lines.shift();
  }
}

/**
 * Read the tail of a plugin-backed component's structured logs. Returns copies so
 * callers cannot mutate the retained buffer. An unknown component yields an empty
 * array (parity with process-manager.getProcessLogLines for an unknown id).
 */
export function getComponentLogLines(
  projectId: string,
  benchId: number,
  componentName: string,
  tail = 200,
): ComponentLogLine[] {
  const store = stores.get(key(projectId, benchId, componentName));
  if (!store) return [];
  return store.lines.slice(-tail).map((line) => ({ ...line }));
}

/**
 * Whether any plugin-backed log history exists for this component. Lets the logs
 * route decide between the structured store (plugin-backed) and the built-in
 * process-manager buffer without consulting component config.
 */
export function hasComponentLogs(
  projectId: string,
  benchId: number,
  componentName: string,
): boolean {
  return stores.has(key(projectId, benchId, componentName));
}

/**
 * Explicitly drop a component's log history. Called on component teardown or
 * workspace removal, NOT on a Stop -> Start cycle (which must retain history,
 * AC4). Mirrors process-manager.clearProcessLogs for the plugin-backed side.
 */
export function clearComponentLogs(
  projectId: string,
  benchId: number,
  componentName: string,
): void {
  stores.delete(key(projectId, benchId, componentName));
}

/**
 * Drop every component's log history for a bench (#397). Called on bench teardown
 * alongside the other per-bench in-memory clears (clearLedgerForBench /
 * clearAuditLog / unregisterBrokerContextsForBench / clearComponentStatusForBench),
 * so a bench id that is later reused does not inherit the prior generation's
 * forwarded compose/init/migration logs at GET .../components/:name/logs. This is
 * the "workspace removal" arm of the store's clearing contract; a Stop -> Start
 * cycle must NOT call it (history survives a restart, AC4).
 */
export function clearComponentLogsForBench(projectId: string, benchId: number): void {
  const prefix = `${projectId}:${benchId}:`;
  for (const k of stores.keys()) {
    if (k.startsWith(prefix)) stores.delete(k);
  }
}

/** Test-only reset of the whole store. */
export function _resetForTest(): void {
  stores.clear();
}
