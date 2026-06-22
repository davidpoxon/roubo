import type { GateState } from "../../lib/api";
import GateStateIndicator from "./GateStateIndicator";

// Gate-state panel (#702, FR-012): for any gate, the operator sees its current
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
export default function GateStatePanel({ gate }: { gate: GateState }) {
  const isPassed = gate.status === "passed";
  const unresolved = gate.unresolvedCaseIds;
  const covering = gate.coveringUnitIds;

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

      {isPassed ? (
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
    </section>
  );
}
