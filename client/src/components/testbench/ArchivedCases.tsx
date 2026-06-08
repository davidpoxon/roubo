import { Archive } from "lucide-react";
import type { BenchResults, CaseResult } from "@roubo/shared/testbench-contracts";
import StatusIndicator from "./StatusIndicator";

// Archived (orphaned) cases section for the TestBench review tab (FR-013, FR-017,
// NFR-003). After a reconcile, a case removed from the source plan keeps its
// recorded results on disk, flagged `orphaned`, and is excluded from the rollup.
// Those results would otherwise be invisible in the panel because the case list
// iterates the live plan. This read-only section surfaces each orphaned case's id,
// its effective status (override wins over derived), its recorded observation
// marks, and its notes, so an authored mark or note is never silently lost from
// the reviewer's view.
//
// The section renders only when at least one orphaned result exists.

function effectiveStatus(result: CaseResult): CaseResult["derivedStatus"] {
  return result.statusOverride?.status ?? result.derivedStatus;
}

function ObservationMarks({ result }: { result: CaseResult }) {
  const marks = Object.entries(result.observationMarks);
  if (marks.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {marks.map(([observationId, mark]) => (
        <li
          key={observationId}
          className="flex items-center gap-2 font-mono text-[11px] text-stone-500 dark:text-stone-500"
        >
          <span className="truncate">{observationId}</span>
          <span
            className={
              mark.result === "pass"
                ? "font-semibold text-green-600 dark:text-green-400"
                : "font-semibold text-red-600 dark:text-red-400"
            }
          >
            {mark.result}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Notes({ result }: { result: CaseResult }) {
  if (result.notes.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {result.notes.map((note) => (
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

export default function ArchivedCases({ results }: { results: BenchResults | null }) {
  const orphans = results
    ? Object.entries(results.caseResults).filter(([, result]) => result.orphaned === true)
    : [];

  if (orphans.length === 0) return null;

  return (
    <section
      data-testid="archived-cases"
      aria-label="Archived cases"
      className="rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-100/40 dark:bg-stone-900/30 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <Archive size={13} className="text-stone-500 shrink-0" aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
          Archived
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-500">
          {orphans.length}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
        Removed from the source plan. Results retained and excluded from the rollup, never deleted.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {orphans.map(([caseId, result]) => (
          <li
            key={caseId}
            data-testid={`archived-case-${caseId}`}
            className="rounded-md bg-white/60 dark:bg-stone-900/40 px-3 py-2"
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-stone-400 dark:text-stone-600 shrink-0">
                {caseId}
              </span>
              <StatusIndicator status={effectiveStatus(result)} />
            </div>
            <ObservationMarks result={result} />
            <Notes result={result} />
          </li>
        ))}
      </ul>
    </section>
  );
}
