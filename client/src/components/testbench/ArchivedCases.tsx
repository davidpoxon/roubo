import { useEffect, useRef } from "react";
import { Archive, Undo2 } from "lucide-react";
import { Button } from "react-aria-components";
import type { BenchResults, CaseResult } from "@roubo/shared/testbench-contracts";
import type { ArchivedCaseModel } from "./rollup";
import StatusIndicator from "./StatusIndicator";
import { caseLifecycleErrorMessage, useSetCaseLifecycle } from "../../hooks/useTestbenchPlan";

// Archived cases section for the TestBench review tab (FR-013, FR-017, NFR-003,
// and SATCA-FR-006/FR-007 via #769). Two different things end up archived, and
// this one section shows both rather than inventing a second surface:
//
//   1. Lifecycle-archived cases. A case retired or superseded in the source plan.
//      It is STILL in the plan, so its results are never flagged `orphaned` and
//      its marks, notes, and status override sit untouched on disk. The rollup
//      excludes it from every count and from the live list, so without this
//      section it would vanish from the panel entirely.
//   2. Orphaned results. A case REMOVED from the source plan whose recorded
//      results were retained on reconcile rather than deleted.
//
// Each entry states in text which of the two it is, and labels its state as
// words rather than by colour alone (WCAG 2.1 AA). Both kinds render their
// retained observation marks and notes, so an authored mark or note is never
// silently lost from the reviewer's view.
//
// A same-spec replacement is activatable only when it resolves to a live case in
// this plan: it then calls back into the panel's case selection, which reveals
// that case in the live list. A cross-spec replacement is named but not
// activatable, because the panel holds only this spec's plan, and so is a
// same-spec pointer whose target is absent from the plan or not itself live
// (#789), which would otherwise be a control that does nothing when activated.
//
// Focus lands here after a case is archived from the case detail pane (#775,
// SATCA-NFR-005). Retiring or superseding removes the case from the live list,
// which unmounts the control that applied the action and would otherwise drop
// focus to the document body. The panel hands this section the id of the case
// that just arrived; the matching entry takes focus, so the reviewer is put on
// the surface the case moved to, which is also where Restore now sits.
//
// Every colour token below is chosen to clear WCAG 2.1 AA (4.5:1) against the
// entry and section backgrounds in BOTH themes; the small state and metadata
// text used to sit at stone-400/stone-500, which measures as low as 2.5:1.
// e2e/e2e-flow/archival-contrast.spec.ts is the browser-rendered guard, because
// jsdom has no layout engine and so cannot decide the color-contrast rule. That
// guard reaches the state labels, the situation lines, the retained reason, the
// replacement reveal and Restore, and, since roubo-development#797, the pass/fail
// mark colours in ObservationMarks too: no fixture seam can render mark text (the
// seeded-results synthesizer writes an empty observationMarks map), so the spec
// marks two observations and retires the case in-app, then scans the entry the
// case lands on.
//
// Restore lives on the lifecycle entry (#772, SATCA-FR-021). It is here rather
// than in the case detail pane because retiring a case removes it from the live
// list, so the surface that applied the action cannot be the one that reverses
// it: this entry is where the archived case is still visible. Restore removes the
// lifecycle record from the source case file entirely, which is what makes the
// action a true reversal. Orphaned-result entries carry no Restore: a case
// removed from the plan has no record to clear, and re-adding it is an authoring
// act, not a lifecycle one.
//
// The section renders when at least one entry of either kind exists.
//
// It is height-capped with its own internal scroll (#832). The section sits in
// the panel's single flex column as a sibling of the live case list, and the
// list's own height floor is 0, so an uncapped section (one retirement reason
// running to a few paragraphs is enough) took the whole column and left the list
// at zero height with no rows reachable. Capping restores positive free space,
// which is what lets the list's flex-1 grow again, and the overflow resolves the
// section's automatic minimum size to 0, so a short window degrades by scrolling
// in here rather than by starving the list. Deliberately NOT shrink-0: that would
// reintroduce the starvation at small viewport heights.

const STATE_LABEL = {
  retired: "Retired",
  superseded: "Superseded",
} as const;

