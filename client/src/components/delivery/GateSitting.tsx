import StatusIndicator from "../ui/StatusIndicator";
import {
  sittingLabel,
  sittingPhase,
  sittingTone,
  type DeliverySittingView,
} from "./gate-sitting-model";

// The gate sitting of a Spec Bench (SB-FR-023): once the delivery reached a
// gate, the server pins the gate commit and smoke-checks the build. The gate
// reads waiting for build until the smoke check passes, then ready to sit, and
// the operator is called; then the sitting opens.
export default function GateSitting({ sitting }: { sitting: DeliverySittingView | undefined }) {
  if (sitting === undefined) return null;
  const state = sittingPhase(sitting);
  const failed = sitting.smokeCheck !== undefined && !sitting.smokeCheck.passed;
  return (
    <section
      aria-label={`Gate ${sitting.gateId} sitting`}
      data-testid="delivery-gate-sitting"
      data-state={state}
      className="space-y-1 rounded-control border border-border bg-bg-surface p-3 text-13"
    >
      <p role="status" className="flex flex-wrap items-center gap-2 text-text-primary">
        <span className="font-mono">Gate {sitting.gateId}</span>
        <StatusIndicator
          tone={sittingTone(sitting)}
          label={sittingLabel(sitting)}
          data-testid="delivery-gate-sitting-state"
        />
      </p>
      {state === "preparing" && (
        <p className="text-text-secondary">
          The build is coming up at the gate commit. You are called once it is live and its smoke
          check passes.
        </p>
      )}
      {sitting.blocked === true && (
        <p data-testid="delivery-gate-sitting-blocked" className="text-text-secondary">
          Blocked by {sitting.fixUnitBlockers?.length === 1 ? "a fix unit" : "fix units"} filed for
          cases marked Not met:{" "}
          {(sitting.fixUnitBlockers ?? []).map((blocker) => blocker.fixRef).join(", ")}
        </p>
      )}
      {failed && sitting.smokeCheck?.detail !== undefined && (
        <p data-testid="delivery-gate-sitting-smoke" className="text-text-secondary">
          Last smoke check: {sitting.smokeCheck.detail}
        </p>
      )}
    </section>
  );
}
