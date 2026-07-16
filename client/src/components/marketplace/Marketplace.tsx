import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Modal,
  ModalOverlay,
  Radio,
  RadioGroup,
  SearchField,
} from "react-aria-components";
import { CloudOff, Loader2, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import type {
  InstallErrorCode,
  InstallPreview,
  MarketplaceKind,
  MarketplaceListing,
  PermissionCategory,
} from "@roubo/shared";
import { ApiError } from "../../lib/api";
import {
  useMarketplaceCatalog,
  useMarketplaceInstallCancel,
  useMarketplaceInstallConfirm,
  useMarketplaceInstallPreview,
  useMarketplaceUpdatePreview,
} from "../../hooks/useMarketplace";
import { useGrantConsent } from "../../hooks/usePlugins";
import { useToast } from "../../hooks/useToast";
import MarketplaceCard from "./MarketplaceCard";
import MarketplaceDrawer from "./MarketplaceDrawer";
import MarketplaceConsentModal from "./MarketplaceConsentModal";
import MarketplaceInstallProgress from "./MarketplaceInstallProgress";
import { deriveStageStatuses, describeArtifact } from "./marketplace-install-stages";
import MarketplaceOfflineBanner from "./MarketplaceOfflineBanner";

// Marketplace catalog view (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621).
// There is deliberately NO third-party SUBMISSION affordance anywhere in this
// view: entries come from the first-party curated catalog and from marketplace
// sources the consumer explicitly registered elsewhere. Browse + search + kind
// filter; install and update reuse the existing staging -> consent -> commit flow
// via the consent modal.
//
// Multi-source browse (CPHMTP-FR-004, issue #557): the list is the MERGED catalog
// across the first-party source and every registered source, each card carrying
// exactly one provenance chip. The source filter chip row scopes the list to a
// single source and back to all, and a source that could serve nothing is called
// out on its own without disturbing the sources that listed fine.

const STRINGS = {
  heading: "Plugin Marketplace",
  description:
    "Browse, install, and update Roubo plugins. Component plugins define what a bench runs; integration plugins connect issue trackers.",
  curatedBadge: "First-party curated",
  searchLabel: "Search plugins",
  searchPlaceholder: "Search plugins",
  filterLabel: "Filter by kind",
  sourceFilterLabel: "Filter by source",
  allSources: "All sources",
  sourcesUnavailable: (labels: string[]) =>
    labels.length === 1
      ? `${labels[0]} is unavailable right now, so its plugins are not listed. Every other source is unaffected.`
      : `${labels.join(", ")} are unavailable right now, so their plugins are not listed. Every other source is unaffected.`,
  loading: "Loading catalog…",
  loadFailedPrefix: "Failed to load catalog: ",
  catalogUnverified:
    "The plugin catalog could not be verified and was rejected. No plugins are shown to protect you from an unverified source.",
  empty: "No plugins match that search.",
  installedToast: (name: string) => `Installed ${name}.`,
  updatedToast: (name: string) => `Updated ${name}.`,
  installFailed: "Install failed.",
  stagingInstallTitle: (name: string) => `Installing ${name}`,
  stagingUpdateTitle: (name: string) => `Updating ${name}`,
  stagingFailed:
    "The install was refused before anything was written. Nothing ran on your machine.",
  stagingClose: "Close",
};

const KIND_TABS: { id: "all" | MarketplaceKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "component", label: "Component" },
  { id: "integration", label: "Integration" },
];

// Sentinel for the unscoped source filter. Safe against collision with a real
// source id: registered ids are `<host-slug>-<8 hex>` and the built-in is
// `first-party`, so no source can ever be called `__all__`.
const ALL_SOURCES = "__all__";

// Shared chip styling for both filter rows, so the source chips read as the same
// control as the kind chips rather than a second, competing pattern.
function chipClasses({
  isSelected,
  isFocusVisible,
}: {
  isSelected: boolean;
  isFocusVisible: boolean;
}): string {
  return [
    "cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium outline-none transition-colors",
    isSelected
      ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
      : "text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-200",
    isFocusVisible ? "ring-2 ring-amber-500" : "",
  ].join(" ");
}

