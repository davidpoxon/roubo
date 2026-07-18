import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import { Check, Download, Package, RefreshCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { declaredCategories } from "@roubo/shared";
import type { MarketplaceListing, PluginLifecycle } from "@roubo/shared";
import { CATEGORY_META } from "./permission-categories";
import ProvenanceBadge from "./ProvenanceBadge";
import { isFirstPartySource, listingProvenance } from "./plugin-provenance";

// Detail drawer for one catalog entry (CP-FR-020, issue #621; CP-FR-021, issue
// #622). A right-side modal panel mirroring the prototype: identity, summary,
// metadata (integrity, provenance, sandbox status, kind, version, curation), and
// the same state-aware affordance as the card (Update / Installed / Install).
// The Provenance row shows the registry path; the Sandbox row flags that enforced
// isolation is not yet active.
//
// The Integrity row is provenance-dependent (CPHMTP-FR-006, issue #563). Only the
// first-party catalog carries a signature, so only a first-party entry can claim
// "signed by Roubo": a third-party source is unsigned, and its integrity floor is
// the per-artifact sha256 digest the installer recomputes and fails closed on
// (CPHMTP-NFR-004), which is what its row says instead. The claim keys off the
// SOURCE (`isFirstPartySource`), not the per-entry curation flag: catalog signing
// is a source property, so an uncurated first-party entry is still signed by Roubo
// even though its Curation row grades it Unverified (issue #603). The Curation row
// renders the shared ProvenanceBadge, so the drawer carries the same
// non-dismissible Unverified badge and source provenance as the card (CPHMTP-TC-031).

const STRINGS = {
  title: "Plugin detail",
  close: "Close",
  integrity: "Integrity",
  integrityVerified: "Verified · signed by Roubo",
  integrityUnsigned: "Unsigned source · artifact digest checked at install",
  provenance: "Provenance",
  kind: "Kind",
  version: "Version",
  curation: "Curation",
  sandbox: "Sandbox",
  unsandboxed: "Unsandboxed (v2)",
  lifecycle: "Lifecycle",
  permissionsHeading: "Declared permissions",
  noPermissions: "This plugin declares no special permissions.",
  install: "Install",
  update: "Update",
  installed: "Installed",
};

// Human-readable lifecycle rendering shown in the Lifecycle row (issue #401,
// CP-TC-097 / CP-TC-104). The one-shot copy names the run-to-completion shape;
// the long-running copy names the supervised start / stop / health / logs shape,
// so a one-shot plugin's drawer shows no long-running (start / stop / health /
// logs) description (CP-TC-097 S001-O02).
const LIFECYCLE_DESCRIPTION: Record<PluginLifecycle, string> = {
  "long-running": "long-running (start, stop, health, and logs)",
  "one-shot": "one-shot (start runs to completion, then completed)",
};

interface Props {
  listing: MarketplaceListing;
  /** Display label for `listing.sourceId`, resolved by the container the same way the card's is. */
  sourceLabel: string;
  onClose: () => void;
  onInstall: (listing: MarketplaceListing) => void;
  onUpdate: (listing: MarketplaceListing) => void;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[12.5px]">
      <dt className="text-stone-400 dark:text-stone-500">{label}</dt>
      <dd className="text-stone-700 dark:text-stone-200">{children}</dd>
    </div>
  );
}

