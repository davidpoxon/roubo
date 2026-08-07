// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import {
  useTestbenchPlan,
  useSetTestbenchFocus,
  useSetCaseLifecycle,
  testbenchPlanQueryKey,
} from "./useTestbenchPlan";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

const planResponse = {
  plan: { $schema: "x", schemaVersion: "1.0.0", specSlug: "demo", cases: [] },
  results: null,
  stale: true,
  planHash: "abc123",
  recovered: false,
};

describe("useTestbenchPlan", () => {
  it("fetches the plan for a project and bench and exposes the stale flag", async () => {
    mockedApi.fetchTestbenchPlan.mockResolvedValue(planResponse as never);
    const { result } = renderHookWithProviders(() => useTestbenchPlan("p1", 3));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchTestbenchPlan).toHaveBeenCalledWith("p1", 3);
    expect(result.current.data?.stale).toBe(true);
  });

  it("does not retry on failure", async () => {
    mockedApi.fetchTestbenchPlan.mockRejectedValue(new Error("boom") as never);
    const { result } = renderHookWithProviders(() => useTestbenchPlan("p1", 3));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.fetchTestbenchPlan).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled, then fetches once enabled flips true (#500)", async () => {
    mockedApi.fetchTestbenchPlan.mockResolvedValue(planResponse as never);
    const { result, rerender } = renderHookWithProviders(
      ({ enabled }: { enabled: boolean }) => useTestbenchPlan("p1", 3, { enabled }),
      { initialProps: { enabled: false } },
    );

    // Disabled: the query is gated, so no request is made.
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchTestbenchPlan).not.toHaveBeenCalled();

    // The bench-detail poller flips status to ready -> enabled becomes true.
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchTestbenchPlan).toHaveBeenCalledWith("p1", 3);
  });
});

describe("testbenchPlanQueryKey", () => {
  it("namespaces the cache by project and bench", () => {
    expect(testbenchPlanQueryKey("p1", 3)).toEqual(["testbenchPlan", "p1", 3]);
  });
});

describe("useSetTestbenchFocus", () => {
  it("PUTs the focus endpoint with the chosen spec path", async () => {
    mockedApi.setTestbenchFocus.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useSetTestbenchFocus());
    result.current.mutate({
      projectId: "p1",
      benchId: 3,
      focusedSpecPath: "/repo/.specifications/billing/test-cases.json",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.setTestbenchFocus).toHaveBeenCalledWith(
      "p1",
      3,
      "/repo/.specifications/billing/test-cases.json",
    );
  });

  it("invalidates the plan, bench-detail, and bench-list queries on success", async () => {
    mockedApi.setTestbenchFocus.mockResolvedValue({} as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useSetTestbenchFocus(), { queryClient });
    result.current.mutate({
      projectId: "p1",
      benchId: 3,
      focusedSpecPath: "/repo/.specifications/billing/test-cases.json",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["testbenchPlan", "p1", 3] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["bench", "p1", 3] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["benches"] });
  });
});

// #772 (SATCA-FR-019/FR-021, SATCA-TC-056): the lifecycle mutation sends the
// fingerprint from the cached plan (the view the reviewer actually acted on) as
// the If-Match precondition, and invalidates the plan on success rather than
// guessing at the new rollup.
describe("useSetCaseLifecycle", () => {
  const cached = { ...planResponse, caseFileFingerprint: "fp-loaded" };

  it("sends the cached plan's fingerprint as the precondition", async () => {
    mockedApi.setCaseLifecycle.mockResolvedValue({} as never);
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey("p1", 3), cached);

    const { result } = renderHookWithProviders(() => useSetCaseLifecycle(), { queryClient });
    result.current.mutate({
      projectId: "p1",
      benchId: 3,
      caseId: "TC-001",
      lifecycle: { state: "retired", reason: "obsolete" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.setCaseLifecycle).toHaveBeenCalledWith(
      "p1",
      3,
      "TC-001",
      { state: "retired", reason: "obsolete" },
      "fp-loaded",
    );
  });

  it("sends a null lifecycle to restore", async () => {
    mockedApi.setCaseLifecycle.mockResolvedValue({} as never);
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey("p1", 3), cached);

    const { result } = renderHookWithProviders(() => useSetCaseLifecycle(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 3, caseId: "TC-001", lifecycle: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.setCaseLifecycle).toHaveBeenCalledWith("p1", 3, "TC-001", null, "fp-loaded");
  });

  it("refuses to write when the cached plan carries no fingerprint", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey("p1", 3), planResponse);

    const { result } = renderHookWithProviders(() => useSetCaseLifecycle(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 3, caseId: "TC-001", lifecycle: null });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.setCaseLifecycle).not.toHaveBeenCalled();
  });

  it("invalidates the plan query on success", async () => {
    mockedApi.setCaseLifecycle.mockResolvedValue({} as never);
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey("p1", 3), cached);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useSetCaseLifecycle(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 3, caseId: "TC-001", lifecycle: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["testbenchPlan", "p1", 3] });
  });

  // The invalidation refetch is asynchronous, so a second action fired in the gap
  // must not re-send the pre-write precondition and be refused with a 409 for the
  // app's own write. Seeding the returned fingerprint closes that window.
  it("seeds the returned fingerprint so a back-to-back action sends the new precondition", async () => {
    mockedApi.setCaseLifecycle.mockResolvedValue({ caseFileFingerprint: "fp-after" } as never);
    const queryClient = makeQueryClient();
    queryClient.setQueryData(testbenchPlanQueryKey("p1", 3), cached);

    const { result } = renderHookWithProviders(() => useSetCaseLifecycle(), { queryClient });
    result.current.mutate({
      projectId: "p1",
      benchId: 3,
      caseId: "TC-001",
      lifecycle: { state: "retired", reason: "obsolete" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryData<typeof cached>(testbenchPlanQueryKey("p1", 3))?.caseFileFingerprint,
    ).toBe("fp-after");

    // A second action, before any refetch lands, carries the post-write value.
    result.current.mutate({ projectId: "p1", benchId: 3, caseId: "TC-002", lifecycle: null });
    await waitFor(() =>
      expect(mockedApi.setCaseLifecycle).toHaveBeenLastCalledWith(
        "p1",
        3,
        "TC-002",
        null,
        "fp-after",
      ),
    );
  });
});
