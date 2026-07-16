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
import type { ThirdPartyCatalogClient } from "./catalog-client.js";
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
// Cross-source id collisions (CPHMTP-FR-005, issue #558): a plugin id served by
// MORE THAN ONE source is ambiguous, and this module refuses to resolve that
// ambiguity for the caller. There is deliberately no precedence order and no
// shadowing: picking a winner would silently decide whose code runs. The rule is
// enforced at BOTH code paths the FR names:
//   - listing: `listCatalog` indexes id -> sourceIds over the UNFILTERED merge and
//     stamps `collision` on every contributing listing, so each colliding source
//     still gets its own card and the mark survives a kind / query / source filter.
//   - install/update: `assertInstallable` re-derives the collision from the same
//     merged view and throws `AmbiguousSourceError` (409) before any artifact is
//     fetched, unless the caller named a `sourceId` explicitly.
// The listing mark is display; the install guard is the enforcement. Neither
// trusts the other, so a stale client cannot install a colliding id by skipping
// the listing.

export interface ListCatalogParams {
  q?: string;
  kind?: MarketplaceKind;
  /** Scope the merged list to one source's entries (the source filter chips). */
  sourceId?: string;
}

/**
 * A plugin id is served by more than one source and the caller named none, so
 * install/update is refused (CPHMTP-FR-005, issue #558). The route maps this to
 * `409 { code: "ambiguous-source", sourceIds }`.
 *
 * Deliberately NOT an `InstallError`: that class carries only a code plus a
 * message, and the client needs `sourceIds` to offer one explicit
 * install-from-<source> choice per source. Widening `InstallErrorCode` for a code
 * that must carry a payload would make the install-error channel dishonest, so
 * this follows the `CatalogUnverifiedError` precedent instead: a dedicated error
 * class with its own typed body and its own sender in the route.
 *
 * Thrown BEFORE any artifact is fetched or staged, so a refused install leaves
 * nothing on disk (CPHMTP-TC-034 S002).
 */
export class AmbiguousSourceError extends Error {
  readonly code = "ambiguous-source" as const;
  readonly pluginId: string;
  readonly sourceIds: string[];
  constructor(pluginId: string, sourceIds: string[]) {
    super(
      `Plugin "${pluginId}" is served by ${sourceIds.length} sources. Choose which source to install it from.`,
    );
    this.pluginId = pluginId;
    this.sourceIds = sourceIds;
    this.name = "AmbiguousSourceError";
  }
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

function annotate(
  entry: MarketplaceCatalogEntry,
  sourceId: string,
  /**
   * Every source serving this entry's id, from the collision index built over the
   * UNFILTERED merge. One element (this source alone) is the common case and is
   * not a collision; two or more stamps `collision` (CPHMTP-FR-005, issue #558).
   */
  servingSourceIds: string[] = [sourceId],
): MarketplaceListing {
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
    // Mark the cross-source collision rather than resolving it (CPHMTP-FR-005,
    // issue #558). Spread last and only when it applies, so a single-source
    // listing carries no `collision` key at all.
    ...(servingSourceIds.length > 1 ? { collision: { sourceIds: servingSourceIds } } : {}),
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
  /**
   * The registry row backing this source, absent for the synthesised first-party
   * one. Carried so an install resolved to this source can build its
   * ThirdPartyInstallContext (consented origin + credential + allowHttp) without a
   * second registry lookup, and so the install path cannot mistake a third-party
   * source for the first-party one: the row's presence IS the third-party marker.
   */
  row?: MarketplaceSource;
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
      row,
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
      row,
      status: { ...base, source: "cache", fetchedAt: null, unavailable: true },
    };
  }
}

/**
 * The fan-out: the first-party catalog plus one client per registered source, all
 * in flight at once. `listSources()` is a local file read, so nothing here
 * serialises a network call behind another.
 *
 * Shared by `listCatalog` and the install/update resolution path, so both see the
 * SAME merged view of who serves what. That sharing is what makes the FR-005
 * install guard trustworthy: the listing's collision mark and the install-time
 * ambiguity check are derived from one source of truth, so they cannot disagree.
 */
