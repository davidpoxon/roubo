import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Button,
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Checkbox,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  TooltipTrigger,
  Tooltip,
} from "react-aria-components";
import {
  Play,
  Square,
  Trash2,
  X,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Container,
  Unlink,
  RotateCcw,
  Ban,
} from "lucide-react";
import {
  useBenchDetail,
  useStartBench,
  useStopBench,
  useTeardownBench,
  useCleanupAndRetryBench,
  useStartComponent,
  useStopComponent,
  useDismissBenchNotifications,
} from "../hooks/useBenches";
import type { Bench, ProvisioningStep, DirtyReason, CapturedUserId } from "@roubo/shared";
import { COMPONENT_STEP_PREFIX } from "@roubo/shared";
import { useProjects } from "../hooks/useProjects";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useTeardownTracker } from "../hooks/useClearingTracker";
import { useElapsed } from "../hooks/useElapsed";
import { useUnassignContainer } from "../hooks/useContainers";
import ComponentStatusDot from "./ComponentStatusDot";
import ToolButtons from "./ToolButtons";
import LogStream from "./LogStream";
import TerminalTabs from "./TerminalTabs";
import InspectionRunner from "./InspectionRunner";
import AssignContainerModal from "./AssignContainerModal";
import { stepIcon, stepTextColor, phaseIcon, phaseTextColor } from "../lib/provisioning";
import Spinner from "./Spinner";
import NotificationIndicator from "./NotificationIndicator";
import { useBenchViewState, type BenchTabId } from "../hooks/useBenchViewState";
import { isDirtyBenchError } from "../lib/api";
import ClearBenchDirtyDialog from "./ClearBenchDirtyDialog";
import { useToast } from "../hooks/useToast";
import { useBenchIssue } from "../hooks/useBenchIssue";
import IssueTransitionDropdown from "./IssueTransitionDropdown";
import IssueAssignControl from "./IssueAssignControl";
import { securityCategoryFor, shortIssueRef } from "../lib/chip-mapping";
import { displayIssueRef } from "../lib/issue-id";
import TestBenchPanel from "./testbench/TestBenchPanel";

const ALERT_BENCH_DISABLED_TRANSITION_COPY =
  "Resolved by pushing code that fixes the underlying alert. GitHub auto-closes the alert.";
const ALERT_BENCH_DISABLED_ASSIGN_TOOLTIP =
  "Security alerts cannot be assigned from Roubo. They are repo-level findings, not user-assigned work.";

function ComponentStatusText({ status, startedAt }: { status: string; startedAt?: string }) {
  const elapsed = useElapsed(status === "starting" ? startedAt : undefined);
  if (status === "starting" && elapsed) {
    return (
      <span className="text-[11px] text-stone-500 dark:text-stone-600">
        {status} <span className="text-stone-500 dark:text-stone-700 font-mono">{elapsed}</span>
      </span>
    );
  }
  return <span className="text-[11px] text-stone-500 dark:text-stone-600">{status}</span>;
}

function ComponentePhaseDetail({ detail, startedAt }: { detail: string; startedAt?: string }) {
  const elapsed = useElapsed(startedAt);
  return (
    <div className="flex items-center gap-2 px-4 pb-2 mt-1">
      <span className="flex items-center gap-3">
        <span className="w-1 h-1 rounded-full bg-amber-500/50" />
        <span className="text-[11px] text-amber-500/70">{detail}</span>
        {elapsed && (
          <span className="text-[11px] text-stone-500 dark:text-stone-700 font-mono">
            {elapsed}
          </span>
        )}
      </span>
    </div>
  );
}

