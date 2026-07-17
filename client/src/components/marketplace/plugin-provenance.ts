import { FIRST_PARTY_SOURCE_ID, SEED_PLUGIN_IDS } from "@roubo/shared";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";

// The trust derivation behind the shared ProvenanceBadge (CPHMTP-FR-006 /
// CPHMTP-NFR-001, issue #563).
//
// CPHMTP-NFR-001 requires "0 UI states where a third-party plugin renders
// first-party verified styling". That is only checkable if there is exactly ONE
// place the green first-party treatment can be decided. This module is that place:
// every plugin surface normalises what it has into `PluginProvenance` here and
// renders `ProvenanceBadge`, which asks `trustTreatmentOf` and nothing else. No
// surface decides trust for itself, and the badge exposes no prop that can request
// the verified treatment, so a hostile catalog serving `verified: true` still gets
// the amber Unverified pill.
//
// It lives apart from ProvenanceBadge.tsx so the component file exports only its
// component (the react-refresh rule), and so this derivation, which is the actual
// security boundary, has its own unit tests.

/** Display label for the built-in catalog, mirroring the server's own chip label. */
export const FIRST_PARTY_LABEL = "Roubo first-party";

/**
 * Stand-in source for an installed plugin the provenance ledger does not describe
 * and which is not a first-party seed default: in practice one installed from a
 * raw git URL or a local path, whose install path deliberately records no ledger
 * row. It is NOT a real source id (a generated third-party id ends in an 8-char
 * hex suffix, and "source" is not hex), and exists so such a plugin grades
 * unverified rather than letting missing provenance read as first-party.
 */
export const UNKNOWN_SOURCE_ID = "unknown-source";

/** Display label for {@link UNKNOWN_SOURCE_ID}. */
export const UNKNOWN_SOURCE_LABEL = "Unknown source";

/**
 * The normalised trust input every surface passes. Both shapes that reach the UI
 * (a `MarketplaceListing` pre-install, a `PluginRecord` post-install) are folded
 * into this by `listingProvenance` / `recordProvenance`, so the badge has exactly
 * ONE code path and cannot grow a second, divergent derivation that re-opens the
 * CPHMTP-NFR-001 hole.
 */
export interface PluginProvenance {
  /** `FIRST_PARTY_SOURCE_ID`, or a registered source's generated id. */
  sourceId: string;
  /** Human-readable name of that source, shown alongside the badge. */
  sourceLabel: string;
  /**
   * The first-party catalog's display-only curation flag. Meaningful ONLY on the
   * first-party path: it is necessary but not sufficient for the verified
   * treatment, and is ignored outright for every other source, so setting it can
   * never win a third-party entry the green treatment.
   */
  curated: boolean;
  /** The source this plugin came from has been removed from the registry. */
  orphaned: boolean;
}

export type TrustTreatment = "verified" | "unverified";

/**
 * The single trust decision. Verified requires BOTH the first-party listing path
 * and the first-party catalog's curation flag; everything else, including any
 * third-party entry claiming otherwise, is unverified. Fails closed: an unknown or
 * missing source reads as unverified.
 */
export function trustTreatmentOf(provenance: PluginProvenance): TrustTreatment {
  return provenance.sourceId === FIRST_PARTY_SOURCE_ID && provenance.curated
    ? "verified"
    : "unverified";
}

/**
 * Whether a plugin came from the first-party catalog. This is a SOURCE property,
 * distinct from {@link trustTreatmentOf}: catalog signing is decided by the source
 * the entry reached the UI through (only the first-party catalog carries a Roubo
 * signature), not by the per-entry `curated` flag. So an uncurated first-party
 * entry (`curated: false`) is still signed-by-Roubo here, while `trustTreatmentOf`
 * still grades it unverified. Callers deciding curation must use `trustTreatmentOf`;
 * callers deciding the catalog signature use this (issue #603).
 */
export function isFirstPartySource(provenance: PluginProvenance): boolean {
  return provenance.sourceId === FIRST_PARTY_SOURCE_ID;
}

/**
 * A registered source row carries no display name, so derive the label from its
 * catalog URL host the way the server does for the marketplace chips. Falls back
 * to the raw URL, then to the source id, so a label is never empty.
 */
function sourceLabelFor(sourceId: string, sourceUrl: string | undefined): string {
  if (sourceId === FIRST_PARTY_SOURCE_ID) return FIRST_PARTY_LABEL;
  if (sourceId === UNKNOWN_SOURCE_ID) return UNKNOWN_SOURCE_LABEL;
  if (sourceUrl === undefined) return sourceId;
  try {
    return new URL(sourceUrl).host;
  } catch {
    return sourceUrl;
  }
}

/** Provenance of a catalog entry (marketplace list, card, drawer, consent modal). */
export function listingProvenance(
  listing: MarketplaceListing,
  sourceLabel: string,
): PluginProvenance {
  return {
    sourceId: listing.sourceId,
    sourceLabel,
    curated: listing.verified,
    // A catalog entry is a thing you could install, not a thing installed from a
    // now-removed source, so it is never orphaned. Orphaning is a property of the
    // install record only (issue #560).
    orphaned: false,
  };
}

/**
 * Which source an installed plugin came from when the ledger does not say.
 *
 * Absence is ambiguous and must NOT be read as first-party on its own: a seeded
 * first-party default carries no ledger row (the seed install writes none), but
 * neither does a plugin the user installed from a raw git URL or local path
 * (`POST /api/plugins/install`, whose provenance recording is a documented no-op
 * on those paths). Defaulting absence to first-party therefore handed the green
 * first-party treatment to arbitrary third-party code, breaking CPHMTP-NFR-001
 * ("0 UI states where a third-party plugin renders first-party verified styling")
 * on the installed-plugins tab that TC-056 enumerates.
 *
 * The plugin's id is the only signal that separates the two here, so absence
 * reads as first-party only for the seed set and unverified for everything else.
 * That is a display-layer heuristic, not a trust root: stamping a ledger row on
 * the seed and raw-install paths, so this can simply fail closed, is the durable
 * fix (davidpoxon/roubo-development#607).
 */
function unstampedSourceIdFor(plugin: PluginRecord): string {
  return (SEED_PLUGIN_IDS as readonly string[]).includes(plugin.id)
    ? FIRST_PARTY_SOURCE_ID
    : UNKNOWN_SOURCE_ID;
}

/**
 * Provenance of an installed plugin (installed-plugins settings tab, permission
 * review dialog). The provenance fields are optional on `PluginRecord`: when the
 * ledger stamped them they are authoritative, and when it did not,
 * `unstampedSourceIdFor` decides what the absence means (see above).
 */
export function recordProvenance(plugin: PluginRecord): PluginProvenance {
  const sourceId = plugin.sourceId ?? unstampedSourceIdFor(plugin);
  return {
    sourceId,
    sourceLabel: sourceLabelFor(sourceId, plugin.sourceUrl),
    curated: plugin.unverified !== true,
    orphaned: plugin.orphaned === true,
  };
}
