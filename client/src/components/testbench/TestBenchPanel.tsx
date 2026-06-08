import { useMemo, useState } from "react";
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import { buildRollup, flattenRollup } from "./rollup";
import CaseList from "./CaseList";
import CaseDetail from "./CaseDetail";
import ProgressBar from "./ProgressBar";
import Spinner from "../Spinner";

// TestBench review tab content (#419/#420, FR-005/FR-006/FR-007). Hosts the
// overall progress rollup above a virtualised, level/priority-grouped case list,
// with a case detail pane beside the list once a case is selected (#420). The
// selected-case id lives here so the list and detail pane stay in sync; the
// detail pane drives the per-case mark/override mutations. Notes (#17) and
// staleness/reconcile (#18) are separate slices and out of scope.
export default function TestBenchPanel({
  projectId,
  benchId,
}: {
  projectId: string;
  benchId: number;
}) {
  const { data, isLoading, isError, error } = useTestbenchPlan(projectId, benchId);
  const [selectedCaseId, setSelectedCaseId] = useState<string | undefined>(undefined);

  const model = useMemo(() => (data ? buildRollup(data.plan.cases, data.results) : null), [data]);
  const flatRows = useMemo(() => (model ? flattenRollup(model) : []), [model]);
  // Resolve the selected case from the live plan. If the selection no longer
  // exists (e.g. the plan refetched smaller), the detail pane simply closes.
  const selectedCase = useMemo(
    () => (selectedCaseId ? (data?.plan.cases.find((c) => c.id === selectedCaseId) ?? null) : null),
    [data, selectedCaseId],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600 py-8">
        <Spinner />
        Loading test cases...
      </div>
    );
  }

  if (isError || !data || !model) {
    const message =
      error instanceof Error ? error.message : "Could not load the TestBench plan for this bench.";
    return (
      <div className="py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      </div>
    );
  }

  if (data.plan.cases.length === 0) {
    return (
      <div className="py-8">
        <p className="text-sm text-stone-500 dark:text-stone-600">
          This spec has no test cases yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 px-4 py-3">
        <ProgressBar counts={model.overall} label="Overall" />
      </div>
      <div className="flex flex-1 min-h-0 gap-4">
        <div className={selectedCase ? "w-2/5 min-w-0 flex flex-col" : "flex-1 flex flex-col"}>
          <CaseList rows={flatRows} onSelect={setSelectedCaseId} selectedCaseId={selectedCaseId} />
        </div>
        {selectedCase && (
          <div className="flex-1 min-w-0 rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-50 dark:bg-stone-900/30 p-4 overflow-hidden flex flex-col">
            <CaseDetail
              projectId={projectId}
              benchId={benchId}
              testCase={selectedCase}
              result={data.results?.caseResults[selectedCase.id]}
              onBack={() => setSelectedCaseId(undefined)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
