// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEntranceAnimation } from "./useEntranceAnimation";

beforeEach(() => {
  // jsdom does not implement requestAnimationFrame/cancelAnimationFrame
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    // Store the callback: tests can invoke it manually
    (globalThis as Record<string, unknown>).__pendingRaf = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useEntranceAnimation", () => {
  it("starts as false before RAF fires", () => {
    const { result } = renderHook(() => useEntranceAnimation());
    expect(result.current).toBe(false);
  });

  it("becomes true after requestAnimationFrame fires", () => {
    const { result } = renderHook(() => useEntranceAnimation());
    expect(result.current).toBe(false);

    act(() => {
      const cb = (globalThis as Record<string, unknown>).__pendingRaf as FrameRequestCallback;
      cb(0);
    });

    expect(result.current).toBe(true);
  });

  it("calls cancelAnimationFrame on unmount", () => {
    const { unmount } = renderHook(() => useEntranceAnimation());
    unmount();
    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalledWith(1);
  });
});
