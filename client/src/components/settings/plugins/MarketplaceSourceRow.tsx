import { Button } from "react-aria-components";
import { BadgeCheck, Boxes } from "lucide-react";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { sourceDisplayName } from "./marketplace-source-name";

// One row of the Marketplaces settings list (CPHMTP-FR-001 / CPHMTP-US-001,
// #976). The built-in first-party row is recognised by its reserved id,
// never by URL-matching, and is non-removable by construction: it renders no
// Remove control at all rather than a disabled one, so there is no removal
// affordance to reach by keyboard or screen reader.

const STRINGS = {
  firstPartyPill: "Verified, first-party",
  firstPartyMeta: "Built in · signed catalog · cannot be removed",
  unverifiedPill: "Unverified source",
  removeCta: "Remove…",
  removeLabel: (name: string) => `Remove ${name}…`,
  registeredPrefix: "Registered ",
  credentialAttached: " · credential attached",
  noCredential: " · no credential",
};

/** The registration date, rendered as a bare ISO calendar day (no clock noise). */
function registeredDay(registeredAt: string): string {
  return registeredAt.slice(0, 10);
}

function ProvenancePill({ verified }: { verified: boolean }) {
  return (
    <span
      data-testid="marketplace-source-pill"
      data-verified={verified}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-11 font-medium leading-none ${
        verified
          ? "bg-success-surface border-success-border text-success-text"
          : "bg-accent-muted border-accent-border text-accent-text"
      }`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {verified ? STRINGS.firstPartyPill : STRINGS.unverifiedPill}
    </span>
  );
}

interface Props {
  source: MarketplaceSourceSummary;
  /**
   * Opens the removal consequences dialog (#980). Wired as a seam here:
   * that dialog is a separate slice and explicitly out of scope for #976.
   */
  onRemove: (source: MarketplaceSourceSummary) => void;
}

export default function MarketplaceSourceRow({ source, onRemove }: Props) {
  const isFirstParty = source.id === FIRST_PARTY_SOURCE_ID;
  const name = sourceDisplayName(source);
  // The display name is only the host, so two sources on the same host (distinct
  // rows: the registry keys a source on its full normalised URL) would otherwise
  // give their Remove controls identical accessible names. Describing the button
  // by the row's raw URL keeps the name concise and the control unambiguous.
  const urlId = `marketplace-source-url-${source.id}`;

  return (
    <li
      data-testid="marketplace-source-row"
      data-source-id={source.id}
      className="flex items-start gap-3 rounded-xl border border-border px-4 py-3"
    >
      <span
        aria-hidden
        className="mt-0.5 flex-none text-text-secondary"
        data-testid="marketplace-source-icon"
      >
        {isFirstParty ? <BadgeCheck size={16} /> : <Boxes size={16} />}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 font-medium text-text-primary">{name}</span>
          <ProvenancePill verified={isFirstParty} />
        </div>
        {/* The raw URL, always shown verbatim and never shortened: the operator
            judges a source by the exact origin they consented to (CPHMTP-NFR-003). */}
        <p
          id={urlId}
          data-testid="marketplace-source-url"
          className="font-mono text-11 break-all text-text-secondary"
        >
          {source.url}
        </p>
        <p data-testid="marketplace-source-meta" className="text-11 text-text-secondary">
          {isFirstParty
            ? STRINGS.firstPartyMeta
            : `${STRINGS.registeredPrefix}${registeredDay(source.registeredAt)}${
                source.hasCredential ? STRINGS.credentialAttached : STRINGS.noCredential
              }`}
        </p>
      </div>

      {!isFirstParty && (
        <Button
          data-testid="marketplace-source-remove"
          aria-label={STRINGS.removeLabel(name)}
          aria-describedby={urlId}
          onPress={() => onRemove(source)}
          className="flex-none rounded-control border border-danger-border bg-bg-surface px-3 py-1.5 text-12 font-medium text-danger-text outline-none transition-colors hover:bg-danger-surface focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {STRINGS.removeCta}
        </Button>
      )}
    </li>
  );
}
