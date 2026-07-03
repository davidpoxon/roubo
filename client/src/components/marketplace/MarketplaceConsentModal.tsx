import { useState } from "react";
import { Button, Checkbox, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { AlertTriangle, Check, Download, RefreshCw, ShieldAlert } from "lucide-react";
import { declaredCategories, type InstallPreview, type PermissionCategory } from "@roubo/shared";
import MarketplaceInstallProgress from "./MarketplaceInstallProgress";
import { deriveStageStatuses, describeArtifact } from "./marketplace-install-stages";
import { CATEGORY_META } from "./permission-categories";

// Install/update consent for a marketplace catalog entry (CP-FR-020, issue
// #621). It shows every permission category the STAGED manifest declares (the
// staged preview is authoritative, not the catalog summary) and gates the
// confirm control behind an acknowledgement. The confirm control uses
// aria-disabled (not native disabled) plus a guarded no-op onPress so it stays
// keyboard-operable while gated (NFR-007). On confirm it hands the acknowledged
// categories to the container, which mints/refreshes the plugin's ConsentRecord
// after the commit succeeds (issue #399).

const STRINGS = {
  installTitle: (name: string) => `Install ${name}?`,
  updateTitle: (name: string) => `Update ${name}?`,
  intro: "This plugin requests the access listed below. Review it before continuing.",
  trust:
    "Verified, first-party, but unsandboxed in this release. Enforced isolation arrives later; until then, review the access below.",
  noDeclared: "This plugin declares no special permissions.",
  acknowledge:
    "I understand this plugin runs with my privileges and acknowledge the access listed above.",
  errorFallback: "Couldn't complete the install.",
  progressHeading: "Install & verify",
  cancel: "Cancel",
  installing: "Installing…",
  updating: "Updating…",
  confirmInstall: "Install plugin",
  confirmUpdate: "Update plugin",
};

interface Props {
  preview: InstallPreview;
  mode: "install" | "update";
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
  // Receives the categories the consumer acknowledged (every declared category),
  // so the container can mint/refresh the plugin's ConsentRecord after the
  // install/update commits (issue #399, CP-TC-090 / CP-TC-096).
  onConfirm: (acknowledgedCategories: PermissionCategory[]) => void;
}

export default function MarketplaceConsentModal({
  preview,
  mode,
  error,
  isPending,
  onCancel,
  onConfirm,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { manifest } = preview;
  const declared = manifest.permissions;
  const categories = declaredCategories(declared);
  const canConfirm = acknowledged && !isPending;
  const ConfirmIcon = mode === "update" ? RefreshCw : Download;

  // While the confirm mutation is pending, the button reflects the in-flight
  // commit (the 4-step widget shows stage 4 active), replacing the bare
  // "Working…" label (issue #374).
  function resolveConfirmLabel(): string {
    if (isPending) return mode === "update" ? STRINGS.updating : STRINGS.installing;
    return mode === "update" ? STRINGS.confirmUpdate : STRINGS.confirmInstall;
  }
  const confirmLabel = resolveConfirmLabel();

  // The modal is the permission gate between stage 3 (done after staging) and
  // stage 4 (committed on confirm), so stages 1-3 are always done here: stage 4
  // advances to active while the confirm mutation is pending and lands on failed
  // (fail-closed) if the confirm errors. The success end state is the toast, by
  // which point this modal has already closed (issue #374).
  const stageStatuses = deriveStageStatuses({
    stagingPending: false,
    stagingSettled: true,
    confirmPending: isPending,
    confirmSettled: false,
    failedPhase: error ? "confirm" : undefined,
  });

  function handleCancel() {
    if (isPending) return;
    onCancel();
  }

  function handleConfirm() {
    if (!canConfirm) return;
    // Hand the container the acknowledged categories (all declared ones) so it
    // can POST /consent after the commit succeeds (issue #399).
    onConfirm(categories);
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) handleCancel();
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog
          data-testid="marketplace-consent-modal"
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {mode === "update"
                ? STRINGS.updateTitle(manifest.name)
                : STRINGS.installTitle(manifest.name)}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              <span className="font-mono">{manifest.id}</span> · {manifest.kind} plugin · v
              {manifest.version}
            </p>
          </div>

          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <div
              data-testid="marketplace-consent-trust"
              className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              <ShieldAlert size={14} className="shrink-0 mt-0.5" />
              <span>
                <span className="font-semibold">Verified, first-party.</span> {STRINGS.trust}
              </span>
            </div>

            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
                {STRINGS.progressHeading}
              </p>
              <MarketplaceInstallProgress
                statuses={stageStatuses}
                pluginId={manifest.id}
                artifactLabel={describeArtifact(preview.source, manifest)}
              />
            </div>

            {categories.length === 0 ? (
              <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.noDeclared}</p>
            ) : (
              <ul data-testid="marketplace-consent-list" className="space-y-2">
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
              data-testid="marketplace-consent-ack"
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

          {error && (
            <div className="px-5 pb-1">
              <div
                role="alert"
                data-testid="marketplace-consent-error"
                className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            <Button
              onPress={handleCancel}
              isDisabled={isPending}
              data-testid="marketplace-consent-cancel"
              className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              autoFocus
              onPress={handleConfirm}
              aria-disabled={!canConfirm}
              data-testid="marketplace-consent-confirm"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                canConfirm
                  ? "text-stone-950 bg-amber-500 hover:bg-amber-400"
                  : "text-stone-500 dark:text-stone-400 bg-stone-200 dark:bg-stone-800 cursor-not-allowed"
              }`}
            >
              <ConfirmIcon size={13} />
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
