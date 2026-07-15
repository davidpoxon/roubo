import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { FileText, Pencil, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { BenchStatus } from "@roubo/shared";
import type { ReconcileClassification } from "@roubo/shared/testbench-domain";
import { useBenchViewState } from "../../hooks/useBenchViewState";
import { useTestbenchPlan, useSetTestbenchFocus } from "../../hooks/useTestbenchPlan";
import {
  useReconcilePreview,
  useReconcileApply,
  useReconcilePurge,
} from "../../hooks/useReconcile";
import { buildRollup, flattenRollup } from "./rollup";
import CaseList from "./CaseList";
import CaseDetail from "./CaseDetail";
import ProgressBar from "./ProgressBar";
import SpecPickerModal from "./SpecPickerModal";
import StalenessBanner from "./StalenessBanner";
import ResultsRecoveryBanner from "./ResultsRecoveryBanner";
import ReconcileDialog from "./ReconcileDialog";
import ArchivedCases from "./ArchivedCases";
import GatesOverview from "./GatesOverview";
import BatchView from "./BatchView";
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
  benchStatus = "active",
}: {
  projectId: string;
  benchId: number;
  focusedSpecPath?: string;
  benchStatus?: BenchStatus;
}) {
  // Gate the plan query on worktree readiness (#500). The query reads
  // `.specifications/<slug>/test-cases.json` from the bench worktree, so firing it
  // when that worktree is absent 404s with MissingPlanError. Two states lack a
  // readable worktree: `preparing` (set before the worktree is added on create,
  // and re-entered briefly while components (re)start) and `clearing` (the
  // worktree is being torn down). In both we show a placeholder instead of firing
  // the query. Every other status (`active`/`idle`, and `error`, which is reached
  // only after provisioning, e.g. a component-start failure) has a worktree whose
  // plan should load. The bench-detail query polls and flips status, at which
  // point the now-enabled plan query fires automatically: no manual remount needed.
  const ready = benchStatus !== "preparing" && benchStatus !== "clearing";
  const { data, isLoading, isError, error } = useTestbenchPlan(projectId, benchId, {
    enabled: ready,
  });
  const [selectedCaseId, setSelectedCaseId] = useState<string | undefined>(undefined);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const setFocus = useSetTestbenchFocus();

  // Per-bench UI state, persisted via localStorage so it survives tab/bench
  // navigation and reload: the case-list collapse (#524) and the Cases/Batches
  // view (#359).
  const {
    testbenchCaseListCollapsed,
    setTestbenchCaseListCollapsed,
    testbenchViewMode,
    setTestbenchViewMode,
  } = useBenchViewState(projectId, benchId);

  // View mode (#702/#359): the existing whole-spec case review ("cases") or the
  // verify-gate batch surface ("batches"). Derived directly from the per-bench
  // persisted value (no local mirror), defaulting to "batches" on first visit
  // (no remembered view, #359). Reading straight from the hook each render is
  // deliberate: the bench route is keyless, so navigating to another bench reuses
  // this panel instance with a new benchId, and a useState mirror would keep the
  // previous bench's view (its initialiser never re-runs on a prop change) and
  // bleed/clobber it across benches. The toggle writes the choice back per bench,
  // mirroring testbenchCaseListCollapsed. The batches surface lists one gate per
  // phase (GatesOverview); opening a gate switches to its BatchView, scoped to
  // the gate's gating subset. `openGateId` tracks the open batch within the
  // batches mode (null = the overview list). Gates are project-level, so the
  // batches surface does not depend on this bench's plan query.
  const viewMode = testbenchViewMode ?? "batches";
  const [openGateId, setOpenGateId] = useState<string | null>(null);

  // Reconcile (#422/#413, FR-016/FR-017, NFR-003). The server computes staleness
  // and the add/changed/orphan classification; this panel only renders them and
  // dispatches the preview/apply/purge calls. The classification is fetched via a
  // preview (no write) when the dialog opens, then Apply persists the
  // orphan-not-delete results and the plan-query invalidation clears the banner.
  const [isReconcileOpen, setIsReconcileOpen] = useState(false);
  const [classification, setClassification] = useState<ReconcileClassification | null>(null);
  const reconcilePreview = useReconcilePreview();
  const reconcileApply = useReconcileApply();
  const reconcilePurge = useReconcilePurge();

  const openReconcile = () => {
    reconcilePreview.mutate(
      { projectId, benchId },
      {
        onSuccess: (response) => {
          setClassification(response.classification);
          setIsReconcileOpen(true);
        },
      },
    );
  };

  const closeReconcile = () => {
    setIsReconcileOpen(false);
    setClassification(null);
  };

  const handleApply = () => {
    reconcileApply.mutate({ projectId, benchId }, { onSuccess: () => closeReconcile() });
  };

  const handlePurge = () => {
    reconcilePurge.mutate({ projectId, benchId }, { onSuccess: () => closeReconcile() });
  };

  const reconcileError =
    reconcileApply.error instanceof Error
      ? reconcileApply.error.message
      : reconcilePurge.error instanceof Error
        ? reconcilePurge.error.message
        : null;

  const model = useMemo(() => (data ? buildRollup(data.plan.cases, data.results) : null), [data]);
  const flatRows = useMemo(() => (model ? flattenRollup(model) : []), [model]);
  // The case ids in list (grouped) order, so the detail pane's Next action can
  // advance to the case that visually follows the current one (#508).
  const orderedCaseIds = useMemo(
    () => flatRows.filter((r) => r.kind === "case").map((r) => r.row.case.id),
    [flatRows],
  );
  // Resolve the selected case from the live plan. If the selection no longer
  // exists (e.g. the plan refetched smaller), the detail pane simply closes.
  const selectedCase = useMemo(
    () => (selectedCaseId ? (data?.plan.cases.find((c) => c.id === selectedCaseId) ?? null) : null),
    [data, selectedCaseId],
  );
  // The case id following the selected one in list order, or undefined when the
  // selection is the last case (no Next offered then).
  const nextCaseId = useMemo(() => {
    if (!selectedCaseId) return undefined;
    const pos = orderedCaseIds.indexOf(selectedCaseId);
    return pos >= 0 && pos < orderedCaseIds.length - 1 ? orderedCaseIds[pos + 1] : undefined;
  }, [orderedCaseIds, selectedCaseId]);

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
      activePath={focusedSpecPath}
    />
  ) : null;

  // Cases / Batches mode toggle (#702). A two-segment switch above the body that
  // flips between the whole-spec case review and the verify-gate batch surface.
  // Switching back to the overview clears any open batch.
  const modeToggle = (
    <div
      aria-label="TestBench view"
      className="inline-flex self-start rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 p-0.5"
    >
      {(["batches", "cases"] as const).map((mode) => (
        <Button
          key={mode}
          aria-pressed={viewMode === mode}
          onPress={() => {
            setTestbenchViewMode(mode);
            if (mode === "cases") setOpenGateId(null);
          }}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
            viewMode === mode
              ? "bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-100 shadow-sm"
              : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          }`}
        >
          {mode === "cases" ? "Cases" : "Batches"}
        </Button>
      ))}
    </div>
  );

  // Wrap every render branch so the header action stays available regardless of
  // the plan's load / empty / error state.
  const frame = (body: React.ReactNode) => (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {header}
      {modeToggle}
      {body}
      {picker}
    </div>
  );

  // Batches mode (#702): the verify-gate surface. It renders independently of the
  // bench's plan query (load / error / empty) and is short-circuited before the
  // plan branches below. The overview is scoped to the bench's focused spec slug
  // (issue #549), the same way the Cases tab scopes to `focusedSpecPath`, so two
  // benches on different specs each show only their own batches; with no focused
  // spec the overview shows a "focus a spec" empty state.
  if (viewMode === "batches") {
    return frame(
      openGateId ? (
        <BatchView
          projectId={projectId}
          benchId={benchId}
          gateId={openGateId}
          onBack={() => setOpenGateId(null)}
        />
      ) : (
        <GatesOverview
          projectId={projectId}
          specSlug={focusedSpecPath ? focusedSpecSlug(focusedSpecPath) : undefined}
          onOpenGate={setOpenGateId}
        />
      ),
    );
  }

  // While the worktree is still provisioning the plan query is disabled (#500), so
  // there is no data and no error yet. Render an explicit "preparing" placeholder
  // BEFORE the error branch so a disabled query is never mistaken for a failure.
  if (!ready) {
    return frame(
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-600 py-8">
        <Spinner />
        Preparing test cases...
      </div>,
    );
  }

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
      <ResultsRecoveryBanner recoveryReason={data.recoveryReason} />
      <StalenessBanner stale={data.stale} onReconcile={openReconcile} />
      <div className="rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/60 dark:bg-stone-900/40 px-4 py-3">
        <ProgressBar counts={model.overall} label="Overall" />
      </div>
      <div className="flex flex-1 min-h-0 gap-4">
        {selectedCase && testbenchCaseListCollapsed ? (
          // Collapsed strip: the list is hidden so the detail pane (which still
          // shows the selected case) takes the freed width. An expand button
          // restores the list (#524).
          <div className="shrink-0 flex flex-col">
            <Button
              onPress={() => setTestbenchCaseListCollapsed(false)}
              aria-label="Expand test case list"
              aria-expanded={false}
              className="flex items-center justify-center p-2 rounded-lg text-stone-500 dark:text-stone-400 ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-50 dark:bg-stone-900/30 transition-colors hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/40 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <PanelLeftOpen aria-hidden="true" className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <div
            className={selectedCase ? "w-2/5 min-w-0 flex flex-col gap-2" : "flex-1 flex flex-col"}
          >
            {selectedCase && (
              <div className="flex justify-end shrink-0">
                <Button
                  onPress={() => setTestbenchCaseListCollapsed(true)}
                  aria-label="Collapse test case list"
                  aria-expanded={true}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-stone-500 dark:text-stone-400 transition-colors hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/40 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  <PanelLeftClose aria-hidden="true" className="w-3.5 h-3.5" />
                  Collapse list
                </Button>
              </div>
            )}
            <CaseList
              rows={flatRows}
              onSelect={setSelectedCaseId}
              selectedCaseId={selectedCaseId}
            />
          </div>
        )}
        {selectedCase && (
          <div className="flex-1 min-w-0 rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-50 dark:bg-stone-900/30 p-4 overflow-hidden flex flex-col">
            <CaseDetail
              projectId={projectId}
              benchId={benchId}
              testCase={selectedCase}
              result={data.results?.caseResults[selectedCase.id]}
              onBack={() => setSelectedCaseId(undefined)}
              onNext={nextCaseId ? () => setSelectedCaseId(nextCaseId) : undefined}
            />
          </div>
        )}
      </div>
      <ArchivedCases results={data.results} />
      {classification && (
        <ReconcileDialog
          isOpen={isReconcileOpen}
          onClose={closeReconcile}
          classification={classification}
          onApply={handleApply}
          onPurge={handlePurge}
          isApplying={reconcileApply.isPending}
          isPurging={reconcilePurge.isPending}
          error={reconcileError}
        />
      )}
    </>,
  );
}
