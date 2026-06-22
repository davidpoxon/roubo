import semver from "semver";
import type {
  InstallPreview,
  MarketplaceCatalogEntry,
  MarketplaceKind,
  MarketplaceListing,
} from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";
import catalog from "./marketplace-catalog.json";

// Marketplace catalog service (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621).
//
// The curated catalog is a static, checked-in manifest. This service reads it,
// cross-references the installed plugin set to annotate each entry's install /
// update state, and supports search + kind filtering. Install and update REUSE
// the existing plugin-installer staging -> consent -> commit flow: the install
// route returns an InstallPreview (staging token) and the client drives the
// existing confirm/cancel endpoints. The `verified` flag is a display-only
// first-party curation marker, NOT a signature check (integrity verification is
// out of scope here).

interface RawCatalog {
  entries: MarketplaceCatalogEntry[];
}

const ENTRIES: readonly MarketplaceCatalogEntry[] = (catalog as RawCatalog).entries;

/** The id-indexed catalog, for resolveSource / install / update. */
const ENTRY_BY_ID = new Map<string, MarketplaceCatalogEntry>(ENTRIES.map((e) => [e.id, e]));

export interface ListCatalogParams {
  q?: string;
  kind?: MarketplaceKind;
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
  const updateAvailable =
    installed && installedVersion !== null && isNewerVersion(entry.version, installedVersion);
  return { ...entry, installed, installedVersion, updateAvailable };
}

function matchesQuery(listing: MarketplaceListing, q: string): boolean {
  const haystack = `${listing.name} ${listing.id} ${listing.summary}`.toLowerCase();
  return haystack.includes(q);
}

/**
 * Return the curated catalog, annotated with install/update state, filtered by
 * an optional free-text query (name / id / summary, case-insensitive) and an
 * optional kind.
 */
export function listCatalog(params: ListCatalogParams = {}): MarketplaceListing[] {
  const q = params.q?.trim().toLowerCase() ?? "";
  const kind = params.kind;
  return ENTRIES.map(annotate).filter(
    (listing) =>
      (kind === undefined || listing.kind === kind) && (q.length === 0 || matchesQuery(listing, q)),
  );
}

/** Resolve a catalog entry by id, or null when it is not in the catalog. */
export function resolveEntry(id: string): MarketplaceCatalogEntry | null {
  return ENTRY_BY_ID.get(id) ?? null;
}

/**
 * Stage an install of a catalog entry, delegating to the plugin-installer git
 * flow. Returns an InstallPreview (staging token + manifest) the client drives
 * through the existing consent + confirm endpoints. Throws when the id is not
 * in the curated catalog.
 */
export async function install(id: string): Promise<InstallPreview> {
  const entry = resolveEntry(id);
  if (!entry) {
    throw new pluginInstaller.InstallError("invalid-input", `Unknown catalog plugin: ${id}`);
  }
  return pluginInstaller.previewFromGitUrl(entry.source.url);
}

/**
 * Stage an update of an already-installed catalog entry, delegating to the
 * plugin-installer update flow (which replaces the installed copy at commit
 * time). Returns an InstallPreview. Throws when the id is not in the catalog.
 */
export async function update(id: string): Promise<InstallPreview> {
  const entry = resolveEntry(id);
  if (!entry) {
    throw new pluginInstaller.InstallError("invalid-input", `Unknown catalog plugin: ${id}`);
  }
  return pluginInstaller.previewUpdateFromGitUrl(entry.source.url, entry.id);
}
