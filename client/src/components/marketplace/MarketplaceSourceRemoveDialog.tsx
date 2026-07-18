import type { ReactNode } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { AlertTriangle, Puzzle, Trash2, Unlink } from "lucide-react";

// Removal consequences dialog for a third-party marketplace source
// (CPHMTP-FR-009 / CPHMTP-US-006, issue #564). Removing a source is a cascade the
// operator should understand before confirming: the source's installed plugins
// keep running but are orphaned (no updates until the source is re-registered),
// while the registry entry, cached catalog, and stored credential are deleted.
//
// It follows the MarketplaceSourceConsentModal (issue #562) shape deliberately:
// presentational, with the container owning the mutation via onConfirm, so this
// component touches no network and no query cache. Cancel, Escape, and a backdrop
// press all resolve to onCancel, which mutates nothing (CPHMTP-TC-021). The
// destructive action never holds focus on open: Cancel does, so the safe answer
// is the default (CPHMTP-TC-012 S001-O02).
//
// aria-modal is stamped through a ref because React Aria deliberately omits it and
// <Dialog> strips the prop via filterDOMProps (issue #424); copied from the
// consent modal rather than shared, as that extraction is issue #974.

const STRINGS = {
  title: (name: string) => `Remove "${name}"?`,
  intro:
    "Removing this marketplace cleans up everything Roubo stored for it. Here is what happens:",
  urlLabel: "Marketplace URL",
  keepLead: "Installed plugins keep running.",
  keepBody:
    "Anything you installed from this marketplace stays installed and keeps running. Removing the marketplace does not uninstall or stop its plugins.",
  orphanLead: "They are marked orphaned, with no updates.",
  orphanBody:
    "Those plugins keep their Unverified badge and are offered no updates until you re-register this marketplace.",
  deleteLead: "The source's stored data is deleted.",
  deleteBody:
    "The registry entry, the cached catalog, and the stored credential for this marketplace are deleted.",
  cancel: "Cancel",
  confirm: "Remove marketplace",
  removing: "Removing…",
};

// Issue #424: React Aria Components intentionally omits `aria-modal` from the
// rendered dialog, and <Dialog> strips an `aria-modal` prop via filterDOMProps, so
// it has to be stamped on the element through a ref. ModalOverlay/Modal's
// ariaHideOutside already inerts the background; this makes the modality explicit
// to assistive technology too. Copied from MarketplaceSourceConsentModal rather
// than shared: the extraction is issue #974.
function stampAriaModal(el: HTMLElement | null): void {
  el?.setAttribute("aria-modal", "true");
}

interface Props {
  /** The source's display name (its URL host), shown in the title. */
  sourceName: string;
  /** The raw catalog URL, shown verbatim so the operator sees exactly what is being removed. */
  sourceUrl: string;
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function MarketplaceSourceRemoveDialog({
  sourceName,
  sourceUrl,
  error,
  isPending,
  onCancel,
  onConfirm,
}: Props) {
  function handleCancel() {
    if (isPending) return;
    onCancel();
  }

  function handleConfirm() {
    // Guard mirrors the consent modal: while a removal is in flight the control
    // stays out of action so a second press cannot fire a duplicate mutation.
    if (isPending) return;
    onConfirm();
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
          ref={stampAriaModal}
          data-testid="marketplace-source-remove-dialog"
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {STRINGS.title(sourceName)}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
              {STRINGS.intro}
            </p>
            <p
              data-testid="marketplace-source-remove-url"
              aria-label={STRINGS.urlLabel}
              className="mt-2 font-mono text-[11px] break-all text-stone-500 dark:text-stone-400"
            >
              {sourceUrl}
            </p>
          </div>

          <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
            <ConsequenceRow
              testId="marketplace-source-remove-keep"
              icon={
                <Puzzle size={14} className="shrink-0 mt-0.5 text-stone-500 dark:text-stone-400" />
              }
              tone="neutral"
              lead={STRINGS.keepLead}
              body={STRINGS.keepBody}
            />
            <ConsequenceRow
              testId="marketplace-source-remove-orphan"
              icon={<Unlink size={14} className="shrink-0 mt-0.5" />}
              tone="warn"
              lead={STRINGS.orphanLead}
              body={STRINGS.orphanBody}
            />
            <ConsequenceRow
              testId="marketplace-source-remove-delete"
              icon={<Trash2 size={14} className="shrink-0 mt-0.5" />}
              tone="danger"
              lead={STRINGS.deleteLead}
              body={STRINGS.deleteBody}
            />
          </div>

          {error && (
            <div className="px-5 pb-1">
              <div
                role="alert"
                data-testid="marketplace-source-remove-error"
                className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            {/* Cancel holds focus on open: declining is the safe answer, so the
                destructive control never opens focused (CPHMTP-TC-012 S001-O02). */}
            <Button
              autoFocus
              onPress={handleCancel}
              isDisabled={isPending}
              data-testid="marketplace-source-remove-cancel"
              className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              onPress={handleConfirm}
              isDisabled={isPending}
              data-testid="marketplace-source-remove-confirm"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-500 disabled:opacity-60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              <Trash2 size={13} />
              {isPending ? STRINGS.removing : STRINGS.confirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const TONE_CLASS = {
  neutral:
    "border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 text-stone-700 dark:text-stone-300",
  warn: "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200",
  danger:
    "border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300",
} as const;

function ConsequenceRow({
  testId,
  icon,
  tone,
  lead,
  body,
}: {
  testId: string;
  icon: ReactNode;
  tone: keyof typeof TONE_CLASS;
  lead: string;
  body: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${TONE_CLASS[tone]}`}
    >
      {icon}
      <span>
        <span className="font-semibold">{lead}</span> {body}
      </span>
    </div>
  );
}
