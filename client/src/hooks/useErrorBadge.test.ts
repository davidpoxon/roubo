// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { countComponentErrors, useErrorBadge } from "./useErrorBadge";
import type { Bench } from "@roubo/shared";

vi.mock("./useBenches", () => ({
  useAllBenches: vi.fn(),
}));

import { useAllBenches } from "./useBenches";

function makeBench(components: Record<string, { status: string }>): Bench {
  return {
    id: 1,
    projectId: "p1",
    branch: "main",
    workspacePath: "/tmp",
    status: "active",
    ports: {},
    components: components as Bench["components"],
    createdAt: "2024-01-01",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
  };
}

describe("countComponentErrors", () => {
  it("returns 0 for undefined", () => {
    expect(countComponentErrors(undefined)).toBe(0);
  });

  it("returns 0 for empty bench list", () => {
    expect(countComponentErrors([])).toBe(0);
  });

  it("returns 0 when no components are in error", () => {
    const benches = [
      makeBench({ api: { status: "running" }, db: { status: "running" } }),
      makeBench({ web: { status: "stopped" } }),
    ];
    expect(countComponentErrors(benches)).toBe(0);
  });

  it("returns 1 when one component has error status", () => {
    const benches = [makeBench({ api: { status: "error" }, db: { status: "running" } })];
    expect(countComponentErrors(benches)).toBe(1);
  });

  it("counts errors across multiple benches", () => {
    const benches = [
      makeBench({ api: { status: "error" }, db: { status: "error" } }),
      makeBench({ web: { status: "running" } }),
      makeBench({ worker: { status: "error" } }),
    ];
    expect(countComponentErrors(benches)).toBe(3);
  });
});

describe("useErrorBadge", () => {
  const setBadgeCount = vi.fn();

  beforeEach(() => {
    setBadgeCount.mockClear();
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: { setBadgeCount },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
  });

  it("calls setBadgeCount with 0 when no benches are loaded", () => {
    vi.mocked(useAllBenches).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAllBenches
    >);
    renderHook(() => useErrorBadge());
    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });

  it("calls setBadgeCount with the error count when components are in error", () => {
    vi.mocked(useAllBenches).mockReturnValue({
      data: [makeBench({ api: { status: "error" }, db: { status: "running" } })],
    } as ReturnType<typeof useAllBenches>);
    renderHook(() => useErrorBadge());
    expect(setBadgeCount).toHaveBeenCalledWith(1);
  });

  it("does not throw when window.roubo is undefined", () => {
    Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
    vi.mocked(useAllBenches).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAllBenches
    >);
    expect(() => renderHook(() => useErrorBadge())).not.toThrow();
  });

  it("updates badge count when bench data changes between renders", () => {
    vi.mocked(useAllBenches).mockReturnValue({ data: undefined } as ReturnType<
      typeof useAllBenches
    >);
    const { rerender } = renderHook(() => useErrorBadge());
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);

    vi.mocked(useAllBenches).mockReturnValue({
      data: [makeBench({ api: { status: "error" } })],
    } as ReturnType<typeof useAllBenches>);
    rerender();
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });
});
