import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { FIRST_PARTY_SOURCE_ID, parseManifest } from "@roubo/shared";
import type {
  InstallPreview,
  MarketplaceCatalogEntry,
  MarketplaceCatalogSource,
  MarketplaceKind,
  MarketplaceListing,
  MarketplaceSource,
  MarketplaceSourceStatus,
  PluginLifecycle,
  PluginManifest,
  PluginRecord,
} from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";
import * as catalogClient from "./catalog-client.js";
import type { ThirdPartyCatalogClient, VerifiedCatalog } from "./catalog-client.js";
import * as sourcesState from "./marketplace-sources-state.js";

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

// Multi-source listing (CPHMTP-FR-004 / NFR-006 / NFR-007, issue #557): listCatalog
// no longer reads the first-party client alone. It fans out over the first-party
// catalog AND every registered source concurrently (Promise.all), merging the
// results into one list where every entry is stamped with the `sourceId` it came
// from. Isolation falls out of the fan-out: each third-party client owns the
// existing 5s per-fetch timeout and 256KB cap and never throws, so a dead source
// costs at most its own timeout and can never block a healthy source or the
// first-party section. Per-source health rides back on `sources` rather than one
// catalog-wide scalar, so only the failed source shows as unavailable.
//
// Install and update stay FIRST-PARTY ONLY on this slice: unsigned install (issue
// #559) and cross-source id collisions (issue #558) are separate slices, so a
// third-party entry lists here but is not installable yet.

export interface ListCatalogParams {
  q?: string;
  kind?: MarketplaceKind;
  /** Scope the merged list to one source's entries (the source filter chips). */
  sourceId?: string;
}

/**
 * The merged, annotated, filtered multi-source catalog.
 *
 * `source` and `fetchedAt` are the FIRST-PARTY catalog's provenance, straight from
 * the first-party catalog-client's degrade chain, so the route can forward them to
 * the client, which renders the offline / staleness banner when
 * `source !== "network"` (CPHM-FR-009 / CPHM-NFR-003, issue #372). `fetchedAt` is
 * the ISO fetch timestamp (network / cache), or `null` for the bundled seed. They
 * stay first-party-scoped: a third-party source going dark must not flip the
 * first-party banner.
 *
 * `sources` is the per-source status of every source in the fan-out (first-party
 * first, then registered sources in registration order), so one dead source is
 * reported as unavailable on its own row while the rest list normally
 * (CPHMTP-NFR-007). It always describes every source, even when `params.sourceId`
 * scoped the listings to one, so the client can keep rendering the full chip row.
 */
export interface CatalogResult {
  listings: MarketplaceListing[];
  source: MarketplaceCatalogSource;
  fetchedAt: string | null;
  sources: MarketplaceSourceStatus[];
}

/** Display label for the built-in catalog's provenance chip and filter chip. */
const FIRST_PARTY_LABEL = "Roubo first-party";

/**
 * A registered source row carries a URL but no display name, so the chip label is
 * derived from the URL's host (`marketplace.acme.example` reads better than the
 * generated `marketplace-acme-example-1a2b3c4d` slug). Falls back to the raw URL
 * for an unparseable value, so a label is never empty.
 */
function sourceLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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

