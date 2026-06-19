// Relative-time formatting for the cut list's last-updated indicator (FR-006).
// Drives the wording shown next to the refresh control: a fresh "updated N ago"
// when the data is live, and a distinct "snapshot N ago" when a cached/stale
// snapshot is being served (the plugin is unavailable). Keeping both labels in
// one place guarantees the stale state never reads as a normal fresh update.

/**
 * Format an elapsed duration as a compact time-ago string: "just now",
 * "2m ago", "3h ago", "5d ago". Sub-minute gaps collapse to "just now".
 */
export function formatTimeAgo(fromMs: number, nowMs: number = Date.now()): string {
  const deltaMs = Math.max(0, nowMs - fromMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Last-updated label for the live (warm) state: "updated just now" /
 * "updated 2m ago". Returns null when no successful fetch has happened yet
 * (`updatedAtMs` is 0), so the indicator stays hidden rather than reading a
 * misleading epoch.
 */
export function formatLastUpdated(updatedAtMs: number, nowMs: number = Date.now()): string | null {
  if (!updatedAtMs) return null;
  return `updated ${formatTimeAgo(updatedAtMs, nowMs)}`;
}

/**
 * Last-updated label for the stale state (plugin unavailable, cached snapshot):
 * "snapshot just now" / "snapshot 14m ago". Deliberately worded differently
 * from the warm `formatLastUpdated` so a cached snapshot never reads as a fresh
 * update (FR-006 / AC3). Returns null when no timestamp is available.
 */
export function formatSnapshotAge(capturedAtMs: number, nowMs: number = Date.now()): string | null {
  if (!capturedAtMs) return null;
  return `snapshot ${formatTimeAgo(capturedAtMs, nowMs)}`;
}