interface PendingConsent {
  mode: "install" | "update";
  listing: MarketplaceListing;
  preview: InstallPreview;
}

// The active install/update during the staging (preview) phase, before the
// consent modal opens. It drives the 4-step progress surface so a staging-phase
// signature/digest failure is visible on its own stage, not only as a toast
// (issue #374).
interface ActiveStaging {
  mode: "install" | "update";
  listing: MarketplaceListing;
  failed: boolean;
  errorCode?: InstallErrorCode;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function Marketplace() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | MarketplaceKind>("all");
  const [sourceId, setSourceId] = useState<string>(ALL_SOURCES);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConsent | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [staging, setStaging] = useState<ActiveStaging | null>(null);

  const queryKind = kind === "all" ? undefined : kind;
  const { data, isLoading, error } = useMarketplaceCatalog({
    q: search.trim() || undefined,
    kind: queryKind,
    sourceId: sourceId === ALL_SOURCES ? undefined : sourceId,
  });

  const installPreview = useMarketplaceInstallPreview();
  const updatePreview = useMarketplaceUpdatePreview();
  const confirmMutation = useMarketplaceInstallConfirm();
  const cancelMutation = useMarketplaceInstallCancel();
  const grantConsent = useGrantConsent();
  const { addToast } = useToast();

  const listings = useMemo(() => data?.listings ?? [], [data]);
  const detailListing = useMemo(
    () => listings.find((l) => l.id === detailId) ?? null,
    [listings, detailId],
  );

  // The per-source status rows always describe EVERY source in the fan-out, even
  // while the listings are scoped to one, so the chip row stays complete and the
  // user can always get back to "All sources" (CPHMTP-FR-004).
  const sources = useMemo(() => data?.sources ?? [], [data]);
  const sourceLabels = useMemo(() => new Map(sources.map((s) => [s.id, s.label])), [sources]);
  // Only registered third-party sources can be unavailable: the first-party chain
  // always has the bundled seed to fall back on. Called out per source, so one
  // dead source never implies the others failed (CPHMTP-NFR-007).
  const unavailable = useMemo(() => sources.filter((s) => s.unavailable), [sources]);
  // One chip per source, plus the unscoped default. Rendered only once there is
  // more than the built-in source to choose between: a single-source install has
  // nothing to filter.
  const showSourceFilter = sources.length > 1;

  const stagingPending = installPreview.isPending || updatePreview.isPending;

  function stagingErrorCode(err: unknown): InstallErrorCode | undefined {
    return err instanceof ApiError ? (err.code as InstallErrorCode | undefined) : undefined;
  }

  function beginInstall(listing: MarketplaceListing) {
    setConsentError(null);
    setStaging({ mode: "install", listing, failed: false });
    installPreview.mutate(listing.id, {
      onSuccess: (preview) => {
        setStaging(null);
        setPending({ mode: "install", listing, preview });
      },
      onError: (err) => {
        setStaging({ mode: "install", listing, failed: true, errorCode: stagingErrorCode(err) });
        addToast(errorMessage(err, STRINGS.installFailed));
      },
    });
  }

  function beginUpdate(listing: MarketplaceListing) {
    setConsentError(null);
    setStaging({ mode: "update", listing, failed: false });
    updatePreview.mutate(listing.id, {
      onSuccess: (preview) => {
        setStaging(null);
        setPending({ mode: "update", listing, preview });
      },
      onError: (err) => {
        setStaging({ mode: "update", listing, failed: true, errorCode: stagingErrorCode(err) });
        addToast(errorMessage(err, STRINGS.installFailed));
      },
    });
  }

  function dismissStaging() {
    setStaging(null);
  }

  function handleConsentCancel() {
    if (!pending) return;
    cancelMutation.mutate(pending.preview.stagingToken);
    setPending(null);
    setConsentError(null);
    setStaging(null);
  }

