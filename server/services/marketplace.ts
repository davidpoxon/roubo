import semver from "semver";
import type {
  InstallPreview,
  MarketplaceCatalogEntry,
  MarketplaceCatalogSource,
  MarketplaceKind,
  MarketplaceListing,
} from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";
import * as catalogClient from "./catalog-client.js";
import type { VerifiedCatalog } from "./catalog-client.js";

// Marketplace catalog service (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621;
// CP-FR-021 / CP-US-011, issue #622; hosted-marketplace catalog-client,
// CPHM-FR-001 / FR-009, issue #306).
//
// The catalog is no longer an embedded module-load constant: entries come from
// the `catalog-client`, which fetches the signed catalog + key-ring over HTTPS,
// verifies them fail-closed against the embedded bootstrap root key, caches the
// last verified envelope, and degrades NETWORK -> CACHE -> SEED so the listing
// is never zero. This service reads those verified entries, cross-references the
// installed plugin set to annotate each entry's install / update state, and
// supports search + kind filtering. Install and update REUSE the existing
// plugin-installer staging -> consent -> commit flow; the expected per-entry
// integrity digest is threaded so the installer can reject a tampered package
// before commit. Revoked entries are filtered from listings and rejected at
// install/update (CP-TC-109). When the catalog is being served from the cache
// or the seed (the marketplace was unreachable), a NEW install/update is paused
// with a clear `marketplace-unreachable` error (CPHM-TC-045/050/051); seeded and
// already-installed plugins are unaffected.

export interface ListCatalogParams {
  q?: string;
  kind?: MarketplaceKind;
}

/**
 * The annotated, filtered catalog plus the served catalog's provenance. `source`
 * and `fetchedAt` come straight from the catalog-client's degrade chain so the
 * route can forward them to the client, which renders the offline / staleness
 * banner when `source !== "network"` (CPHM-FR-009 / CPHM-NFR-003, issue #372).
 * `fetchedAt` is the ISO fetch timestamp (network / cache), or `null` for the
 * bundled seed.
 */
export interface CatalogResult {
  listings: MarketplaceListing[];
  source: MarketplaceCatalogSource;
  fetchedAt: string | null;
}

/**
 * Compare two version strings. Returns true when `catalogVersion` is strictly
 * newer than `installedVersion`. Uses semver when both parse; falls back to a
 * case-insensitive string inequality so a non-semver bump still surfaces an
 * update rather than silently hiding one.
 */
export function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const a = semver.coerce(catalogVersion);
  const b = semver.coerce(installedVersion);
  if (a && b) return semver.gt(a, b);
  return catalogVersion.trim().toLowerCase() !== installedVersion.trim().toLowerCase();
}

function annotate(entry: MarketplaceCatalogEntry): MarketplaceListing {
  const record = pluginManager.listInstalled().find((r) => r.id === entry.id);
  const installed = record !== undefined;
  const installedVersion = record?.manifest?.version ?? null;
  // Bundled plugins (e.g. github-com) ship with Roubo and update with it; they
  // cannot be updated in place. The catalog source for such an entry is the same
  // bundled directory, so a stale catalog `version` field could otherwise read as
  // a newer release and offer an Update action that always fails at
  // previewUpdateFromGitUrl (issue #752). Suppress updateAvailable for bundled
  // records here, where it is computed, so the card shows them as Installed.
  const updateAvailable =
    installed &&
    record?.source !== "bundled" &&
    installedVersion !== null &&
    isNewerVersion(entry.version, installedVersion);
  return { ...entry, installed, installedVersion, updateAvailable };
}

function matchesQuery(listing: MarketplaceListing, q: string): boolean {
  const haystack = `${listing.name} ${listing.id} ${listing.summary}`.toLowerCase();
  return haystack.includes(q);
}

/**
 * Return the curated catalog, annotated with install/update state, filtered by
 * an optional free-text query (name / id / summary, case-insensitive) and an
 * optional kind. Revoked entries are filtered out (CP-TC-109). Serves the most
 * recently resolved catalog (the catalog-client refreshes it from the network at
 * most once per its short memo TTL: fetch-on-marketplace-open, NFR-004),
 * degrading to cache then seed; the list is never zero. Filtering runs in memory,
 * so search-as-you-type does not force a fetch + signature verify per keystroke.
 * Throws `CatalogUnverifiedError` only when even the bundled seed fails
 * verification (the route maps that to 502).
 *
 * Returns the served catalog's provenance (`source` / `fetchedAt`) alongside the
 * listings so the route can forward it: when the catalog was served from the
 * cache or the seed (the marketplace was unreachable), the client renders the
 * offline / staleness banner (CPHM-FR-009 / CPHM-NFR-003, issue #372).
 */
