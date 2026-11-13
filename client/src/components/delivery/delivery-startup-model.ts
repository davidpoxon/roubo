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

function workspaceStep(bench: StartupBench): DeliveryStartupStep {
  const label = "Workspace ready";
  if (bench.status === "preparing") return { id: "workspace", label, status: "running" };
  if (bench.status === "error")
    return { id: "workspace", label, status: "error", detail: "The bench is in error." };
  if (bench.status === "clearing")
    return { id: "workspace", label, status: "cancelled", detail: "The bench is being cleared." };
  return { id: "workspace", label, status: "done" };
}

/**
 * Where the start-up of the bench's delivery is. `session` is the bench's
 * delivery session from its terminal sessions, when the list names it.
 */
export function deliveryStartup(
  bench: StartupBench,
  session: TerminalSession | undefined,
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

  const failure = launchFailureOf(bench, session);
  const ended = failure === undefined && session?.status === "ended" ? session : undefined;
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
  } else if (bench.deliverySessionId !== undefined) {
    sessionStep.status = "done";
  } else if (workspace.status === "done") {
    sessionStep.status = "running";
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
  else if (ended !== undefined) phase = "session-ended";
  else if (sessionRuns && awaiting) phase = "awaiting-operator";
  else if (sessionRuns) phase = "planning";
  else phase = "starting";

  return { phase, steps };
}
