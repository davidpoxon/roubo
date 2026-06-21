import { useState } from "react";
import { Button, Checkbox, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Globe,
  KeyRound,
  Network,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Container,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { declaredCategories, type PermissionCategory, type PluginPermissions } from "@roubo/shared";
import { ApiError } from "../lib/api";
import { useGrantConsent } from "../hooks/usePlugins";

// Issue #615 (CP-FR-011 / CP-FR-012 / CP-NFR-001 / CP-NFR-007). Permission
// consent dialog modelled on EnablePluginPromptModal. Shows every permission
// category the component plugin's manifest declares, in plain language, and
// blocks the confirm control until the consumer ticks the acknowledgement.
// A non-first-party plugin is labeled unsandboxed (enforcement arrives in v2).
//
// Per the project's React Aria convention (NFR-007), the confirm control uses
// aria-disabled (not the native `disabled` attribute) plus a guarded no-op
// onPress, so it stays focusable and keyboard operable while it is gated.

const STRINGS = {
  title: (pluginName: string) => `Review permissions for ${pluginName}`,
  intro: "This plugin requests the access listed below. Review it before continuing.",
  firstPartyTrust:
    "Verified, first-party, but unsandboxed in this release. Enforced isolation arrives in v2; until then, review the access below.",
  thirdPartyTrust:
    "Third-party and unsandboxed in this release. It runs with your privileges; enforced isolation arrives in v2. Review the access below carefully.",
  noDeclared: "This plugin declares no special permissions.",
  acknowledge:
    "I understand this plugin runs with my privileges and acknowledge the access listed.",
  errorFallback: "Couldn't record your consent.",
  cancel: "Cancel",
  saving: "Saving…",
  confirm: "Acknowledge and continue",
};

interface CategoryMeta {
  label: string;
  icon: LucideIcon;
  describe: (permissions: PluginPermissions) => string;
}

function joinList(items: readonly string[]): string {
  return items.join(", ");
}

const CATEGORY_META: Record<PermissionCategory, CategoryMeta> = {
  network: {
    label: "Network access",
    icon: Globe,
    describe: (p) =>
      p.network.hosts.length > 0
        ? `Reach external hosts: ${joinList(p.network.hosts)}.`
        : "Reach external hosts.",
  },
  credentials: {
    label: "Stored credentials",
    icon: KeyRound,
    describe: (p) =>
      p.credentials.slots.length > 0
        ? `Access stored credentials: ${joinList(p.credentials.slots.map((s) => s.slot))}.`
        : "Access your stored credentials.",
  },
  filesystem: {
    label: "Filesystem",
    icon: FolderOpen,
    describe: (p) =>
      p.filesystem.paths.length > 0
        ? `Read files at: ${joinList(p.filesystem.paths)}.`
        : "Read files in the workspace.",
  },
  processes: {
    label: "Run processes",
    icon: TerminalSquare,
    describe: (p) =>
      p.processes !== false && p.processes.executables.length > 0
        ? `Run executables: ${joinList(p.processes.executables)}.`
        : "Run processes on your machine.",
  },
  ports: {
    label: "Network ports",
    icon: Network,
    describe: (p) =>
      p.ports !== undefined && p.ports !== false && p.ports.names.length > 0
        ? `Allocate bench ports: ${joinList(p.ports.names)}.`
        : "Allocate bench ports.",
  },
  docker: {
    label: "Docker",
    icon: Container,
    describe: () => "Manage Docker containers via the host broker.",
  },
};

interface Props {
  pluginId: string;
  pluginName: string;
  declared: PluginPermissions;
  firstParty: boolean;
  onCancel: () => void;
  onConsented: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function PermissionConsentModal({
  pluginId,
  pluginName,
  declared,
  firstParty,
  onCancel,
  onConsented,
}: Props) {
  const grantMutation = useGrantConsent();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPending = grantMutation.isPending;
  const categories = declaredCategories(declared);
  const canConfirm = acknowledged && !isPending;

  function handleCancel() {
    if (isPending) return;
    onCancel();
  }

  function handleConfirm() {
    // Guarded no-op: the confirm control is aria-disabled (not natively
    // disabled) so it stays focusable, but presses are ignored until the
    // acknowledgement is ticked. See NFR-007.
    if (!canConfirm) return;
    setError(null);
    grantMutation.mutate(
      { pluginId, acknowledgedCategories: categories },
      {
        onSuccess: () => onConsented(),
        onError: (err) => setError(errorMessage(err, STRINGS.errorFallback)),
      },
    );
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
          data-testid="permission-consent-modal"
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {STRINGS.title(pluginName)}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{STRINGS.intro}</p>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div
              data-testid="permission-consent-trust"
              data-first-party={firstParty ? "true" : "false"}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                firstParty
                  ? "border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200"
                  : "border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 text-red-800 dark:text-red-200"
              }`}
            >
              {firstParty ? (
                <ShieldCheck size={14} className="shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert size={14} className="shrink-0 mt-0.5" />
              )}
              <span>
                <span className="font-semibold">Unsandboxed.</span>{" "}
                {firstParty ? STRINGS.firstPartyTrust : STRINGS.thirdPartyTrust}
              </span>
            </div>

            {categories.length === 0 ? (
              <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.noDeclared}</p>
            ) : (
              <ul data-testid="permission-consent-list" className="space-y-2">
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
              data-testid="permission-consent-ack"
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
                data-testid="permission-consent-error"
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
              data-testid="permission-consent-cancel"
              className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              autoFocus
              onPress={handleConfirm}
              aria-disabled={!canConfirm}
              data-testid="permission-consent-confirm"
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                canConfirm
                  ? "text-stone-950 bg-amber-500 hover:bg-amber-400"
                  : "text-stone-500 dark:text-stone-400 bg-stone-200 dark:bg-stone-800 cursor-not-allowed"
              }`}
            >
              <Check size={13} />
              {isPending ? STRINGS.saving : STRINGS.confirm}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
