import { useState } from "react";
import { GitBranch, Play, Square, Trash2, X, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router";
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
import Button from "./ui/Button";
import IconButton from "./ui/IconButton";
import Dialog, { DIALOG_ACTIONS_CLASS } from "./ui/Dialog";
import StatusIndicator from "./ui/StatusIndicator";
import type { StatusTone } from "./ui/styles";
import { focusRingOffset } from "./ui/focus-ring";

// DESIGN.md Bench card: the border is the bench status. Clearing is work in
// progress, so it shares `status-preparing` with preparing.
const STATUS_TONE: Record<Bench["status"], StatusTone> = {
  active: "active",
  preparing: "preparing",
  error: "error",
  clearing: "preparing",
  idle: "idle",
};

const BORDER_CLASSES: Record<StatusTone, string> = {
  active: "border-status-active",
  preparing: "border-status-preparing",
  error: "border-status-error",
  idle: "border-status-idle",
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
  const statusTone: StatusTone = bench.error ? "error" : (STATUS_TONE[bench.status] ?? "idle");

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
        className={`cursor-pointer group h-[260px] rounded-card ${focusRingOffset}`}
        role="link"
        tabIndex={0}
        onClick={() => navigate(`/projects/${bench.projectId}/benches/${bench.id}`)}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(`/projects/${bench.projectId}/benches/${bench.id}`);
        }}
      >
        <div
          data-testid="bench-card-frame"
          className={`border ${BORDER_CLASSES[statusTone]} bg-bg-surface group-hover:bg-bg-hover rounded-card transition-colors h-full`}
        >
          <div className="p-4 flex flex-col h-full">
            {/* Header */}
            <div className="space-y-0.5 shrink-0">
              {projectName && (
                <p className="text-11 font-medium uppercase tracking-label text-text-secondary">
                  {projectName}
                </p>
              )}
              <div className="flex items-center gap-2">
                <p className="text-14 font-semibold text-text-primary">Bench {bench.id}</p>
                <NotificationIndicator notifications={bench.notifications} />
                <StatusIndicator
                  tone={statusTone}
                  label={bench.status}
                  pulse={bench.status === "preparing" || bench.status === "clearing"}
                  className="ml-auto"
                  data-testid="bench-card-status"
                />
              </div>
            </div>

            {/* Branch */}
            <div className="flex items-center gap-1.5 text-12 text-text-secondary mt-2.5 shrink-0">
              <GitBranch size={12} className="shrink-0 text-text-secondary" />
              <span className="truncate">{bench.branch}</span>
            </div>

            {/* Assigned issue */}
            {bench.assignedIssue && (
              <div className="flex items-center gap-1.5 text-12 text-text-secondary mt-2.5 shrink-0">
                <span className="font-mono text-accent-text shrink-0">
                  {displayIssueRef(bench.assignedIssue)}
                </span>
                <span className="truncate">{bench.assignedIssue.title}</span>
              </div>
            )}

            {isFromPreviousIntegration && (
              <div className="mt-1.5 shrink-0">
                <span
                  data-testid="previous-integration-badge"
                  className="inline-flex items-center px-1.5 py-0.5 rounded-chip text-11 font-medium bg-accent-muted text-accent-text"
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
                        className={`text-11 ${stepTextColor[step.status]} transition-colors duration-200`}
                      >
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              ) : bench.error ? (
                <p className="text-11 text-danger-text line-clamp-2">{bench.error}</p>
              ) : (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {componentEntries.map(([name, component]) => (
                    <span key={name} className="flex items-center gap-1.5">
                      <ComponentStatusDot status={component.status} label={name} />
                      <span className="text-11 text-text-secondary">{name}</span>
                      {matchedPorts.has(name) && (
                        <span className="text-11 font-mono text-text-secondary">
                          :{matchedPorts.get(name)}
                        </span>
                      )}
                    </span>
                  ))}
                  {orphanPorts.map(([name, port]) => (
                    <span key={name} className="flex items-center gap-1.5">
                      <span className="text-11 text-text-secondary">{name}</span>
                      <span className="text-11 font-mono text-text-secondary">:{port}</span>
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
                  className="w-full outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <RotateCcw
                    size={12}
                    className={cleanupAndRetry.isPending ? "animate-spin" : ""}
                  />
                  {cleanupAndRetry.isPending ? "Cleaning up..." : "Cleanup & Retry"}
                </Button>
              </div>
            )}

            {isPrimaryStartCTA && (
              <p className="text-11 text-text-secondary mt-2 shrink-0 truncate">
                Idle · click Start to run components
              </p>
            )}

            {/* Actions */}
            <div
              className="flex items-center gap-0.5 pt-2 mt-auto border-t border-border shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <IconButton
                isDisabled={isBusy}
                tone={isPrimaryStartCTA ? "primary" : "default"}
                label={isRunning ? "Stop all components" : "Start all components on this bench"}
                onPress={() => {
                  if (isRunning)
                    stopBench.mutate({ projectId: bench.projectId, benchId: bench.id });
                  else startBench.mutate({ projectId: bench.projectId, benchId: bench.id });
                }}
              >
                {isRunning ? <Square size={14} /> : <Play size={14} />}
              </IconButton>
              <ToolButtons projectId={bench.projectId} benchId={bench.id} compact />
              <IconButton
                isDisabled={!canTeardown}
                tone="danger"
                label={isProvisioning ? "Cancel preparing" : "Clear bench"}
                onPress={() => setConfirmOpen(true)}
              >
                {isProvisioning ? <X size={14} /> : <Trash2 size={14} />}
              </IconButton>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        isDismissable
        widthClassName="max-w-sm"
        title={isProvisioning ? "Cancel preparing" : "Clear bench"}
      >
        {({ close }) => (
          <>
            <p className="text-13 text-text-body">
              {isProvisioning
                ? "This will cancel preparing and clean up any resources created so far. This action cannot be undone."
                : "This will stop all components, remove Docker volumes (including any database data), remove the workspace, and delete the branch. This action cannot be undone."}
            </p>
            <div className={DIALOG_ACTIONS_CLASS}>
              <Button onPress={close}>Cancel</Button>
              <Button
                variant="danger"
                onPress={() => {
                  teardown.mutate(
                    { projectId: bench.projectId, benchId: bench.id },
                    {
                      onSuccess: () => registerTeardown(bench.projectId, bench.id, bench.branch),
                      onError: (err) => {
                        if (isDirtyBenchError(err)) setDirtyReasons(err.details.reasons);
                      },
                    },
                  );
                  close();
                }}
              >
                {isProvisioning ? "Cancel preparing" : "Clear bench"}
              </Button>
            </div>
          </>
        )}
      </Dialog>

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
