import type {
  Bench,
  BenchNotification,
  ProvisioningStepStatus,
  TerminalSession,
} from "@roubo/shared";

// The start-up of a Spec Bench's delivery, before the delivery session writes
// its record. The record lands only after the session's preflight and the
// operator's answer to the plan and the budget, which takes minutes, so the
// Delivery tab shows where the start-up is instead of a missing file. Each step
// is derived from what the bench already knows: its status, the session it
// launched, and the notifications that session raised.

export type DeliveryStartupPhase =
  /** The workspace is still provisioning, or the session is not started yet. */
  | "starting"
  /** The session runs its preflight. */
  | "planning"
  /** The session waits for the operator's answer in the Terminal. */
  | "awaiting-operator"
  /** The launch failed, so no session runs the delivery. */
  | "launch-failed"
  /**
   * The workspace is ready but no session has started for a while, with no
   * failure to name: the launch may have failed with its notification since
   * dismissed.
   */
  | "launch-stalled"
  /** The session ended before it wrote the record. */
  | "session-ended"
  /** The bench is in error or is being cleared. */
  | "bench-unavailable"
  /** An attached bench waits for the running delivery's record. */
  | "attach-waiting";

export interface DeliveryStartupStep {
  id: "workspace" | "session" | "planning" | "operator" | "record" | "attach";
  label: string;
  status: ProvisioningStepStatus;
  detail?: string;
}

export interface DeliveryStartup {
  phase: DeliveryStartupPhase;
  steps: DeliveryStartupStep[];
}

export const OPERATOR_STEP_DETAIL =
  "The session asks you to confirm the plan and the budget before it writes the record.";

type StartupBench = Pick<
  Bench,
  "status" | "deliveryBindMode" | "deliverySessionId" | "notifications"
>;

// The failure of the latest create-time launch. A failure older than the
// session the bench now records belongs to an earlier launch, so it no longer
// counts.
function launchFailureOf(
  bench: StartupBench,
  session: TerminalSession | undefined,
): BenchNotification | undefined {
  const failures = bench.notifications.filter(
    (n) => n.type === "agent-launch-failed" && n.sourceSessionId === undefined,
  );
  const latest = failures.reduce<BenchNotification | undefined>(
    (acc, n) => (acc === undefined || n.createdAt > acc.createdAt ? n : acc),
    undefined,
  );
  if (latest === undefined) return undefined;
  if (bench.deliverySessionId === undefined) return latest;
  if (session !== undefined && latest.createdAt > session.createdAt) return latest;
  return undefined;
}

function launchFailureText(failure: BenchNotification): string {
  const message = failure.metadata?.message;
  if (typeof message === "string" && message !== "") return message;
  return failure.launchFailure?.message ?? "The delivery session did not start.";
}

function endedText(session: TerminalSession): string {
  const signal = session.unexpectedExit?.signal;
  if (signal) return `The session ended on ${signal} before it wrote the delivery record.`;
  const code = session.unexpectedExit?.exitCode ?? session.exitCode;
  return code === undefined
    ? "The session ended before it wrote the delivery record."
    : `The session ended with exit code ${code} before it wrote the delivery record.`;
}

function goneText(): string {
  return "The session is no longer running, and it did not write the delivery record.";
}

function workspaceStep(bench: StartupBench): DeliveryStartupStep {
  const label = "Workspace ready";
  if (bench.status === "preparing") return { id: "workspace", label, status: "running" };
  if (bench.status === "error")
    return { id: "workspace", label, status: "error", detail: "The bench is in error." };
  if (bench.status === "clearing")
    return { id: "workspace", label, status: "cancelled", detail: "The bench is being cleared." };
  return { id: "workspace", label, status: "done" };
}

export interface DeliveryStartupOptions {
  /**
   * The bench's terminal sessions were read. A recorded session that the list
   * does not name was closed and is gone, so it ended without the record.
   */
  sessionListed?: boolean;
  /**
   * The session step has waited longer than a launch takes, so the operator is
   * offered the launch again.
   */
  launchStalled?: boolean;
}

/**
 * Where the start-up of the bench's delivery is. `session` is the bench's
 * delivery session from its terminal sessions, when the list names it.
 */
export function deliveryStartup(
  bench: StartupBench,
  session: TerminalSession | undefined,
  { sessionListed = false, launchStalled = false }: DeliveryStartupOptions = {},
): DeliveryStartup {
  const workspace = workspaceStep(bench);
  const unavailable = bench.status === "error" || bench.status === "clearing";

  if (bench.deliveryBindMode === "attach") {
    return {
      phase: unavailable ? "bench-unavailable" : "attach-waiting",
      steps: [
        workspace,
        {
          id: "attach",
          label: "Waiting for the running delivery to write its record",
          status: workspace.status === "done" ? "running" : "pending",
        },
      ],
    };
  }

  // While the bench prepares (on create, or Cleanup & Retry) it launches its
  // session itself once the workspace is ready, so an earlier launch's failure
  // or ended session no longer counts.
  const preparing = bench.status === "preparing";
  const failure = preparing ? undefined : launchFailureOf(bench, session);
  const ended =
    !preparing && failure === undefined && session?.status === "ended" ? session : undefined;
  const gone =
    !preparing &&
    failure === undefined &&
    bench.deliverySessionId !== undefined &&
    sessionListed &&
    session === undefined;
  const awaiting =
    session?.status === "live" &&
    bench.notifications.some(
      (n) => n.priority === "action-needed" && n.sourceSessionId === session.id,
    );

  const sessionStep: DeliveryStartupStep = {
    id: "session",
    label: "Delivery session started",
    status: "pending",
  };
  if (failure !== undefined) {
    sessionStep.status = "error";
    sessionStep.detail = launchFailureText(failure);
  } else if (ended !== undefined) {
    sessionStep.status = "error";
    sessionStep.detail = endedText(ended);
  } else if (gone) {
    sessionStep.status = "error";
    sessionStep.detail = goneText();
  } else if (preparing) {
    sessionStep.status = "pending";
  } else if (bench.deliverySessionId !== undefined) {
    sessionStep.status = "done";
  } else if (workspace.status === "done") {
    sessionStep.status = "running";
    if (launchStalled) {
      sessionStep.detail =
        "The session has not started yet. If it does not start, launch it again.";
    }
  }

  const sessionRuns = sessionStep.status === "done";
  const steps: DeliveryStartupStep[] = [
    workspace,
    sessionStep,
    {
      id: "planning",
      label: "Planning the delivery",
      status: sessionRuns ? (awaiting ? "done" : "running") : "pending",
    },
    {
      id: "operator",
      label: "Waiting for your answer in the Terminal",
      status: sessionRuns && awaiting ? "running" : "pending",
      detail: OPERATOR_STEP_DETAIL,
    },
    { id: "record", label: "Delivery record written", status: "pending" },
  ];

  let phase: DeliveryStartupPhase;
  if (unavailable) phase = "bench-unavailable";
  else if (failure !== undefined) phase = "launch-failed";
  else if (ended !== undefined || gone) phase = "session-ended";
  else if (sessionStep.status === "running" && launchStalled) phase = "launch-stalled";
  else if (sessionRuns && awaiting) phase = "awaiting-operator";
  else if (sessionRuns) phase = "planning";
  else phase = "starting";

  return { phase, steps };
}
