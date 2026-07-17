import { Button } from "react-aria-components";
import { AlertTriangle, ArrowRight, Check, Download, Package, RefreshCw } from "lucide-react";
import type { MarketplaceListing } from "@roubo/shared";
import ProvenanceBadge from "./ProvenanceBadge";
import { listingProvenance } from "./plugin-provenance";

// One catalog card (CP-FR-020 / CP-US-010, issue #621). State-aware affordance:
//   - update available -> Update button
//   - installed (current) -> "Installed" badge, NO install affordance
//   - not installed -> Install button
// Each card shows the version and one ProvenanceBadge: the shared trust treatment
// (Verified / Unverified) plus exactly one source provenance chip naming where the
// entry came from (CPHMTP-FR-004, issue #557; CPHMTP-FR-006, issue #563). The card
// renders no trust marker of its own: the badge owns that decision so a third-party
// entry cannot reach the first-party verified styling from here (CPHMTP-NFR-001).

const STRINGS = {
  install: "Install",
  update: "Update",
  installed: "Installed",
  collisionPill: (count: number) => `Served by ${count} sources`,
  // Names every contributing source, so the collision is legible from the card
  // without opening anything (CPHMTP-TC-033 S001-O02).
  collisionLabel: (labels: string[]) =>
    `Plugin id served by ${labels.length} sources: ${labels.join(", ")}. Choose a source to install from.`,
};

/**
 * The cross-source collision pill (CPHMTP-FR-005, issue #558). Renders beside the
 * SourceChip on every card whose id another source also serves, so each colliding
 * card is marked and none is presented as the winner: there is no precedence, and
 * the ambiguity is surfaced rather than resolved.
 *
 * Red (not the amber of a third-party chip) because this is not provenance, it is
 * a blocked action: install/update of this id is refused until the consumer picks a
 * source. It names every contributing source via its accessible label, so the mark
 * is not just an unexplained count (CPHMTP-NFR-008).
 */
function CollisionPill({ sourceLabels }: { sourceLabels: string[] }) {
  return (
    <span
      data-testid="marketplace-card-collision"
      data-source-count={sourceLabels.length}
      aria-label={STRINGS.collisionLabel(sourceLabels)}
      className="inline-flex items-center gap-1 rounded-full border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-2 py-0.5 text-[10px] font-medium text-red-800 dark:text-red-300"
    >
      <AlertTriangle size={11} aria-hidden className="shrink-0" />
      <span className="truncate">{STRINGS.collisionPill(sourceLabels.length)}</span>
    </span>
  );
}

function KindPill({ kind }: { kind: MarketplaceListing["kind"] }) {
  const cls =
    kind === "component"
      ? "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200"
      : "border-stone-200 dark:border-stone-700 bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300";
  return (
    <span
      data-testid="marketplace-card-kind"
      className={`inline-flex items-center rounded-full border ${cls} px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide`}
    >
      {kind}
    </span>
  );
}

interface Props {
  listing: MarketplaceListing;
  /**
   * Display label for `listing.sourceId`, resolved from the catalog response's
   * per-source status rows (a registered source row carries no display name, so
   * the server derives the label from its URL host).
   */
  sourceLabel: string;
  /**
   * Display labels for every source in `listing.collision.sourceIds`, resolved the
   * same way. Empty when this listing is not a collision.
   */
  collisionSourceLabels: string[];
  onOpenDetail: (id: string) => void;
  onInstall: (listing: MarketplaceListing) => void;
  onUpdate: (listing: MarketplaceListing) => void;
}

export default function MarketplaceCard({
  listing,
  sourceLabel,
  collisionSourceLabels,
  onOpenDetail,
  onInstall,
  onUpdate,
}: Props) {
  const showInstalled = listing.installed && !listing.updateAvailable;
  const isCollision = listing.collision !== undefined;

  return (
    <article
      data-testid="marketplace-card"
      data-plugin-id={listing.id}
      className="group flex flex-col rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/40 p-4 transition-colors hover:border-stone-300 dark:hover:border-stone-700"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
          <Package size={18} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Button
              data-testid="marketplace-card-detail"
              onPress={() => onOpenDetail(listing.id)}
              className="truncate text-[14px] font-semibold text-stone-900 dark:text-stone-100 hover:text-amber-700 dark:hover:text-amber-400 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
            >
              {listing.name}
            </Button>
            <KindPill kind={listing.kind} />
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-stone-400 dark:text-stone-500">
            {listing.id}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ProvenanceBadge provenance={listingProvenance(listing, sourceLabel)} />
            {isCollision && <CollisionPill sourceLabels={collisionSourceLabels} />}
          </div>
        </div>
      </div>

      <p className="mt-3 flex-1 text-[12.5px] leading-relaxed text-stone-600 dark:text-stone-400">
        {listing.summary}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px]">
          {listing.updateAvailable && listing.installedVersion ? (
            <span data-testid="marketplace-card-version">
              <span className="font-mono text-stone-400 dark:text-stone-500 line-through">
                v{listing.installedVersion}
              </span>{" "}
              <ArrowRight size={11} className="inline text-stone-400" aria-hidden />{" "}
              <span className="font-mono text-amber-700 dark:text-amber-400">
                v{listing.version}
              </span>
            </span>
          ) : (
            <span
              data-testid="marketplace-card-version"
              className="font-mono text-stone-500 dark:text-stone-400"
            >
              v{listing.version}
            </span>
          )}
        </div>

        {listing.updateAvailable ? (
          <Button
            data-testid="marketplace-card-update"
            onPress={() => onUpdate(listing)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-medium text-stone-950 transition-colors hover:bg-amber-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            <RefreshCw size={14} /> {STRINGS.update}
          </Button>
        ) : showInstalled ? (
          <span
            data-testid="marketplace-card-installed"
            className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-950/20 px-3 py-1.5 text-[12px] font-medium text-green-800 dark:text-green-300"
          >
            <Check size={14} /> {STRINGS.installed}
          </span>
        ) : (
          <Button
            data-testid="marketplace-card-install"
            onPress={() => onInstall(listing)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-medium text-stone-950 transition-colors hover:bg-amber-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            <Download size={14} /> {STRINGS.install}
          </Button>
        )}
      </div>
    </article>
  );
}
