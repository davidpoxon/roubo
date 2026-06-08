import { useMemo } from "react";
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import { buildRollup, flattenRollup } from "./rollup";
import CaseList from "./CaseList";
import ProgressBar from "./ProgressBar";
import Spinner from "../Spinner";

// TestBench review tab content (#419, FR-005/FR-006). Hosts the overall progress
// rollup above a virtualised, level/priority-grouped case list. Loading, empty,
// and error states are handled here; the list itself only ever sees a resolved
// plan. Case detail + marks (#16), notes (#17), and staleness/reconcile (#18) are
// separate slices and out of scope.
export default function TestBenchPanel({
  projectId,
  benchId,
}: {
  projectId: string;
  benchId: number;
}) {
  const { data, isLoading, isError, error } = useTestbenchPlan(projectId, benchId);

  const model = useMemo(() => (data ? buildRollup(data.plan.cases, data.results) : null), [data]);
  const flatRows = useMemo(() => (model ? flattenRollup(model) : []), [model]);

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
      <CaseList rows={flatRows} />
    </div>
  );
}