export default function MarketplaceDrawer({
  listing,
  sourceLabel,
  onClose,
  onInstall,
  onUpdate,
}: Props) {
  const showInstalled = listing.installed && !listing.updateAvailable;
  const provenance = listingProvenance(listing, sourceLabel);
  const isSigned = isFirstPartySource(provenance);
  // PRE-INSTALL provenance the server derived onto the listing (issue #401): the
  // declared permission categories (exactly those the manifest requests, via
  // `declaredCategories`) and the component lifecycle. Both are null when the
  // manifest is unavailable pre-install (a non-bundled, not-yet-installed entry),
  // in which case the corresponding section / row is omitted.
  const declaredPermissions = listing.declaredPermissions;
  const permissionCategories = declaredPermissions ? declaredCategories(declaredPermissions) : [];

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
    >
      <Modal className="h-full w-full max-w-md">
        <Dialog
          ref={stampAriaModal}
          data-testid="marketplace-drawer"
          className="h-full w-full overflow-y-auto border-l border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 outline-none"
        >
          <div className="sticky top-0 flex h-14 items-center justify-between border-b border-stone-200 dark:border-stone-800 bg-white/90 dark:bg-stone-900/90 px-5 backdrop-blur">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {STRINGS.title}
            </Heading>
            <Button
              data-testid="marketplace-drawer-close"
              onPress={onClose}
              aria-label={STRINGS.close}
              className="grid h-8 w-8 place-items-center rounded-lg text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <X size={16} />
            </Button>
          </div>

          <div className="p-5">
            <div className="flex items-start gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                <Package size={22} aria-hidden />
              </div>
              <div className="min-w-0">
                <h3 className="text-[16px] font-semibold text-stone-900 dark:text-stone-100">
                  {listing.name}
                </h3>
                <p className="mt-0.5 font-mono text-[11px] text-stone-400 dark:text-stone-500">
                  {listing.id} · v{listing.version}
                </p>
              </div>
            </div>

            <p className="mt-4 text-[13px] leading-relaxed text-stone-600 dark:text-stone-400">
              {listing.summary}
            </p>

            <dl className="mt-5 space-y-2">
              <MetaRow label={STRINGS.integrity}>
                <span
                  data-testid="marketplace-drawer-integrity"
                  className={`inline-flex items-center gap-1 ${
                    isSigned
                      ? "text-green-700 dark:text-green-400"
                      : "text-amber-700 dark:text-amber-400"
                  }`}
                >
                  {isSigned ? (
                    <>
                      <ShieldCheck size={14} aria-hidden /> {STRINGS.integrityVerified}
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={14} aria-hidden /> {STRINGS.integrityUnsigned}
                    </>
                  )}
                </span>
              </MetaRow>
              <MetaRow label={STRINGS.provenance}>
                <span data-testid="marketplace-drawer-provenance" className="font-mono">
                  {listing.provenance}
                </span>
              </MetaRow>
              <MetaRow label={STRINGS.kind}>{listing.kind}</MetaRow>
              {listing.lifecycle !== null && (
                <MetaRow label={STRINGS.lifecycle}>
                  <span data-testid="marketplace-drawer-lifecycle" className="font-mono">
                    {LIFECYCLE_DESCRIPTION[listing.lifecycle]}
                  </span>
                </MetaRow>
              )}
              <MetaRow label={STRINGS.version}>
                <span className="font-mono">v{listing.version}</span>
              </MetaRow>
              <MetaRow label={STRINGS.curation}>
                <ProvenanceBadge provenance={provenance} />
              </MetaRow>
              <MetaRow label={STRINGS.sandbox}>
                <span
                  data-testid="marketplace-drawer-sandbox"
                  className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
                >
                  <ShieldAlert size={14} aria-hidden /> {STRINGS.unsandboxed}
                </span>
              </MetaRow>
            </dl>

            {declaredPermissions !== null && (
              <div className="mt-6" data-testid="marketplace-drawer-permissions">
                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
                  {STRINGS.permissionsHeading}
                </p>
                {permissionCategories.length === 0 ? (
                  <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                    {STRINGS.noPermissions}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {permissionCategories.map((category) => {
                      const meta = CATEGORY_META[category];
                      const Icon = meta.icon;
                      return (
                        <li
                          key={category}
                          data-category={category}
                          className="flex items-start gap-2.5 rounded-lg border border-stone-200 dark:border-stone-800 px-3 py-2"
                        >
                          <Icon
                            size={15}
                            aria-hidden
                            className="shrink-0 mt-0.5 text-stone-500 dark:text-stone-400"
                          />
                          <div className="min-w-0">
                            <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
                              {meta.label}
                            </p>
                            <p className="text-xs text-stone-500 dark:text-stone-400 break-words">
                              {meta.describe(declaredPermissions)}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-6">
              {listing.updateAvailable ? (
                <Button
                  data-testid="marketplace-drawer-update"
                  onPress={() => onUpdate(listing)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-[13px] font-medium text-stone-950 transition-colors hover:bg-amber-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
                >
                  <RefreshCw size={16} /> {STRINGS.update}
                </Button>
              ) : showInstalled ? (
                <span
                  data-testid="marketplace-drawer-installed"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-950/20 px-3 py-2 text-[13px] font-medium text-green-800 dark:text-green-300"
                >
                  <Check size={16} /> {STRINGS.installed}
                </span>
              ) : (
                <Button
                  data-testid="marketplace-drawer-install"
                  onPress={() => onInstall(listing)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-[13px] font-medium text-stone-950 transition-colors hover:bg-amber-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
                >
                  <Download size={16} /> {STRINGS.install}
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
