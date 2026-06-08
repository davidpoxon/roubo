// @vitest-environment jsdom
//
// #419 NFR-002: the windowing hook mounts only the rows intersecting the
// viewport, so a large list stays bounded in the DOM.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { type RefObject } from "react";
import { useWindowedRows } from "./useWindowedRows";

const VIEWPORT = 400;
const ROW = 40;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => VIEWPORT,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A stable ref to a real scroll element, created once outside render so we never
// touch ref.current during render.
function makeScrollRef(): RefObject<HTMLElement | null> {
  return { current: document.createElement("div") };
}

function useHarness(count: number, ref: RefObject<HTMLElement | null>) {
  return useWindowedRows(ref, count, () => ROW, 4);
}

describe("useWindowedRows", () => {
  it("computes an exact total size from the row sizer", () => {
    const ref = makeScrollRef();
    const { result } = renderHook(() => useHarness(500, ref));
    expect(result.current.totalSize).toBe(500 * ROW);
  });

  it("mounts only a bounded window for a 500-row list", () => {
    const ref = makeScrollRef();
    const { result } = renderHook(() => useHarness(500, ref));
    // viewport 400 / row 40 = 10 visible + overscan on both sides; far fewer
    // than the full 500.
    expect(result.current.virtualRows.length).toBeGreaterThan(0);
    expect(result.current.virtualRows.length).toBeLessThan(60);
  });

  it("starts the window at the top by default", () => {
    const ref = makeScrollRef();
    const { result } = renderHook(() => useHarness(500, ref));
    expect(result.current.virtualRows[0].index).toBe(0);
    expect(result.current.virtualRows[0].start).toBe(0);
  });

  it("returns an empty window for a zero-length list", () => {
    const ref = makeScrollRef();
    const { result } = renderHook(() => useHarness(0, ref));
    expect(result.current.virtualRows).toEqual([]);
    expect(result.current.totalSize).toBe(0);
  });

  it("offsetForIndex returns the cumulative top of a row", () => {
    const ref = makeScrollRef();
    const { result } = renderHook(() => useHarness(10, ref));
    expect(result.current.offsetForIndex(0)).toBe(0);
    expect(result.current.offsetForIndex(3)).toBe(3 * ROW);
  });
});
