import { useState, useLayoutEffect, useMemo, useCallback, type RefObject } from "react";

// Minimal fixed-row-height list virtualiser (#419, NFR-002). Only the rows
// intersecting the scroll viewport (plus a small overscan) are mounted, so a
// 500-case plan renders a bounded, windowed DOM regardless of plan size.
//
// We deliberately hand-roll this rather than pull in @tanstack/react-virtual:
// that library's hook returns non-memoizable functions that the repo's
// react-hooks compiler lint (incompatible-library, run with --max-warnings 0 and
// noInlineConfig) reports as a warning with no permitted in-code suppression. A
// fixed-height window is all this list needs and stays inside the lint budget.

export interface WindowedRow {
  index: number;
  start: number;
  size: number;
}

export interface WindowedRows {
  totalSize: number;
  virtualRows: WindowedRow[];
  // Cumulative offset of a row's top edge, used to scroll a row into view.
  offsetForIndex: (index: number) => number;
}

export function useWindowedRows(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
  rowSize: (index: number) => number,
  overscan = 8,
): WindowedRows {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Prefix sums of row offsets so each row's absolute top is an O(1) lookup and
  // the total height is exact even with mixed header/case row heights.
  const offsets = useMemo(() => {
    const arr = new Array<number>(count + 1);
    arr[0] = 0;
    for (let i = 0; i < count; i++) {
      arr[i + 1] = arr[i] + rowSize(i);
    }
    return arr;
  }, [count, rowSize]);

  const totalSize = offsets[count] ?? 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight || el.offsetHeight || 0);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : undefined;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [scrollRef]);

  const virtualRows = useMemo(() => {
    if (count === 0) return [];
    // Treat a not-yet-measured viewport as a generous window so the first paint
    // mounts a sensible slice rather than nothing.
    const height = viewportHeight > 0 ? viewportHeight : 600;
    const top = scrollTop;
    const bottom = top + height;

    // Binary search for the first row whose bottom edge is past the viewport top.
    let lo = 0;
    let hi = count - 1;
    let first = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] > top) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    let last = first;
    while (last < count - 1 && offsets[last] < bottom) {
      last++;
    }

    const start = Math.max(0, first - overscan);
    const end = Math.min(count - 1, last + overscan);

    const rows: WindowedRow[] = [];
    for (let i = start; i <= end; i++) {
      rows.push({ index: i, start: offsets[i], size: offsets[i + 1] - offsets[i] });
    }
    return rows;
  }, [count, offsets, scrollTop, viewportHeight, overscan]);

  const offsetForIndex = useCallback((index: number) => offsets[index] ?? 0, [offsets]);

  return { totalSize, virtualRows, offsetForIndex };
}
