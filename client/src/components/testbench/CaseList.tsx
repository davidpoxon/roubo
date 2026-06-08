import { useRef, useState, useCallback, useMemo, useLayoutEffect, type KeyboardEvent } from "react";
import type { FlatRow } from "./rollup";
import { useWindowedRows } from "./useWindowedRows";
import CaseRow from "./CaseRow";
import ProgressBar from "./ProgressBar";

// Windowed, keyboard-navigable case list (#419, NFR-002 p95 < 300ms for 500
// cases). Only the rows intersecting the scroll viewport (plus a small overscan)
// are mounted via useWindowedRows, so a 500-case plan renders a bounded number of
// DOM nodes regardless of plan size.
//
// Keyboard model: the list is one tab stop (roving tabindex). ArrowUp/ArrowDown
// move focus between case rows (skipping the non-interactive level/priority
// headers); Home/End jump to the first/last case. The focused row gets a visible
// amber focus ring. Headers are decorative readouts and are never focusable.

const ROW_HEIGHT = 36; // case row
const LEVEL_HEIGHT = 44; // level header (taller, hosts the rollup bar)
const PRIORITY_HEIGHT = 32; // priority subheader

function rowSize(row: FlatRow): number {
  if (row.kind === "level") return LEVEL_HEIGHT;
  if (row.kind === "priority") return PRIORITY_HEIGHT;
  return ROW_HEIGHT;
}

