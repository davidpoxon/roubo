// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBenchViewState } from "./useBenchViewState";

const STORAGE_KEY = "roubo-bench-view-state";

beforeEach(() => {
  localStorage.clear();
});

describe("useBenchViewState", () => {
  it("returns undefined values when storage is empty", () => {
    const { result } = renderHook(() => useBenchViewState("proj", 1));
    expect(result.current.activeTab).toBeUndefined();
    expect(result.current.activeTerminalSessionId).toBeUndefined();
  });

  it("setActiveTab writes to localStorage and updates state", () => {
    const { result } = renderHook(() => useBenchViewState("proj", 1));

    act(() => {
      result.current.setActiveTab("info");
    });

    expect(result.current.activeTab).toBe("info");
    const store = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(store["proj:1"].activeTab).toBe("info");
  });

  it("a fresh hook instance reads the persisted activeTab from localStorage", () => {
    const { result: a } = renderHook(() => useBenchViewState("proj", 1));
    act(() => {
      a.current.setActiveTab("terminal");
    });

    const { result: b } = renderHook(() => useBenchViewState("proj", 1));
    expect(b.current.activeTab).toBe("terminal");
  });

  it("setActiveTerminalSessionId writes the session id to localStorage", () => {
    const { result } = renderHook(() => useBenchViewState("proj", 1));

    act(() => {
      result.current.setActiveTerminalSessionId("session-xyz");
    });

    expect(result.current.activeTerminalSessionId).toBe("session-xyz");
    const store = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(store["proj:1"].activeTerminalSessionId).toBe("session-xyz");
  });

  it("setActiveTerminalSessionId(null) clears the field without removing the entry", () => {
    const { result } = renderHook(() => useBenchViewState("proj", 1));
    act(() => {
      result.current.setActiveTab("terminal");
    });
    act(() => {
      result.current.setActiveTerminalSessionId("session-xyz");
    });

    act(() => {
      result.current.setActiveTerminalSessionId(null);
    });

    expect(result.current.activeTerminalSessionId).toBeUndefined();
    const store = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    // Entry for the bench still exists (activeTab preserved)
    expect(store["proj:1"].activeTab).toBe("terminal");
    expect(store["proj:1"].activeTerminalSessionId).toBeUndefined();
  });

  it("state for two different benches does not cross-contaminate", () => {
    const { result: bench1 } = renderHook(() => useBenchViewState("proj", 1));
    const { result: bench2 } = renderHook(() => useBenchViewState("proj", 2));

    act(() => {
      bench1.current.setActiveTab("components");
    });
    act(() => {
      bench2.current.setActiveTab("info");
    });

    expect(bench1.current.activeTab).toBe("components");
    expect(bench2.current.activeTab).toBe("info");
    const store = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(store["proj:1"].activeTab).toBe("components");
    expect(store["proj:2"].activeTab).toBe("info");
  });

  it("corrupted JSON in localStorage is handled gracefully", () => {
    localStorage.setItem(STORAGE_KEY, "not-valid-json{{{");

    const { result } = renderHook(() => useBenchViewState("proj", 1));

    expect(result.current.activeTab).toBeUndefined();
    expect(result.current.activeTerminalSessionId).toBeUndefined();
  });

  it("two concurrent instances do not clobber each other's fields", () => {
    // BenchDetail and TerminalTabs both call this hook independently.
    // Each must write only its own field without overwriting the other's.
    const { result: detailHook } = renderHook(() => useBenchViewState("proj", 1));
    act(() => {
      detailHook.current.setActiveTab("terminal");
    });

    const { result: terminalHook } = renderHook(() => useBenchViewState("proj", 1));
    act(() => {
      terminalHook.current.setActiveTerminalSessionId("session-1");
    });

    // Both fields must survive in localStorage
    const { result: reader } = renderHook(() => useBenchViewState("proj", 1));
    expect(reader.current.activeTab).toBe("terminal");
    expect(reader.current.activeTerminalSessionId).toBe("session-1");
  });

  it("re-reads the entry for the new benchKey when the hook is re-rendered with different args", () => {
    const { result, rerender } = renderHook(
      ({ projectId, benchId }: { projectId: string; benchId: number }) =>
        useBenchViewState(projectId, benchId),
      { initialProps: { projectId: "proj", benchId: 1 } },
    );

    act(() => {
      result.current.setActiveTab("inspection");
    });
    expect(result.current.activeTab).toBe("inspection");

    // Same hook instance, new benchKey — simulates react-router navigating
    // from /benches/1 to /benches/2 while BenchDetail stays mounted.
    rerender({ projectId: "proj", benchId: 2 });
    expect(result.current.activeTab).toBeUndefined();

    act(() => {
      result.current.setActiveTab("info");
    });
    expect(result.current.activeTab).toBe("info");

    // Navigating back restores bench 1's persisted tab.
    rerender({ projectId: "proj", benchId: 1 });
    expect(result.current.activeTab).toBe("inspection");
  });

  it("state for different projects does not cross-contaminate", () => {
    const { result: projA } = renderHook(() => useBenchViewState("proj-a", 1));
    const { result: projB } = renderHook(() => useBenchViewState("proj-b", 1));

    act(() => {
      projA.current.setActiveTab("inspection");
    });
    act(() => {
      projB.current.setActiveTab("info");
    });

    expect(projA.current.activeTab).toBe("inspection");
    expect(projB.current.activeTab).toBe("info");
  });
});
