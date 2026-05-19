// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useInspectionRun, useStartInspection, useAbortInspection } from "./useInspection";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useInspectionRun", () => {
  it("fetches inspection run for project and bench", async () => {
    const run = { id: "run-1", status: "completed", results: [] };
    mockedApi.fetchInspectionRun.mockResolvedValue(run as never);
    const { result } = renderHookWithProviders(() => useInspectionRun("p1", 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchInspectionRun).toHaveBeenCalledWith("p1", 1);
    expect(result.current.data).toEqual(run);
  });

  it("does not retry on failure", async () => {
    mockedApi.fetchInspectionRun.mockRejectedValue(new Error("Not found") as never);
    const { result } = renderHookWithProviders(() => useInspectionRun("p1", 1));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApi.fetchInspectionRun).toHaveBeenCalledTimes(1);
  });

  it("returns running data when status is running", async () => {
    const run = { id: "run-r", status: "running", results: [] };
    mockedApi.fetchInspectionRun.mockResolvedValue(run as never);
    const { result } = renderHookWithProviders(() => useInspectionRun("p1", 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("running");
  });
});

describe("useStartInspection", () => {
  it("calls startInspection and invalidates inspectionRun query", async () => {
    const run = { id: "run-2", status: "running" };
    mockedApi.startInspection.mockResolvedValue(run as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useStartInspection(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.startInspection).toHaveBeenCalledWith("p1", 2, undefined);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["inspectionRun", "p1", 2] });
  });

  it("passes filter to startInspection", async () => {
    mockedApi.startInspection.mockResolvedValue({ id: "run-3" } as never);
    const { result } = renderHookWithProviders(() => useStartInspection());
    result.current.mutate({ projectId: "p2", benchId: 3, filter: "unit" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.startInspection).toHaveBeenCalledWith("p2", 3, "unit");
  });
});

describe("useAbortInspection", () => {
  it("calls abortInspection and invalidates inspectionRun query", async () => {
    mockedApi.abortInspection.mockResolvedValue(undefined as never);

    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useAbortInspection(), { queryClient });
    result.current.mutate({ projectId: "p1", benchId: 5 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.abortInspection).toHaveBeenCalledWith("p1", 5);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["inspectionRun", "p1", 5] });
  });
});
