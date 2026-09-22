import { Button } from "react-aria-components";
import { Plus, Loader2 } from "lucide-react";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { useMarketplaceSources } from "../../../hooks/useMarketplaceSources";
import MarketplaceSourceRow from "./MarketplaceSourceRow";

// The Marketplaces settings section (CPHMTP-FR-001 / CPHMTP-US-001, #976):
// the built-in first-party source plus every registered third-party source, with
// an add entry point and a per-row remove entry point.
//
// The server synthesises the first-party row into GET /api/marketplace/sources,
// so this list renders the response as-is rather than merging the built-in in
// itself. Both dialogs the entry points lead to (the registration consent dialog,
// #975, and the removal consequences dialog, #980) are separate slices
// and out of scope here: this section wires the controls to seams, so those slices
// mount the real dialogs without reshaping the section.

const STRINGS = {
  heading: "Marketplaces",
  description:
    "Roubo installs plugins from the first-party marketplace and any marketplace you register. A registered marketplace is any URL that serves the Roubo catalog format.",
  addCta: "Add marketplace…",
  listHeading: "Registered marketplaces",
  listAriaLabel: "Registered marketplaces",
  sectionAriaLabel: "Marketplaces",
  loading: "Loading marketplaces...",
  loadFailedPrefix: "Failed to load marketplaces: ",
  empty: "No marketplaces registered.",
  note: "Adding a marketplace never contacts the URL until you consent. Credentials are stored in the OS keychain and sent only to that marketplace's origin.",
};

interface Props {
  /**
   * Opens the registration consent dialog (#975, out of scope for issue
   * #976). Defaults to a no-op so the section is renderable on its own.
   */
  onAddSource?: () => void;
  /** Opens the removal consequences dialog (#980, out of scope here). */
  onRemoveSource?: (source: MarketplaceSourceSummary) => void;
}

export default function MarketplacesTab({ onAddSource, onRemoveSource }: Props = {}) {
  const { data, isLoading, error } = useMarketplaceSources();

  function handleRemove(source: MarketplaceSourceSummary) {
    onRemoveSource?.(source);
  }

  return (
    <section aria-label={STRINGS.sectionAriaLabel} className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h3 className="text-14 font-semibold text-text-primary">{STRINGS.heading}</h3>
          <p className="mt-1 text-12 text-text-secondary leading-relaxed">{STRINGS.description}</p>
        </div>
        <Button
          data-testid="add-marketplace"
          onPress={() => onAddSource?.()}
          className="inline-flex flex-none items-center gap-1.5 px-3 py-1.5 text-12 font-medium rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Plus size={14} />
          {STRINGS.addCta}
        </Button>
      </header>

      {isLoading && (
        <div className="flex items-center gap-2 text-12 text-text-secondary">
          <Loader2 size={14} className="animate-spin" />
          {STRINGS.loading}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 text-danger-text"
        >
          {STRINGS.loadFailedPrefix}
          {(error as Error).message}
        </div>
      )}

      {data && (
        <div className="space-y-3">
          <h4 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
            {STRINGS.listHeading}
          </h4>
          {data.sources.length === 0 ? (
            <p className="text-12 text-text-secondary">{STRINGS.empty}</p>
          ) : (
            <ul aria-label={STRINGS.listAriaLabel} className="space-y-3">
              {data.sources.map((source) => (
                <MarketplaceSourceRow key={source.id} source={source} onRemove={handleRemove} />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-11 text-text-secondary leading-relaxed max-w-2xl">{STRINGS.note}</p>
    </section>
  );
}