export default function CaseList({
  rows,
  onSelect,
  selectedCaseId,
}: {
  rows: FlatRow[];
  // Lift the active case up to the host (#420): fired when a case row is
  // activated (click or Enter/Space) so the host can render its detail pane.
  onSelect?: (caseId: string) => void;
  // The case currently shown in the detail pane, highlighted distinctly from
  // the roving keyboard focus.
  selectedCaseId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set when a keyboard navigation should move DOM focus onto the focused row.
  // Gates the focus effect so it only fires for keyboard nav, never on initial
  // mount or when focus arrives natively from a tab/click.
  const pendingFocusRef = useRef(false);

  // Indices of the case rows, in order: the only focusable rows.
  const caseIndices = useMemo(
    () => rows.map((r, i) => (r.kind === "case" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );
  const [focusedIndex, setFocusedIndex] = useState<number>(() => caseIndices[0] ?? -1);

  const sizeAt = useCallback((index: number) => rowSize(rows[index]), [rows]);
  const { totalSize, virtualRows, offsetForIndex } = useWindowedRows(
    scrollRef,
    rows.length,
    sizeAt,
  );

  // Clamp to a row that actually exists. focusedIndex is state that survives a
  // rows change (the plan can refetch to a smaller plan while this list stays
  // mounted), so a stale index could point past the new case list. Falling back
  // to the first case keeps the render path (and the always-mounted focused row
  // below) from ever referencing a row that no longer exists. The stored state
  // resyncs on the next keyboard navigation (onKeyDown clamps via indexOf) or
  // when the list is tabbed into (onFocus updates it), so no effect is needed.
  const activeFocusIndex = caseIndices.includes(focusedIndex)
    ? focusedIndex
    : (caseIndices[0] ?? -1);

  // Always mount the focused row, even when a large Home/End jump leaves it
  // outside the current scroll window. Keyboard focus must be able to land on it
  // synchronously after the next commit; relying on the scroll-driven window to
  // re-render and mount it first is a race (the scroll event is async and is not
  // guaranteed to land before focus is applied), so the row would otherwise not
  // exist when focus runs. The windowed rows cover the visible case; this appends
  // the focused row only when the window does not already include it.
  const renderedRows = useMemo(() => {
    if (activeFocusIndex < 0 || virtualRows.some((r) => r.index === activeFocusIndex)) {
      return virtualRows;
    }
    const start = offsetForIndex(activeFocusIndex);
    const size = offsetForIndex(activeFocusIndex + 1) - start;
    return [...virtualRows, { index: activeFocusIndex, start, size }];
  }, [virtualRows, activeFocusIndex, offsetForIndex]);

  const moveFocus = useCallback(
    (target: number) => {
      if (target < 0) return;
      pendingFocusRef.current = true;
      setFocusedIndex(target);
      // Scroll the target into view. Focus itself is handled by the layout effect
      // below, which fires after the row (always mounted via renderedRows) commits.
      const el = scrollRef.current;
      if (el) {
        const top = offsetForIndex(target);
        const bottom = offsetForIndex(target + 1);
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      }
    },
    [offsetForIndex],
  );

  // Move DOM focus onto the focused row after it renders. Because the focused row
  // is always mounted (renderedRows), this lands synchronously on commit with no
  // dependence on requestAnimationFrame or scroll-event timing.
  useLayoutEffect(() => {
    if (!pendingFocusRef.current) return;
    const node = scrollRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${focusedIndex}"]`,
    );
    if (node) {
      node.focus();
      pendingFocusRef.current = false;
    }
  }, [focusedIndex]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (caseIndices.length === 0) return;
      const pos = caseIndices.indexOf(focusedIndex);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next =
          pos < 0 ? caseIndices[0] : caseIndices[Math.min(pos + 1, caseIndices.length - 1)];
        moveFocus(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = pos < 0 ? caseIndices[0] : caseIndices[Math.max(pos - 1, 0)];
        moveFocus(prev);
      } else if (e.key === "Home") {
        e.preventDefault();
        moveFocus(caseIndices[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        moveFocus(caseIndices[caseIndices.length - 1]);
      } else if (e.key === "Enter" || e.key === " ") {
        // Activate the focused case: open its detail pane (#420).
        const row = rows[focusedIndex];
        if (row?.kind === "case") {
          e.preventDefault();
          onSelect?.(row.row.case.id);
        }
      }
    },
    [caseIndices, focusedIndex, moveFocus, onSelect, rows],
  );

  return (
    <div
      ref={scrollRef}
      className="overflow-auto flex-1 min-h-0 rounded-lg ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/40 bg-stone-50 dark:bg-stone-900/30"
      role="group"
      aria-label="Test cases grouped by level and priority"
      onKeyDown={onKeyDown}
    >
      <div className="relative w-full" style={{ height: `${totalSize}px` }}>
        {renderedRows.map((item) => {
          const row = rows[item.index];
          const common = {
            className: "absolute top-0 left-0 w-full",
            style: { height: `${item.size}px`, transform: `translateY(${item.start}px)` },
          } as const;

          if (row.kind === "level") {
            return (
              <div key={row.key} {...common}>
                <div className="flex items-center gap-3 px-4 py-2 h-full bg-stone-100/80 dark:bg-stone-900/60">
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                    <span className="text-xs font-semibold text-stone-800 dark:text-stone-200">
                      {row.level}
                    </span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <ProgressBar counts={row.counts} label={`${row.counts.total} cases`} />
                  </div>
                </div>
              </div>
            );
          }

          if (row.kind === "priority") {
            return (
              <div key={row.key} {...common}>
                <div className="flex items-center gap-2 px-4 py-1.5 pl-8 h-full">
                  <span className="text-[10px] uppercase tracking-wider font-medium text-stone-400 dark:text-stone-600">
                    {row.priority}
                  </span>
                  <span className="text-[10px] font-mono text-stone-400 dark:text-stone-600 tabular-nums">
                    {row.counts.total}
                  </span>
                </div>
              </div>
            );
          }

          const isFocused = item.index === activeFocusIndex;
          const isSelected = row.row.case.id === selectedCaseId;
          return (
            <div key={row.key} {...common}>
              <div
                data-row-index={item.index}
                data-testid="case-row"
                role="button"
                aria-pressed={isSelected}
                tabIndex={isFocused ? 0 : -1}
                onFocus={() => setFocusedIndex(item.index)}
                onClick={() => onSelect?.(row.row.case.id)}
                className={`outline-none rounded-md mx-1 h-full flex items-center cursor-pointer transition-colors ${
                  isFocused
                    ? "ring-2 ring-amber-500 ring-inset bg-stone-100 dark:bg-stone-800/60"
                    : isSelected
                      ? "bg-amber-50 dark:bg-amber-950/30"
                      : "hover:bg-stone-100/70 dark:hover:bg-stone-800/40"
                }`}
              >
                <div className="w-full">
                  <CaseRow model={row.row} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
