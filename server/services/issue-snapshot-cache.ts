import type { PaginatedIssues } from "@roubo/shared";

// FR-014: when a plugin is `errored` or `disabled` and the host can't reach it,
// the routes layer falls back to the last successful first-page `listIssues`
// response from this cache so the cut-list keeps rendering instead of going
// blank on 502. The cache is intentionally first-page-only: TC-016's banner
// copy ("Showing the last successful issue snapshot...") talks about one
// snapshot, not paginated state, and serving a stale page 2 with no fresh
// page 1 would mislead the user. Paginated requests still 502 when the plugin
// is down; the client uses `nextCursor: null` on the cached response to stop
// further paging.
//
// In-memory only. Cleared by `pluginManager.shutdown()` and on plugin
// disable/uninstall. Survives plugin crash + restart so the first-page cache
// is the bridge across the `errored` window.

export interface IssueSnapshot {
  response: PaginatedIssues;
  capturedAt: string;
  pluginName: string;
}

const snapshots = new Map<string, IssueSnapshot>();

/**
 * Record a successful first-page response. Returns silently for non-first-page
 * responses so the caller can call this unconditionally — keeps the route
 * code straightforward.
 */
export function recordSnapshot(
  pluginId: string,
  response: PaginatedIssues,
  pluginName: string,
  isFirstPage: boolean,
): void {
  if (!isFirstPage) return;
  // Defensive copy so later mutations on the route's `body` don't leak into
  // the cache. JSON round-trip is fine here — the response is plain data.
  const cloned = JSON.parse(JSON.stringify(response)) as PaginatedIssues;
  // Clear any stale markers the caller may have left set so the next read
  // doesn't double-stamp them when we serve from the cache.
  delete cloned.stale;
  delete cloned.snapshotCapturedAt;
  snapshots.set(pluginId, {
    response: cloned,
    capturedAt: new Date().toISOString(),
    pluginName,
  });
}

export function getSnapshot(pluginId: string): IssueSnapshot | undefined {
  return snapshots.get(pluginId);
}

export function clearSnapshot(pluginId: string): void {
  snapshots.delete(pluginId);
}

export function clearAll(): void {
  snapshots.clear();
}
