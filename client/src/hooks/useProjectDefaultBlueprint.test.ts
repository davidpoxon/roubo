// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import {
  useProjectDefaultBlueprint,
  useUpdateProjectDefaultBlueprint,
} from "./useProjectDefaultBlueprint";
import * as api from "../lib/api";
import type { ProjectDefaultBlueprintResponse } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchProjectDefaultBlueprint: vi.fn(),
  updateProjectDefaultBlueprint: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchProjectDefaultBlueprint);
const mockedUpdate = vi.mocked(api.updateProjectDefaultBlueprint);

beforeEach(() => {
  vi.resetAllMocks();
});

const globalDefault: ProjectDefaultBlueprintResponse = {
  blueprintId: "bp-global",
  source: "global",
};

describe("useProjectDefaultBlueprint", () => {
  it("returns blueprint data from the API", async () => {
    mockedFetch.mockResolvedValue(globalDefault);

    const { result } = renderHookWithProviders(() => useProjectDefaultBlueprint("proj-1"));

    await waitFor(() => {
      expect(result.current.data).toEqual(globalDefault);
    });
    expect(mockedFetch).toHaveBeenCalledWith("proj-1");
  });

  it("does not fetch when projectId is undefined", () => {
    renderHookWithProviders(() => useProjectDefaultBlueprint(undefined));
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("useUpdateProjectDefaultBlueprint", () => {
  it("applies optimistic update when setting a specific blueprint", async () => {
    mockedUpdate.mockResolvedValue({ blueprintId: "bp-proj" });
    const queryClient = makeQueryClient();
    queryClient.setQueryData<ProjectDefaultBlueprintResponse>(
      ["blueprint-default", "proj-1"],
      globalDefault,
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultBlueprint("proj-1"), {
      queryClient,
    });

    act(() => {
      result.current.mutate("bp-proj");
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<ProjectDefaultBlueprintResponse>([
        "blueprint-default",
        "proj-1",
      ]);
      expect(cached).toEqual({ blueprintId: "bp-proj", source: "project" });
    });
  });

  it("does not apply optimistic update when clearing (null) because source is unknown", async () => {
    mockedUpdate.mockResolvedValue({ blueprintId: null });
    const queryClient = makeQueryClient();
    const projectOverride: ProjectDefaultBlueprintResponse = {
      blueprintId: "bp-proj",
      source: "project",
    };
    queryClient.setQueryData<ProjectDefaultBlueprintResponse>(
      ["blueprint-default", "proj-1"],
      projectOverride,
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultBlueprint("proj-1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate(null);
    });

    // Cache should remain unchanged after onMutate has run
    await waitFor(() => {
      const cached = queryClient.getQueryData<ProjectDefaultBlueprintResponse>([
        "blueprint-default",
        "proj-1",
      ]);
      expect(cached).toEqual(projectOverride);
    });
  });

  it("rolls back to previous data when the API fails", async () => {
    mockedUpdate.mockRejectedValue(new Error("Server error"));
    const queryClient = makeQueryClient();
    queryClient.setQueryData<ProjectDefaultBlueprintResponse>(
      ["blueprint-default", "proj-1"],
      globalDefault,
    );

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultBlueprint("proj-1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate("bp-new");
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<ProjectDefaultBlueprintResponse>([
        "blueprint-default",
        "proj-1",
      ]);
      expect(cached).toEqual(globalDefault);
    });
  });

  it("invalidates blueprint-default and projects queries after settling", async () => {
    mockedUpdate.mockResolvedValue({ blueprintId: "bp-proj" });
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useUpdateProjectDefaultBlueprint("proj-1"), {
      queryClient,
    });

    await act(async () => {
      result.current.mutate("bp-proj");
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["blueprint-default", "proj-1"] }),
      );
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["projects"] }));
    });
  });
});