export async function listCatalog(params: ListCatalogParams = {}): Promise<CatalogResult> {
  const { entries, source, fetchedAt } = await catalogClient.getVerifiedCatalog();
  const q = params.q?.trim().toLowerCase() ?? "";
  const kind = params.kind;
  const listings = entries
    .filter((e) => e.revoked !== true)
    .map(annotate)
    .filter(
      (listing) =>
        (kind === undefined || listing.kind === kind) &&
        (q.length === 0 || matchesQuery(listing, q)),
    );
  return { listings, source, fetchedAt };
}

/**
 * Resolve a catalog entry by id, or null when it is not in the verified
 * catalog. Reuses the most recently resolved catalog (the one the open
 * Plugins view fetched) rather than forcing another network round-trip. Revoked
 * entries are still returned here so install/update can emit a specific
 * `revoked` error rather than a generic unknown-id error.
 */
export async function resolveEntry(id: string): Promise<MarketplaceCatalogEntry | null> {
  const { entries } = await catalogClient.getVerifiedCatalog();
  return entries.find((e) => e.id === id) ?? null;
}

function assertInstallable(catalog: VerifiedCatalog, id: string): MarketplaceCatalogEntry {
  const entry = catalog.entries.find((e) => e.id === id) ?? null;
  if (!entry) {
    throw new pluginInstaller.InstallError("invalid-input", `Unknown catalog plugin: ${id}`);
  }
  if (entry.revoked === true) {
    throw new pluginInstaller.InstallError(
      "revoked",
      `Plugin "${id}" has been revoked and can no longer be installed or updated.`,
    );
  }
  if (catalog.source !== "network") {
    // Degraded to cache / seed: the marketplace is unreachable, so a new
    // install/update is paused with a clear message rather than attempting (and
    // failing) a fetch (CPHM-TC-045/050/051). Seeded and already-installed
    // plugins keep working.
    throw new pluginInstaller.InstallError(
      "marketplace-unreachable",
      `Can't install "${id}" while the marketplace is unreachable. Seeded and already-installed plugins remain available; new installs resume when the marketplace is reachable again.`,
    );
  }
  return entry;
}

/**
 * Stage an install of a catalog entry, delegating to the plugin-installer preview
 * matching the entry's source: a `git` source clones (`previewFromGitUrl`), a
 * `release` source downloads + unpacks the built artifact (`previewFromRelease`,
 * issue #370). Returns an InstallPreview (staging token + manifest) the client
 * drives through the existing consent + confirm endpoints. Throws when the id is
 * not in the curated catalog (`invalid-input`), has been revoked (`revoked`), or
 * the marketplace is unreachable (`marketplace-unreachable`). The entry's expected
 * integrity digest is threaded to the installer so a tampered package is rejected
 * before commit (CP-TC-107/108).
 */
export async function install(id: string): Promise<InstallPreview> {
  const catalog = await catalogClient.getVerifiedCatalog();
  const entry = assertInstallable(catalog, id);
  if (entry.source.type === "release") {
    return pluginInstaller.previewFromRelease(entry.source.assetUrl, entry.integrity);
  }
  return pluginInstaller.previewFromGitUrl(
    entry.source.url,
    entry.integrity,
    entry.source.directory,
  );
}

/**
 * Stage an update of an already-installed catalog entry, delegating to the
 * plugin-installer update preview matching the entry's source: a `git` source
 * re-clones (`previewUpdateFromGitUrl`), a `release` source downloads + unpacks
 * the new built artifact (`previewUpdateFromRelease`, issue #370). Either replaces
 * the installed copy at commit time. Returns an InstallPreview. Throws when the id
 * is not in the catalog (`invalid-input`), has been revoked (`revoked`), or the
 * marketplace is unreachable (`marketplace-unreachable`). The expected integrity
 * digest is threaded so a tampered package is rejected before commit, leaving the
 * existing version intact (CP-TC-112).
 */
export async function update(id: string): Promise<InstallPreview> {
  const catalog = await catalogClient.getVerifiedCatalog();
  const entry = assertInstallable(catalog, id);
  if (entry.source.type === "release") {
    return pluginInstaller.previewUpdateFromRelease(
      entry.source.assetUrl,
      entry.id,
      entry.integrity,
    );
  }
  return pluginInstaller.previewUpdateFromGitUrl(
    entry.source.url,
    entry.id,
    entry.integrity,
    entry.source.directory,
  );
}
