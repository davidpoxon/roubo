import { Globe, ShieldAlert, ShieldCheck, Unplug } from "lucide-react";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import { trustTreatmentOf, type PluginProvenance, type TrustTreatment } from "./plugin-provenance";

// The ONE trust treatment in the app (CPHMTP-FR-006 / CPHMTP-NFR-001, issue
// #563). Every plugin surface (marketplace card, detail drawer, installed-plugins
// settings tab, install consent modal, permission review dialog) renders this
// component, and nothing else renders a Verified / Unverified marker of its own.
//
// It takes only the plugin's provenance and asks `trustTreatmentOf` (see
// plugin-provenance.ts, which carries the reasoning): there is deliberately no
// `verified` prop, no `treatment` prop, and no override, so no caller can request
// the first-party verified styling for a plugin that has not earned it.
//
// The badge is non-dismissible BY CONSTRUCTION (CPHMTP-TC-041): it is plain
// rendered markup with no close affordance and no local or persisted dismissal
// state, so there is nothing to dismiss and nothing to restore after a reload. It
// stops rendering the Unverified pill only when the provenance it is handed stops
// being unverified.

const STRINGS = {
  verified: "Verified · first-party",
  unverified: "Unverified",
  orphaned: "Orphaned",
  provenancePrefix: "Source: ",
  // Announced-only context for the two warning pills. The visible pill stays a
  // short word; the reason rides along in the accessible text so the badge is not
  // an unexplained mark for a screen-reader user (CPHMTP-NFR-008).
  unverifiedContext: " plugin from an unsigned source. Roubo cannot vouch for its contents.",
  orphanedContext:
    ": the marketplace source it was installed from has been removed, so it has no update path.",
};

const TRUST_STYLES: Record<TrustTreatment, string> = {
  verified:
    "border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-950/20 text-green-800 dark:text-green-300",
  unverified:
    "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200",
};

const PILL_CLASS =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none";

function TrustPill({ treatment }: { treatment: TrustTreatment }) {
  const isVerified = treatment === "verified";
  const Icon = isVerified ? ShieldCheck : ShieldAlert;
  return (
    <span
      data-testid="provenance-trust"
      data-treatment={treatment}
      className={`${PILL_CLASS} ${TRUST_STYLES[treatment]}`}
    >
      <Icon size={11} aria-hidden className="shrink-0" />
      {isVerified ? STRINGS.verified : STRINGS.unverified}
      {!isVerified && <span className="sr-only">{STRINGS.unverifiedContext}</span>}
    </span>
  );
}

/**
 * Red, not the amber of the unverified pill: an orphaned plugin is not merely
 * untrusted, it is stranded (no update path, until its source is registered
 * again). Rendered ALONGSIDE the unverified pill rather than replacing it, because
 * the two facts are independent: losing the source does not make the plugin's code
 * any more or less verified, and CPHMTP-FR-009 requires the unverified badge to be
 * retained through the orphaning.
 */
function OrphanedPill() {
  return (
    <span
      data-testid="provenance-orphaned"
      className={`${PILL_CLASS} border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 text-red-800 dark:text-red-300`}
    >
      <Unplug size={11} aria-hidden className="shrink-0" />
      {STRINGS.orphaned}
      <span className="sr-only">{STRINGS.orphanedContext}</span>
    </span>
  );
}

/**
 * The source provenance shown alongside the badge (CPHMTP-FR-004 / CPHMTP-FR-006).
 * First-party is a DISTINCT treatment from a registered third-party source (green
 * versus amber), so an unsigned source cannot visually pass itself off as the
 * curated catalog. A visually hidden "Source: " prefix leads the chip's subtree
 * text, so a screen reader announces "Source: ACME workplace" rather than a bare
 * hostname out of context (CPHMTP-NFR-008). It is deliberately subtree text and
 * not an `aria-label`: the chip is a role-less span (ARIA role `generic`), which
 * prohibits `aria-label`, and a generic container is not a navigation stop, so
 * assistive tech reads the subtree rather than the name (issue #596).
 */
function SourceChip({ sourceId, label }: { sourceId: string; label: string }) {
  const isFirstParty = sourceId === FIRST_PARTY_SOURCE_ID;
  return (
    <span
      data-testid="provenance-source"
      data-source-id={sourceId}
      className={`${PILL_CLASS} max-w-[12rem] ${
        isFirstParty ? TRUST_STYLES.verified : TRUST_STYLES.unverified
      }`}
    >
      {isFirstParty ? (
        <ShieldCheck size={11} aria-hidden className="shrink-0" />
      ) : (
        <Globe size={11} aria-hidden className="shrink-0" />
      )}
      <span className="sr-only">{STRINGS.provenancePrefix}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The trust badge plus its source provenance, as one unit. */
export default function ProvenanceBadge({ provenance }: { provenance: PluginProvenance }) {
  const treatment = trustTreatmentOf(provenance);
  return (
    <span
      data-testid="provenance-badge"
      data-treatment={treatment}
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      <TrustPill treatment={treatment} />
      {provenance.orphaned && <OrphanedPill />}
      <SourceChip sourceId={provenance.sourceId} label={provenance.sourceLabel} />
    </span>
  );
}
