// @vitest-environment jsdom
//
// #702 (FR-012): the gate-state hooks fetch project-level gate state, do not
// retry on failure, gate the fetch on `enabled`, and expose an invalidation
// helper the batch view uses to live-update after a mark (AC2).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { act } from "@testing-library/react";
import {
  useGates,
  useGate,
  useInvalidateGates,
  useMergeGates,
  useSplitGate,
  useResetGateOverrides,
  useSignOffGate,
  useReopenGate,
  useFileFixIssue,
  gatesQueryKey,
  gateQueryKey,
} from "./useGates";

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

// fetchGates now resolves the GatesResponse shape ({ gates, invalidSpecs }) rather
// than a bare array (#371).
const gatesResponse = { gates: [gate], invalidSpecs: [] };

describe("query keys", () => {
  it("namespaces gates by project and a gate by project + id", () => {
    expect(gatesQueryKey("p1")).toEqual(["gates", "p1"]);
    expect(gateQueryKey("p1", "WU-099")).toEqual(["gate", "p1", "WU-099"]);
  });
});

describe("useGates", () => {
  it("fetches the project's gates", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesResponse as never);
    const { result } = renderHookWithProviders(() => useGates("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchGates).toHaveBeenCalledWith("p1");
    expect(result.current.data).toEqual(gatesResponse);
  });

  it("does not retry on failure", async () => {
    mockedApi.fetchGates.mockRejectedValue(new Error("boom") as never);
    const { result } = renderHookWithProviders(() => useGates("p1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.fetchGates).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", () => {
    mockedApi.fetchGates.mockResolvedValue(gatesResponse as never);
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

describe("useMergeGates", () => {
  it("calls the merge endpoint and invalidates the gates query on success", async () => {
    mockedApi.mergeGates.mockResolvedValue([] as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useMergeGates("p1"), { queryClient });
    await act(async () => {
      await result.current.mutateAsync(["WU-001", "WU-002"]);
    });
    expect(mockedApi.mergeGates).toHaveBeenCalledWith("p1", ["WU-001", "WU-002"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
  });
});

describe("useSplitGate", () => {
  it("calls the split endpoint and invalidates the gates query on success", async () => {
    mockedApi.splitGate.mockResolvedValue([] as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useSplitGate("p1"), { queryClient });
    const parts = [
      { label: "A", coversWorkUnitIds: ["WU-031"] },
      { label: "B", coversWorkUnitIds: ["WU-032"] },
    ];
    await act(async () => {
      await result.current.mutateAsync({ gateId: "WU-100", parts });
    });
    expect(mockedApi.splitGate).toHaveBeenCalledWith("p1", "WU-100", parts);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
  });
});

describe("useResetGateOverrides", () => {
  it("calls the reset endpoint and invalidates the gates query on success", async () => {
    mockedApi.resetGateOverrides.mockResolvedValue(undefined as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useResetGateOverrides("p1"), { queryClient });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(mockedApi.resetGateOverrides).toHaveBeenCalledWith("p1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
  });
});

// #830 (FR-007/FR-008): sign-off closes the gate's tracker issue; reopen reopens
// it. Both invalidate the open gate AND the overview list so the button re-reads
// the server's `signedOff` signal.
describe("useSignOffGate", () => {
  it("calls the sign-off endpoint and invalidates the gate + gates queries on success", async () => {
    mockedApi.signOffGate.mockResolvedValue({
      ...gate,
      status: "passed",
      signedOff: true,
    } as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useSignOffGate("p1"), { queryClient });
    await act(async () => {
      await result.current.mutateAsync("WU-099");
    });
    expect(mockedApi.signOffGate).toHaveBeenCalledWith("p1", "WU-099");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gate", "p1", "WU-099"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
  });
});

describe("useReopenGate", () => {
  it("calls the reopen endpoint and invalidates the gate + gates queries on success", async () => {
    mockedApi.reopenGate.mockResolvedValue({ ...gate, signedOff: false } as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useReopenGate("p1"), { queryClient });
    await act(async () => {
      await result.current.mutateAsync("WU-099");
    });
    expect(mockedApi.reopenGate).toHaveBeenCalledWith("p1", "WU-099");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gate", "p1", "WU-099"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
  });
});

// #706 (FR-009/FR-010): filing a fix issue resolves a FixIssueRecord for BOTH a
// 201 complete and a 207 link_pending outcome (the api call does not throw on
// 207), and on success invalidates the gate + gates + the bench's testbench plan
// so the still-blocked state re-reads.
describe("useFileFixIssue", () => {
  it("files via the endpoint and invalidates the gate, gates, and testbench plan on success", async () => {
    mockedApi.fileFixIssue.mockResolvedValue({
      fixIssueRef: "acme/app#452",
      gateRef: "acme/app#451",
      failedCaseId: "TC-024",
      linkStatus: "complete",
      createdAt: "2026-07-08T00:00:00.000Z",
    } as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useFileFixIssue("p1", 3, "WU-040"), {
      queryClient,
    });
    const body = { failedCaseId: "TC-024", notes: "It broke" };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(mockedApi.fileFixIssue).toHaveBeenCalledWith("p1", "WU-040", body);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gate", "p1", "WU-040"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["gates", "p1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["testbenchPlan", "p1", 3] });
  });
});
