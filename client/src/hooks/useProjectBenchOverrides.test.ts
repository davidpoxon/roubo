// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useUpdateProjectBenchOverrides } from "./useProjectBenchOverrides";
import * as api from "../lib/api";
import type { RegisteredProject } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  updateProjectBenchOverrides: vi.fn(),
}));

const mockedUpdate = vi.mocked(api.updateProjectBenchOverrides);

beforeEach(() => {
  vi.resetAllMocks();
});

const makeProject = (
  id: string,
  benches?: Partial<{
    autoClear: boolean;
    enforceIssueDependencies: boolean;
    workUnitAutoClear: boolean;
  }>,
): RegisteredProject => ({
  id,
  repoPath: "/repo",
  configValid: true,
  settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  config: {
    project: id,
    components: [],
    benches,
  } as unknown as RegisteredProject["config"],
});

const fullOverrides = {
  autoClear: null,
  enforceIssueDependencies: null,
  workUnitAutoClear: null,
};

describe("useUpdateProjectBenchOverrides", () => {
  it("applies optimistic autoClear update to project cache before API resolves", async () => {
    mockedUpdate.mockResolvedValue({ ...fullOverrides, autoClear: true });
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RegisteredProject[]>(
      ["projects"],
      [makeProject("p1", { autoClear: false })],
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectBenchOverrides("p1"), {
      queryClient,
    });

    act(() => {
      result.current.mutate({ autoClear: true });
    });

    await waitFor(() => {
      const projects = queryClient.getQueryData<RegisteredProject[]>(["projects"]);
      expect(projects?.[0].config?.benches?.autoClear).toBe(true);
    });
  });

  it("removes autoClear from cache when null is passed", async () => {
    mockedUpdate.mockResolvedValue(fullOverrides);
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RegisteredProject[]>(
      ["projects"],
      [makeProject("p1", { autoClear: true })],
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectBenchOverrides("p1"), {
      queryClient,
    });

    act(() => {
      result.current.mutate({ autoClear: null });
    });

    await waitFor(() => {
      const projects = queryClient.getQueryData<RegisteredProject[]>(["projects"]);
      expect(projects?.[0].config?.benches?.autoClear).toBeUndefined();
    });
  });

  it("applies optimistic enforceIssueDependencies update", async () => {
    mockedUpdate.mockResolvedValue({
      ...fullOverrides,
      enforceIssueDependencies: true,
    });
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RegisteredProject[]>(
      ["projects"],
      [makeProject("p1", { enforceIssueDependencies: false })],
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectBenchOverrides("p1"), {
      queryClient,
    });

    act(() => {
      result.current.mutate({ enforceIssueDependencies: true });
    });

    await waitFor(() => {
      const projects = queryClient.getQueryData<RegisteredProject[]>(["projects"]);
      expect(projects?.[0].config?.benches?.enforceIssueDependencies).toBe(true);
    });
  });

  it("rolls back to previous projects when the API fails", async () => {
    mockedUpdate.mockRejectedValue(new Error("Network error"));
    const queryClient = makeQueryClient();
    const original = [makeProject("p1", { autoClear: false })];
    queryClient.setQueryData<RegisteredProject[]>(["projects"], original);

    const { result } = renderHookWithProviders(() => useUpdateProjectBenchOverrides("p1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate({ autoClear: true });
    });

    await waitFor(() => {
      const projects = queryClient.getQueryData<RegisteredProject[]>(["projects"]);
      expect(projects?.[0].config?.benches?.autoClear).toBe(false);
    });
  });

  it("does not mutate projects for other project ids", async () => {
    mockedUpdate.mockResolvedValue({ ...fullOverrides, autoClear: true });
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RegisteredProject[]>(
      ["projects"],
      [makeProject("p1", { autoClear: false }), makeProject("p2", { autoClear: false })],
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectBenchOverrides("p1"), {
      queryClient,
    });

    act(() => {
      result.current.mutate({ autoClear: true });
    });

    await waitFor(() => {
      const projects = queryClient.getQueryData<RegisteredProject[]>(["projects"]);
      expect(projects?.[1].config?.benches?.autoClear).toBe(false);
    });
  });

  it("invalidates the projects query after settling", async () => {
    mockedUpdate.mockResolvedValue(fullOverrides);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useUpdateProjectBenchOverrides("p1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate({ autoClear: true });
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects"] }));
    });
  });
});
