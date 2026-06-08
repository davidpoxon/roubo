// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useTestbenchSpecs, useManualPathValidation } from "./useTestbenchSpecs";
import type { DiscoveredSpec, ManualPathValidation } from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchSpecs: vi.fn(), validateSpecPath: vi.fn() };
});
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useTestbenchSpecs", () => {
  it("returns the discovered specs when enabled", async () => {
    const specs: DiscoveredSpec[] = [
      { slug: "testbench", path: "/repo/.specifications/testbench/test-cases.json", caseCount: 3 },
    ];
    mockedApi.fetchSpecs.mockResolvedValue({ specs });

    const { result } = renderHookWithProviders(() => useTestbenchSpecs("p1", true));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchSpecs).toHaveBeenCalledWith("p1");
    expect(result.current.data).toEqual(specs);
  });

  it("does not fetch while disabled", () => {
    renderHookWithProviders(() => useTestbenchSpecs("p1", false));
    expect(mockedApi.fetchSpecs).not.toHaveBeenCalled();
  });

  it("does not fetch when projectId is empty", () => {
    renderHookWithProviders(() => useTestbenchSpecs("", true));
    expect(mockedApi.fetchSpecs).not.toHaveBeenCalled();
  });
});

describe("useManualPathValidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts idle for an empty path", () => {
    const { result } = renderHookWithProviders(() => useManualPathValidation("p1", "", true));
    expect(result.current).toEqual({ status: "idle" });
    expect(mockedApi.validateSpecPath).not.toHaveBeenCalled();
  });

  it("stays idle while disabled even with a path", () => {
    const { result } = renderHookWithProviders(() =>
      useManualPathValidation("p1", ".specifications/x/test-cases.json", false),
    );
    expect(result.current).toEqual({ status: "idle" });
    expect(mockedApi.validateSpecPath).not.toHaveBeenCalled();
  });

  it("transitions idle -> validating -> valid for a contract-valid path", async () => {
    const ok: ManualPathValidation = { ok: true, slug: "testbench", caseCount: 5 };
    mockedApi.validateSpecPath.mockResolvedValue(ok);

    const { result } = renderHookWithProviders(() =>
      useManualPathValidation("p1", ".specifications/testbench/test-cases.json", true),
    );

    // Synchronously validating before the debounce fires.
    expect(result.current.status).toBe("validating");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current).toEqual({
      status: "valid",
      slug: "testbench",
      caseCount: 5,
      path: ".specifications/testbench/test-cases.json",
    });
    expect(mockedApi.validateSpecPath).toHaveBeenCalledWith(
      "p1",
      ".specifications/testbench/test-cases.json",
    );
  });

  it("transitions to invalid with the server-supplied error messages", async () => {
    const bad: ManualPathValidation = {
      ok: false,
      errors: ["path escapes the project repository"],
    };
    mockedApi.validateSpecPath.mockResolvedValue(bad);

    const { result } = renderHookWithProviders(() =>
      useManualPathValidation("p1", "../outside/test-cases.json", true),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current).toEqual({
      status: "invalid",
      errors: ["path escapes the project repository"],
    });
  });

  it("debounces: a single in-flight request for the final value", async () => {
    mockedApi.validateSpecPath.mockResolvedValue({ ok: true, slug: "s", caseCount: 1 });

    const { rerender } = renderHookWithProviders(
      ({ path }: { path: string }) => useManualPathValidation("p1", path, true),
      { initialProps: { path: ".specifications/a/test-cases.json" } },
    );
    rerender({ path: ".specifications/ab/test-cases.json" });
    rerender({ path: ".specifications/abc/test-cases.json" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockedApi.validateSpecPath).toHaveBeenCalledTimes(1);
    expect(mockedApi.validateSpecPath).toHaveBeenCalledWith(
      "p1",
      ".specifications/abc/test-cases.json",
    );
  });
});
