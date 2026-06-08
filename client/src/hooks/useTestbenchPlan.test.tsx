// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useTestbenchPlan, useSetTestbenchFocus, testbenchPlanQueryKey } from "./useTestbenchPlan";

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
