import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { FileText, Pencil } from "lucide-react";
import { useTestbenchPlan, useSetTestbenchFocus } from "../../hooks/useTestbenchPlan";
import { buildRollup, flattenRollup } from "./rollup";
import CaseList from "./CaseList";
import CaseDetail from "./CaseDetail";
import ProgressBar from "./ProgressBar";
import SpecPickerModal from "./SpecPickerModal";
import Spinner from "../Spinner";

// Render the focused-spec identity from its test-cases.json path: the slug is the
// parent directory name (`.specifications/<slug>/test-cases.json`), with the full
// path kept beside it for disambiguation when two slugs collide.
function focusedSpecSlug(path: string): string {
  const segments = path.split("/").filter(Boolean);
  // .../<slug>/test-cases.json -> the segment before the file name.
  return segments.length >= 2 ? segments[segments.length - 2] : (segments[0] ?? path);
}

// TestBench review tab content (#419/#420/#423, FR-005/FR-006/FR-007/FR-024). A
// header row carries the focused-spec identity and an explicit "Change focused
// spec" action that opens the spec-picker in re-point mode; below it sits the
// overall progress rollup above a virtualised, level/priority-grouped case list,
// with a case detail pane beside the list once a case is selected (#420). The
// selected-case id lives here so the list and detail pane stay in sync; the
// detail pane drives the per-case mark/override mutations.
//
// Re-point (#423) is explicit only: dismissing the picker changes nothing. On
// confirm the mutation PUTs the focus endpoint and invalidates the plan query, so
// the panel reloads the newly focused plan, its independently preserved results,
// and the server-computed `stale` flag. Per-spec result isolation is enforced
// server-side.
export default function TestBenchPanel({
  projectId,
  benchId,
  focusedSpecPath,
}: {
  projectId: string;
  benchId: number;
  focusedSpecPath?: string;
}) {
  const { data, isLoading, isError, error } = useTestbenchPlan(projectId, benchId);
  const [selectedCaseId, setSelectedCaseId] = useState<string | undefined>(undefined);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const setFocus = useSetTestbenchFocus();

  const model = useMemo(() => (data ? buildRollup(data.plan.cases, data.results) : null), [data]);
  const flatRows = useMemo(() => (model ? flattenRollup(model) : []), [model]);
  // Resolve the selected case from the live plan. If the selection no longer
  // exists (e.g. the plan refetched smaller), the detail pane simply closes.
  const selectedCase = useMemo(
    () => (selectedCaseId ? (data?.plan.cases.find((c) => c.id === selectedCaseId) ?? null) : null),
    [data, selectedCaseId],
  );

  const handleRepoint = (nextPath: string) => {
    if (nextPath === focusedSpecPath) {
      // Re-pointing to the same spec is a no-op; just close the picker.
      setIsPickerOpen(false);
      return;
    }
    setFocus.mutate(
      { projectId, benchId, focusedSpecPath: nextPath },
      {
        onSuccess: () => {
          // Drop any stale selection from the prior spec before the new plan loads.
          setSelectedCaseId(undefined);
          setIsPickerOpen(false);
        },
      },
    );
  };

  const header = focusedSpecPath ? (
    <div className="flex items-center justify-between gap-3 rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 px-4 py-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <FileText size={15} className="text-amber-500 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
            {focusedSpecSlug(focusedSpecPath)}
          </p>
          <p className="text-[11px] font-mono text-stone-400 dark:text-stone-500 truncate">
            {focusedSpecPath}
          </p>
        </div>
      </div>
      <Button
        onPress={() => setIsPickerOpen(true)}
        isDisabled={setFocus.isPending}
        className="flex items-center gap-1.5 shrink-0 px-3 py-1.5 text-sm font-medium text-stone-700 dark:text-stone-200 bg-stone-200/70 dark:bg-stone-800/70 hover:bg-stone-200 dark:hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <Pencil size={13} />
        {setFocus.isPending ? "Re-pointing..." : "Change focused spec"}
      </Button>
    </div>
  ) : null;

  const picker = focusedSpecPath ? (
    <SpecPickerModal
      isOpen={isPickerOpen}
      onClose={() => setIsPickerOpen(false)}
      projectId={projectId}
      onCreate={handleRepoint}
      isCreating={setFocus.isPending}
      mode="repoint"
    />
  ) : null;

  // Wrap every render branch so the header action stays available regardless of
  // the plan's load / empty / error state.
  const frame = (body: React.ReactNode) => (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {header}
      {body}
      {picker}
    </div>
  );

  if (isLoading) {
    return frame(
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600 py-8">
        <Spinner />
        Loading test cases...
      </div>,
    );
  }

  if (isError || !data || !model) {
    const message =
      error instanceof Error ? error.message : "Could not load the TestBench plan for this bench.";
    return frame(
      <div className="py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      </div>,
    );
  }

  if (data.plan.cases.length === 0) {
    return frame(
      <div className="py-8">
        <p className="text-sm text-stone-500 dark:text-stone-600">
          This spec has no test cases yet.
        </p>
      </div>,
    );
  }

  return frame(
    <>
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
    </>,
  );
}
