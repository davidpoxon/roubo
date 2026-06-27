// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBenchViewState } from "./useBenchViewState";

const STORAGE_KEY = "roubo-bench-view-state";

beforeEach(() => {
  localStorage.clear();
});

describe("useBenchViewState headerCollapsed (#805)", () => {
  it("defaults headerCollapsed to false", () => {
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    expect(result.current.headerCollapsed).toBe(false);
  });

  it("persists headerCollapsed to localStorage under the per-bench key", () => {
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    act(() => result.current.setHeaderCollapsed(true));
    expect(result.current.headerCollapsed).toBe(true);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored["proj-1:1"].headerCollapsed).toBe(true);
  });

  it("reads back a previously persisted collapsed state", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "proj-1:2": { headerCollapsed: true } }));
    const { result } = renderHook(() => useBenchViewState("proj-1", 2));
    expect(result.current.headerCollapsed).toBe(true);
  });

  it("keeps headerCollapsed isolated per bench", () => {
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    act(() => result.current.setHeaderCollapsed(true));
    const other = renderHook(() => useBenchViewState("proj-1", 9));
    expect(other.result.current.headerCollapsed).toBe(false);
  });

  it("does not clobber other persisted fields when toggling", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "proj-1:1": { activeTab: "info" } }));
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    act(() => result.current.setHeaderCollapsed(true));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored["proj-1:1"]).toEqual({ activeTab: "info", headerCollapsed: true });
  });
});

describe("useBenchViewState testbenchViewMode (#359)", () => {
  it("leaves testbenchViewMode undefined until a view is picked (first-visit signal)", () => {
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    expect(result.current.testbenchViewMode).toBeUndefined();
  });

  it("persists testbenchViewMode to localStorage under the per-bench key", () => {
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    act(() => result.current.setTestbenchViewMode("cases"));
    expect(result.current.testbenchViewMode).toBe("cases");
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored["proj-1:1"].testbenchViewMode).toBe("cases");
  });

  it("reads back a previously persisted view", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "proj-1:2": { testbenchViewMode: "batches" } }),
    );
    const { result } = renderHook(() => useBenchViewState("proj-1", 2));
    expect(result.current.testbenchViewMode).toBe("batches");
  });

  it("keeps testbenchViewMode isolated per bench", () => {
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    act(() => result.current.setTestbenchViewMode("cases"));
    const other = renderHook(() => useBenchViewState("proj-1", 9));
    expect(other.result.current.testbenchViewMode).toBeUndefined();
  });

  it("does not clobber other persisted fields when setting the view", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "proj-1:1": { activeTab: "info" } }));
    const { result } = renderHook(() => useBenchViewState("proj-1", 1));
    act(() => result.current.setTestbenchViewMode("batches"));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored["proj-1:1"]).toEqual({ activeTab: "info", testbenchViewMode: "batches" });
  });
});