  function handleConsentConfirm(acknowledgedCategories: PermissionCategory[]) {
    if (!pending) return;
    const { mode, listing, preview } = pending;
    confirmMutation.mutate(preview.stagingToken, {
      onSuccess: () => {
        // The install/update is committed. Mint (install) or refresh (update
        // across a permissions change) the plugin's ConsentRecord with the
        // categories the consumer just acknowledged, so the component-plugin
        // registry consent gate (hasConsent) admits the component (issue #399,
        // CP-TC-090 / CP-TC-096). The POST is safe for every confirm: an
        // in-place update that did not change permissions keeps its record
        // regardless (uninstallForUpdate preserves consent), and a matching
        // re-mint here is an idempotent upsert. grantConsent surfaces its own
        // failure toast; the install itself has already succeeded.
        grantConsent.mutate({ pluginId: preview.manifest.id, acknowledgedCategories });
        addToast(
          mode === "update"
            ? STRINGS.updatedToast(listing.name)
            : STRINGS.installedToast(listing.name),
        );
        setPending(null);
        setConsentError(null);
        setStaging(null);
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
              className={chipClasses}
            >
              {t.label}
            </Radio>
          ))}
        </RadioGroup>
      </div>

      {showSourceFilter && (
        <div className="mt-3">
          <RadioGroup
            aria-label={STRINGS.sourceFilterLabel}
            value={sourceId}
            onChange={setSourceId}
            data-testid="marketplace-source-filter"
            className="flex flex-wrap items-center gap-1.5"
          >
            <Radio
              value={ALL_SOURCES}
              data-testid={`marketplace-source-filter-${ALL_SOURCES}`}
              className={chipClasses}
            >
              {STRINGS.allSources}
            </Radio>
            {sources.map((s) => (
              <Radio
                key={s.id}
                value={s.id}
                data-testid={`marketplace-source-filter-${s.id}`}
                className={chipClasses}
              >
                {s.label}
              </Radio>
            ))}
          </RadioGroup>
        </div>
      )}

      <div className="mt-7">
        {unavailable.length > 0 && (
          <div
            role="status"
            data-testid="marketplace-sources-unavailable"
            className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200"
          >
            <CloudOff size={15} className="shrink-0 mt-0.5" aria-hidden />
            <span>{STRINGS.sourcesUnavailable(unavailable.map((s) => s.label))}</span>
          </div>
        )}

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
                key={`${listing.sourceId}:${listing.id}`}
                listing={listing}
                sourceLabel={sourceLabels.get(listing.sourceId) ?? listing.sourceId}
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

      {staging && (
        <ModalOverlay
          isOpen
          onOpenChange={(open) => {
            if (!open && staging.failed) dismissStaging();
          }}
          isDismissable={staging.failed}
          isKeyboardDismissDisabled={!staging.failed}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          <Modal className="w-full max-w-lg mx-4">
            <Dialog
              data-testid="marketplace-install-progress-modal"
              className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none p-5"
            >
              <Heading
                slot="title"
                className="text-sm font-semibold text-stone-900 dark:text-stone-100"
              >
                {staging.mode === "update"
                  ? STRINGS.stagingUpdateTitle(staging.listing.name)
                  : STRINGS.stagingInstallTitle(staging.listing.name)}
              </Heading>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                <span className="font-mono">{staging.listing.id}</span> · {staging.listing.kind}{" "}
                plugin · v{staging.listing.version}
              </p>

              <div className="mt-4">
                <MarketplaceInstallProgress
                  statuses={deriveStageStatuses({
                    stagingPending: !staging.failed,
                    stagingSettled: false,
                    confirmPending: false,
                    confirmSettled: false,
                    failedPhase: staging.failed ? "staging" : undefined,
                    errorCode: staging.errorCode,
                  })}
                  pluginId={staging.listing.id}
                  artifactLabel={describeArtifact(staging.listing.source, staging.listing)}
                  errorCode={staging.errorCode}
                />
              </div>

              {staging.failed && (
                <div className="mt-4 flex items-center justify-between gap-3">
                  <p
                    role="alert"
                    data-testid="marketplace-install-progress-failed"
                    className="text-xs text-red-700 dark:text-red-300"
                  >
                    {STRINGS.stagingFailed}
                  </p>
                  <Button
                    autoFocus
                    onPress={dismissStaging}
                    data-testid="marketplace-install-progress-close"
                    className="shrink-0 rounded-lg px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  >
                    {STRINGS.stagingClose}
                  </Button>
                </div>
              )}
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </section>
  );
}
