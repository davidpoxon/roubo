import { useState } from "react";
import { Button, Checkbox, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
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
}

export default function ConsentReviewDialog({
  pluginId,
  pluginName,
  declared,
  provenance,
  version,
  onClose,
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
      { onSuccess: () => onClose() },
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog
          data-testid="consent-review-dialog"
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {STRINGS.title(pluginName)}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              <span className="font-mono">{pluginId}</span> · component plugin
              {version ? ` · v${version}` : ""}
            </p>
          </div>

          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <p className="text-[13px] text-stone-600 dark:text-stone-400">{STRINGS.intro}</p>

            <div
              data-testid="consent-review-trust"
              data-treatment={isVerified ? "verified" : "unverified"}
              className="space-y-2 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
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
                className="text-xs text-stone-500 dark:text-stone-400"
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
              className="group flex items-start gap-2.5 text-[13px] text-stone-700 dark:text-stone-200 cursor-pointer outline-none"
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 group-data-[selected]:border-amber-500 group-data-[selected]:bg-amber-500 group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-amber-500 transition-colors">
                <Check
                  size={11}
                  strokeWidth={3}
                  className="text-stone-950 opacity-0 group-data-[selected]:opacity-100"
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
                className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
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

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            <Button
              onPress={handleClose}
              isDisabled={isPending}
              data-testid="consent-review-cancel"
              className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              autoFocus
              onPress={handleConfirm}
              aria-disabled={!canConfirm}
              data-testid="consent-review-confirm"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                canConfirm
                  ? "text-stone-950 bg-amber-500 hover:bg-amber-400"
                  : "text-stone-500 dark:text-stone-400 bg-stone-200 dark:bg-stone-800 cursor-not-allowed"
              }`}
            >
              <ShieldCheck size={13} />
              {isPending ? STRINGS.granting : STRINGS.confirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
