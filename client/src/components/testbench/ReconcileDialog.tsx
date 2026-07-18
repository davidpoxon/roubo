import { useState, type ReactNode } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import { Plus, RefreshCw, Archive, AlertTriangle } from "lucide-react";
import type { ReconcileClassification } from "@roubo/shared/testbench-domain";

// The reconcile dialog (FR-017, NFR-003). Renders the server-computed
// classification in three reviewer-facing sections, actionable ones first:
// Changed (cases whose body changed, results retained for re-review), Orphan
// (recorded results with no matching plan case), and a de-emphasized
// Not-yet-recorded section (plan cases with no recorded result, listed for
// reference and untouched by Apply). Orphans are clearly marked and retained,
// never silently deleted.
//
// Applying reconcile preserves surviving results and archives orphans (they stay
// on disk, excluded from the rollup). Purging orphans is a SEPARATE, explicitly
// confirmed step: a second confirmation the reviewer must opt into, and can
// cancel back out of without losing the orphaned results.
//
// No domain rules live here. The classification is computed server-side and
// passed in; this component only renders it and dispatches the two server calls.
const STRINGS = {
  title: "Reconcile results with the source plan",
  intro:
    "The source plan changed. Review what changed below, then apply to preserve recorded results and archive orphaned cases.",
  addedHeading: "Not yet recorded",
  addedHelp:
    "Plan cases with no recorded result yet, listed for reference. Apply does not touch them: it preserves recorded results and archives orphans, leaving unrecorded cases as they are.",
  changedHeading: "Changed",
  changedHelp: "Case body changed: recorded marks and notes are kept for re-review.",
  orphanHeading: "Orphaned",
  orphanHelp:
    "Recorded results with no matching plan case. Retained and excluded from the rollup, never deleted.",
  none: "None",
  cancel: "Cancel",
  apply: "Apply (keep orphans)",
  applying: "Applying…",
  purge: "Purge orphans…",
  purgeConfirmTitle: "Permanently delete orphaned results?",
  purgeConfirmBody: (n: number) =>
    n === 1
      ? "1 orphaned result will be permanently deleted. This cannot be undone."
      : `${n} orphaned results will be permanently deleted. This cannot be undone.`,
  purgeConfirmBack: "Back",
  purgeConfirmAction: "Delete orphans",
  purging: "Deleting…",
};

function CaseList({ ids }: { ids: string[] }) {
  if (ids.length === 0) {
    return <p className="text-[12px] text-stone-400 dark:text-stone-600">{STRINGS.none}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {ids.map((id) => (
        <li key={id} className="font-mono text-[12px] text-stone-700 dark:text-stone-300 break-all">
          {id}
        </li>
      ))}
    </ul>
  );
}

function Section({
  icon,
  heading,
  help,
  count,
  testId,
  children,
}: {
  icon: ReactNode;
  heading: string;
  help: string;
  count: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
          {heading}
        </span>
        <span
          className="font-mono text-[11px] text-stone-500 dark:text-stone-500"
          data-testid={`${testId}-count`}
        >
          {count}
        </span>
      </div>
      <p className="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">{help}</p>
      {children}
    </div>
  );
}

export default function ReconcileDialog({
  isOpen,
  onClose,
  classification,
  onApply,
  onPurge,
  isApplying = false,
  isPurging = false,
  error,
}: {
  isOpen: boolean;
  onClose: () => void;
  classification: ReconcileClassification;
  // Apply reconcile: keep orphans (archive, never delete).
  onApply: () => void;
  // Purge orphans: the separate destructive step, only reached after the second
  // explicit confirmation below.
  onPurge: () => void;
  isApplying?: boolean;
  isPurging?: boolean;
  error?: string | null;
}) {
  // The orphan-purge confirmation is a distinct, cancelable second step within the
  // dialog. It is never shown by default: the reviewer must opt into it, and
  // "Back" returns to the classification view with orphans still intact (NFR-003).
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const isBusy = isApplying || isPurging;
  const orphanCount = classification.removed.length;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setConfirmingPurge(false);
          onClose();
        }
      }}
      isDismissable={!isBusy}
      isKeyboardDismissDisabled={isBusy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col min-h-0 max-h-[inherit] overflow-hidden"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60 shrink-0">
                <Heading
                  slot="title"
                  className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  {STRINGS.title}
                </Heading>
              </div>

              {confirmingPurge ? (
                <PurgeConfirmation
                  orphanCount={orphanCount}
                  isPurging={isPurging}
                  error={error}
                  onBack={() => setConfirmingPurge(false)}
                  onConfirm={onPurge}
                />
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-5">
                    <p className="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">
                      {STRINGS.intro}
                    </p>

                    <Section
                      testId="reconcile-section-changed"
                      icon={<RefreshCw size={13} className="text-amber-500 shrink-0" aria-hidden />}
                      heading={STRINGS.changedHeading}
                      help={STRINGS.changedHelp}
                      count={classification.changed.length}
                    >
                      <CaseList ids={classification.changed} />
                    </Section>

                    <Section
                      testId="reconcile-section-orphan"
                      icon={<Archive size={13} className="text-stone-500 shrink-0" aria-hidden />}
                      heading={STRINGS.orphanHeading}
                      help={STRINGS.orphanHelp}
                      count={orphanCount}
                    >
                      <CaseList ids={classification.removed} />
                    </Section>

                    <Section
                      testId="reconcile-section-added"
                      icon={<Plus size={13} className="text-stone-400 shrink-0" aria-hidden />}
                      heading={STRINGS.addedHeading}
                      help={STRINGS.addedHelp}
                      count={classification.added.length}
                    >
                      <CaseList ids={classification.added} />
                    </Section>

                    {error && (
                      <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
                        {error}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 shrink-0">
                    {orphanCount > 0 ? (
                      <Button
                        isDisabled={isBusy}
                        onPress={() => setConfirmingPurge(true)}
                        data-testid="reconcile-purge-trigger"
                        className="px-2.5 py-1 text-[11px] font-medium rounded-md text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        {STRINGS.purge}
                      </Button>
                    ) : (
                      <span />
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        isDisabled={isBusy}
                        onPress={close}
                        data-testid="reconcile-cancel"
                        className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        {STRINGS.cancel}
                      </Button>
                      <Button
                        isDisabled={isBusy}
                        onPress={onApply}
                        data-testid="reconcile-apply"
                        className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 active:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
                      >
                        {isApplying ? STRINGS.applying : STRINGS.apply}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function PurgeConfirmation({
  orphanCount,
  isPurging,
  error,
  onBack,
  onConfirm,
}: {
  orphanCount: number;
  isPurging: boolean;
  error?: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <div
        className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-4"
        data-testid="reconcile-purge-confirm"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {STRINGS.purgeConfirmTitle}
            </p>
            <p className="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">
              {STRINGS.purgeConfirmBody(orphanCount)}
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 shrink-0">
        <Button
          isDisabled={isPurging}
          onPress={onBack}
          data-testid="reconcile-purge-back"
          className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {STRINGS.purgeConfirmBack}
        </Button>
        <Button
          isDisabled={isPurging}
          onPress={onConfirm}
          data-testid="reconcile-purge-confirm-action"
          className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
        >
          {isPurging ? STRINGS.purging : STRINGS.purgeConfirmAction}
        </Button>
      </div>
    </>
  );
}
