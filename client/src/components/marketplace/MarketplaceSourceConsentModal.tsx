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
  Text,
  TextField,
} from "react-aria-components";
import { AlertTriangle, Check, PlusCircle, ShieldAlert } from "lucide-react";
import { stampAriaModal } from "../../lib/aria-modal";

// Registration consent for a third-party marketplace source (CPHMTP-FR-002 /
// CPHMTP-NFR-003 / CPHMTP-NFR-008, #975). This dialog is the ONLY path to
// registering a source, and it is shared by the Marketplaces settings section
// (#976) and the project-open offer (#982), so it stays
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
//     it and <Dialog> strips the prop via filterDOMProps (#902).

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

// Only one of these dialogs is ever mounted at a time (it is modal), so a module
// constant is enough to tie the allow-http hint to its checkbox; no useId needed.
const ALLOW_HTTP_HINT_ID = "marketplace-source-consent-allow-http-hint";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-lg mx-4">
        <Dialog
          ref={stampAriaModal}
          data-testid="marketplace-source-consent-modal"
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          <div className="px-5 py-4 border-b border-border">
            <Heading slot="title" className="text-16 font-semibold text-text-primary">
              {STRINGS.title}
            </Heading>
            <p className="mt-1 text-12 text-text-secondary leading-relaxed">{STRINGS.intro}</p>
          </div>

          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <div
              data-testid="marketplace-source-consent-warning"
              className="flex items-start gap-2 rounded-lg border border-accent-border bg-accent-muted px-3 py-2 text-12 text-accent-text leading-relaxed"
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
              <Label className="block text-12 text-text-secondary mb-1.5">{STRINGS.urlLabel}</Label>
              <Input
                autoFocus={initialUrl.length === 0}
                className="w-full px-3 py-1.5 rounded-control border border-border-control bg-bg-field text-13 text-text-primary font-mono outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
              />
              <Text
                slot="description"
                className="mt-1 block text-11 text-text-secondary leading-relaxed"
              >
                {STRINGS.urlHint}
              </Text>
            </TextField>

            <TextField
              value={credential}
              onChange={setCredential}
              isDisabled={isPending}
              type="password"
              autoComplete="off"
              data-testid="marketplace-source-consent-credential"
            >
              <Label className="block text-12 text-text-secondary mb-1.5">
                {STRINGS.credentialLabel}
              </Label>
              {/* type="password" rides on the TextField above, so the value is
                  masked on screen and kept out of autofill history. */}
              <Input className="w-full px-3 py-1.5 rounded-control border border-border-control bg-bg-field text-13 text-text-primary font-mono outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger" />
              <Text
                slot="description"
                className="mt-1 block text-11 text-text-secondary leading-relaxed"
              >
                {STRINGS.credentialHint}
              </Text>
            </TextField>

            <div>
              <Checkbox
                isSelected={allowHttp}
                onChange={setAllowHttp}
                isDisabled={isPending}
                // The label alone says "allow plain http"; the consequence (anyone
                // on the network can read and tamper with it) lives in the hint, so
                // it is wired as a description rather than left as an adjacent
                // paragraph a screen reader would not announce on focus. The
                // TextFields above get this from <Text slot="description">, which a
                // bare Checkbox has no equivalent for (CPHMTP-NFR-008).
                aria-describedby={ALLOW_HTTP_HINT_ID}
                data-testid="marketplace-source-consent-allow-http"
                className="group flex items-start gap-2.5 text-13 text-text-body cursor-pointer outline-none"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-control border border-border-control bg-bg-field group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-focus-ring transition-colors">
                  <Check
                    size={12}
                    strokeWidth={3}
                    className="text-on-accent opacity-0 group-data-[selected]:opacity-100"
                  />
                </span>
                <span>{STRINGS.allowHttpLabel}</span>
              </Checkbox>
              <p
                id={ALLOW_HTTP_HINT_ID}
                className="mt-1 ml-6.5 text-11 text-text-secondary leading-relaxed"
              >
                {STRINGS.allowHttpHint}
              </p>
            </div>

            <Checkbox
              isSelected={acknowledged}
              onChange={setAcknowledged}
              isDisabled={isPending}
              data-testid="marketplace-source-consent-ack"
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

          {error && (
            <div className="px-5 pb-1">
              <div
                role="alert"
                data-testid="marketplace-source-consent-error"
                className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 text-danger-text flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
            {/* Cancel is the default when the URL arrives prefilled (the offer
                path): declining is the safe answer, so it holds focus rather than
                the gated Register control (CPHMTP-TC-024 S001-O02). When the user
                has to type the URL themselves, the URL field takes focus instead. */}
            <Button
              autoFocus={initialUrl.length > 0}
              onPress={handleCancel}
              isDisabled={isPending}
              data-testid="marketplace-source-consent-cancel"
              className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              onPress={handleConfirm}
              aria-disabled={!canConfirm}
              data-testid="marketplace-source-consent-confirm"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                canConfirm
                  ? "text-on-accent bg-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active"
                  : "text-text-secondary bg-bg-hover cursor-not-allowed"
              }`}
            >
              <PlusCircle size={14} />
              {isPending ? STRINGS.registering : STRINGS.confirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
