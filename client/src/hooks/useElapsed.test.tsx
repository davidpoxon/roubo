// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useElapsed } from "./useElapsed";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useElapsed", () => {
  it("returns null when no timestamp provided", () => {
    const { result } = renderHook(() => useElapsed(undefined));
    expect(result.current).toBeNull();
  });

  it("returns null when active is false", () => {
    const ts = new Date(Date.now() - 5000).toISOString();
    const { result } = renderHook(() => useElapsed(ts, false));
    expect(result.current).toBeNull();
  });

  it("formats elapsed seconds under 60", () => {
    const ts = new Date(Date.now() - 5000).toISOString();
    const { result } = renderHook(() => useElapsed(ts));
    expect(result.current).toBe("5s");
  });

  it("formats elapsed minutes and seconds for >= 60 seconds", () => {
    const ts = new Date(Date.now() - 90000).toISOString();
    const { result } = renderHook(() => useElapsed(ts));
    expect(result.current).toBe("1m 30s");
  });

  it("formats exact minutes with 0 remainder seconds", () => {
    const ts = new Date(Date.now() - 120000).toISOString();
    const { result } = renderHook(() => useElapsed(ts));
    expect(result.current).toBe("2m 0s");
  });

  it("updates every second via interval", () => {
    const ts = new Date(Date.now() - 5000).toISOString();
    const { result } = renderHook(() => useElapsed(ts));
    expect(result.current).toBe("5s");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe("8s");
  });

  it("clears interval on unmount", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const ts = new Date(Date.now() - 1000).toISOString();
    const { unmount } = renderHook(() => useElapsed(ts));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("does not start interval when timestamp is undefined", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    renderHook(() => useElapsed(undefined));
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
