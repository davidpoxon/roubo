import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Check, Download, Package, RefreshCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { MarketplaceListing } from "@roubo/shared";

// Detail drawer for one catalog entry (CP-FR-020, issue #621; CP-FR-021, issue
// #622). A right-side modal panel mirroring the prototype: identity, summary,
// metadata (integrity, provenance, sandbox status, kind, version, curation), and
// the same state-aware affordance as the card (Update / Installed / Install).
// The Integrity row reflects the signed-catalog verification (the entry only
// reaches this drawer when the catalog signature validated, so a verified entry
// is "signed by Roubo"); the Provenance row shows the registry path; the Sandbox
// row flags that enforced isolation is not yet active.

const STRINGS = {
  title: "Plugin detail",
  close: "Close",
  integrity: "Integrity",
  integrityVerified: "Verified · signed by Roubo",
  provenance: "Provenance",
  verified: "Verified · first-party curated",
  curatedOnly: "First-party curated. Listed by Roubo maintainers.",
  kind: "Kind",
  version: "Version",
  curation: "Curation",
  sandbox: "Sandbox",
  unsandboxed: "Unsandboxed (v2)",
  install: "Install",
  update: "Update",
  installed: "Installed",
};

interface Props {
  listing: MarketplaceListing;
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

export default function MarketplaceDrawer({ listing, onClose, onInstall, onUpdate }: Props) {
  const showInstalled = listing.installed && !listing.updateAvailable;

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
                  className="inline-flex items-center gap-1 text-green-700 dark:text-green-400"
                >
                  <ShieldCheck size={14} aria-hidden /> {STRINGS.integrityVerified}
                </span>
              </MetaRow>
              <MetaRow label={STRINGS.provenance}>
                <span data-testid="marketplace-drawer-provenance" className="font-mono">
                  {listing.provenance}
                </span>
              </MetaRow>
              <MetaRow label={STRINGS.kind}>{listing.kind}</MetaRow>
              <MetaRow label={STRINGS.version}>
                <span className="font-mono">v{listing.version}</span>
              </MetaRow>
              <MetaRow label={STRINGS.curation}>
                {listing.verified ? (
                  <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                    <ShieldCheck size={14} aria-hidden /> {STRINGS.verified}
                  </span>
                ) : (
                  STRINGS.curatedOnly
                )}
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
