import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import {
  AlertTriangle,
  Check,
  Download,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { declaredCategories } from "@roubo/shared";
import type { MarketplaceListing, PluginLifecycle } from "@roubo/shared";
import { CATEGORY_META } from "./permission-categories";
import ProvenanceBadge from "./ProvenanceBadge";
import { isFirstPartySource, listingProvenance } from "./plugin-provenance";

// Detail drawer for one catalog entry (CP-FR-020, #688; CP-FR-021, issue
// #690). A right-side modal panel mirroring the prototype: identity, summary,
// metadata (integrity, provenance, sandbox status, kind, version, curation), and
// the same state-aware affordance as the card (Update / Installed / Install).
// The Provenance row shows the registry path; the Sandbox row flags that enforced
// isolation is not yet active.
//
// The Integrity row is provenance-dependent (CPHMTP-FR-006, #977). Only the
// first-party catalog carries a signature, so only a first-party entry can claim
// "signed by Roubo": a third-party source is unsigned, and its integrity floor is
// the per-artifact sha256 digest the installer recomputes and fails closed on
// (CPHMTP-NFR-004), which is what its row says instead. The claim keys off the
// SOURCE (`isFirstPartySource`), not the per-entry curation flag: catalog signing
// is a source property, so an uncurated first-party entry is still signed by Roubo
// even though its Curation row grades it Unverified (#979). The Curation row
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
  // The agent-CLI compatibility window (AP-FR-022, #1112), phrased exactly
  // as the card's line so the two surfaces agree word for word.
  agentCompatibility: "Agent CLI",
  agentCompatibilityUndeclared: "compatibility not declared",
  // The host-range mark (#1134), worded as the card's pill is so the two
  // surfaces agree. The row appears only when this host is out of range: a
  // compatible listing is the unremarkable case and gains no row.
  hostCompatibility: "Roubo",
  hostIncompatible: (range: string, host: string) => `requires ${range} · host is ${host}`,
  incompatibleAction: "Incompatible with this Roubo",
  permissionsHeading: "Declared permissions",
  noPermissions: "This plugin declares no special permissions.",
  install: "Install",
  update: "Update",
  installed: "Installed",
};

// Human-readable lifecycle rendering shown in the Lifecycle row (#883,
// CP-TC-097 / CP-TC-104). The one-shot copy names the run-to-completion shape;
// the long-running copy names the supervised start / stop / health / logs shape,
// so a one-shot plugin's drawer shows no long-running (start / stop / health /
// logs) description (CP-TC-097 S001-O02).
const LIFECYCLE_DESCRIPTION: Record<PluginLifecycle, string> = {
  "long-running": "long-running (start, stop, health, and logs)",
  "one-shot": "one-shot (start runs to completion, then completed)",
};

/**
 * The declared agent-CLI window as one line, or the undeclared fallback
 * (AP-TC-121). Mirrors the card's `AgentCompatibilityLine` phrasing; the drawer
 * renders it as a metadata row because that is how every other derived
 * pre-install fact (lifecycle, provenance, curation) reads here.
 */
