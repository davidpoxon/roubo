// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppBadge } from "./useAppBadge";
import type { Bench } from "@roubo/shared";

vi.mock("./useBenches", () => ({
  useAllBenches: vi.fn(),
}));

import { useAllBenches } from "./useBenches";

function makeBench(notifications: Bench["notifications"] = []): Bench {
  return {
    id: 1,
    projectId: "p1",
    branch: "main",
    workspacePath: "/tmp",
    status: "active",
    ports: {},
    components: {} as Bench["components"],
    createdAt: "2024-01-01",
    provisioningSteps: [],
    teardownSteps: [],
    notifications,
  };
}

let notifCounter = 0;
function makeNotification(priority: "action-needed" | "info"): Bench["notifications"][number] {
  return {
    id: `n${++notifCounter}`,
    type: "claude-waiting",
    priority,
    createdAt: "2024-01-01",
  };
}

describe("useAppBadge", () => {
  const setBadgeCount = vi.fn();

  beforeEach(() => {
    setBadgeCount.mockClear();
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: { setBadgeCount },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: undefined,
    });
  });

  it("calls setBadgeCount with 0 when no benches are loaded", () => {
    vi.mocked(useAllBenches).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAllBenches
    >);
    renderHook(() => useAppBadge());
    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });

  it("calls setBadgeCount with 0 when no action-needed notifications exist", () => {
    vi.mocked(useAllBenches).mockReturnValue({
      data: [makeBench([makeNotification("info")])],
    } as ReturnType<typeof useAllBenches>);
    renderHook(() => useAppBadge());
    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });

  it("counts action-needed notifications", () => {
    vi.mocked(useAllBenches).mockReturnValue({
      data: [makeBench([makeNotification("action-needed"), makeNotification("info")])],
    } as ReturnType<typeof useAllBenches>);
    renderHook(() => useAppBadge());
    expect(setBadgeCount).toHaveBeenCalledWith(1);
  });

  it("counts action-needed notifications across multiple benches", () => {
    vi.mocked(useAllBenches).mockReturnValue({
      data: [
        makeBench([makeNotification("action-needed")]),
        makeBench([makeNotification("action-needed"), makeNotification("action-needed")]),
      ],
    } as ReturnType<typeof useAllBenches>);
    renderHook(() => useAppBadge());
    expect(setBadgeCount).toHaveBeenCalledWith(3);
  });

  it("does not throw when window.roubo is undefined", () => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: undefined,
    });
    vi.mocked(useAllBenches).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAllBenches
    >);
    expect(() => renderHook(() => useAppBadge())).not.toThrow();
  });

  it("updates badge count when bench data changes between renders", () => {
    vi.mocked(useAllBenches).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAllBenches
    >);
    const { rerender } = renderHook(() => useAppBadge());
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);

    vi.mocked(useAllBenches).mockReturnValue({
      data: [makeBench([makeNotification("action-needed")])],
    } as ReturnType<typeof useAllBenches>);
    rerender();
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });
});
