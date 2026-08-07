import type { GateEmptyReason, GateState } from "../../lib/api";
import GateStateIndicator from "./GateStateIndicator";

// Gate-state panel (#702, VG-FR-012): for any gate, the operator sees its current
// state (passed / failed / pending / stale) and, for a non-passed gate, the
// unresolved gating cases and the slice unit(s) they trace to (the gate's
// `covers`). Reuses the DESIGN.md status-dot vocabulary via GateStateIndicator;
// no staleness/classification logic lives here, it renders the server-evaluated
// GateState as-is.
//
// Live-update (AC2): the panel is a pure render of the GateState its host passes
// in. The host (BatchView) re-fetches the gate via React Query after each mark
// write, so the status and unresolved sets here flip pending/failed/passed/stale
// as cases are marked, with no local state of its own.
//
// Lifecycle exclusion (#777, SATCA-FR-008/FR-011): retiring the case that was
// holding a gate pending releases the gate, and the released gate then looks
// identical to one whose cases were all verified. The exclusion line is what tells
// those two apart, so it renders on EVERY status, including `passed`, naming the
// declared cases lifecycle removed. `emptyReason` alone could not carry this: it
// is reported only on the `no_gating_cases` rung, which is the narrower case where
// lifecycle emptied the set outright rather than merely narrowing it.

// Why a `no_gating_cases` gate has nothing left, in words. Colour and the bare
// status dot cannot say this, and the operator's next move differs per reason.
const EMPTY_REASON_COPY: Record<GateEmptyReason, string> = {
  lifecycle: "Every declared case was excluded by lifecycle.",
  policy: "Every declared case was excluded by the level and type policy.",
  mixed: "Every declared case was excluded by lifecycle or by the level and type policy.",
};

export default function GateStatePanel({ gate }: { gate: GateState }) {
  const isPassed = gate.status === "passed";
  // A gate whose (narrowed) gating set is empty is a structural "nothing to gate
  // on" state, distinct from passed: it must never read as a pass (issue #436).
  const isNoGatingCases = gate.status === "no_gating_cases";
  const unresolved = gate.unresolvedCaseIds;
  const covering = gate.coveringUnitIds;
  // Absent on a response from a server predating #777; read that as none.
  const lifecycleExcluded = gate.lifecycleExcludedCaseIds ?? [];
  const emptyReason = isNoGatingCases && gate.emptyReason ? gate.emptyReason : null;

  return (
    <section
      aria-label={`Gate ${gate.gateId} state`}
      data-testid="gate-state-panel"
      className="rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 px-4 py-3 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400 truncate">
            {gate.gateId}
          </span>
        </div>
        <GateStateIndicator status={gate.status} />
      </div>

      {isNoGatingCases ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          No gating cases in scope. Nothing to verify here.
          {emptyReason !== null && ` ${EMPTY_REASON_COPY[emptyReason]}`}
        </p>
      ) : isPassed ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          All gating cases passed. Nothing outstanding.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600">
              Unresolved cases
            </p>
            {unresolved.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {unresolved.map((caseId) => (
                  <li
                    key={caseId}
                    className="font-mono text-[11px] text-stone-700 dark:text-stone-300 rounded-md bg-stone-200/70 dark:bg-stone-800/70 px-1.5 py-0.5"
                  >
                    {caseId}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-500 dark:text-stone-400">None.</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600">
              Covering units
            </p>
            {covering.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {covering.map((unitId) => (
                  <li
                    key={unitId}
                    className="font-mono text-[11px] text-stone-700 dark:text-stone-300 rounded-md bg-stone-200/70 dark:bg-stone-800/70 px-1.5 py-0.5"
                  >
                    {unitId}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-500 dark:text-stone-400">None.</p>
            )}
          </div>
        </div>
      )}

      {lifecycleExcluded.length > 0 && (
        <p
          data-testid="gate-lifecycle-excluded"
          className="text-xs text-stone-600 dark:text-stone-400"
        >
          {"Excluded by lifecycle: "}
          <span className="font-mono text-stone-700 dark:text-stone-300">
            {lifecycleExcluded.join(", ")}
          </span>
          {lifecycleExcluded.length === 1
            ? ". This case is retired, so it no longer gates."
            : ". These cases are retired, so they no longer gate."}
        </p>
      )}
    </section>
  );
}
