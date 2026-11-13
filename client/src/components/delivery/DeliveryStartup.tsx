import type { Bench } from "@roubo/shared";
import Button from "../ui/Button";
import StatusIndicator from "../ui/StatusIndicator";
import type { StatusTone } from "../ui/styles";
import { stepIcon, stepTextColor } from "../../lib/provisioning";
import { useElapsed } from "../../hooks/useElapsed";
import {
  useDeliverySession,
  useDeliverySessionStartBlocked,
  useDeliverySpecSummary,
  useLaunchDelivery,
} from "../../hooks/useDelivery";
import { deliveryStartup, type DeliveryStartupPhase } from "./delivery-startup-model";

// DESIGN.md Delivery start-up: what the Delivery tab shows while a Spec Bench
// has no delivery record yet. The record lands only after the session's
// preflight and the operator's answer to the plan and the budget, so this is a
// wait, not a fault: a neutral panel, never danger. It names the phase with a
// status indicator and the time since the session started, what the spec holds,
// and each start-up step. The Terminal is one press away while the session waits
// for the operator. A launch-mode bench offers to launch its session again only
// once the launch failed or the session ended without the record.

const PHASE_HEAD: Record<DeliveryStartupPhase, { tone: StatusTone; label: string }> = {
  starting: { tone: "preparing", label: "Starting the delivery" },
  planning: { tone: "preparing", label: "Planning the delivery" },
  "awaiting-operator": { tone: "preparing", label: "Waiting for you" },
  "launch-failed": { tone: "error", label: "The delivery session did not start" },
  "session-ended": { tone: "error", label: "The delivery session ended" },
  "bench-unavailable": { tone: "idle", label: "The bench is unavailable" },
  "attach-waiting": { tone: "preparing", label: "Waiting for the delivery" },
};

const PHASE_NOTE: Record<DeliveryStartupPhase, string> = {
  starting: "The bench starts the delivery session. The map shows here once it writes the record.",
  planning:
    "The delivery session reads the spec and plans the delivery. The map shows here once it writes the record.",
  "awaiting-operator":
    "The delivery session needs your answer in the Terminal before it writes the record.",
  "launch-failed": "No session runs the delivery. Launch it again when the cause is fixed.",
  "session-ended": "No session runs the delivery. Launch it again to start the delivery.",
  "bench-unavailable": "The delivery starts when the bench is ready again.",
  "attach-waiting":
    "This bench joins a delivery that runs elsewhere. The map shows here once its record is in the spec folder.",
};

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export default function DeliveryStartup({
  bench,
  onOpenTerminal,
}: {
  bench: Bench;
  onOpenTerminal?: (() => void) | undefined;
}) {
  const session = useDeliverySession(bench);
  const { phase, steps } = deliveryStartup(bench, session);
  const summary = useDeliverySpecSummary(bench.projectId, bench.id, true);
  const waiting = PHASE_HEAD[phase].tone === "preparing";
  const elapsed = useElapsed(session?.createdAt ?? bench.createdAt, waiting);
  const counts =
    summary.data !== undefined && summary.data.units + summary.data.gates > 0
      ? `${plural(summary.data.units, "unit", "units")} and ${plural(summary.data.gates, "gate", "gates")} in this spec`
      : undefined;
  const offerLaunch =
    bench.deliveryBindMode === "launch" && (phase === "launch-failed" || phase === "session-ended");

  return (
    <section
      role="status"
      aria-label="Delivery start-up"
      data-testid="delivery-startup"
      data-phase={phase}
      className="flex flex-col gap-3 rounded-control border border-border bg-bg-surface p-4 text-13"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusIndicator
          tone={PHASE_HEAD[phase].tone}
          label={PHASE_HEAD[phase].label}
          data-testid="delivery-startup-phase"
        />
        {elapsed !== null && (
          <span
            className="font-mono text-11 text-text-secondary"
            data-testid="delivery-startup-elapsed"
          >
            {elapsed}
          </span>
        )}
      </div>
      <p className="text-text-body">{PHASE_NOTE[phase]}</p>
      {counts !== undefined && (
        <p className="text-text-secondary" data-testid="delivery-startup-counts">
          {counts}
        </p>
      )}
      <ol aria-label="Start-up steps" className="space-y-1">
        {steps.map((step) => (
          <li
            key={step.id}
            data-testid={`delivery-startup-step-${step.id}`}
            data-status={step.status}
          >
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex w-4 shrink-0 items-center justify-center">
                {stepIcon[step.status]}
              </span>
              <span className={stepTextColor[step.status]}>{step.label}</span>
              <span className="sr-only">{`, ${step.status}`}</span>
            </div>
            {step.detail !== undefined &&
              (step.status === "running" || step.status === "error") && (
                <p
                  className={`pl-7 text-12 ${step.status === "error" ? "text-danger-text" : "text-text-secondary"}`}
                >
                  {step.detail}
                </p>
              )}
          </li>
        ))}
      </ol>
      {phase === "awaiting-operator" && onOpenTerminal !== undefined && (
        <div>
          <Button onPress={onOpenTerminal}>Open the terminal</Button>
        </div>
      )}
      {offerLaunch && <LaunchDeliveryControl bench={bench} />}
    </section>
  );
}

// Launches the bench's delivery session again (POST /delivery/launch).
function LaunchDeliveryControl({ bench }: { bench: Bench }) {
  const launch = useLaunchDelivery(bench.projectId, bench.id);
  const blocked = useDeliverySessionStartBlocked(bench);
  return (
    <div data-testid="delivery-launch-control" className="space-y-2">
      <Button onPress={() => launch.mutate()} isDisabled={launch.isPending || blocked}>
        Launch the delivery session
      </Button>
      {launch.isError && (
        <p role="alert" className="text-danger-text">
          {launch.error.message}
        </p>
      )}
    </div>
  );
}
