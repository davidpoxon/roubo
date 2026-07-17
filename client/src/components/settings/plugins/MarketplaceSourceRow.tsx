import { Button } from "react-aria-components";
import { BadgeCheck, Boxes } from "lucide-react";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { sourceDisplayName } from "./marketplace-source-name";

// One row of the Marketplaces settings list (CPHMTP-FR-001 / CPHMTP-US-001,
// issue #561). The built-in first-party row is recognised by its reserved id,
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-none ${
        verified
          ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400"
          : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-400"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${verified ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {verified ? STRINGS.firstPartyPill : STRINGS.unverifiedPill}
    </span>
  );
}

interface Props {
  source: MarketplaceSourceSummary;
  /**
   * Opens the removal consequences dialog. Wired as a seam here: the dialog
   * itself is a separate slice and explicitly out of scope for issue #561.
   */
  onRemove: (source: MarketplaceSourceSummary) => void;
}

export default function MarketplaceSourceRow({ source, onRemove }: Props) {
  const isFirstParty = source.id === FIRST_PARTY_SOURCE_ID;
  const name = sourceDisplayName(source);

  return (
    <li
      data-testid="marketplace-source-row"
      data-source-id={source.id}
      className="flex items-start gap-3 rounded-xl border border-stone-200 dark:border-stone-800 px-4 py-3"
    >
      <span
        aria-hidden
        className="mt-0.5 flex-none text-stone-400 dark:text-stone-500"
        data-testid="marketplace-source-icon"
      >
        {isFirstParty ? <BadgeCheck size={18} /> : <Boxes size={18} />}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-stone-900 dark:text-stone-100">{name}</span>
          <ProvenancePill verified={isFirstParty} />
        </div>
        {/* The raw URL, always shown verbatim and never shortened: the operator
            judges a source by the exact origin they consented to (CPHMTP-NFR-003). */}
        <p
          data-testid="marketplace-source-url"
          className="font-mono text-[11px] break-all text-stone-500 dark:text-stone-400"
        >
          {source.url}
        </p>
        <p
          data-testid="marketplace-source-meta"
          className="text-[11px] text-stone-400 dark:text-stone-500"
        >
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
          onPress={() => onRemove(source)}
          className="flex-none rounded-md border border-red-200 dark:border-red-900/50 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 outline-none transition-colors hover:bg-red-50 dark:hover:bg-red-950/30 focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {STRINGS.removeCta}
        </Button>
      )}
    </li>
  );
}
