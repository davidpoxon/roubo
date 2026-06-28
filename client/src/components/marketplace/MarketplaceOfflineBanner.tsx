import { AlertTriangle } from "lucide-react";
import type { MarketplaceCatalogSource } from "@roubo/shared";

// Marketplace offline / staleness banner (CPHM-FR-009 / CPHM-NFR-003, issue
// #372; verifies CPHM-TC-043 S002 and CPHM-TC-051 S003). The catalog-client
// degrades NETWORK -> CACHE -> SEED fail-closed so the plugin list is never zero,
// but the route now also surfaces the served catalog's `source` / `fetchedAt`,
// so the Plugins view can tell the user it is offline and how stale the served
// catalog is.
//
// DESIGN.md "Attention banner": amber-50 background, amber-200 border, amber-800
// message, AlertTriangle marker (matching the testbench StalenessBanner), amber
// signalling "needs attention" consistent with the system's amber-for-active.
// Distinct from that component's shared `staleness-banner` testid: this carries
// its own `marketplace-offline-banner` id so the two never collide.
//
// The banner states three things (the CPHM-TC-043 S002 observations):
//   (a) the marketplace is unreachable and the last verified catalog is shown,
//   (b) how stale that catalog is ("fetched 2h ago"); the bundled seed never had
//       a fetch, so its `fetchedAt` is null and the staleness clause is omitted,
//   (c) seeded and installed plugins remain available, new installs are paused
//       until the marketplace is reachable again.
// It renders only when `source !== "network"`; on reconnect the source flips back
// to "network" and the banner clears (CPHM-TC-051 S006).

/**
 * Format an ISO fetch timestamp as a coarse "ago" string ("just now", "5m ago",
 * "2h ago", "3d ago"). Returns null for a missing or unparseable timestamp (the
 * seed has no fetch), so the caller omits the staleness clause.
 */
function formatFetchedAgo(fetchedAt: string | null): string | null {
  if (fetchedAt === null) return null;
  const then = new Date(fetchedAt).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STRINGS = {
  // (a) unreachable + last verified catalog shown. The staleness clause (b) is
  // appended when a fetch timestamp is known (cache), omitted for the seed.
  unreachableWithFetch: (ago: string) =>
    `The marketplace is unreachable. Showing the last verified catalog, fetched ${ago}.`,
  unreachableNoFetch: "The marketplace is unreachable. Showing the last verified catalog.",
  // (c) seeded / installed stay available, new installs paused until reconnect.
  availability:
    "Seeded and installed plugins remain available; new installs are paused until you're back online.",
};

export default function MarketplaceOfflineBanner({
  source,
  fetchedAt,
}: {
  source: MarketplaceCatalogSource;
  fetchedAt: string | null;
}) {
  // Only degraded sources (the marketplace was unreachable) show the banner; a
  // live "network" catalog clears it.
  if (source === "network") return null;

  const ago = formatFetchedAgo(fetchedAt);
  const lead = ago === null ? STRINGS.unreachableNoFetch : STRINGS.unreachableWithFetch(ago);

  return (
    <div
      role="status"
      data-testid="marketplace-offline-banner"
      className="flex items-start gap-3 px-4 py-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
      <div className="flex-1 min-w-0 space-y-1">
        <p
          data-testid="marketplace-offline-banner-status"
          className="text-sm text-amber-800 dark:text-amber-200"
        >
          {lead}
        </p>
        <p
          data-testid="marketplace-offline-banner-availability"
          className="text-[13px] text-amber-700 dark:text-amber-300/90"
        >
          {STRINGS.availability}
        </p>
      </div>
    </div>
  );
}
