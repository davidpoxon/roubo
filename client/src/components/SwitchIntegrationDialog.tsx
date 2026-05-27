import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
  Radio,
  RadioGroup,
} from "react-aria-components";
import { AlertTriangle } from "lucide-react";
import type { InstalledPluginSummary } from "@roubo/shared";
import { useInstalledPlugins } from "../hooks/useInstalledPlugins";
import { useSwitchProjectIntegration } from "../hooks/useProjectIntegration";
import { ApiError } from "../lib/api";

const STRINGS = {
  titleChoose: "Choose integration",
  titleSwitch: "Switch integration",
  loadingPlugins: "Loading plugins…",
  noPlugins: "No integration plugins are installed. Install a plugin from the Plugins page first.",
  installedAriaLabel: "Installed integrations",
  staleBenchesWarning:
    'Active benches will keep working against their stored issue snapshot. They will show an "Issue from previous integration" badge and their source-sync controls will be disabled. New benches will use the new integration.',
  switchFailedFallback: "Switch failed",
  cancel: "Cancel",
  switching: "Switching…",
};

const PLUGIN_STATUS_LABELS: Record<InstalledPluginSummary["status"], string> = {
  enabled: "enabled",
  disabled: "disabled",
  errored: "errored",
  incompatible: "incompatible",
  invalid: "invalid",
};

interface Props {
  projectId: string;
  currentPluginId: string | null;
}

function isUsable(p: InstalledPluginSummary): boolean {
  return p.status !== "errored" && p.status !== "incompatible" && p.status !== "invalid";
}

export default function SwitchIntegrationDialog({ projectId, currentPluginId }: Props) {
  // Hoist switchMutation so the ModalOverlay can gate dismissal: Escape /
  // overlay-click mid-switch would otherwise unmount the dialog while the
  // PUT to /integration/override continues silently, swapping the active
  // integration after the user thought they cancelled.
  const switchMutation = useSwitchProjectIntegration(projectId);
  const isSwitching = switchMutation.isPending;

  return (
    <ModalOverlay
      isDismissable={!isSwitching}
      isKeyboardDismissDisabled={isSwitching}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-md mx-4 max-h-[calc(100vh-2rem)] flex">
        <Dialog className="flex flex-col w-full max-h-full overflow-y-auto bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <SwitchFlow
              currentPluginId={currentPluginId}
              close={close}
              switchMutation={switchMutation}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SwitchFlow({
  currentPluginId,
  close,
  switchMutation,
}: {
  currentPluginId: string | null;
  close: () => void;
  switchMutation: ReturnType<typeof useSwitchProjectIntegration>;
}) {
  const { data: plugins, isLoading } = useInstalledPlugins(true);

  const [selected, setSelected] = useState<string | null>(currentPluginId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const usable = useMemo(() => (plugins ?? []).filter(isUsable), [plugins]);
  const isChoosing = currentPluginId === null;
  const canConfirm = !switchMutation.isPending && selected !== null && selected !== currentPluginId;

  const handleConfirm = async () => {
    if (!canConfirm || !selected) return;
    try {
      await switchMutation.mutateAsync(selected);
      close();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : STRINGS.switchFailedFallback,
      );
    }
  };

  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          {isChoosing ? STRINGS.titleChoose : STRINGS.titleSwitch}
        </Heading>
      </div>

      <div className="px-5 py-4 space-y-4">
        {isLoading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{STRINGS.loadingPlugins}</p>
        ) : (plugins ?? []).length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{STRINGS.noPlugins}</p>
        ) : (
          <RadioGroup
            aria-label={STRINGS.installedAriaLabel}
            value={selected ?? ""}
            onChange={(v) => setSelected(v)}
            className="flex flex-col gap-2"
          >
            {(plugins ?? []).map((p) => {
              const disabled = !isUsable(p);
              return (
                <Radio
                  key={p.id}
                  value={p.id}
                  isDisabled={disabled}
                  className="outline-none data-[disabled]:opacity-50"
                >
                  {({ isSelected, isFocusVisible }) => (
                    <div
                      className={[
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all duration-150 cursor-pointer select-none",
                        isSelected
                          ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/80"
                          : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 hover:border-stone-300 dark:hover:border-stone-700",
                        isFocusVisible
                          ? "ring-2 ring-amber-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                          : "",
                        disabled ? "cursor-not-allowed" : "",
                      ].join(" ")}
                    >
                      <div
                        className={[
                          "w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-all duration-150",
                          isSelected
                            ? "border-stone-700 dark:border-stone-300 bg-stone-700 dark:bg-stone-300"
                            : "border-stone-300 dark:border-stone-600",
                        ].join(" ")}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-stone-900 dark:text-stone-100">
                          {p.name}
                        </div>
                        <div className="text-[11px] font-mono text-stone-400 dark:text-stone-600 truncate">
                          {p.id}
                        </div>
                      </div>
                      {p.status !== "enabled" && (
                        <span
                          className={[
                            "text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded",
                            p.status === "errored" || p.status === "incompatible"
                              ? "bg-red-500/15 text-red-400"
                              : "bg-stone-200 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
                          ].join(" ")}
                        >
                          {PLUGIN_STATUS_LABELS[p.status]}
                        </span>
                      )}
                    </div>
                  )}
                </Radio>
              );
            })}
          </RadioGroup>
        )}

        {!isChoosing && (
          <div className="flex items-start gap-2.5 p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[12px] leading-relaxed text-stone-700 dark:text-stone-300">
              {STRINGS.staleBenchesWarning}
            </p>
          </div>
        )}

        {errorMessage && (
          <p role="alert" className="text-[12px] text-red-400">
            {errorMessage}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          isDisabled={switchMutation.isPending}
          onPress={close}
          className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {STRINGS.cancel}
        </Button>
        <Button
          isDisabled={!canConfirm || usable.length === 0}
          onPress={handleConfirm}
          data-testid="switch-integration-confirm"
          className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
        >
          {switchMutation.isPending
            ? STRINGS.switching
            : isChoosing
              ? STRINGS.titleChoose
              : STRINGS.titleSwitch}
        </Button>
      </div>
    </>
  );
}
