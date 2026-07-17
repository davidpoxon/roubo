import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import { AlertTriangle, Check, PlusCircle, ShieldAlert } from "lucide-react";

// Registration consent for a third-party marketplace source (CPHMTP-FR-002 /
// CPHMTP-NFR-003 / CPHMTP-NFR-008, issue #562). This dialog is the ONLY path to
// registering a source, and it is shared by the Marketplaces settings section
// (issue #561) and the project-open offer (issue #565), so it stays
// presentational: the container owns the mutation and hands it `onConfirm`.
//
// Consent-before-fetch (CPHMTP-NFR-003) falls out of that split. Nothing here
// touches the network: the candidate URL is only rendered, and the single write
// (POST /api/marketplace/sources, itself a pure write with no call to the
// candidate URL) happens in the container after onConfirm. Cancel, Escape, and a
// backdrop press all resolve to onCancel, which fires nothing at all.
//
// Two house conventions are load-bearing:
//   - the Register control uses aria-disabled plus a guarded no-op onPress, not
//     native disabled, so it stays keyboard reachable while gated (CPHMTP-NFR-008);
//   - aria-modal is stamped through a ref, because React Aria deliberately omits
//     it and <Dialog> strips the prop via filterDOMProps (issue #424).

const STRINGS = {
  title: "Register a third-party marketplace",
  intro:
    "Roubo has not reviewed this marketplace. Check the URL below before you trust it: nothing is requested from it until you register.",
  warningLead: "Not signed by Roubo.",
  warning:
    "Plugins from this marketplace run with your privileges and can execute arbitrary code on your machine. Anything you install from it is permanently marked Unverified.",
  urlLabel: "Marketplace URL",
  urlHint:
    "Shown exactly as it will be fetched. Roubo requests nothing from this URL until you register.",
  credentialLabel: "Credential (optional)",
  credentialHint:
    "For a marketplace that needs a token. Stored in your OS keyring and sent only to this marketplace.",
  allowHttpLabel: "Allow plain http (intranet)",
  allowHttpHint:
    "https is always allowed. Check this only for an intranet marketplace served over plain http, which anyone on the network can read and tamper with.",
  acknowledge:
    "I understand this marketplace is not signed by Roubo, that its plugins run with my privileges and can execute arbitrary code, and that plugins installed from it are permanently marked Unverified.",
  cancel: "Cancel",
  confirm: "Register marketplace",
  registering: "Registering…",
};

// Issue #424: React Aria Components intentionally omits `aria-modal` from the
// rendered dialog, and <Dialog> strips an `aria-modal` prop via filterDOMProps,
// so it has to be stamped on the element through a ref. ModalOverlay/Modal's
// ariaHideOutside already inerts the background; this makes the modality explicit
// to assistive technology too (CPHMTP-NFR-008, WCAG modal semantics). Copied from
// PluginConfigureDialog rather than shared: the extraction is issue #974.
function stampAriaModal(el: HTMLElement | null): void {
  el?.setAttribute("aria-modal", "true");
}

export interface MarketplaceSourceConsentInput {
  url: string;
  // Omitted when the field is left blank: the server treats an empty credential
  // as "none supplied" and leaves any stored one alone.
  credential?: string;
  allowHttp: boolean;
}

interface Props {
  /**
   * The candidate URL, shown raw. The settings-add path opens with "" and the
   * user types it; the project-open offer prefills the URL the project declared.
   * Either way the consumer sees the exact string that will be fetched before
   * consenting to it (CPHMTP-FR-002).
   */
  initialUrl?: string;
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (input: MarketplaceSourceConsentInput) => void;
}

