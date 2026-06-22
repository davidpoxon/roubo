import { Button } from "react-aria-components";
import { ArrowRight, Check, Download, Package, RefreshCw, ShieldCheck } from "lucide-react";
import type { MarketplaceListing } from "@roubo/shared";

// One catalog card (CP-FR-020 / CP-US-010, issue #621). State-aware affordance:
//   - update available -> Update button
//   - installed (current) -> "Installed" badge, NO install affordance
//   - not installed -> Install button
// Each card shows the display-only verified marker and the version.

const STRINGS = {
  verified: "Verified",
  install: "Install",
  update: "Update",
  installed: "Installed",
};

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
  onOpenDetail: (id: string) => void;
  onInstall: (listing: MarketplaceListing) => void;
  onUpdate: (listing: MarketplaceListing) => void;
}

export default function MarketplaceCard({ listing, onOpenDetail, onInstall, onUpdate }: Props) {
  const showInstalled = listing.installed && !listing.updateAvailable;

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
        </div>
      </div>

      <p className="mt-3 flex-1 text-[12.5px] leading-relaxed text-stone-600 dark:text-stone-400">
        {listing.summary}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px]">
          {listing.verified && (
            <span
              data-testid="marketplace-card-verified"
              className="inline-flex items-center gap-1 text-green-700 dark:text-green-400"
            >
              <ShieldCheck size={14} aria-hidden /> {STRINGS.verified}
            </span>
          )}
          <span className="text-stone-300 dark:text-stone-700">·</span>
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
