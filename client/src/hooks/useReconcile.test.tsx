// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useReconcilePreview, useReconcileApply, useReconcilePurge } from "./useReconcile";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

const outcome = {
  classification: { added: [], unchanged: [], changed: [], removed: ["TC-9"] },
  applied: false,
};

describe("useReconcilePreview", () => {
  it("calls reconcileTestbench with no flags (preview only) and does not invalidate", async () => {
    mockedApi.reconcileTestbench.mockResolvedValue(outcome as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useReconcilePreview(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.reconcileTestbench).toHaveBeenCalledWith("p1", 3, {});
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useReconcileApply", () => {
  it("calls reconcileTestbench with confirm:true and invalidates the plan query", async () => {
    mockedApi.reconcileTestbench.mockResolvedValue({ ...outcome, applied: true } as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useReconcileApply(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.reconcileTestbench).toHaveBeenCalledWith("p1", 3, { confirm: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["testbenchPlan", "p1", 3] });
  });
});

describe("useReconcilePurge", () => {
  it("calls reconcileTestbench with confirm + purgeOrphans and invalidates the plan query", async () => {
    mockedApi.reconcileTestbench.mockResolvedValue({ ...outcome, applied: true } as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useReconcilePurge(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.reconcileTestbench).toHaveBeenCalledWith("p1", 3, {
      confirm: true,
      purgeOrphans: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["testbenchPlan", "p1", 3] });
  });
});