export default function MarketplaceSourceConsentModal({
  initialUrl = "",
  error,
  isPending,
  onCancel,
  onConfirm,
}: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [credential, setCredential] = useState("");
  // Default off (Spike 551): plain http is never permitted silently.
  const [allowHttp, setAllowHttp] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const trimmedUrl = url.trim();
  const canConfirm = acknowledged && trimmedUrl.length > 0 && !isPending;

  function handleCancel() {
    if (isPending) return;
    onCancel();
  }

  function handleConfirm() {
    // Guarded no-op: the control is aria-disabled rather than natively disabled,
    // so a press can still land here while gated. Re-reading canConfirm is what
    // makes unticking the acknowledgement re-disable Register (CPHMTP-TC-020).
    if (!canConfirm) return;
    onConfirm({
      url: trimmedUrl,
      credential: credential.length > 0 ? credential : undefined,
      allowHttp,
    });
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
          data-testid="marketplace-source-consent-modal"
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {STRINGS.title}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
              {STRINGS.intro}
            </p>
          </div>

          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <div
              data-testid="marketplace-source-consent-warning"
              className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 leading-relaxed"
            >
              <ShieldAlert size={14} className="shrink-0 mt-0.5" />
              <span>
                <span className="font-semibold">{STRINGS.warningLead}</span> {STRINGS.warning}
              </span>
            </div>

            <TextField
              value={url}
              onChange={setUrl}
              isDisabled={isPending}
              type="url"
              autoComplete="off"
              data-testid="marketplace-source-consent-url"
            >
              <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                {STRINGS.urlLabel}
              </Label>
              <Input
                autoFocus={initialUrl.length === 0}
                className="w-full px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 text-sm text-stone-900 dark:text-stone-100 font-mono outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              />
              <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                {STRINGS.urlHint}
              </p>
            </TextField>

            <TextField
              value={credential}
              onChange={setCredential}
              isDisabled={isPending}
              type="password"
              autoComplete="off"
              data-testid="marketplace-source-consent-credential"
            >
              <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                {STRINGS.credentialLabel}
              </Label>
              {/* type="password" rides on the TextField above, so the value is
                  masked on screen and kept out of autofill history. */}
              <Input className="w-full px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 text-sm text-stone-900 dark:text-stone-100 font-mono outline-none focus-visible:ring-2 focus-visible:ring-amber-500" />
              <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                {STRINGS.credentialHint}
              </p>
            </TextField>

            <div>
              <Checkbox
                isSelected={allowHttp}
                onChange={setAllowHttp}
                isDisabled={isPending}
                data-testid="marketplace-source-consent-allow-http"
                className="group flex items-start gap-2.5 text-[13px] text-stone-700 dark:text-stone-200 cursor-pointer outline-none"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 group-data-[selected]:border-amber-500 group-data-[selected]:bg-amber-500 group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-amber-500 transition-colors">
                  <Check
                    size={11}
                    strokeWidth={3}
                    className="text-stone-950 opacity-0 group-data-[selected]:opacity-100"
                  />
                </span>
                <span>{STRINGS.allowHttpLabel}</span>
              </Checkbox>
              <p className="mt-1 ml-6.5 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                {STRINGS.allowHttpHint}
              </p>
            </div>

            <Checkbox
              isSelected={acknowledged}
              onChange={setAcknowledged}
              isDisabled={isPending}
              data-testid="marketplace-source-consent-ack"
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
                data-testid="marketplace-source-consent-error"
                className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            {/* Cancel is the default when the URL arrives prefilled (the offer
                path): declining is the safe answer, so it holds focus rather than
                the gated Register control (CPHMTP-TC-024 S001-O02). When the user
                has to type the URL themselves, the URL field takes focus instead. */}
            <Button
              autoFocus={initialUrl.length > 0}
              onPress={handleCancel}
              isDisabled={isPending}
              data-testid="marketplace-source-consent-cancel"
              className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              onPress={handleConfirm}
              aria-disabled={!canConfirm}
              data-testid="marketplace-source-consent-confirm"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                canConfirm
                  ? "text-stone-950 bg-amber-500 hover:bg-amber-400"
                  : "text-stone-500 dark:text-stone-400 bg-stone-200 dark:bg-stone-800 cursor-not-allowed"
              }`}
            >
              <PlusCircle size={13} />
              {isPending ? STRINGS.registering : STRINGS.confirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