function StepList({ steps, bench }: { steps: ProvisioningStep[]; bench?: Bench }) {
  return (
    <div className="mb-4">
      <div className="space-y-1">
        {steps.map((step) => {
          const componentMatch =
            bench && step.id.startsWith(COMPONENT_STEP_PREFIX)
              ? step.id.slice(COMPONENT_STEP_PREFIX.length)
              : null;
          const componentStatus = componentMatch && bench ? bench.components[componentMatch] : null;
          const phases = componentStatus?.phases ?? step.phases;
          const hasPhases = phases && phases.length > 0;
          const showPhases =
            hasPhases &&
            (step.status === "running" || step.status === "done" || step.status === "error");

          return (
            <div key={step.id}>
              <div className="flex items-center gap-3 px-4 py-2 rounded-lg">
                <span className="flex items-center justify-center w-4 shrink-0">
                  {stepIcon[step.status]}
                </span>
                <span
                  className={`text-sm ${stepTextColor[step.status]} transition-colors duration-200`}
                >
                  {step.label}
                </span>
                {step.status === "error" && step.error && (
                  <span className="text-xs text-red-400/70 truncate ml-2">{step.error}</span>
                )}
              </div>
              {showPhases && phases && (
                <div className="pl-11 space-y-0.5 pb-1">
                  {phases.map((phase) => (
                    <div key={phase.label} className="flex items-center gap-2.5">
                      <span className="flex items-center justify-center w-3 shrink-0">
                        {phaseIcon[phase.status]}
                      </span>
                      <span
                        className={`text-[11px] ${phaseTextColor[phase.status]} transition-colors duration-200`}
                      >
                        {phase.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const tabClassName = ({ isSelected }: { isSelected: boolean }) =>
  `px-3 py-2 text-xs font-medium transition-colors outline-none cursor-default border-b-2 -mb-px ${
    isSelected
      ? "text-stone-800 dark:text-stone-200 border-amber-500"
      : "text-stone-500 dark:text-stone-600 border-transparent hover:text-stone-700 dark:hover:text-stone-400"
  }`;

const statusBadge: Record<string, string> = {
  running: "bg-green-500/15 text-green-400",
  provisioning: "bg-amber-500/15 text-amber-400",
  error: "bg-red-500/15 text-red-400",
  stopping: "bg-amber-500/15 text-amber-400",
  inactive: "bg-stone-500/15 text-stone-400",
};

function ComponentsTab({
  bench,
  projectId,
  benchId,
  isBusy,
  showSteps,
  hasDatabaseComponent,
  databaseComponentName,
}: {
  bench: Bench;
  projectId: string;
  benchId: number;
  isBusy: boolean;
  showSteps: boolean;
  hasDatabaseComponent: boolean;
  databaseComponentName: string | null;
}) {
  const startComponent = useStartComponent();
  const stopComponent = useStopComponent();
  const unassign = useUnassignContainer();
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());
  const [assignModal, setAssignModal] = useState<string | null>(null);

  const toggleLogs = (component: string) => {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(component)) next.delete(component);
      else next.add(component);
      return next;
    });
  };

  return (
    <>
      {showSteps && <StepList steps={bench.provisioningSteps} bench={bench} />}

      <div className="space-y-1">
        {Object.entries(bench.components).map(([name, component]) => {
          const isRunning = component.status === "running";
          const isBusyComponent =
            component.status === "starting" || component.status === "stopping" || isBusy;
          const logsOpen = openLogs.has(name);
          const isDbComponent = name === databaseComponentName;
          const assigned = bench.assignedContainers?.[name];

          return (
            <div key={name}>
              <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-stone-100 dark:bg-stone-900/50 hover:bg-stone-200/50 dark:hover:bg-stone-900/80 transition-colors">
                <div className="flex items-center gap-3">
                  <ComponentStatusDot status={component.status} />
                  <span className="text-sm font-medium text-stone-800 dark:text-stone-200">
                    {name}
                  </span>
                  <ComponentStatusText status={component.status} startedAt={component.startedAt} />
                  {assigned && (
                    <span className="flex items-center gap-1 text-[10px] text-stone-400 dark:text-stone-600">
                      <Container size={10} />
                      <span className="font-mono">{assigned.containerName}</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {isDbComponent &&
                    hasDatabaseComponent &&
                    (assigned ? (
                      <Button
                        onPress={() => unassign.mutate({ projectId, benchId, component: name })}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700/50 transition-colors outline-none"
                      >
                        <Unlink size={11} />
                        Unassign
                      </Button>
                    ) : (
                      <Button
                        onPress={() => setAssignModal(name)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700/50 transition-colors outline-none"
                      >
                        <Container size={11} />
                        Assign
                      </Button>
                    ))}
                  <Button
                    isDisabled={isBusyComponent}
                    onPress={() => {
                      if (isRunning) stopComponent.mutate({ projectId, benchId, component: name });
                      else startComponent.mutate({ projectId, benchId, component: name });
                    }}
                    className="px-2.5 py-1 rounded-md text-xs text-stone-500 not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 not-disabled:hover:bg-stone-200 dark:not-disabled:hover:bg-stone-700/50 disabled:opacity-30 transition-colors outline-none"
                  >
                    {isRunning ? "Stop" : "Start"}
                  </Button>
                  <Button
                    onPress={() => toggleLogs(name)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700/50 transition-colors outline-none"
                  >
                    {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Logs
                  </Button>
                </div>
              </div>
              {!showSteps && component.status === "starting" && component.statusDetail && (
                <ComponentePhaseDetail
                  detail={component.statusDetail}
                  startedAt={component.statusDetailStartedAt}
                />
              )}
              {logsOpen && (
                <div className="mt-1 mb-2">
                  <LogStream projectId={projectId} benchId={benchId} component={name} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {assignModal && (
        <AssignContainerModal
          projectId={projectId}
          benchId={benchId}
          component={assignModal}
          isOpen={!!assignModal}
          onOpenChange={(open) => {
            if (!open) setAssignModal(null);
          }}
        />
      )}
    </>
  );
}

function InfoTab({ bench }: { bench: Bench }) {
  const [copiedPath, setCopiedPath] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyWorkspace = () => {
    if (!bench.workspacePath) return;
    navigator.clipboard.writeText(bench.workspacePath);
    setCopiedPath(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedPath(false), 2000);
  };

  return (
    <div className="rounded-lg bg-stone-100 dark:bg-stone-900/50 divide-y divide-stone-200 dark:divide-stone-800/40">
      <div className="px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-1.5">
          Ports
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {Object.entries(bench.ports).map(([name, port]) => (
            <span key={name} className="text-sm">
              <span className="text-stone-500">{name}</span>
              <span className="text-stone-800 dark:text-stone-200 font-mono ml-1.5">{port}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-1.5">
          Workspace
        </p>
        <div className="flex items-center gap-2">
          <code className="text-sm text-stone-700 dark:text-stone-300 font-mono">
            {bench.workspacePath}
          </code>
          <Button
            onPress={copyWorkspace}
            className="text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors outline-none"
          >
            <Copy size={12} />
          </Button>
          {copiedPath && <span className="text-[10px] text-green-500">Copied</span>}
        </div>
      </div>
      <div className="px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-1.5">
          Created
        </p>
        <p className="text-sm text-stone-700 dark:text-stone-300">
          {new Date(bench.createdAt).toLocaleString()}
        </p>
      </div>
      {bench.assignedContainers && Object.keys(bench.assignedContainers).length > 0 && (
        <div className="px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-1.5">
            Assigned Containers
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {Object.entries(bench.assignedContainers).map(([componentName, assigned]) => (
              <span key={componentName} className="text-sm">
                <span className="text-stone-500">{componentName}</span>
                <span className="text-stone-800 dark:text-stone-200 font-mono ml-1.5">
                  {assigned.containerName}
                </span>
                <span className="text-stone-400 dark:text-stone-600 font-mono ml-1">
                  :{assigned.port}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AssignedIssueTransition({
  projectId,
  externalId,
  capturedUserId,
}: {
  projectId: string;
  externalId: string;
  capturedUserId: CapturedUserId | undefined;
}) {
  const { data: issue } = useBenchIssue(projectId, externalId);
  if (!issue) return null;
  const isAlertBacked = securityCategoryFor(issue.issueType) !== null;
  return (
    <>
      {isAlertBacked ? (
        <p
          data-testid="alert-bench-transition-explanation"
          className="text-[11px] text-stone-500 dark:text-stone-600"
        >
          {ALERT_BENCH_DISABLED_TRANSITION_COPY}
        </p>
      ) : (
        <IssueTransitionDropdown
          projectId={projectId}
          externalId={externalId}
          currentState={issue.currentState}
          allowedTransitions={issue.allowedTransitions}
        />
      )}
      <IssueAssignControl
        projectId={projectId}
        externalId={externalId}
        assignees={issue.assignees}
        capturedUserId={capturedUserId}
        isDisabled={isAlertBacked}
        disabledTooltip={isAlertBacked ? ALERT_BENCH_DISABLED_ASSIGN_TOOLTIP : undefined}
      />
    </>
  );
}

export default function BenchDetail() {
  const { projectId = "", benchId: benchIdStr = "" } = useParams<{
    projectId: string;
    benchId: string;
  }>();
  const benchId = parseInt(benchIdStr, 10);
  const navigate = useNavigate();

  const { data: bench, isLoading, isError } = useBenchDetail(projectId, benchId);
  const { data: projects } = useProjects();
  const { data: integration } = useProjectIntegration(projectId);
  const activeIntegrationId = integration?.plugin?.id ?? null;
  const benchIntegrationId = bench?.assignedIssue?.integrationId ?? null;
  const isFromPreviousIntegration =
    activeIntegrationId !== null &&
    benchIntegrationId !== null &&
    benchIntegrationId !== activeIntegrationId;
  const startBench = useStartBench();
  const stopBench = useStopBench();
  const teardown = useTeardownBench();
  const cleanupAndRetry = useCleanupAndRetryBench();
  const { register: registerTeardown } = useTeardownTracker();
  const { addToast } = useToast();
  const { mutate: dismissBenchNotifications } = useDismissBenchNotifications();

  const [showTeardown, setShowTeardown] = useState(false);
  const [removeWorkspace, setRemoveWorkspace] = useState(true);
  const [dirtyReasons, setDirtyReasons] = useState<DirtyReason[] | null>(null);
  const [forceError, setForceError] = useState<string | null>(null);
  const [expandedErrorKey, setExpandedErrorKey] = useState<string | null>(null);
  const wasTearingDownRef = useRef(false);

  const project = projects?.find((a) => a.id === projectId);
  const isRunning = bench?.status === "active";
  const isBusy = bench?.status === "preparing" || bench?.status === "clearing";
  const isProvisioning = bench?.status === "preparing";
  const canTeardown = bench?.status !== "clearing";
  const isTearingDown = bench?.status === "clearing" && (bench?.teardownSteps?.length ?? 0) > 0;
  const showSteps =
    (bench?.provisioningSteps.length ?? 0) > 0 &&
    (bench?.status === "preparing" || bench?.status === "error");

  // Auto-dismiss bench-level notifications on bench open; session-scoped terminal notifications
  // persist until the user opens the specific terminal (sub-tab click or PTY input).
  useEffect(() => {
    dismissBenchNotifications({ projectId, benchId });
  }, [projectId, benchId, dismissBenchNotifications]);

  // Track when bench enters teardown state and auto-navigate when deleted
  useEffect(() => {
    if (isTearingDown) wasTearingDownRef.current = true;
  }, [isTearingDown]);

  useEffect(() => {
    if (wasTearingDownRef.current && (isError || !bench)) {
      navigate(projectId ? `/projects/${projectId}` : "/");
    }
  }, [isError, bench, navigate, projectId]);

  const errorExpanded = bench?.error != null && expandedErrorKey === bench.error;
  const isLongError = !!bench?.error && (bench.error.length > 200 || bench.error.includes("\n"));

  // Detect if this project has a database component
  const databaseComponentName = project?.config
    ? (Object.entries(project.config.components).find(
        ([, componentConfig]) => componentConfig.type === "database",
      )?.[0] ?? null)
    : null;
  const hasDatabaseComponent = !!databaseComponentName;
  const hasInsepection = !!project?.config?.inspection;

  const isTestbench = bench?.variant === "testbench";

  const { activeTab, setActiveTab, headerCollapsed, setHeaderCollapsed } = useBenchViewState(
    projectId,
    benchId,
  );
  // A TestBench (#418) surfaces a dedicated "testbench" tab as the first tab so a
  // freshly created TestBench opens on it. The review surface itself ships in #419
  // via TestBenchPanel.
  const availableTabIds: BenchTabId[] = [
    ...(isTestbench ? (["testbench"] as BenchTabId[]) : []),
    "components",
    "terminal",
    ...(hasInsepection ? (["inspection"] as BenchTabId[]) : []),
    "info",
  ];
  const defaultTab: BenchTabId = availableTabIds[0];
  const selectedTab: BenchTabId =
    activeTab && availableTabIds.includes(activeTab) ? activeTab : defaultTab;

  if (isLoading) {
    return (
      <div className="p-8 flex-1">
        <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600">
          <Spinner />
          Loading bench...
        </div>
      </div>
    );
  }

  if (!bench) {
    return (
      <div className="p-8 flex-1">
        <p className="text-sm text-stone-500 dark:text-stone-600">Bench not found.</p>
        <Button
          onPress={() => navigate(projectId ? `/projects/${projectId}` : "/")}
          className="mt-3 text-sm text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none"
        >
          Go back
        </Button>
      </div>
    );
  }

  return (
    <div className="p-8 flex flex-col flex-1 min-h-0">
      <div className="flex items-start justify-between mb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Bench {bench.id}
            </h2>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium capitalize ${
                statusBadge[bench.status] ?? "bg-stone-500/15 text-stone-400"
              }`}
            >
              {bench.status}
            </span>
          </div>
          {!headerCollapsed && (
            <>
              <div className="flex items-center gap-1.5 text-sm text-stone-600 dark:text-stone-400">
                <GitBranch size={14} className="text-stone-400 dark:text-stone-600" />
                {bench.branch}
              </div>
              {bench.baseBranch && bench.baseCommit && (
                <p className="text-xs text-stone-500 dark:text-stone-600">
                  Branched from{" "}
                  <span className="font-mono text-stone-600 dark:text-stone-400">
                    {bench.baseBranch}
                  </span>
                  {" @ "}
                  <span className="font-mono text-stone-600 dark:text-stone-400">
                    {bench.baseCommit}
                  </span>
                </p>
              )}
              {project && (
                <p className="text-xs text-stone-400 dark:text-stone-600">
                  {project.config?.project?.displayName}
                </p>
              )}
              {bench.assignedIssue && (
                <div className="flex items-center gap-1.5 text-xs text-stone-500">
                  <span className="font-mono text-violet-400">
                    {displayIssueRef(bench.assignedIssue)}
                  </span>
                  <span>{bench.assignedIssue.title}</span>
                  <AssignedIssueTransition
                    projectId={projectId}
                    externalId={bench.assignedIssue.externalId}
                    capturedUserId={integration?.effective.capturedUserId}
                  />
                  {isFromPreviousIntegration && (
                    <span
                      data-testid="previous-integration-badge"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-500 dark:text-amber-400"
                    >
                      Issue from previous integration
                    </span>
                  )}
                  {bench.assignedIssue.blockedBy && bench.assignedIssue.blockedBy.length > 0 && (
                    <TooltipTrigger delay={300}>
                      <Button className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-red-500/15 text-red-400 outline-none cursor-default">
                        <Ban size={10} />
                        Blocked
                      </Button>
                      <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-stone-400 mb-0.5">Blocked by:</span>
                          {bench.assignedIssue.blockedBy.map((ref) => (
                            <span key={ref} className="font-mono text-violet-400">
                              {shortIssueRef(ref)}
                            </span>
                          ))}
                        </div>
                      </Tooltip>
                    </TooltipTrigger>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <TooltipTrigger delay={300}>
            <Button
              aria-label={headerCollapsed ? "Expand bench header" : "Collapse bench header"}
              aria-expanded={!headerCollapsed}
              onPress={() => setHeaderCollapsed(!headerCollapsed)}
              className="flex items-center justify-center p-1.5 rounded-lg text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {headerCollapsed ? (
                <ChevronRight size={14} aria-hidden="true" />
              ) : (
                <ChevronDown size={14} aria-hidden="true" />
              )}
            </Button>
            <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg">
              {headerCollapsed ? "Expand header" : "Collapse header"}
            </Tooltip>
          </TooltipTrigger>
          <ToolButtons projectId={projectId} benchId={benchId} />
          <Button
            isDisabled={isBusy}
            onPress={() => {
              if (isRunning) stopBench.mutate({ projectId, benchId });
              else startBench.mutate({ projectId, benchId });
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-500 rounded-lg not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 not-disabled:hover:bg-stone-200 dark:not-disabled:hover:bg-stone-800 disabled:opacity-40 transition-colors outline-none"
          >
            {isRunning ? <Square size={12} /> : <Play size={12} />}
            {isRunning ? "Stop All" : "Start All"}
          </Button>
          <Button
            isDisabled={!canTeardown}
            onPress={() => setShowTeardown(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-500 dark:text-stone-600 rounded-lg not-disabled:hover:text-red-400 not-disabled:hover:bg-red-500/10 disabled:opacity-40 transition-colors outline-none"
          >
            {isProvisioning ? <X size={12} /> : <Trash2 size={12} />}
            {isProvisioning ? "Cancel" : "Clear"}
          </Button>
        </div>
      </div>

      {!headerCollapsed && bench.error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <p
            id="bench-error-message"
            className={`text-sm text-red-400 break-words ${
              isLongError && !errorExpanded ? "line-clamp-3" : ""
            }`}
          >
            {bench.error}
          </p>
          {isLongError && (
            <Button
              aria-expanded={errorExpanded}
              aria-controls="bench-error-message"
              onPress={() => setExpandedErrorKey(errorExpanded ? null : (bench.error ?? null))}
              className="mt-2 text-xs font-medium text-red-300/80 hover:text-red-300 outline-none"
            >
              {errorExpanded ? "Show less" : "Show more"}
            </Button>
          )}
          <Button
            isDisabled={cleanupAndRetry.isPending}
            onPress={() =>
              cleanupAndRetry.mutate(
                { projectId, benchId },
                {
                  onError: (err) =>
                    addToast(err instanceof Error && err.message ? err.message : "Cleanup failed", {
                      duration: 8000,
                    }),
                },
              )
            }
            className="flex items-center gap-1.5 mt-3 px-3 py-1.5 text-xs font-medium text-red-300 bg-red-500/15 rounded-lg hover:bg-red-500/25 transition-colors outline-none disabled:opacity-40"
          >
            <RotateCcw size={12} className={cleanupAndRetry.isPending ? "animate-spin" : ""} />
            {cleanupAndRetry.isPending ? "Cleaning up..." : "Cleanup & Retry"}
          </Button>
        </div>
      )}

      {/* Collapsing the header hides only the detail metadata above the tabs (gated
          on `!headerCollapsed` further up); the Tabs always stay visible so the
          collapse reclaims just the header's vertical space, not the whole bench
          (#811). Keeping the Tabs mounted also preserves the Terminal panel's live
          WebSocket session, which uses shouldForceMount to survive tab switches and a
          collapse/expand cycle without a reconnect (#805). */}
      <div className="flex flex-col flex-1 min-h-0">
        <Tabs
          className="flex flex-col flex-1 min-h-0"
          selectedKey={selectedTab}
          onSelectionChange={(k) => {
            setActiveTab(k as BenchTabId);
          }}
        >
          <TabList className="flex gap-1 border-b border-stone-200 dark:border-stone-800/60 mb-6">
            {isTestbench && (
              <Tab id="testbench" className={tabClassName}>
                TestBench
              </Tab>
            )}
            <Tab id="components" className={tabClassName}>
              Components
            </Tab>
            <Tab id="terminal" className={tabClassName}>
              Terminal
              <NotificationIndicator
                notifications={bench.notifications.filter((n) => n.sourceSessionId)}
              />
            </Tab>
            {hasInsepection && (
              <Tab id="inspection" className={tabClassName}>
                Inspection
              </Tab>
            )}
            <Tab id="info" className={tabClassName}>
              Info
            </Tab>
          </TabList>

          {isTestbench && (
            <TabPanel id="testbench" className="outline-none flex flex-col flex-1 min-h-0">
              <TestBenchPanel
                projectId={projectId}
                benchId={benchId}
                focusedSpecPath={bench.focusedSpecPath}
                benchStatus={bench.status}
              />
            </TabPanel>
          )}

          <TabPanel id="components" className="outline-none overflow-auto flex-1">
            {isTearingDown && <StepList steps={bench.teardownSteps} />}
            <ComponentsTab
              bench={bench}
              projectId={projectId}
              benchId={benchId}
              isBusy={isBusy}
              showSteps={showSteps}
              hasDatabaseComponent={hasDatabaseComponent}
              databaseComponentName={databaseComponentName}
            />
          </TabPanel>

          <TabPanel
            id="terminal"
            className={({ isInert }) =>
              `outline-none flex flex-col flex-1 min-h-0 ${isInert ? "hidden" : ""}`
            }
            shouldForceMount
          >
            <TerminalTabs
              key={`${projectId}:${benchId}`}
              projectId={projectId}
              benchId={benchId}
              projectName={project?.config?.project?.displayName ?? projectId}
              hasAssignedIssue={!!bench.assignedIssue}
              notifications={bench.notifications}
            />
          </TabPanel>

          {hasInsepection && (
            <TabPanel id="inspection" className="outline-none overflow-auto flex-1">
              <InspectionRunner projectId={projectId} benchId={benchId} />
            </TabPanel>
          )}

          <TabPanel id="info" className="outline-none overflow-auto flex-1">
            <InfoTab bench={bench} />
          </TabPanel>
        </Tabs>
      </div>

      <ModalOverlay
        isOpen={showTeardown}
        onOpenChange={setShowTeardown}
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      >
        <Modal className="w-full max-w-sm mx-4">
          <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
            {({ close }) => (
              <>
                <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                  <Heading
                    slot="title"
                    className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                  >
                    {isProvisioning ? `Cancel Bench ${bench.id}` : `Clear Bench ${bench.id}`}
                  </Heading>
                </div>
                <div className="px-5 py-4 space-y-3">
                  <p className="text-sm text-stone-600 dark:text-stone-400">
                    {isProvisioning
                      ? "This will cancel preparing and clean up any resources created so far."
                      : "This will stop all components and remove Docker containers."}
                  </p>
                  {!isProvisioning && (
                    <Checkbox
                      isSelected={removeWorkspace}
                      onChange={setRemoveWorkspace}
                      className="flex items-center gap-2 cursor-pointer group"
                    >
                      {({ isSelected }) => (
                        <>
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                              isSelected
                                ? "bg-stone-600 border-stone-500"
                                : "bg-stone-200 dark:bg-stone-800 border-stone-400 dark:border-stone-600"
                            }`}
                          >
                            {isSelected && <Check size={10} className="text-stone-100" />}
                          </div>
                          <span className="text-sm text-stone-700 dark:text-stone-300">
                            Remove git worktree
                          </span>
                        </>
                      )}
                    </Checkbox>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                  <Button
                    onPress={close}
                    className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
                  >
                    Cancel
                  </Button>
                  <Button
                    isDisabled={teardown.isPending}
                    onPress={() => {
                      teardown.mutate(
                        {
                          projectId,
                          benchId,
                          removeWorkspace: isProvisioning ? true : removeWorkspace,
                        },
                        {
                          onSuccess: () => registerTeardown(projectId, benchId, bench.branch),
                          onError: (err) => {
                            if (isDirtyBenchError(err)) setDirtyReasons(err.details.reasons);
                          },
                        },
                      );
                      close();
                    }}
                    className="px-4 py-1.5 text-sm font-medium text-red-100 bg-red-600 not-disabled:hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors outline-none"
                  >
                    {isProvisioning ? "Cancel preparing" : "Clear"}
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
        benchId={benchId}
        reasons={dirtyReasons ?? []}
        isPending={teardown.isPending}
        forceError={forceError}
        onConfirmForce={() => {
          teardown.mutate(
            {
              projectId,
              benchId,
              removeWorkspace: isProvisioning ? true : removeWorkspace,
              force: true,
            },
            {
              onSuccess: () => {
                registerTeardown(projectId, benchId, bench.branch);
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
    </div>
  );
}
