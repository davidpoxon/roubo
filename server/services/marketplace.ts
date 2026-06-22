import semver from "semver";
import type {
  InstallPreview,
  MarketplaceCatalogEntry,
  MarketplaceKind,
  MarketplaceListing,
  SignedMarketplaceCatalog,
} from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import * as pluginInstaller from "./plugin-installer.js";
import { verifyCatalogSignature } from "./marketplace-integrity.js";
import catalog from "./marketplace-catalog.json";

// Marketplace catalog service (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621;
// CP-FR-021 / CP-US-011, issue #622).
//
// The curated catalog is a static, checked-in SIGNED manifest. This service
// verifies its detached ed25519 signature at load against the bundled
// first-party public key and FAILS CLOSED: an invalid, missing, or tampered
// signature yields zero listings, so the route surfaces a catalog-unverified
// error and the client renders no plugin cards (CP-TC-118, AC-3). The service
// reads the verified payload, cross-references the installed plugin set to
// annotate each entry's install / update state, and supports search + kind
// filtering. Install and update REUSE the existing plugin-installer staging ->
// consent -> commit flow; the expected per-entry integrity digest is threaded
// through so the installer can reject a tampered package before commit
// (CP-TC-107/108/112). Revoked entries are filtered from listings and rejected
// at install/update (CP-TC-109).

interface RawSignedCatalog extends SignedMarketplaceCatalog {
  $comment?: string;
}

const RAW = catalog as RawSignedCatalog;

/**
 * Whether the static catalog's signature verified at load. When false the
 * marketplace fails closed: ENTRIES is empty and every install/update is
 * rejected (the catalog cannot be trusted to source executable code).
 */
export const CATALOG_VERIFIED: boolean = verifyCatalogSignature(RAW.payload, RAW.signature);

const ENTRIES: readonly MarketplaceCatalogEntry[] = CATALOG_VERIFIED
  ? (RAW.payload.entries ?? [])
  : [];

/** The id-indexed catalog (verified entries only), for resolveEntry / install / update. */
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
 * optional kind. Revoked entries are filtered out (CP-TC-109). When the catalog
 * signature did not verify, ENTRIES is empty so this returns []; callers should
 * consult `CATALOG_VERIFIED` to distinguish a verified-but-empty catalog from an
 * unverified one (the route maps the latter to a catalog-unverified error).
 */
export function listCatalog(params: ListCatalogParams = {}): MarketplaceListing[] {
  const q = params.q?.trim().toLowerCase() ?? "";
  const kind = params.kind;
  return ENTRIES.filter((e) => e.revoked !== true)
    .map(annotate)
    .filter(
      (listing) =>
        (kind === undefined || listing.kind === kind) &&
        (q.length === 0 || matchesQuery(listing, q)),
    );
}

/**
 * Resolve a catalog entry by id, or null when it is not in the verified
 * catalog. Revoked entries are still returned here so install/update can emit a
 * specific `revoked` error rather than a generic unknown-id error.
 */
export function resolveEntry(id: string): MarketplaceCatalogEntry | null {
  return ENTRY_BY_ID.get(id) ?? null;
}

function assertInstallable(id: string): MarketplaceCatalogEntry {
  const entry = resolveEntry(id);
  if (!entry) {
    throw new pluginInstaller.InstallError("invalid-input", `Unknown catalog plugin: ${id}`);
  }
  if (entry.revoked === true) {
    throw new pluginInstaller.InstallError(
      "revoked",
      `Plugin "${id}" has been revoked and can no longer be installed or updated.`,
    );
  }
  return entry;
}

/**
 * Stage an install of a catalog entry, delegating to the plugin-installer git
 * flow. Returns an InstallPreview (staging token + manifest) the client drives
 * through the existing consent + confirm endpoints. Throws when the id is not in
 * the curated catalog (`invalid-input`) or has been revoked (`revoked`). The
 * entry's expected integrity digest is threaded to the installer so a tampered
 * package is rejected before commit (CP-TC-107/108).
 */
export async function install(id: string): Promise<InstallPreview> {
  const entry = assertInstallable(id);
  return pluginInstaller.previewFromGitUrl(entry.source.url, entry.integrity);
}

/**
 * Stage an update of an already-installed catalog entry, delegating to the
 * plugin-installer update flow (which replaces the installed copy at commit
 * time). Returns an InstallPreview. Throws when the id is not in the catalog
 * (`invalid-input`) or has been revoked (`revoked`). The expected integrity
 * digest is threaded so a tampered package is rejected before commit, leaving
 * the existing version intact (CP-TC-112).
 */
export async function update(id: string): Promise<InstallPreview> {
  const entry = assertInstallable(id);
  return pluginInstaller.previewUpdateFromGitUrl(entry.source.url, entry.id, entry.integrity);
}
