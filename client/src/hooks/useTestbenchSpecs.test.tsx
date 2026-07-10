// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import {
  useTestbenchSpecs,
  useManualPathValidation,
  partitionSpecs,
  deriveSpecSummary,
} from "./useTestbenchSpecs";
import type {
  DiscoveredSpec,
  InvalidSpec,
  ManualPathValidation,
  SpecStatusCounts,
  SpecVerification,
} from "../lib/api";

// Build a verification payload with sensible defaults so each test states only
// the fields it cares about (#482/#483).
function verification(
  over: Partial<Omit<SpecVerification, "statusCounts">> & {
    statusCounts?: Partial<SpecStatusCounts>;
  } = {},
): SpecVerification {
  const { statusCounts, ...rest } = over;
  const counts: SpecStatusCounts = {
    not_started: 0,
    in_progress: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    ...(statusCounts ?? {}),
  };
  return {
    classification: "needs-attention",
    resultsPresent: true,
    resultsValid: true,
    planHashMatch: true,
    recoveryReason: null,
    aggregationError: false,
    ...rest,
    statusCounts: counts,
  };
}

function spec(over: Partial<DiscoveredSpec> = {}): DiscoveredSpec {
  return {
    slug: "s",
    path: `/repo/.specifications/${over.slug ?? "s"}/test-cases.json`,
    caseCount: 0,
    verification: verification(),
    ...over,
  };
}

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
      {
        slug: "testbench",
        path: "/repo/.specifications/testbench/test-cases.json",
        caseCount: 3,
        verification: verification({ statusCounts: { passed: 3 } }),
      },
    ];
    mockedApi.fetchSpecs.mockResolvedValue({ specs, invalid: [] });

    const { result } = renderHookWithProviders(() => useTestbenchSpecs("p1", true));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchSpecs).toHaveBeenCalledWith("p1");
    expect(result.current.data).toEqual({ specs, invalid: [] });
  });

  it("surfaces present-but-invalid specs alongside the valid ones", async () => {
    const invalid: InvalidSpec[] = [
      {
        slug: "broken",
        path: "/repo/.specifications/broken/test-cases.json",
        errors: ["cases.0.level: Invalid input"],
      },
    ];
    mockedApi.fetchSpecs.mockResolvedValue({ specs: [], invalid });

    const { result } = renderHookWithProviders(() => useTestbenchSpecs("p1", true));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ specs: [], invalid });
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

describe("partitionSpecs", () => {
  it("splits specs by verification.classification only", () => {
    const specs = [
      spec({ slug: "a", verification: verification({ classification: "needs-attention" }) }),
      spec({ slug: "b", verification: verification({ classification: "all-passed" }) }),
      spec({ slug: "c", verification: verification({ classification: "needs-attention" }) }),
      spec({ slug: "d", verification: verification({ classification: "all-passed" }) }),
    ];
    const { needsAttention, allPassed } = partitionSpecs(specs);
    expect(needsAttention.map((s) => s.slug)).toEqual(["a", "c"]);
    expect(allPassed.map((s) => s.slug)).toEqual(["b", "d"]);
  });

  it("preserves input order within each group", () => {
    const specs = [
      spec({ slug: "z", verification: verification({ classification: "all-passed" }) }),
      spec({ slug: "y", verification: verification({ classification: "all-passed" }) }),
      spec({ slug: "x", verification: verification({ classification: "needs-attention" }) }),
    ];
    const { needsAttention, allPassed } = partitionSpecs(specs);
    expect(allPassed.map((s) => s.slug)).toEqual(["z", "y"]);
    expect(needsAttention.map((s) => s.slug)).toEqual(["x"]);
  });

  it("returns empty groups for an empty list", () => {
    expect(partitionSpecs([])).toEqual({ needsAttention: [], allPassed: [] });
  });
});

describe("deriveSpecSummary", () => {
  it("reports 'no results yet' with a hollow marker when no sidecar is present", () => {
    const s = spec({ caseCount: 4, verification: verification({ resultsPresent: false }) });
    expect(deriveSpecSummary(s)).toEqual({ marker: "none", text: "no results yet", failed: 0 });
  });

  it("reports 'results stale' with a stale marker when a valid sidecar mismatches the plan hash", () => {
    const s = spec({
      caseCount: 29,
      verification: verification({
        resultsPresent: true,
        resultsValid: true,
        planHashMatch: false,
        statusCounts: { passed: 29 },
      }),
    });
    expect(deriveSpecSummary(s)).toEqual({ marker: "stale", text: "results stale", failed: 0 });
  });

  it("reports 'All M passed' with a passed marker for an all-passed spec", () => {
    const s = spec({
      caseCount: 81,
      verification: verification({ classification: "all-passed", statusCounts: { passed: 81 } }),
    });
    expect(deriveSpecSummary(s)).toEqual({ marker: "passed", text: "All 81 passed", failed: 0 });
  });

  it("reports 'P of M passed' with a progress marker when nothing has failed", () => {
    const s = spec({
      caseCount: 63,
      verification: verification({ statusCounts: { passed: 58, in_progress: 2, not_started: 3 } }),
    });
    expect(deriveSpecSummary(s)).toEqual({
      marker: "progress",
      text: "58 of 63 passed",
      failed: 0,
    });
  });

  it("uses the failed marker and carries the failure count when cases have failed", () => {
    const s = spec({
      caseCount: 52,
      verification: verification({ statusCounts: { passed: 41, failed: 3, not_started: 8 } }),
    });
    expect(deriveSpecSummary(s)).toEqual({ marker: "failed", text: "41 of 52 passed", failed: 3 });
  });

  it("prefers the no-results state over a stale hash when the sidecar is absent", () => {
    const s = spec({
      caseCount: 5,
      verification: verification({
        resultsPresent: false,
        resultsValid: false,
        planHashMatch: false,
      }),
    });
    expect(deriveSpecSummary(s).marker).toBe("none");
  });
});
