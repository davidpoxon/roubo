import { Button } from "react-aria-components";
import { ChevronRight } from "lucide-react";
import type { GateState } from "../../lib/api";
import { useGates } from "../../hooks/useGates";
import GateStateIndicator from "./GateStateIndicator";
import Spinner from "../Spinner";

// Gates overview (#702, FR-001/FR-012, AC1): one card per gate (one gate per
// phase by default, derived server-side from each work unit's milestone), each
// showing the gate's id and its evaluated status. A non-passed gate is "blocked"
// in the operator's sense: its card names the blocking unit(s), the covering
// slice unit ids the unresolved gating cases trace to (the gate's `covers`, per
// FR-012). When the gate passes, the evaluator returns an empty coveringUnitIds
// and the card clears: the blocking-unit line disappears (AC1: "clears when that
// blocker passes").
//
// Live-update: the list is React Query backed; the batch view invalidates the
// gates query after each mark, so a gate flipping to passed re-renders the
// overview without the blocking line.
//
// Note (data sourcing): the merged gate API exposes only { gateId, status,
// unresolvedCaseIds, coveringUnitIds }; it does not surface the work unit's
// milestone/phase label or its depends_on graph. So the card labels each gate by
// its gateId (which is one verify unit per phase) and derives the "blocking
// unit" from coveringUnitIds rather than from depends_on. Surfacing a richer
// phase title or the upstream dependency would require expanding the gate API,
// which is out of scope for this client-only slice (#702).

function GateCard({ gate, onOpen }: { gate: GateState; onOpen: (gateId: string) => void }) {
  const isBlocked = gate.status !== "passed";
  const blockingUnits = gate.coveringUnitIds;

  return (
    <Button
      onPress={() => onOpen(gate.gateId)}
      data-testid="gate-card"
      className="group flex flex-col gap-2 text-left rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 px-4 py-3 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800/40 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      <div className="flex items-center justify-between gap-3 w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="font-mono text-[11px] text-stone-600 dark:text-stone-300 truncate">
            {gate.gateId}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <GateStateIndicator status={gate.status} />
          <ChevronRight
            aria-hidden="true"
            className="w-4 h-4 text-stone-400 dark:text-stone-600 transition-transform group-hover:translate-x-0.5"
          />
        </div>
      </div>
      {isBlocked && blockingUnits.length > 0 && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Blocked by{" "}
          <span className="font-mono text-stone-700 dark:text-stone-300">
            {blockingUnits.join(", ")}
          </span>
        </p>
      )}
    </Button>
  );
}

export default function GatesOverview({
  projectId,
  onOpenGate,
}: {
  projectId: string;
  onOpenGate: (gateId: string) => void;
}) {
  const { data: gates, isLoading, isError, error } = useGates(projectId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600 py-8">
        <Spinner />
        Loading batches...
      </div>
    );
  }

  if (isError || !gates) {
    const message =
      error instanceof Error ? error.message : "Could not load the batches for this project.";
    return (
      <div className="py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      </div>
    );
  }

  if (gates.length === 0) {
    return (
      <div className="py-8">
        <p className="text-sm text-stone-500 dark:text-stone-600">
          This project has no verify gates yet.
        </p>
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="Verification batches"
      className="flex flex-col gap-2 overflow-auto flex-1 min-h-0"
    >
      {gates.map((gate) => (
        <div role="listitem" key={gate.gateId}>
          <GateCard gate={gate} onOpen={onOpenGate} />
        </div>
      ))}
    </div>
  );
}