async function fetchAllSources(): Promise<SourceResult[]> {
  return Promise.all([fetchFirstParty(), ...sourcesState.listSources().map(fetchSource)]);
}

/**
 * Index plugin id -> every source id serving it, over the merged fan-out
 * (CPHMTP-FR-005, issue #558). An id mapping to two or more source ids is a
 * cross-source collision.
 *
 * Revoked entries are excluded: a revoked entry is not served to anyone (the
 * listing filters it out and install refuses it), so counting it would invent a
 * collision for an id only one source actually serves.
 *
 * Source ids preserve fan-out order (first-party first, then registered sources in
 * registration order) and are de-duplicated, so a single source listing an id twice
 * is not mistaken for a collision.
 */
function buildCollisionIndex(results: SourceResult[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const { entries, status } of results) {
    for (const entry of entries) {
      if (entry.revoked === true) continue;
      const serving = byId.get(entry.id);
      if (serving === undefined) {
        byId.set(entry.id, [status.id]);
      } else if (!serving.includes(status.id)) {
        serving.push(status.id);
      }
    }
  }
  return byId;
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
  const results = await fetchAllSources();
  const collisions = buildCollisionIndex(results);

  const q = params.q?.trim().toLowerCase() ?? "";
  const kind = params.kind;
  const sourceId = params.sourceId;
  // Merge, ANNOTATE, THEN filter, with the collision index built BEFORE any of it.
  // The order is load-bearing: a collision is a property of the whole merged
  // catalog, not of the current view, so it is derived from the UNFILTERED merge.
  // Derived after filtering instead, scoping to one source (or to a kind, or
  // typing a query only one colliding entry matched) would leave a single
  // surviving listing that looked unambiguous, and the view would silently resolve
  // the very ambiguity the FR refuses to resolve (CPHMTP-TC-044). Filtering last
  // means every surviving listing still carries the mark.
  const listings = results
    .flatMap(({ entries, status }) =>
      entries
        .filter((e) => e.revoked !== true)
        .map((e) => annotate(e, status.id, collisions.get(e.id) ?? [status.id])),
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
 * Resolve a catalog entry by id across EVERY source, or null when no source
 * serves it. Reuses each client's most recently resolved catalog (the one the open
 * Plugins view fetched) rather than forcing another network round-trip. Revoked
 * entries are still returned here so install/update can emit a specific `revoked`
 * error rather than a generic unknown-id error.
 *
 * Multi-source since issue #558: this is the route's unknown-id (404) pre-check,
 * and reading the first-party catalog alone made it lie about every third-party
 * id. A third-party-only id 404'd before install could run, and a colliding id
 * resolved to the first-party entry and sailed past the ambiguity check that is
 * the whole point of FR-005. It resolves over the merged fan-out for that reason.
 *
 * Returns the FIRST match in fan-out order, which is safe precisely because it is
 * only an existence check: it answers "does any source serve this id", never
 * "which source wins". `assertInstallable` owns the ambiguity decision, and no
 * caller may use this to pick a source.
 */
export async function resolveEntry(id: string): Promise<MarketplaceCatalogEntry | null> {
  const results = await fetchAllSources();
  for (const { entries } of results) {
    const entry = entries.find((e) => e.id === id);
    if (entry) return entry;
  }
  return null;
}

/** One source's offer of a given id: the entry plus the source that served it. */
interface InstallCandidate {
  entry: MarketplaceCatalogEntry;
  status: MarketplaceSourceStatus;
  /** The registry row when the serving source is third-party; absent for first-party. */
  row?: MarketplaceSource;
}

/**
 * Resolve which source's entry an install/update should use, enforcing the
 * no-precedence rule (CPHMTP-FR-005, issue #558).
 *
 * `sourceId` names the source explicitly (the pick-a-source choice); omitted, the
 * id must resolve from exactly one source or the call is refused with
 * `AmbiguousSourceError`. Every rejection here happens before any artifact is
 * fetched or staged.
 */
function assertInstallable(
  results: SourceResult[],
  id: string,
  sourceId?: string,
): InstallCandidate {
  const candidates: InstallCandidate[] = results.flatMap(({ entries, status, row }) =>
    entries.filter((e) => e.id === id).map((entry) => ({ entry, status, row })),
  );

  if (candidates.length === 0) {
    throw new pluginInstaller.InstallError("invalid-input", `Unknown catalog plugin: ${id}`);
  }

  // An explicit choice is honoured as given: the caller named the source, so no
  // ambiguity remains to resolve. The named source must actually serve the id;
  // otherwise the choice is stale (the source stopped serving it, or was removed)
  // and is refused rather than quietly falling back to another source, which would
  // install code from somewhere the consumer did not choose.
  if (sourceId !== undefined) {
    const chosen = candidates.find((c) => c.status.id === sourceId);
    if (!chosen) {
      throw new pluginInstaller.InstallError(
        "invalid-input",
        `Source "${sourceId}" does not serve plugin "${id}".`,
      );
    }
    return assertServable(chosen, id);
  }

  // No explicit choice. A revoked entry is not served, so it cannot make an id
  // ambiguous: filter before counting, or a revoked first-party entry would block
  // an install the one remaining source can satisfy honestly.
  const servable = candidates.filter((c) => c.entry.revoked !== true);
  if (servable.length > 1) {
    throw new AmbiguousSourceError(
      id,
      servable.map((c) => c.status.id),
    );
  }
  // Nothing servable: every candidate is revoked. Report that specifically (410)
  // rather than as an unknown id.
  if (servable.length === 0) {
    return assertServable(candidates[0], id);
  }
  return assertServable(servable[0], id);
}

/** The per-candidate gates that apply once exactly one source is settled on. */
function assertServable(candidate: InstallCandidate, id: string): InstallCandidate {
  if (candidate.entry.revoked === true) {
    throw new pluginInstaller.InstallError(
      "revoked",
      `Plugin "${id}" has been revoked and can no longer be installed or updated.`,
    );
  }
  if (candidate.status.source !== "network") {
    // Degraded to cache / seed: the source is unreachable, so a new install/update
    // is paused with a clear message rather than attempting (and failing) a fetch
    // (CPHM-TC-045/050/051). Seeded and already-installed plugins keep working.
    // Scoped to the CHOSEN source's own degrade state, so one stale source cannot
    // pause an install from a healthy one.
    throw new pluginInstaller.InstallError(
      "marketplace-unreachable",
      `Can't install "${id}" while the marketplace is unreachable. Seeded and already-installed plugins remain available; new installs resume when the marketplace is reachable again.`,
    );
  }
  return candidate;
}

/**
 * The provenance an install/update commit records for the chosen source
 * (CPHMTP-FR-005 AC4 / CPHMTP-FR-006). `unverified` is derived from WHICH source
 * was chosen, never from the entry payload: only the first-party signed chain can
 * assert verification, and a third-party catalog is unsigned, so any third-party
 * source is unverified by construction.
 */
function provenanceOf(status: MarketplaceSourceStatus): pluginInstaller.InstallProvenance {
  return {
    sourceId: status.id,
    sourceUrl: status.url,
    unverified: status.id !== FIRST_PARTY_SOURCE_ID,
  };
}

/**
 * Build the installer's ThirdPartyInstallContext for a chosen source, or
 * `undefined` for the first-party one.
 *
 * This is the seam issue #559 built and left dormant ("there is no production
 * third-party install caller yet"): #558 is that caller, since naming a source
 * explicitly is what first makes a third-party entry installable. Passing the
 * context is what engages the unsigned-source trust treatment (CPHMTP-FR-005 AC4):
 * it makes the per-artifact digest MANDATORY (CPHMTP-NFR-004, an unsigned source
 * has no signature chain, so the digest is the only integrity anchor) and scopes
 * the artifact download to the source's consented origin, attaching the credential
 * there and nowhere else (CPHMTP-NFR-002). Omitting it would install third-party
 * code with both guards dormant.
 *
 * The credential is read per install rather than cached: installs are rare (unlike
 * the per-keystroke listing path, which is why the LISTING caches its clients), so
 * the keyring cost is irrelevant here and a rotated token is always current.
 */
async function thirdPartyContextFor(
  candidate: InstallCandidate,
): Promise<pluginInstaller.ThirdPartyInstallContext | undefined> {
  const { row } = candidate;
  if (row === undefined) return undefined;
  const credential = row.hasCredential
    ? ((await sourcesState.readSourceCredential(row.id)) ?? undefined)
    : undefined;
  return {
    sourceOrigin: new URL(row.url).origin,
    credential,
    allowHttp: row.allowHttp,
  };
}

/**
 * Stage an install of a catalog entry, delegating to the plugin-installer preview
 * matching the entry's source: a `git` source clones (`previewFromGitUrl`), a
 * `release` source downloads + unpacks the built artifact (`previewFromRelease`,
 * issue #370). Returns an InstallPreview (staging token + manifest) the client
 * drives through the existing consent + confirm endpoints. Throws when the id is
 * served by no source (`invalid-input`), has been revoked (`revoked`), or the
 * chosen source is unreachable (`marketplace-unreachable`). The entry's expected
 * integrity digest is threaded to the installer so a tampered package is rejected
 * before commit (CP-TC-107/108).
 *
 * `sourceId` names which source to install from (CPHMTP-FR-005, issue #558).
 * Omitted, the id must be served by exactly one source: when several serve it this
 * throws `AmbiguousSourceError` (409) rather than picking one, and nothing is
 * fetched. The chosen source's provenance rides to the installer so the commit can
 * record the choice on the install record (AC4).
 */
export async function install(id: string, sourceId?: string): Promise<InstallPreview> {
  const results = await fetchAllSources();
  const candidate = assertInstallable(results, id, sourceId);
  const { entry, status } = candidate;
  const thirdParty = await thirdPartyContextFor(candidate);
  const provenance = provenanceOf(status);
  if (entry.source.type === "release") {
    return pluginInstaller.previewFromRelease(
      entry.source.assetUrl,
      entry.integrity,
      thirdParty,
      provenance,
    );
  }
  return pluginInstaller.previewFromGitUrl(
    entry.source.url,
    entry.integrity,
    entry.source.directory,
    thirdParty,
    provenance,
  );
}

/**
 * Stage an update of an already-installed catalog entry, delegating to the
 * plugin-installer update preview matching the entry's source: a `git` source
 * re-clones (`previewUpdateFromGitUrl`), a `release` source downloads + unpacks
 * the new built artifact (`previewUpdateFromRelease`, issue #370). Either replaces
 * the installed copy at commit time. Returns an InstallPreview. Throws when the id
 * is served by no source (`invalid-input`), has been revoked (`revoked`), or the
 * chosen source is unreachable (`marketplace-unreachable`). The expected integrity
 * digest is threaded so a tampered package is rejected before commit, leaving the
 * existing version intact (CP-TC-112).
 *
 * Ambiguity is enforced HERE too, not only at the listing (CPHMTP-FR-005 AC3,
 * issue #558): a plugin installed from one source whose id a newly registered
 * source starts serving becomes ambiguous to update, and updating it by precedence
 * could silently swap in a different publisher's code. Without an explicit
 * `sourceId` such an update throws `AmbiguousSourceError` (409) and the installed
 * copy is left untouched.
 */
export async function update(id: string, sourceId?: string): Promise<InstallPreview> {
  const results = await fetchAllSources();
  const candidate = assertInstallable(results, id, sourceId);
  const { entry, status } = candidate;
  const thirdParty = await thirdPartyContextFor(candidate);
  const provenance = provenanceOf(status);
  if (entry.source.type === "release") {
    return pluginInstaller.previewUpdateFromRelease(
      entry.source.assetUrl,
      entry.id,
      entry.integrity,
      thirdParty,
      provenance,
    );
  }
  return pluginInstaller.previewUpdateFromGitUrl(
    entry.source.url,
    entry.id,
    entry.integrity,
    entry.source.directory,
    thirdParty,
    provenance,
  );
}

// Test-only reset for the per-source client cache, so one test's fake source
// clients never leak into the next.
export const __test = {
  resetSourceClients(): void {
    thirdPartyClients.clear();
  },
};
