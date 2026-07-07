import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { useGate, useInvalidateGates, useSignOffGate, useReopenGate } from "../../hooks/useGates";
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
// Sign-off (AC3, FR-007/FR-008, issue #830) is now a real, persisted action: it
// closes the gate's tracker issue through the active integration plugin (the
// server enforces the same load-bearing guard, rejecting sign-off whenever the
// gate's evaluated status is anything other than `passed`). The button's state is
// sourced from the SERVER (`gate.signedOff`, derived from the tracker-issue
// state), not local React state, so it survives navigation: a signed-off batch
// reads back as signed off. A signed-off gate can be reopened (the button toggles
// to "Reopen"), which reopens its tracker issue.
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
  const { invalidateGate } = useInvalidateGates();
  const signOffMutation = useSignOffGate(projectId);
  const reopenMutation = useReopenGate(projectId);

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
  // Server-sourced sign-off signal (issue #830): derived from the gate's
  // tracker-issue state, not local React state, so it survives navigation.
  const signedOff = gate?.signedOff ?? false;

  const handleSignOff = () => {
    // Guard (AC3): refuse sign-off unless the gate's evaluated status is passed.
    // The server enforces the same guard (the load-bearing rejection); this is the
    // client-side mirror so a stale UI never fires a doomed request.
    if (gate?.status !== "passed") {
      setSignOffError(
        "This batch cannot be signed off: its gate has not passed. Resolve every gating case first.",
      );
      return;
    }
    setSignOffError(null);
    signOffMutation.mutate(gateId, {
      onError: (err) =>
        setSignOffError(err instanceof Error ? err.message : "The batch could not be signed off."),
    });
  };

  const handleReopen = () => {
    setSignOffError(null);
    reopenMutation.mutate(gateId, {
      onError: (err) =>
        setSignOffError(err instanceof Error ? err.message : "The batch could not be reopened."),
    });
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
        onPress={signedOff ? handleReopen : handleSignOff}
        isDisabled={signedOff ? reopenMutation.isPending : !canSignOff || signOffMutation.isPending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        {signedOff ? "Reopen" : "Sign off batch"}
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

  // A phase has no gating cases either when the subset plan is literally empty, or
  // when the gate's evaluated status is `no_gating_cases` (its declared cases all
  // narrow out of the default policy, e.g. all L3/L4). The `?gateIds=` subset uses
  // the gate's RAW declared ids, so an all-L3/L4 gate still renders case rows here;
  // driving the elision off the evaluated status makes the notice fire for it too
  // (issue #436).
  const noGatingCases = gate.status === "no_gating_cases" || planQuery.data.plan.cases.length === 0;

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
            No gating cases in scope. Nothing to verify here.
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