const LIFECYCLE_SITUATION =
  "Archived by lifecycle. Still in the source plan, excluded from the rollup.";
const ORPHAN_SITUATION =
  "Removed from the source plan. Results retained and excluded from the rollup, never deleted.";

function effectiveStatus(result: CaseResult): CaseResult["derivedStatus"] {
  return result.statusOverride?.status ?? result.derivedStatus;
}

function StateLabel({ children }: { children: string }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-700 dark:text-stone-200 bg-stone-200/70 dark:bg-stone-800/70 shrink-0">
      {children}
    </span>
  );
}

function Situation({ children }: { children: string }) {
  return <p className="mt-1 text-[11px] text-stone-600 dark:text-stone-400">{children}</p>;
}

function ObservationMarks({ result }: { result: CaseResult | undefined }) {
  const marks = Object.entries(result?.observationMarks ?? {});
  if (marks.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {marks.map(([observationId, mark]) => (
        <li
          key={observationId}
          className="flex items-center gap-2 font-mono text-[11px] text-stone-600 dark:text-stone-400"
        >
          <span className="truncate">{observationId}</span>
          <span
            className={
              mark.result === "pass"
                ? "font-semibold text-green-700 dark:text-green-400"
                : "font-semibold text-red-700 dark:text-red-400"
            }
          >
            {mark.result}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Notes({ result }: { result: CaseResult | undefined }) {
  const notes = result?.notes ?? [];
  if (notes.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {notes.map((note) => (
        <li
          key={note.id}
          className="whitespace-pre-wrap text-[12px] text-stone-600 dark:text-stone-400"
        >
          {note.text}
        </li>
      ))}
    </ul>
  );
}

const ENTRY_CLASS = "rounded-md bg-white/60 dark:bg-stone-900/40 px-3 py-2";

// One lifecycle-archived case: its id, its state as words, the status still
// recorded against it, the situation, the verbatim reason, and its replacement.
function LifecycleEntry({
  entry,
  result,
  onSelectCase,
  projectId,
  benchId,
  shouldFocus = false,
}: {
  entry: ArchivedCaseModel;
  result: CaseResult | undefined;
  onSelectCase?: (caseId: string) => void;
  // Both are needed to address the write; the panel supplies them. Omitted (e.g.
  // in a read-only render) the entry simply shows no Restore control.
  projectId?: string;
  benchId?: number;
  // True for the entry the case just moved into, so focus lands here rather than
  // on the body when the applying control unmounts (#775, AC4).
  shouldFocus?: boolean;
}) {
  const caseId = entry.case.id;
  const restore = useSetCaseLifecycle();
  // tabIndex -1 keeps the entry out of the tab order while still being a legal
  // programmatic focus target; the reviewer tabs on from here into Restore.
  const entryRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (shouldFocus) entryRef.current?.focus();
  }, [shouldFocus]);
  const restoreError = caseLifecycleErrorMessage(restore.error);
  const canRestore = projectId !== undefined && benchId !== undefined;
  // Only a replacement the rollup found to be present and live in this spec's
  // plan can be revealed: the panel holds this spec's plan alone, so a
  // slug-qualified pointer, or a same-spec one whose target is missing or itself
  // non-live, is named as text and left inert (#789).
  const revealId =
    entry.isRevealable && entry.replacementRef !== null && onSelectCase !== undefined
      ? entry.replacementRef.caseId
      : null;
  return (
    <li
      ref={entryRef}
      tabIndex={-1}
      data-testid={`archived-case-${caseId}`}
      className={`${ENTRY_CLASS} outline-none focus-visible:ring-2 focus-visible:ring-amber-500`}
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-stone-600 dark:text-stone-400 shrink-0">
          {caseId}
        </span>
        <StateLabel>{STATE_LABEL[entry.state]}</StateLabel>
        <StatusIndicator status={entry.status} />
      </div>
      <Situation>{LIFECYCLE_SITUATION}</Situation>
      {entry.reason !== null && (
        <p
          data-testid={`archived-reason-${caseId}`}
          className="mt-1 whitespace-pre-wrap text-[12px] text-stone-600 dark:text-stone-400"
        >
          {entry.reason}
        </p>
      )}
      {entry.replacement !== null &&
        (revealId !== null && onSelectCase !== undefined ? (
          <Button
            data-testid={`archived-replacement-${caseId}`}
            onPress={() => onSelectCase(revealId)}
            className="mt-1 inline-flex items-center rounded px-1 -mx-1 text-[12px] font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 transition-colors hover:text-amber-800 dark:hover:text-amber-300 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 cursor-pointer"
          >
            Replaced by {revealId}
          </Button>
        ) : (
          <p
            data-testid={`archived-replacement-${caseId}`}
            className="mt-1 text-[12px] text-stone-600 dark:text-stone-400"
          >
            Replaced by {entry.replacement}
          </p>
        ))}
      <ObservationMarks result={result} />
      <Notes result={result} />
      {canRestore && (
        <div className="mt-2">
          <Button
            data-testid={`archived-restore-${caseId}`}
            isDisabled={restore.isPending}
            onPress={() =>
              restore.mutate({
                projectId,
                benchId,
                caseId,
                lifecycle: null,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-stone-700 dark:text-stone-200 bg-stone-200/70 dark:bg-stone-800/70 hover:bg-stone-200 dark:hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed outline-none transition-colors focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <Undo2 aria-hidden="true" className="w-3.5 h-3.5" />
            {restore.isPending ? "Restoring..." : "Restore"}
          </Button>
        </div>
      )}
      {restoreError && (
        <p
          role="alert"
          data-testid={`archived-restore-error-${caseId}`}
          className="mt-1 text-[12px] text-red-700 dark:text-red-400"
        >
          {restoreError}
        </p>
      )}
    </li>
  );
}

export default function ArchivedCases({
  results,
  archived = [],
  onSelectCase,
  projectId,
  benchId,
  focusCaseId,
}: {
  results: BenchResults | null;
  archived?: ArchivedCaseModel[];
  onSelectCase?: (caseId: string) => void;
  // Supplied by the panel so a lifecycle-archived entry can offer Restore
  // (#772). Optional, so a read-only render of the section still works.
  projectId?: string;
  benchId?: number;
  // The case that just arrived here, so its entry can take focus (#775, AC4).
  // Undefined on an ordinary render, which leaves focus exactly where it was.
  focusCaseId?: string;
}) {
  const orphans = results
    ? Object.entries(results.caseResults).filter(([, result]) => result.orphaned === true)
    : [];

  const total = archived.length + orphans.length;
  if (total === 0) return null;

  return (
    <section
      data-testid="archived-cases"
      aria-label="Archived cases"
      className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/40 dark:bg-stone-900/30 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <Archive size={13} className="text-stone-600 dark:text-stone-400 shrink-0" aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-600 dark:text-stone-300">
          Archived
        </span>
        <span className="font-mono text-[11px] text-stone-600 dark:text-stone-400">{total}</span>
      </div>
      <p className="mt-1 text-[11px] text-stone-600 dark:text-stone-400 leading-relaxed">
        Excluded from the rollup and from the live case list. Recorded marks, notes, and status
        overrides are retained, never deleted.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {archived.map((entry) => (
          <LifecycleEntry
            key={entry.case.id}
            entry={entry}
            result={results?.caseResults[entry.case.id]}
            onSelectCase={onSelectCase}
            projectId={projectId}
            benchId={benchId}
            shouldFocus={focusCaseId === entry.case.id}
          />
        ))}
        {orphans.map(([caseId, result]) => (
          <li key={caseId} data-testid={`archived-case-${caseId}`} className={ENTRY_CLASS}>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-stone-600 dark:text-stone-400 shrink-0">
                {caseId}
              </span>
              <StateLabel>Removed from plan</StateLabel>
              <StatusIndicator status={effectiveStatus(result)} />
            </div>
            <Situation>{ORPHAN_SITUATION}</Situation>
            <ObservationMarks result={result} />
            <Notes result={result} />
          </li>
        ))}
      </ul>
    </section>
  );
}
