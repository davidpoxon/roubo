import { useState } from "react";
import {
  Button,
  TooltipTrigger,
  Tooltip,
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
} from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { GitBranch, Play, Square, Trash2, X, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Bench, DirtyReason } from "@roubo/shared";
import ComponentStatusDot from "./ComponentStatusDot";
import NotificationIndicator from "./NotificationIndicator";
import ToolButtons from "./ToolButtons";
import {
  useStartBench,
  useStopBench,
  useTeardownBench,
  useCleanupAndRetryBench,
} from "../hooks/useBenches";
import { useTeardownTracker } from "../hooks/useClearingTracker";
import { displayIssueRef } from "../lib/issue-id";
import { stepIcon, stepTextColor } from "../lib/provisioning";
import { isDirtyBenchError } from "../lib/api";
import ClearBenchDirtyDialog from "./ClearBenchDirtyDialog";
import { useToast } from "../hooks/useToast";

const borderColor: Record<string, string> = {
  active: "border-l-green-500",
  preparing: "border-l-amber-500",
  error: "border-l-red-500",
  clearing: "border-l-amber-500",
  idle: "border-l-stone-200 dark:border-l-stone-800",
};

export default function BenchCard({
  bench,
  projectName,
  activeIntegrationId,
}: {
  bench: Bench;
  projectName?: string;
  activeIntegrationId?: string | null;
}) {
  const isFromPreviousIntegration =
    !!activeIntegrationId &&
    !!bench.assignedIssue?.integrationId &&
    bench.assignedIssue.integrationId !== activeIntegrationId;
  const navigate = useNavigate();
  const startBench = useStartBench();
  const stopBench = useStopBench();
  const teardown = useTeardownBench();
  const cleanupAndRetry = useCleanupAndRetryBench();
  const { register: registerTeardown } = useTeardownTracker();
  const { addToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dirtyReasons, setDirtyReasons] = useState<DirtyReason[] | null>(null);
  const [forceError, setForceError] = useState<string | null>(null);

  const isRunning = bench.status === "active";
  const isBusy = bench.status === "preparing" || bench.status === "clearing";
  const isProvisioning = bench.status === "preparing";
  const canTeardown = bench.status !== "clearing";
  const isPrimaryStartCTA =
    !isRunning &&
    bench.status === "idle" &&
    Object.values(bench.components).every((c) => !c.setupComplete);
  const showSteps =
    bench.provisioningSteps.length > 0 &&
    (bench.status === "preparing" || bench.status === "error");
  const showTeardownSteps = (bench.teardownSteps?.length ?? 0) > 0 && bench.status === "clearing";

  const componentEntries = Object.entries(bench.components);
  const matchedPorts = new Map<string, number>();
  const orphanPorts: [string, number][] = [];
  for (const [portName, portValue] of Object.entries(bench.ports)) {
    if (bench.components[portName]) {
      matchedPorts.set(portName, portValue);
    } else {
      orphanPorts.push([portName, portValue]);
    }
  }

  return (
    <>
      <div
        className="cursor-pointer group h-[260px]"
        role="link"
        tabIndex={0}
        onClick={() => navigate(`/projects/${bench.projectId}/benches/${bench.id}`)}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(`/projects/${bench.projectId}/benches/${bench.id}`);
        }}
      >
        <div
          className={`border-l-[3px] ${
            bench.error
              ? "border-l-red-500"
              : (borderColor[bench.status] ?? "border-l-stone-200 dark:border-l-stone-800")
          } bg-stone-100 dark:bg-stone-900/50 group-hover:bg-stone-200 dark:group-hover:bg-stone-800/70 rounded-xl transition-colors duration-150 h-full ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/30`}
        >
          <div className="p-4 flex flex-col h-full">
            {/* Header */}
            <div className="space-y-0.5 shrink-0">
              {projectName && (
                <p className="text-[10px] font-medium uppercase tracking-widest text-stone-400 dark:text-stone-600">
                  {projectName}
                </p>
              )}
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Bench {bench.id}
                </p>
                <NotificationIndicator notifications={bench.notifications} />
              </div>
            </div>

            {/* Branch */}
            <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400 mt-2.5 shrink-0">
              <GitBranch size={12} className="shrink-0 text-stone-400 dark:text-stone-600" />
              <span className="truncate">{bench.branch}</span>
            </div>

            {/* Assigned issue */}
            {bench.assignedIssue && (
              <div className="flex items-center gap-1.5 text-xs text-stone-500 mt-2.5 shrink-0">
                <span className="font-mono text-violet-400 shrink-0">
                  {displayIssueRef(bench.assignedIssue)}
                </span>
                <span className="truncate">{bench.assignedIssue.title}</span>
              </div>
            )}

            {isFromPreviousIntegration && (
              <div className="mt-1.5 shrink-0">
                <span
                  data-testid="previous-integration-badge"
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-500 dark:text-amber-400"
                >
                  Issue from previous integration
                </span>
              </div>
            )}

            {/* Provisioning steps or Components */}
            <div className="flex-1 min-h-0 overflow-y-auto mt-2.5">
              {showSteps || showTeardownSteps ? (
                <div className="space-y-1.5">
                  {(showSteps ? bench.provisioningSteps : bench.teardownSteps).map((step) => (
                    <div key={step.id} className="flex items-center gap-2">
                      <span className="flex items-center justify-center w-3 shrink-0">
                        {stepIcon[step.status]}
                      </span>
                      <span
                        className={`text-[11px] ${stepTextColor[step.status]} transition-colors duration-200`}
                      >
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              ) : bench.error ? (
                <p className="text-[11px] text-red-400/80 line-clamp-2">{bench.error}</p>
              ) : (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {componentEntries.map(([name, component]) => (
                    <span key={name} className="flex items-center gap-1.5">
                      <ComponentStatusDot status={component.status} label={name} />
                      <span className="text-[11px] text-stone-500 dark:text-stone-400">{name}</span>
                      {matchedPorts.has(name) && (
                        <span className="text-[11px] font-mono text-stone-400 dark:text-stone-600">
                          :{matchedPorts.get(name)}
                        </span>
                      )}
                    </span>
                  ))}
                  {orphanPorts.map(([name, port]) => (
                    <span key={name} className="flex items-center gap-1.5">
                      <span className="text-[11px] text-stone-500">{name}</span>
                      <span className="text-[11px] font-mono text-stone-400 dark:text-stone-600">
                        :{port}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {bench.error && (
              <div onClick={(e) => e.stopPropagation()} className="mt-2 shrink-0">
                <Button
                  isDisabled={cleanupAndRetry.isPending}
                  onPress={() =>
                    cleanupAndRetry.mutate(
                      { projectId: bench.projectId, benchId: bench.id },
                      {
                        onError: (err) =>
                          addToast(
                            err instanceof Error && err.message ? err.message : "Cleanup failed",
                            { duration: 8000 },
                          ),
                      },
                    )
                  }
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-red-300 bg-red-500/10 rounded-lg hover:bg-red-500/20 transition-colors outline-none disabled:opacity-40 w-full"
                >
                  <RotateCcw
                    size={11}
                    className={cleanupAndRetry.isPending ? "animate-spin" : ""}
                  />
                  {cleanupAndRetry.isPending ? "Cleaning up..." : "Cleanup & Retry"}
                </Button>
              </div>
            )}

            {isPrimaryStartCTA && (
              <p className="text-[11px] text-stone-500 dark:text-stone-400 mt-2 shrink-0 truncate">
                Idle · click Start to run components
              </p>
            )}

            {/* Actions */}
            <div
              className="flex items-center gap-0.5 pt-2 mt-auto border-t border-stone-200 dark:border-stone-800/60 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <TooltipTrigger delay={500}>
                <Button
                  isDisabled={isBusy}
                  onPress={() => {
                    if (isRunning)
                      stopBench.mutate({ projectId: bench.projectId, benchId: bench.id });
                    else startBench.mutate({ projectId: bench.projectId, benchId: bench.id });
                  }}
                  className={
                    isPrimaryStartCTA
                      ? "p-1.5 rounded-md bg-amber-500 text-stone-950 not-disabled:hover:bg-amber-400 not-disabled:active:bg-amber-600 disabled:opacity-30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
                      : "p-1.5 rounded-md text-stone-500 not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 not-disabled:hover:bg-stone-200 dark:not-disabled:hover:bg-stone-700/50 disabled:opacity-30 transition-colors outline-none"
                  }
                >
                  {isRunning ? <Square size={13} /> : <Play size={13} />}
                </Button>
                <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                  {isRunning ? "Stop all components" : "Start all components on this bench"}
                </Tooltip>
              </TooltipTrigger>
              <ToolButtons projectId={bench.projectId} benchId={bench.id} compact />
              <TooltipTrigger delay={500}>
                <Button
                  isDisabled={!canTeardown}
                  onPress={() => setConfirmOpen(true)}
                  className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 not-disabled:hover:text-red-400 not-disabled:hover:bg-stone-200 dark:not-disabled:hover:bg-stone-700/50 disabled:opacity-30 transition-colors outline-none"
                >
                  {isProvisioning ? <X size={13} /> : <Trash2 size={13} />}
                </Button>
                <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                  {isProvisioning ? "Cancel preparing" : "Clear bench"}
                </Tooltip>
              </TooltipTrigger>
            </div>
          </div>
        </div>
      </div>

      <ModalOverlay
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      >
        <Modal className="w-full max-w-sm mx-4">
          <Dialog
            ref={stampAriaModal}
            className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
          >
            {({ close }) => (
              <>
                <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                  <Heading
                    slot="title"
                    className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                  >
                    {isProvisioning ? "Cancel preparing" : "Clear bench"}
                  </Heading>
                </div>

                <div className="px-5 py-4">
                  <p className="text-sm text-stone-600 dark:text-stone-400">
                    {isProvisioning
                      ? "This will cancel preparing and clean up any resources created so far. This action cannot be undone."
                      : "This will stop all components, remove Docker volumes (including any database data), remove the workspace, and delete the branch. This action cannot be undone."}
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                  <Button
                    onPress={close}
                    className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
                  >
                    Cancel
                  </Button>
                  <Button
                    onPress={() => {
                      teardown.mutate(
                        { projectId: bench.projectId, benchId: bench.id },
                        {
                          onSuccess: () =>
                            registerTeardown(bench.projectId, bench.id, bench.branch),
                          onError: (err) => {
                            if (isDirtyBenchError(err)) setDirtyReasons(err.details.reasons);
                          },
                        },
                      );
                      close();
                    }}
                    className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-red-600 hover:bg-red-500 rounded-lg transition-colors outline-none"
                  >
                    {isProvisioning ? "Cancel preparing" : "Clear bench"}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ClearBenchDirtyDialog
        isOpen={dirtyReasons !== null}
        onClose={() => {
          setDirtyReasons(null);
          setForceError(null);
        }}
        benchId={bench.id}
        reasons={dirtyReasons ?? []}
        isPending={teardown.isPending}
        forceError={forceError}
        onConfirmForce={() => {
          teardown.mutate(
            { projectId: bench.projectId, benchId: bench.id, force: true },
            {
              onSuccess: () => {
                registerTeardown(bench.projectId, bench.id, bench.branch);
                setDirtyReasons(null);
              },
              onError: (err) => {
                if (isDirtyBenchError(err)) {
                  setDirtyReasons(err.details.reasons);
                  setForceError(null);
                } else {
                  setForceError("Clear failed. Please try again.");
                }
              },
            },
          );
        }}
      />
    </>
  );
}
