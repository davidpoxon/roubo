// @vitest-environment jsdom
//
// #702 (FR-012): the gate-state hooks fetch project-level gate state, do not
// retry on failure, gate the fetch on `enabled`, and expose an invalidation
// helper the batch view uses to live-update after a mark (AC2).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useGates, useGate, useInvalidateGates, gatesQueryKey, gateQueryKey } from "./useGates";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

const gate = {
  gateId: "WU-099",
  status: "pending" as const,
  unresolvedCaseIds: ["TC-001"],
  coveringUnitIds: ["WU-010"],
};

describe("query keys", () => {
  it("namespaces gates by project and a gate by project + id", () => {
    expect(gatesQueryKey("p1")).toEqual(["gates", "p1"]);
    expect(gateQueryKey("p1", "WU-099")).toEqual(["gate", "p1", "WU-099"]);
  });
});

describe("useGates", () => {
  it("fetches the project's gates", async () => {
    mockedApi.fetchGates.mockResolvedValue([gate] as never);
    const { result } = renderHookWithProviders(() => useGates("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchGates).toHaveBeenCalledWith("p1");
    expect(result.current.data).toEqual([gate]);
  });

  it("does not retry on failure", async () => {
    mockedApi.fetchGates.mockRejectedValue(new Error("boom") as never);
    const { result } = renderHookWithProviders(() => useGates("p1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.fetchGates).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", () => {
    mockedApi.fetchGates.mockResolvedValue([gate] as never);
    const { result } = renderHookWithProviders(() => useGates("p1", { enabled: false }));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchGates).not.toHaveBeenCalled();
  });
});

describe("useGate", () => {
  it("fetches one gate by id", async () => {
    mockedApi.fetchGate.mockResolvedValue(gate as never);
    const { result } = renderHookWithProviders(() => useGate("p1", "WU-099"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchGate).toHaveBeenCalledWith("p1", "WU-099");
    expect(result.current.data?.status).toBe("pending");
  });

  it("does not retry on failure", async () => {
    mockedApi.fetchGate.mockRejectedValue(new Error("404") as never);
    const { result } = renderHookWithProviders(() => useGate("p1", "WU-099"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.fetchGate).toHaveBeenCalledTimes(1);
  });
});

describe("useInvalidateGates", () => {
  it("invalidates the gate and gates queries (live-update after a mark)", () => {
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useInvalidateGates(), { queryClient });
    result.current.invalidateGate("p1", "WU-099");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gate", "p1", "WU-099"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
  });
});
