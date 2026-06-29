import { useMemo, useState } from "react";
import { Input, Radio, RadioGroup, SearchField } from "react-aria-components";
import { Loader2, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import type { InstallPreview, MarketplaceKind, MarketplaceListing } from "@roubo/shared";
import { ApiError } from "../../lib/api";
import {
  useMarketplaceCatalog,
  useMarketplaceInstallCancel,
  useMarketplaceInstallConfirm,
  useMarketplaceInstallPreview,
  useMarketplaceUpdatePreview,
} from "../../hooks/useMarketplace";
import { useToast } from "../../hooks/useToast";
import MarketplaceCard from "./MarketplaceCard";
import MarketplaceDrawer from "./MarketplaceDrawer";
import MarketplaceConsentModal from "./MarketplaceConsentModal";
import MarketplaceOfflineBanner from "./MarketplaceOfflineBanner";

// Marketplace catalog view (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621).
// First-party curated: there is deliberately NO third-party submission
// affordance anywhere in this view. Browse + search + kind filter; install and
// update reuse the existing staging -> consent -> commit flow via the consent
// modal.

const STRINGS = {
  heading: "Plugin Marketplace",
  description:
    "Browse, install, and update Roubo plugins. Component plugins define what a bench runs; integration plugins connect issue trackers.",
  curatedBadge: "First-party curated",
  searchLabel: "Search plugins",
  searchPlaceholder: "Search plugins",
  filterLabel: "Filter by kind",
  loading: "Loading catalog…",
  loadFailedPrefix: "Failed to load catalog: ",
  catalogUnverified:
    "The plugin catalog could not be verified and was rejected. No plugins are shown to protect you from an unverified source.",
  empty: "No plugins match that search.",
  installedToast: (name: string) => `Installed ${name}.`,
  updatedToast: (name: string) => `Updated ${name}.`,
  installFailed: "Install failed.",
};

const KIND_TABS: { id: "all" | MarketplaceKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "component", label: "Component" },
  { id: "integration", label: "Integration" },
];

interface PendingConsent {
  mode: "install" | "update";
  listing: MarketplaceListing;
  preview: InstallPreview;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function Marketplace() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | MarketplaceKind>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConsent | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  const queryKind = kind === "all" ? undefined : kind;
  const { data, isLoading, error } = useMarketplaceCatalog({
    q: search.trim() || undefined,
    kind: queryKind,
  });

  const installPreview = useMarketplaceInstallPreview();
  const updatePreview = useMarketplaceUpdatePreview();
  const confirmMutation = useMarketplaceInstallConfirm();
  const cancelMutation = useMarketplaceInstallCancel();
  const { addToast } = useToast();

  const listings = useMemo(() => data?.listings ?? [], [data]);
  const detailListing = useMemo(
    () => listings.find((l) => l.id === detailId) ?? null,
    [listings, detailId],
  );

  const stagingPending = installPreview.isPending || updatePreview.isPending;

  function beginInstall(listing: MarketplaceListing) {
    setConsentError(null);
    installPreview.mutate(listing.id, {
      onSuccess: (preview) => setPending({ mode: "install", listing, preview }),
      onError: (err) => addToast(errorMessage(err, STRINGS.installFailed)),
    });
  }

  function beginUpdate(listing: MarketplaceListing) {
    setConsentError(null);
    updatePreview.mutate(listing.id, {
      onSuccess: (preview) => setPending({ mode: "update", listing, preview }),
      onError: (err) => addToast(errorMessage(err, STRINGS.installFailed)),
    });
  }

  function handleConsentCancel() {
    if (!pending) return;
    cancelMutation.mutate(pending.preview.stagingToken);
    setPending(null);
    setConsentError(null);
  }

  function handleConsentConfirm() {
    if (!pending) return;
    const { mode, listing, preview } = pending;
    confirmMutation.mutate(preview.stagingToken, {
      onSuccess: () => {
        addToast(
          mode === "update"
            ? STRINGS.updatedToast(listing.name)
            : STRINGS.installedToast(listing.name),
        );
        setPending(null);
        setConsentError(null);
        setDetailId(null);
      },
      onError: (err) => setConsentError(errorMessage(err, STRINGS.installFailed)),
    });
  }

