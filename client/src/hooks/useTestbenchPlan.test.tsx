// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useTestbenchPlan, testbenchPlanQueryKey } from "./useTestbenchPlan";

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
