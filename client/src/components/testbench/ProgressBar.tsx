import type { StatusCounts } from "./rollup";

// Slim segmented progress bar (DESIGN.md "Progress bar", lines 382-404).
//
// A non-interactive, non-focusable readout: passed / failed / in-progress
// segments over a stone track, with a JetBrains Mono count label. Remaining
// (not_started + blocked) is the bare track. Colour is paired with an
// accessible text summary so the readout never relies on colour alone
// (WCAG 2.1 AA). When the group has no cases the whole bar dims to 30% per the
// DESIGN.md disabled state.

function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

export default function ProgressBar({ counts, label }: { counts: StatusCounts; label: string }) {
  const { total, passed, failed, in_progress } = counts;
  const remaining = total - passed - failed - in_progress;
  const isEmpty = total === 0;

  // Mono count summary, e.g. "3/4 passed". Always shows the passed/total ratio.
  const ratio = `${passed}/${total}`;
  const ariaLabel = `${label}: ${passed} passed, ${failed} failed, ${in_progress} in progress, ${remaining} remaining of ${total}`;

  return (
    <div className={`flex items-center gap-3 ${isEmpty ? "opacity-30" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600 shrink-0">
        {label}
      </span>
      <div
        role="img"
        aria-label={ariaLabel}
        className="flex h-1.5 flex-1 min-w-16 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700"
      >
        {passed > 0 && (
          <span className="h-full bg-green-500" style={{ width: `${pct(passed, total)}%` }} />
        )}
        {failed > 0 && (
          <span className="h-full bg-red-500" style={{ width: `${pct(failed, total)}%` }} />
        )}
        {in_progress > 0 && (
          <span className="h-full bg-amber-500" style={{ width: `${pct(in_progress, total)}%` }} />
        )}
      </div>
      <span
        aria-hidden="true"
        className="font-mono text-[11px] text-stone-600 dark:text-stone-400 shrink-0 tabular-nums"
      >
        {ratio}
      </span>
    </div>
  );
}