  return (
    <section aria-label={STRINGS.heading}>
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {STRINGS.heading}
          </h2>
          <p className="mt-1 max-w-xl text-[13px] text-stone-500 dark:text-stone-400">
            {STRINGS.description}
          </p>
        </div>
        <span
          data-testid="marketplace-curated-badge"
          className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-2.5 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-200"
        >
          <ShieldCheck size={14} aria-hidden /> {STRINGS.curatedBadge}
        </span>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchField
          aria-label={STRINGS.searchLabel}
          value={search}
          onChange={setSearch}
          className="relative min-w-[220px] max-w-md flex-1"
        >
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400"
          />
          <Input
            data-testid="marketplace-search"
            placeholder={STRINGS.searchPlaceholder}
            className="w-full rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 py-2 pl-9 pr-3 text-[13px] text-stone-900 dark:text-stone-100 placeholder:text-stone-400 outline-none transition-colors focus:border-amber-500 focus:ring-2 focus:ring-amber-500/40 hover:border-stone-300 dark:hover:border-stone-600"
          />
        </SearchField>

        <RadioGroup
          aria-label={STRINGS.filterLabel}
          value={kind}
          onChange={(value) => setKind(value as "all" | MarketplaceKind)}
          className="flex items-center gap-1.5"
        >
          {KIND_TABS.map((t) => (
            <Radio
              key={t.id}
              value={t.id}
              data-testid={`marketplace-filter-${t.id}`}
              className={({ isSelected, isFocusVisible }) =>
                [
                  "cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium outline-none transition-colors",
                  isSelected
                    ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                    : "text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-200",
                  isFocusVisible ? "ring-2 ring-amber-500" : "",
                ].join(" ")
              }
            >
              {t.label}
            </Radio>
          ))}
        </RadioGroup>
      </div>

      <div className="mt-7">
        {data && data.source !== "network" && (
          <div className="mb-5">
            <MarketplaceOfflineBanner source={data.source} fetchedAt={data.fetchedAt} />
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
            <Loader2 size={14} className="animate-spin" />
            {STRINGS.loading}
          </div>
        )}

        {error &&
          (error instanceof ApiError && error.code === "catalog-unverified" ? (
            <div
              role="alert"
              data-testid="marketplace-unverified"
              className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
            >
              <ShieldAlert size={15} className="shrink-0 mt-0.5" aria-hidden />
              <span>{STRINGS.catalogUnverified}</span>
            </div>
          ) : (
            <div
              role="alert"
              data-testid="marketplace-error"
              className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300"
            >
              {STRINGS.loadFailedPrefix}
              {(error as Error).message}
            </div>
          ))}

        {data && listings.length === 0 && (
          <p data-testid="marketplace-empty" className="py-16 text-center text-sm text-stone-400">
            {STRINGS.empty}
          </p>
        )}

        {data && listings.length > 0 && (
          <div
            data-testid="marketplace-grid"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            aria-busy={stagingPending}
          >
            {listings.map((listing) => (
              <MarketplaceCard
                key={listing.id}
                listing={listing}
                onOpenDetail={setDetailId}
                onInstall={beginInstall}
                onUpdate={beginUpdate}
              />
            ))}
          </div>
        )}
      </div>

      {detailListing && (
        <MarketplaceDrawer
          listing={detailListing}
          onClose={() => setDetailId(null)}
          onInstall={beginInstall}
          onUpdate={beginUpdate}
        />
      )}

      {pending && (
        <MarketplaceConsentModal
          preview={pending.preview}
          mode={pending.mode}
          error={consentError}
          isPending={confirmMutation.isPending}
          onCancel={handleConsentCancel}
          onConfirm={handleConsentConfirm}
        />
      )}
    </section>
  );
}
