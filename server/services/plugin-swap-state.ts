// Shared state of a plugin process swap (HR-FR-009): the swap gap that a
// component start or stop waits out, and the stale marks a swap leaves when a
// resource did not re-bind or the new process did not start.
//
// It lives apart from plugin-manager so bench-manager and the bench serialiser
// can read it without importing plugin-manager's process supervision, and so a
// test that replaces plugin-manager with a stub still sees the real state.

/**
 * How long a start or stop waits for a swap gap to close before it goes on
 * anyway. A gap closes when the new process is up or has failed to start, so
 * this only bounds a swap that never finishes (an update whose registration
 * threw); the waiter then meets the same "not running" error it would have
 * met with no queue at all.
 */
export const SWAP_GAP_TIMEOUT_MS = 60_000;

interface SwapGap {
  promise: Promise<void>;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

const gaps = new Map<string, SwapGap>();

/**
 * Opens the swap gap of `pluginId`: from now until `closeSwapGap`, the old
 * process is stopping or gone and the new one is not up yet. Opening an open
 * gap is a no-op, so the waiters of the first opening are released together.
 */
export function openSwapGap(pluginId: string): void {
  if (gaps.has(pluginId)) return;
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const timer = setTimeout(() => closeSwapGap(pluginId), SWAP_GAP_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  gaps.set(pluginId, { promise, resolve, timer });
}

/** Closes the swap gap of `pluginId` and releases every start or stop that waits on it. */
export function closeSwapGap(pluginId: string): void {
  const gap = gaps.get(pluginId);
  if (!gap) return;
  gaps.delete(pluginId);
  clearTimeout(gap.timer);
  gap.resolve();
}

export function isInSwapGap(pluginId: string): boolean {
  return gaps.has(pluginId);
}

/**
 * Resolves when `pluginId` is not in a swap gap: at once when no swap runs,
 * else when the gap closes. A start or stop awaits this before it resolves
 * the plugin's connection, so one that lands in the gap is queued behind the
 * swap rather than failed with plugin-not-enabled.
 */
export function waitForSwapGap(pluginId: string): Promise<void> {
  return gaps.get(pluginId)?.promise ?? Promise.resolve();
}

/**
 * A bench, named by its project and its number. Bench numbers are per project,
 * so a number alone does not name one bench.
 */
export interface SwapBenchRef {
  projectId: string;
  benchId: number;
}

function benchRefKey(projectId: string, benchId: number): string {
  return JSON.stringify([projectId, benchId]);
}

// pluginId -> the keys (benchRefKey) of the benches the swap left stale. A
// plugin is stale while it has an entry here, even one with no bench.
const stale = new Map<string, Set<string>>();

/**
 * Marks `pluginId` stale, and each of `benches` with it. Marks add up: a bench
 * marked by an earlier swap stays marked until the plugin is cleared or the
 * bench is (see clearBenchStale).
 */
export function markPluginStale(pluginId: string, benches: Iterable<SwapBenchRef>): void {
  const keys = stale.get(pluginId) ?? new Set<string>();
  for (const { projectId, benchId } of benches) keys.add(benchRefKey(projectId, benchId));
  stale.set(pluginId, keys);
}

/**
 * Clears the stale mark of `pluginId` and of the benches it marked: the plugin
 * is up again with its resources re-bound, or it is gone.
 */
export function clearPluginStale(pluginId: string): void {
  stale.delete(pluginId);
}

/**
 * Drops one bench from every plugin's stale set: the bench was stopped,
 * restarted or cleared, so no resource of it is left unbound, and a bench
 * created later with the same number starts fresh. The plugin's own mark stays.
 */
export function clearBenchStale(projectId: string, benchId: number): void {
  const key = benchRefKey(projectId, benchId);
  for (const keys of stale.values()) keys.delete(key);
}

export function isPluginStale(pluginId: string): boolean {
  return stale.has(pluginId);
}

/**
 * The bench numbers of `benches`, ascending and once each. A notice names a
 * bench by its number, so two projects' benches with one number read as one.
 */
export function benchNumbersOf(benches: Iterable<SwapBenchRef>): number[] {
  const ids = new Set<number>();
  for (const { benchId } of benches) ids.add(benchId);
  return [...ids].sort((a, b) => a - b);
}

/** The bench numbers, ascending and once each, that a swap of `pluginId` left stale. */
export function staleBenchIds(pluginId: string): number[] {
  const keys = stale.get(pluginId);
  if (!keys) return [];
  return benchNumbersOf(
    [...keys].map((key) => {
      const [projectId, benchId] = JSON.parse(key) as [string, number];
      return { projectId, benchId };
    }),
  );
}

/** Whether a swap of any plugin left bench `benchId` of `projectId` stale. */
export function isBenchStaleFromSwap(projectId: string, benchId: number): boolean {
  const key = benchRefKey(projectId, benchId);
  for (const keys of stale.values()) {
    if (keys.has(key)) return true;
  }
  return false;
}

/** Test-only: forget every gap and stale mark. */
export function resetForTests(): void {
  for (const id of [...gaps.keys()]) closeSwapGap(id);
  stale.clear();
}
