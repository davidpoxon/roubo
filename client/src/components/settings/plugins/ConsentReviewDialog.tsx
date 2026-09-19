import { useState } from "react";
import { Button, Checkbox, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { stampAriaModal } from "../../../lib/aria-modal";
import { AlertTriangle, Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { declaredCategories, type PluginPermissions } from "@roubo/shared";
import { useGrantConsent } from "../../../hooks/usePlugins";
import { CATEGORY_META } from "../../marketplace/permission-categories";
import ProvenanceBadge from "../../marketplace/ProvenanceBadge";
import { trustTreatmentOf, type PluginProvenance } from "../../marketplace/plugin-provenance";

// Consent affordance for an already-installed component plugin (issue #490).
// Bundled component plugins (process / database) ship installed but never pass
// through the marketplace install flow, so they have no ConsentRecord and no
// reachable way to mint one: every bench start then fails with `not-consented`.
// This focused dialog shows the plugin's declared permission categories (via the
// shared CATEGORY_META / declaredCategories) behind an acknowledge gate and, on
// confirm, POSTs /consent through useGrantConsent to mint the record. It is
// deliberately NOT MarketplaceConsentModal: that modal is coupled to the install
// flow (staging token, 4-step install-progress widget, "Install/Update" labels),
// all of which would mislead here since the plugin is already installed.
//
// The trust banner is provenance-driven (CPHMTP-FR-006, issue #563): this dialog
// is one of the enumerated plugin surfaces, so a third-party plugin must wear its
// non-dismissible Unverified badge and its source provenance here too, and the
// lead copy must not assert first-party verification the record does not carry
// (CPHMTP-NFR-001, CPHMTP-TC-056 S002).

const STRINGS = {
  title: (name: string) => `Review permissions for ${name}`,
  intro:
    "This installed plugin declares the access listed below. Acknowledge it so benches can use this plugin.",
  verifiedLead: "Verified, first-party.",
  verifiedTrust:
    "Verified, first-party, but unsandboxed in this release. Enforced isolation arrives later; until then, review the access below.",
  unverifiedLead: "Unverified, third-party.",
  unverifiedTrust:
    "This plugin came from a source you registered, not from Roubo. It is unsigned, so Roubo cannot vouch for its contents, and it is unsandboxed in this release: it runs with your privileges. Review the access below.",
  noDeclared: "This plugin declares no special permissions.",
  acknowledge:
    "I understand this plugin runs with my privileges and acknowledge the access listed above.",
  cancel: "Cancel",
  confirm: "Grant consent",
  granting: "Granting…",
};

interface Props {
  pluginId: string;
  pluginName: string;
  declared: PluginPermissions;
  /** The installed record's provenance, via `recordProvenance` at the call site. */
  provenance: PluginProvenance;
  version?: string;
  onClose: () => void;
  /**
   * Fired after consent is successfully recorded, before `onClose`. The bench-page
   * consent fallback (issue #617, AC3) uses it to resume the component start the
   * consent gate blocked; the Settings caller omits it and just closes.
   */
  onGranted?: () => void;
}

export default function ConsentReviewDialog({
  pluginId,
  pluginName,
  declared,
  provenance,
  version,
  onClose,
  onGranted,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const isVerified = trustTreatmentOf(provenance) === "verified";
  const grantConsent = useGrantConsent();
  const categories = declaredCategories(declared);
  const isPending = grantConsent.isPending;
  const canConfirm = acknowledged && !isPending;

  function handleClose() {
    if (isPending) return;
    onClose();
  }

  function handleConfirm() {
    if (!canConfirm) return;
    // The consent gate only requires that every DECLARED category is
    // acknowledged (isFullyAcknowledged), so hand it exactly the declared set.
    // For a plugin that declares nothing (the process plugin), that is [], and
    // the grant is a valid no-permission acknowledgement. On success the hook
    // invalidates the consent query, so the card's "Review permissions"
    // affordance clears without a manual refetch.
    grantConsent.mutate(
      { pluginId, acknowledgedCategories: categories },
      {
        onSuccess: () => {
          onGranted?.();
          onClose();
        },
      },
    );
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-lg mx-4">
        <Dialog
          ref={stampAriaModal}
          data-testid="consent-review-dialog"
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          <div className="px-5 py-4 border-b border-border">
            <Heading slot="title" className="text-16 font-semibold text-text-primary">
              {STRINGS.title(pluginName)}
            </Heading>
            <p className="mt-1 text-12 text-text-secondary">
              <span className="font-mono">{pluginId}</span> · component plugin
              {version ? ` · v${version}` : ""}
            </p>
          </div>

          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <p className="text-13 text-text-secondary">{STRINGS.intro}</p>

            <div
              data-testid="consent-review-trust"
              data-treatment={isVerified ? "verified" : "unverified"}
              className="space-y-2 rounded-lg border border-accent-border bg-accent-muted px-3 py-2 text-12 text-accent-text"
            >
              <div className="flex items-start gap-2">
                <ShieldAlert size={14} className="shrink-0 mt-0.5" />
                <span>
                  <span className="font-semibold">
                    {isVerified ? STRINGS.verifiedLead : STRINGS.unverifiedLead}
                  </span>{" "}
                  {isVerified ? STRINGS.verifiedTrust : STRINGS.unverifiedTrust}
                </span>
              </div>
              <ProvenanceBadge provenance={provenance} />
            </div>

            {categories.length === 0 ? (
              <p
                data-testid="consent-review-no-permissions"
                className="text-12 text-text-secondary"
              >
                {STRINGS.noDeclared}
              </p>
            ) : (
              <ul data-testid="consent-review-list" className="space-y-2">
                {categories.map((category) => {
                  const meta = CATEGORY_META[category];
                  const Icon = meta.icon;
                  return (
                    <li
                      key={category}
                      data-category={category}
                      className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2"
                    >
                      <Icon size={14} aria-hidden className="shrink-0 mt-0.5 text-text-secondary" />
                      <div className="min-w-0">
                        <p className="text-13 font-medium text-text-primary">{meta.label}</p>
                        <p className="text-12 text-text-secondary break-words">
                          {meta.describe(declared)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <Checkbox
              isSelected={acknowledged}
              onChange={setAcknowledged}
              isDisabled={isPending}
              data-testid="consent-review-ack"
              className="group flex items-start gap-2.5 text-13 text-text-body cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-control border border-border-control bg-bg-field group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-focus-ring transition-colors">
                <Check
                  size={12}
                  strokeWidth={3}
                  className="text-on-accent opacity-0 group-data-[selected]:opacity-100"
                />
              </span>
              <span>{STRINGS.acknowledge}</span>
            </Checkbox>
          </div>

          {grantConsent.isError && (
            <div className="px-5 pb-1">
              <div
                role="alert"
                data-testid="consent-review-error"
                className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 text-danger-text flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  {grantConsent.error instanceof Error
                    ? grantConsent.error.message
                    : "Couldn't record consent."}
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
            <Button
              onPress={handleClose}
              isDisabled={isPending}
              data-testid="consent-review-cancel"
              className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              autoFocus
              onPress={handleConfirm}
              aria-disabled={!canConfirm}
              data-testid="consent-review-confirm"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                canConfirm
                  ? "text-on-accent bg-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active"
                  : "text-text-secondary bg-bg-hover cursor-not-allowed"
              }`}
            >
              <ShieldCheck size={14} />
              {isPending ? STRINGS.granting : STRINGS.confirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
