import type { ReactNode } from "react";
import StatusIndicator from "../ui/StatusIndicator";
import type { StatusTone } from "../ui/styles";
import {
  sittingLabel,
  sittingPhase,
  type DeliverySittingPhase,
  type DeliverySittingView,
} from "./gate-sitting-model";

// The gate sitting of a Spec Bench (SB-FR-023) as one banner per phase
// (#1626): once the delivery reached a gate, the server pins the gate commit
// and smoke-checks the build. The gate reads waiting for build until the smoke
// check passes, then ready to sit, and the operator is called; then the sitting
// opens. A gate that a fix unit blocks (SB-FR-027) reads in the danger set,
// whatever its phase.
//
// The banner names the gate and its phase, says what the phase is doing, and
// carries the build's state as a chip. The Test bench tab passes the sitting's
// counts as `facts` and its stage control as `actions`; the Delivery tab shows
// the banner without either.

const SHORT_COMMIT = 7;

type BannerTone = "neutral" | "success" | "danger";

const BANNER_CLASSES: Record<BannerTone, { frame: string; title: string }> = {
  neutral: { frame: "border-border-strong bg-bg-surface", title: "text-text-primary" },
  success: { frame: "border-success-border bg-success-surface", title: "text-success-text" },
  danger: { frame: "border-danger-border bg-danger-surface", title: "text-danger-text" },
};

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-chip border border-border px-2 py-0.5 text-12 text-text-secondary";

export default function GateSitting({
  sitting,
  titleAs = "p",
  facts,
  actions,
}: {
  sitting: DeliverySittingView | undefined;
  /** The element of the title: a heading on the Test bench tab. */
  titleAs?: "h2" | "p";
  /** What the open sitting holds, such as its case counts, with its own layout. */
  facts?: ReactNode;
  /** The sitting's controls, at the end of the banner. */
  actions?: ReactNode;
}) {
  if (sitting === undefined) return null;
  const phase = sittingPhase(sitting);
  const blocked = sitting.blocked === true;
  const tone: BannerTone = blocked ? "danger" : phase === "open" ? "success" : "neutral";
  const classes = BANNER_CLASSES[tone];
  const commit = sitting.commit?.slice(0, SHORT_COMMIT);
  const failed = sitting.smokeCheck !== undefined && !sitting.smokeCheck.passed;
  const blockers = sitting.fixUnitBlockers ?? [];
  const Title = titleAs;
  return (
    <section
      aria-label={`Gate ${sitting.gateId} sitting`}
      data-testid="delivery-gate-sitting"
      data-state={phase}
      data-blocked={blocked ? "true" : undefined}
      className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-control border px-4 py-3 text-13 ${classes.frame}`}
    >
      <div
        role="status"
        className={`flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-13 font-medium ${classes.title}`}
      >
        {blocked && <span>Sitting blocked ·</span>}{" "}
        <Title className="font-medium">
          Gate <span className="break-all font-mono">{sitting.gateId}</span>
        </Title>{" "}
        <span data-testid="delivery-gate-sitting-state">· {sittingLabel(sitting)}</span>
      </div>
      {phase === "preparing" && (
        <p className="min-w-0 text-text-body">
          The build is coming up at the gate commit
          {commit !== undefined && (
            <>
              {" "}
              <span className="font-mono">{commit}</span>
            </>
          )}
          . You are called once it is live and its smoke check passes.
        </p>
      )}
      {phase === "ready" && (
        <p className="min-w-0 text-text-body">
          The build at the gate commit
          {commit !== undefined && (
            <>
              {" "}
              <span className="font-mono">{commit}</span>
            </>
          )}{" "}
          is live and passed its smoke check.
        </p>
      )}
      {facts}
      {blocked && (
        <p
          role="status"
          data-testid="delivery-gate-sitting-blocked"
          className="min-w-0 text-text-body"
        >
          Blocked by {blockers.length === 1 ? "a fix unit" : `${blockers.length} fix units`} filed
          for cases marked Not met:{" "}
          {blockers.map((blocker) => `${blocker.fixRef} (${blocker.caseId})`).join(", ")}
        </p>
      )}
      <span className="flex flex-wrap items-center gap-2">
        {phase === "open" && commit !== undefined && (
          <span className={CHIP_CLASS}>
            pinned <span className="font-mono text-text-body">{commit}</span>
          </span>
        )}
        <span className={CHIP_CLASS}>
          <BuildState sitting={sitting} phase={phase} />
        </span>
      </span>
      {failed && sitting.smokeCheck?.detail !== undefined && (
        <p data-testid="delivery-gate-sitting-smoke" className="basis-full text-12 text-text-body">
          Last smoke check: {sitting.smokeCheck.detail}
        </p>
      )}
      {actions !== undefined && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
    </section>
  );
}

// The build's state, from the last smoke check of the pinned build. A sitting
// opens only once its build is live, so an open sitting with no smoke check
// recorded reads live.
function BuildState({
  sitting,
  phase,
}: {
  sitting: DeliverySittingView;
  phase: DeliverySittingPhase;
}) {
  const check = sitting.smokeCheck;
  const [tone, label]: [StatusTone, string] =
    check === undefined
      ? phase === "open"
        ? ["active", "build live"]
        : ["preparing", "build coming up"]
      : check.passed
        ? ["active", "build live · smoke ok"]
        : ["error", "smoke check failed"];
  return <StatusIndicator tone={tone} label={label} />;
}
