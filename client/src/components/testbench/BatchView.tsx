import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { useGate, useInvalidateGates } from "../../hooks/useGates";
import { testbenchPlanQueryKey } from "../../hooks/useTestbenchPlan";
import { buildRollup, flattenRollup } from "./rollup";
import CaseList from "./CaseList";
import CaseDetail from "./CaseDetail";
import GateStatePanel from "./GateStatePanel";
import Spinner from "../Spinner";

// Batch view (#702, FR-008, AC2/AC3). Opening a gate shows only its gating
// subset: the plan is fetched with the ?gateIds= filter so the case list is
// narrowed to the gate's declared test_case_ids. The gate-state panel sits above
// the list and live-updates as cases are marked (AC2), driven by re-fetching the
// gate via React Query after each mark settle (SSE push is out of scope).
//
// Sign-off (AC3) is a UI guard only, NOT a privileged tracker close (that is
// FR-007, a separate issue): the action is disabled and, if invoked, rejected
// whenever the gate's evaluated status is anything other than `passed`. So a
// batch with a still-failing (or pending / stale) gating case cannot be signed
// off here.
//
// A phase (gate) with no gating cases after the subset filter is elided with a
// clear label, never an unlabelled empty card (AC2): the case list is replaced
// by an explicit "no gating cases" notice.
export default function BatchView({
  projectId,
  benchId,
  gateId,
  onBack,
}: {
  projectId: string;
  benchId: number;
  gateId: string;
  onBack: () => void;
}) {
  const [selectedCaseId, setSelectedCaseId] = useState<string | undefined>(undefined);
  const [signOffError, setSignOffError] = useState<string | null>(null);
  const [signedOff, setSignedOff] = useState(false);
  const { invalidateGate } = useInvalidateGates();

  // The gate's evaluated state, re-fetched after each mark so the panel and the
  // sign-off guard reflect the live status (AC2/AC3).
  const gateQuery = useGate(projectId, gateId);

  // The plan narrowed to this gate's gating subset (?gateIds=). A distinct query
  // key from the full-plan query so the batch view's subset never clobbers the
  // plain TestBench panel's cached full plan; both can coexist.
  const planQuery = useQuery({
    queryKey: [...testbenchPlanQueryKey(projectId, benchId), "gate", gateId] as const,
    queryFn: () => api.fetchTestbenchPlan(projectId, benchId, [gateId]),
    retry: false,
  });

  const model = useMemo(
    () => (planQuery.data ? buildRollup(planQuery.data.plan.cases, planQuery.data.results) : null),
    [planQuery.data],
  );
  const flatRows = useMemo(() => (model ? flattenRollup(model) : []), [model]);
  const selectedCase = useMemo(
    () =>
      selectedCaseId
        ? (planQuery.data?.plan.cases.find((c) => c.id === selectedCaseId) ?? null)
        : null,
    [planQuery.data, selectedCaseId],
  );

  const handleMarked = () => {
    // The mark mutation already invalidates the bench's full-plan query; the
    // subset query and the gate state are separate keys, so refresh both here so
    // the list and the gate-state panel live-update (AC2).
    planQuery.refetch();
    invalidateGate(projectId, gateId);
  };

  const gate = gateQuery.data;
  const canSignOff = gate?.status === "passed";

  const handleSignOff = () => {
    // Guard (AC3): refuse sign-off unless the gate's evaluated status is passed.
    // This is the load-bearing rejection, not just the disabled button: even if
    // the action fires (stale UI), it is rejected with a clear reason.
    if (gate?.status !== "passed") {
      setSignOffError(
        "This batch cannot be signed off: its gate has not passed. Resolve every gating case first.",
      );
      return;
    }
    setSignOffError(null);
    setSignedOff(true);
  };

  const header = (
    <div className="flex items-center justify-between gap-3">
      <Button
        onPress={onBack}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-stone-500 dark:text-stone-400 transition-colors hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/40 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
        Back to batches
      </Button>
      <Button
        onPress={handleSignOff}
        isDisabled={!canSignOff || signedOff}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        {signedOff ? "Signed off" : "Sign off batch"}
      </Button>
    </div>
  );

  const frame = (body: React.ReactNode) => (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {header}
      {body}
    </div>
  );

  if (gateQuery.isLoading || planQuery.isLoading) {
    return frame(
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600 py-8">
        <Spinner />
        Loading batch...
      </div>,
    );
  }

  if (gateQuery.isError || !gate) {
    const message =
      gateQuery.error instanceof Error
        ? gateQuery.error.message
        : `Could not load gate '${gateId}'.`;
    return frame(
      <div className="py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      </div>,
    );
  }

  if (planQuery.isError || !planQuery.data || !model) {
    const message =
      planQuery.error instanceof Error ? planQuery.error.message : "Could not load the batch plan.";
    return frame(
      <div className="py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      </div>,
    );
  }

  const noGatingCases = planQuery.data.plan.cases.length === 0;

  return frame(
    <>
      <GateStatePanel gate={gate} />
      {signOffError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {signOffError}
        </p>
      )}
      {noGatingCases ? (
        // Elide a phase with no gating cases with a clear label (AC2): an
        // explicit notice, never an unlabelled empty card.
        <div className="rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-50 dark:bg-stone-900/30 py-8 px-4">
          <p className="text-sm text-stone-500 dark:text-stone-400">
            This batch has no gating cases. Nothing to verify here.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-4">
          <div className={selectedCase ? "w-2/5 min-w-0 flex flex-col" : "flex-1 flex flex-col"}>
            <CaseList
              rows={flatRows}
              onSelect={setSelectedCaseId}
              selectedCaseId={selectedCaseId}
            />
          </div>
          {selectedCase && (
            <div className="flex-1 min-w-0 rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-50 dark:bg-stone-900/30 p-4 overflow-hidden flex flex-col">
              <CaseDetail
                projectId={projectId}
                benchId={benchId}
                testCase={selectedCase}
                result={planQuery.data.results?.caseResults[selectedCase.id]}
                onBack={() => setSelectedCaseId(undefined)}
                onMarked={handleMarked}
              />
            </div>
          )}
        </div>
      )}
    </>,
  );
}