function describeAgentCompatibility(
  compatibility: NonNullable<MarketplaceListing["agentCompatibility"]>,
): string {
  const bounds = [
    compatibility.minVersion && `floor ${compatibility.minVersion}`,
    compatibility.testedCeiling && `tested <= ${compatibility.testedCeiling}`,
  ].filter(Boolean);
  return bounds.length > 0 ? bounds.join(" · ") : STRINGS.agentCompatibilityUndeclared;
}

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
    <div className="flex items-center justify-between text-12">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-text-body">{children}</dd>
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
  // PRE-INSTALL provenance the server derived onto the listing (#883): the
  // declared permission categories (exactly those the manifest requests, via
  // `declaredCategories`) and the component lifecycle. Both are null when the
  // manifest is unavailable pre-install (a non-bundled, not-yet-installed entry),
  // in which case the corresponding section / row is omitted.
  const declaredPermissions = listing.declaredPermissions;
  const permissionCategories = declaredPermissions ? declaredCategories(declaredPermissions) : [];
  // #1134: the server-derived host-range verdict, non-null only when this
  // host is outside the range the plugin declared. Same suppression rule as the
  // card, so opening the drawer on a marked listing cannot offer an install the
  // card refused.
  const incompatibility = listing.hostCompatibility;

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-40 flex justify-end bg-scrim"
    >
      <Modal className="animate-rise-in h-full w-full max-w-md">
        <Dialog
          ref={stampAriaModal}
          data-testid="marketplace-drawer"
          className="h-full w-full overflow-y-auto border-l border-border bg-bg-surface outline-none"
        >
          <div className="sticky top-0 flex h-14 items-center justify-between border-b border-border bg-bg-surface px-5 backdrop-blur">
            <Heading slot="title" className="text-16 font-semibold text-text-primary">
              {STRINGS.title}
            </Heading>
            <Button
              data-testid="marketplace-drawer-close"
              onPress={onClose}
              aria-label={STRINGS.close}
              className="grid h-8 w-8 place-items-center rounded-control text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <X size={16} />
            </Button>
          </div>

          <div className="p-5">
            <div className="flex items-start gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-bg-hover text-text-body">
                <Package size={16} aria-hidden />
              </div>
              <div className="min-w-0">
                <h3 className="text-16 font-semibold text-text-primary">{listing.name}</h3>
                <p className="mt-0.5 font-mono text-11 text-text-secondary">
                  {listing.id} · v{listing.version}
                </p>
              </div>
            </div>

            <p className="mt-4 text-13 leading-relaxed text-text-secondary">{listing.summary}</p>

            <dl className="mt-5 space-y-2">
              <MetaRow label={STRINGS.integrity}>
                <span
                  data-testid="marketplace-drawer-integrity"
                  className={`inline-flex items-center gap-1 ${
                    isSigned ? "text-success-text" : "text-accent-text"
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
              {incompatibility !== null && (
                <MetaRow label={STRINGS.hostCompatibility}>
                  <span
                    data-testid="marketplace-drawer-incompatible"
                    data-declared-range={incompatibility.declaredRange}
                    className="inline-flex items-center gap-1 font-mono text-danger-text"
                  >
                    <ShieldAlert size={14} aria-hidden />{" "}
                    {STRINGS.hostIncompatible(
                      incompatibility.declaredRange,
                      incompatibility.hostVersion,
                    )}
                  </span>
                </MetaRow>
              )}
              {listing.kind === "agent" && (
                <MetaRow label={STRINGS.agentCompatibility}>
                  <span
                    data-testid="marketplace-drawer-agent-compatibility"
                    data-declared={listing.agentCompatibility !== null}
                    className={listing.agentCompatibility === null ? "italic" : "font-mono"}
                  >
                    {listing.agentCompatibility === null
                      ? STRINGS.agentCompatibilityUndeclared
                      : describeAgentCompatibility(listing.agentCompatibility)}
                  </span>
                </MetaRow>
              )}
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
                  className="inline-flex items-center gap-1 text-accent-text"
                >
                  <ShieldAlert size={14} aria-hidden /> {STRINGS.unsandboxed}
                </span>
              </MetaRow>
            </dl>

            {declaredPermissions !== null && (
              <div className="mt-6" data-testid="marketplace-drawer-permissions">
                <p className="text-11 font-medium uppercase tracking-label text-text-secondary">
                  {STRINGS.permissionsHeading}
                </p>
                {permissionCategories.length === 0 ? (
                  <p className="mt-2 text-12 text-text-secondary">{STRINGS.noPermissions}</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {permissionCategories.map((category) => {
                      const meta = CATEGORY_META[category];
                      const Icon = meta.icon;
                      return (
                        <li
                          key={category}
                          data-category={category}
                          className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2"
                        >
                          <Icon
                            size={14}
                            aria-hidden
                            className="shrink-0 mt-0.5 text-text-secondary"
                          />
                          <div className="min-w-0">
                            <p className="text-13 font-medium text-text-primary">{meta.label}</p>
                            <p className="text-12 text-text-secondary break-words">
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
              {showInstalled ? (
                <span
                  data-testid="marketplace-drawer-installed"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-success-border bg-success-surface px-3 py-2 text-13 font-medium text-success-text"
                >
                  <Check size={16} /> {STRINGS.installed}
                </span>
              ) : incompatibility !== null ? (
                <span
                  data-testid="marketplace-drawer-incompatible-action"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 font-medium text-danger-text"
                >
                  <AlertTriangle size={16} aria-hidden /> {STRINGS.incompatibleAction}
                </span>
              ) : listing.updateAvailable ? (
                <Button
                  data-testid="marketplace-drawer-update"
                  onPress={() => onUpdate(listing)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-control bg-accent px-3 py-2 text-13 font-medium text-on-accent transition-colors not-disabled:hover:bg-accent-hover outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base not-disabled:active:bg-accent-active"
                >
                  <RefreshCw size={16} /> {STRINGS.update}
                </Button>
              ) : (
                <Button
                  data-testid="marketplace-drawer-install"
                  onPress={() => onInstall(listing)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-control bg-accent px-3 py-2 text-13 font-medium text-on-accent transition-colors not-disabled:hover:bg-accent-hover outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base not-disabled:active:bg-accent-active"
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
