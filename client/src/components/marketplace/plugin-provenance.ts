import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
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
 * Stand-in source for an installed plugin the provenance ledger does not describe.
 * Every install path now stamps a row (a first-party seed, a marketplace install,
 * and the raw git / local paths all record one, davidpoxon/roubo-development#607),
 * so in practice this is reached only by a record that predates the ledger. It is
 * NOT a real source id (a generated third-party id ends in an 8-char hex suffix,
 * and "source" is not hex), and exists so such a plugin fails closed to unverified
 * rather than letting missing provenance read as first-party.
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
 * Provenance of an installed plugin (installed-plugins settings tab, permission
 * review dialog). Fails closed: the provenance fields are optional on
 * `PluginRecord`, and an absent `sourceId` grades unverified, full stop.
 *
 * This was once a display-layer heuristic that read absence as first-party for the
 * seed set and unverified for everything else, because a seeded default and a raw
 * git / local install both carried no ledger row and only the id told them apart
 * (CPHMTP-NFR-001, issue #563). Keying trust off a self-asserted id is not a trust
 * root, so every install path now stamps a ledger row (a first-party seed, and the
 * raw git / local paths, davidpoxon/roubo-development#607). With the durable fix in
 * place, absence no longer needs interpreting: a stamped row is authoritative, and
 * its absence simply fails closed.
 */
export function recordProvenance(plugin: PluginRecord): PluginProvenance {
  const sourceId = plugin.sourceId ?? UNKNOWN_SOURCE_ID;
  return {
    sourceId,
    sourceLabel: sourceLabelFor(sourceId, plugin.sourceUrl),
    curated: plugin.unverified !== true,
    orphaned: plugin.orphaned === true,
  };
}
