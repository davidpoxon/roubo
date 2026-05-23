// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useProjectDefaultJig, useUpdateProjectDefaultJig } from "./useProjectDefaultJig";
import * as api from "../lib/api";
import type { ProjectDefaultJigResponse } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchProjectDefaultJig: vi.fn(),
  updateProjectDefaultJig: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchProjectDefaultJig);
const mockedUpdate = vi.mocked(api.updateProjectDefaultJig);

beforeEach(() => {
  vi.resetAllMocks();
});

const globalDefault: ProjectDefaultJigResponse = {
  jigId: "bp-global",
  source: "global",
};

describe("useProjectDefaultJig", () => {
  it("returns jig data from the API", async () => {
    mockedFetch.mockResolvedValue(globalDefault);

    const { result } = renderHookWithProviders(() => useProjectDefaultJig("proj-1"));

    await waitFor(() => {
      expect(result.current.data).toEqual(globalDefault);
    });
    expect(mockedFetch).toHaveBeenCalledWith("proj-1");
  });

  it("does not fetch when projectId is undefined", () => {
    renderHookWithProviders(() => useProjectDefaultJig(undefined));
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("useUpdateProjectDefaultJig", () => {
  it("applies optimistic update when setting a specific jig", async () => {
    mockedUpdate.mockResolvedValue({ jigId: "bp-proj" });
    const queryClient = makeQueryClient();
    queryClient.setQueryData<ProjectDefaultJigResponse>(["jig-default", "proj-1"], globalDefault);

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultJig("proj-1"), {
      queryClient,
    });

    act(() => {
      result.current.mutate("bp-proj");
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<ProjectDefaultJigResponse>(["jig-default", "proj-1"]);
      expect(cached).toEqual({ jigId: "bp-proj", source: "project" });
    });
  });

  it("does not apply optimistic update when clearing (null) because source is unknown", async () => {
    mockedUpdate.mockResolvedValue({ jigId: null });
    const queryClient = makeQueryClient();
    const projectOverride: ProjectDefaultJigResponse = {
      jigId: "bp-proj",
      source: "project",
    };
    queryClient.setQueryData<ProjectDefaultJigResponse>(["jig-default", "proj-1"], projectOverride);

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultJig("proj-1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate(null);
    });

    // Cache should remain unchanged after onMutate has run
    await waitFor(() => {
      const cached = queryClient.getQueryData<ProjectDefaultJigResponse>(["jig-default", "proj-1"]);
      expect(cached).toEqual(projectOverride);
    });
  });

  it("rolls back to previous data when the API fails", async () => {
    mockedUpdate.mockRejectedValue(new Error("Server error"));
    const queryClient = makeQueryClient();
    queryClient.setQueryData<ProjectDefaultJigResponse>(["jig-default", "proj-1"], globalDefault);

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultJig("proj-1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate("bp-new");
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<ProjectDefaultJigResponse>(["jig-default", "proj-1"]);
      expect(cached).toEqual(globalDefault);
    });
  });

  it("invalidates jig-default and projects queries after settling", async () => {
    mockedUpdate.mockResolvedValue({ jigId: "bp-proj" });
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultJig("proj-1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate("bp-proj");
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["jig-default", "proj-1"] }),
      );
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects"] }));
    });
  });
});