// Repo root relative to this service file (server/services/ -> repo root), used
// to locate a bundled plugin's `plugins/<id>` source manifest for PRE-INSTALL
// enrichment (issue #401).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read the declared manifest for a catalog entry so the drawer can render its
 * permissions + lifecycle PRE-INSTALL (issue #401), without baking those fields
 * into the signed catalog payload (which would need the out-of-band signing key
 * and would trip the marketplace drift guard). Prefer the installed record's
 * manifest (authoritative for what is on the machine, always present in
 * production for a seeded / installed plugin); otherwise read the bundled
 * `plugins/<id>` source manifest the git+directory catalog entry points at
 * (available in the source tree and in dev). Returns null when neither is
 * available (a packaged app with an uninstalled, non-bundled entry), so the
 * drawer simply omits the provenance rather than failing.
 */
function readEntryManifest(
  entry: MarketplaceCatalogEntry,
  record: PluginRecord | undefined,
): PluginManifest | null {
  if (record?.manifest) return record.manifest;
  if (entry.source.type !== "git" || entry.source.directory === undefined) return null;
  const manifestPath = path.resolve(REPO_ROOT, entry.source.directory, "roubo-plugin.yaml");
  try {
    const parsed = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}

function annotate(entry: MarketplaceCatalogEntry, sourceId: string): MarketplaceListing {
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
  // PRE-INSTALL provenance the detail drawer renders (issue #401). Lifecycle is a
  // component-plugin concept: integration plugins have no start/stop lifecycle,
  // so their drawer omits the row (lifecycle stays null). An absent manifest
  // `lifecycle` defaults to long-running, the shape every existing component has.
  const manifest = readEntryManifest(entry, record);
  const declaredPermissions = manifest?.permissions ?? null;
  const lifecycle: PluginLifecycle | null =
    manifest !== null && entry.kind === "component" ? (manifest.lifecycle ?? "long-running") : null;
  return {
    ...entry,
    installed,
    installedVersion,
    updateAvailable,
    declaredPermissions,
    lifecycle,
    // Per-entry provenance (CPHMTP-FR-004, issue #557): stamped from the client
    // that returned the entry, never read off the entry itself.
    sourceId,
    // `verified` is the display-only first-party curation flag, and it is a field
    // of the (unsigned, unverifiable) third-party payload, so a hostile source
    // could serve `verified: true` and borrow the green first-party treatment.
    // Only the first-party signed chain can assert it: force it false for every
    // third-party entry here, where provenance is known. The persistent unverified
    // badge proper (CPHMTP-NFR-001) is issue #563.
    verified: sourceId === FIRST_PARTY_SOURCE_ID ? entry.verified : false,
  };
}

function matchesQuery(listing: MarketplaceListing, q: string): boolean {
  const haystack = `${listing.name} ${listing.id} ${listing.summary}`.toLowerCase();
  return haystack.includes(q);
}

/** One source's contribution to the merged listing: its entries and its health. */
interface SourceResult {
  entries: MarketplaceCatalogEntry[];
  status: MarketplaceSourceStatus;
}

// Third-party clients are cached per source id for the life of the process, so a
// listCatalog call reuses the client's in-memory memo (and its warmed per-source
// cache) instead of re-fetching every source on every keystroke: constructing a
// fresh client per call would hand each one an empty memo and defeat the
// fetch-on-marketplace-open budget the first-party path already respects. A row
// whose URL changed (or that was removed and re-registered at a new URL) is
// rebuilt rather than reused, and a removed row's client is simply never asked
// again.
//
// The cached value is the in-flight BUILD PROMISE, not the resolved client, and
// the entry is `set` SYNCHRONOUSLY, before the build's first await (issue #595).
// That invariant is what makes invalidation correct. The build reads the keyring,
// an OS process spawn that Express handlers interleave at, so caching only the
// resolved client left a window in which a concurrent invalidateSourceClient found
// no entry, deleted nothing, and let the resuming build cache a pre-rotation
// client that every later listCatalog reused. With an entry present from the
// instant the cold path starts, an invalidation always has a real entry to drop.
// The same invariant collapses the duplicate cold build: a second concurrent
// caller awaits the same promise, so one keyring spawn and one client.
const thirdPartyClients = new Map<
  string,
  { url: string; client: Promise<ThirdPartyCatalogClient> }
>();

/**
 * Drop a source's cached client so the next listCatalog rebuilds it from the
 * current registry row and keyring credential. The registry-mutating routes call
 * this after a successful add / re-register / remove.
 *
 * A client captures its credential once at construction, and a re-registration
 * resolves to the SAME id and url (the id is a deterministic slug of the
 * normalised href), so a rotated token would otherwise never reach the client:
 * the source would 401, report unavailable, and stay that way until the process
 * restarted. Invalidating here, at the one place the registry changes, keeps the
 * keyring read on the cold path. Re-reading it per listCatalog instead would
 * spawn a keyring process (`security find-generic-password` / `secret-tool
 * lookup`) per credentialed source on every keystroke in the search field, and
 * would darken a healthy source whenever the keyring hiccupped.
 */
export function invalidateSourceClient(id: string): void {
  thirdPartyClients.delete(id);
}

/** Read the source's keyring credential, then construct its client. */
async function buildThirdPartyClient(row: MarketplaceSource): Promise<ThirdPartyCatalogClient> {
  // A credentialed source is unlistable without its credential (the fetch would
  // 401), so read it from the keyring and pass it through. guardedFetch attaches
  // it as an Authorization header on the source origin only, and never after a
  // cross-origin redirect (CPHMTP-NFR-002).
  const credential = row.hasCredential
    ? ((await sourcesState.readSourceCredential(row.id)) ?? undefined)
    : undefined;
  return catalogClient.createThirdPartyCatalogClient(row, { credential });
}

/**
 * The cached build promise for a source, starting one on a miss. Deliberately NOT
 * async: the cache entry has to be `set` before the build's first await, so a
 * concurrent invalidateSourceClient can never land inside the keyring-read window
 * and be lost (issue #595). Callers still await the returned promise.
 */
function getThirdPartyClient(row: MarketplaceSource): Promise<ThirdPartyCatalogClient> {
  const cached = thirdPartyClients.get(row.id);
  if (cached && cached.url === row.url) return cached.client;
  const client = buildThirdPartyClient(row);
  thirdPartyClients.set(row.id, { url: row.url, client });
  // Caching the promise means a REJECTED build would otherwise stay cached and be
  // rethrown by every later call, pinning the source unavailable until a process
  // restart after one transient keyring failure (strictly worse than the race this
  // fixes). Self-evict instead, and only while this exact promise is still the
  // cached one, so a late rejection cannot delete a newer entry that an intervening
  // invalidate-and-rebuild installed. This also marks the rejection handled;
  // fetchSource awaits the promise inside its own try/catch and reports the source
  // unavailable, so behaviour at the call site is unchanged.
  client.catch(() => {
    if (thirdPartyClients.get(row.id)?.client === client) thirdPartyClients.delete(row.id);
  });
  return client;
}

/**
 * Fetch ONE registered source. Never throws: the third-party client already
 * degrades NETWORK -> CACHE -> empty behind its own 5s timeout and 256KB cap, and
 * the try/catch is the backstop for the one step outside it (the keyring read,
 * which can fail on an unavailable headless keyring). A source that can serve
 * nothing is reported unavailable on its own status row and contributes no
 * entries, so every other source and the first-party section list unaffected
 * (CPHMTP-NFR-007).
 */
async function fetchSource(row: MarketplaceSource): Promise<SourceResult> {
  const base = { id: row.id, url: row.url, label: sourceLabel(row.url) };
  try {
    const client = await getThirdPartyClient(row);
    const result = await client.getCatalog();
    // A third-party source has NO seed floor, so its degrade chain bottoms out at
    // an empty result stamped with a null fetchedAt (catalog-client.ts): nothing
    // fetched and no usable cache. A null fetchedAt is the marker for that
    // bottomed-out case, but it is not a guarantee the client enforces: its cache
    // shape guard validates only entries and null-coalesces a non-string
    // fetchedAt, so a cache the app did not write can yield entries with no
    // timestamp. Unavailability therefore keys off the source actually serving
    // nothing, not off the timestamp alone (#594).
    return {
      entries: result.entries,
      status: {
        ...base,
        source: result.source,
        fetchedAt: result.fetchedAt,
        unavailable: result.entries.length === 0 && result.fetchedAt === null,
      },
    };
  } catch (err) {
    console.warn(`marketplace: source ${row.id} could not be listed: ${(err as Error).message}`);
    return {
      entries: [],
      status: { ...base, source: "cache", fetchedAt: null, unavailable: true },
    };
  }
}

/** Fetch the first-party signed catalog. Propagates CatalogUnverifiedError (502). */
async function fetchFirstParty(): Promise<SourceResult> {
  const { entries, source, fetchedAt } = await catalogClient.getVerifiedCatalog();
  return {
    entries,
    status: {
      id: FIRST_PARTY_SOURCE_ID,
      url: sourcesState.FIRST_PARTY_URL,
      label: FIRST_PARTY_LABEL,
      source,
      fetchedAt,
      // The first-party chain always has the bundled seed to fall back on, so it
      // is never unavailable: it either serves entries or throws
      // CatalogUnverifiedError.
      unavailable: false,
    },
  };
}

/**
 * Return the merged multi-source catalog: the first-party curated entries plus
 * every registered source's entries, each annotated with install/update state and
 * stamped with its originating `sourceId` (CPHMTP-FR-004, issue #557). Filtered by
 * an optional free-text query (name / id / summary, case-insensitive), an optional
 * kind, and an optional sourceId (the source filter chips). Revoked entries are
 * filtered out (CP-TC-109).
 *
 * Sources are fetched CONCURRENTLY, not serially, so the list costs the slowest
 * single source rather than the sum of all of them (CPHMTP-NFR-006). Each source
 * carries its own 5s timeout and 256KB cap inside its client and cannot throw, so
 * a dead source adds at most its own timeout and never blocks another source or
 * the first-party section; it comes back unavailable on its own status row while
 * the rest list normally (CPHMTP-NFR-007).
 *
 * Each client serves its most recently resolved catalog (refreshing from the
 * network at most once per its short memo TTL: fetch-on-marketplace-open,
 * CPHM-NFR-004), degrading through its own chain: the first-party chain degrades
 * to cache then seed so it is never zero, while a third-party chain degrades to
 * cache then empty (there is no third-party seed). Filtering runs in memory over
 * the merged list, so search-as-you-type does not force a fetch + signature verify
 * per keystroke. Throws `CatalogUnverifiedError` only when even the bundled
 * first-party seed fails verification (the route maps that to 502).
 */
export async function listCatalog(params: ListCatalogParams = {}): Promise<CatalogResult> {
  // The fan-out: first-party plus one client per registered source, all in flight
  // at once. listSources() is a local file read, so nothing here serialises a
  // network call behind another.
  const results = await Promise.all([
    fetchFirstParty(),
    ...sourcesState.listSources().map(fetchSource),
  ]);

  const q = params.q?.trim().toLowerCase() ?? "";
  const kind = params.kind;
  const sourceId = params.sourceId;
  // Merge, THEN filter: each source's entries are annotated with that source's id
  // through the same single annotate() pass, and the filters apply to the merged
  // list so a kind / query / source filter scopes across every source uniformly.
  const listings = results
    .flatMap(({ entries, status }) =>
      entries.filter((e) => e.revoked !== true).map((e) => annotate(e, status.id)),
    )
    .filter(
      (listing) =>
        (kind === undefined || listing.kind === kind) &&
        (sourceId === undefined || listing.sourceId === sourceId) &&
        (q.length === 0 || matchesQuery(listing, q)),
    );

  const firstParty = results[0].status;
  return {
    listings,
    // First-party-scoped provenance for the existing offline banner (issue #372).
    source: firstParty.source,
    fetchedAt: firstParty.fetchedAt,
    sources: results.map((r) => r.status),
  };
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

// Test-only reset for the per-source client cache, so one test's fake source
// clients never leak into the next.
export const __test = {
  resetSourceClients(): void {
    thirdPartyClients.clear();
  },
};
