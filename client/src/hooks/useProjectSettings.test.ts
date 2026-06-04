// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useProjectSettings } from "./useProjectSettings";
import * as api from "../lib/api";
import type { ProjectSettings, ProjectSettingsResponse } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchProjectSettings);
const mockedUpdate = vi.mocked(api.updateProjectSettings);

beforeEach(() => {
  vi.resetAllMocks();
});

const defaultSettings: ProjectSettings = {
  worktreeSource: { branchFromDefault: true, pullLatest: true },
};

describe("useProjectSettings", () => {
  it("returns settings from the API", async () => {
    mockedFetch.mockResolvedValue(defaultSettings);

    const { result } = renderHookWithProviders(() => useProjectSettings("my-project"));

    await waitFor(() => {
      expect(result.current.settings).toEqual(defaultSettings);
    });

    expect(mockedFetch).toHaveBeenCalledWith("my-project");
  });

  it("does not fetch when projectId is empty", () => {
    mockedFetch.mockResolvedValue(defaultSettings);

    renderHookWithProviders(() => useProjectSettings(""));

    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("calls updateProjectSettings with the new settings", async () => {
    const updated: ProjectSettings = {
      worktreeSource: { branchFromDefault: false, pullLatest: true },
    };
    mockedFetch.mockResolvedValue(defaultSettings);
    mockedUpdate.mockResolvedValue(updated);

    const { result } = renderHookWithProviders(() => useProjectSettings("my-project"));

    await waitFor(() => {
      expect(result.current.settings).toEqual(defaultSettings);
    });

    await act(async () => {
      result.current.updateSettings(updated);
    });

    await waitFor(() => {
      expect(mockedUpdate).toHaveBeenCalledWith("my-project", updated);
    });
  });

  it("reverts optimistic update when the mutation fails", async () => {
    const updated: ProjectSettings = {
      worktreeSource: { branchFromDefault: false, pullLatest: false },
    };
    mockedFetch.mockResolvedValue(defaultSettings);
    mockedUpdate.mockRejectedValue(new Error("Server error"));

    const { result } = renderHookWithProviders(() => useProjectSettings("my-project"));

    await waitFor(() => {
      expect(result.current.settings).toEqual(defaultSettings);
    });

    await act(async () => {
      result.current.updateSettings(updated);
    });

    await waitFor(() => {
      expect(result.current.settings).toEqual(defaultSettings);
    });
  });

  it("query key is scoped to projectId: two hooks with different ids do not share cache", async () => {
    const settingsA: ProjectSettings = {
      worktreeSource: { branchFromDefault: true, pullLatest: true },
    };
    const settingsB: ProjectSettings = {
      worktreeSource: { branchFromDefault: false, pullLatest: false },
    };

    mockedFetch.mockImplementation((id) => {
      if (id === "project-a") return Promise.resolve(settingsA);
      return Promise.resolve(settingsB);
    });

    const queryClient = makeQueryClient();
    const { result: resultA } = renderHookWithProviders(() => useProjectSettings("project-a"), {
      queryClient,
    });
    const { result: resultB } = renderHookWithProviders(() => useProjectSettings("project-b"), {
      queryClient,
    });

    await waitFor(() => {
      expect(resultA.current.settings).toEqual(settingsA);
      expect(resultB.current.settings).toEqual(settingsB);
    });
  });

  it("preserves server-computed fields (defaultBranch) across optimistic updates", async () => {
    const settingsWithBranch: ProjectSettingsResponse = {
      worktreeSource: { branchFromDefault: true, pullLatest: true },
      defaultBranch: "main",
    };
    const toggled: ProjectSettings = {
      worktreeSource: { branchFromDefault: false, pullLatest: true },
    };
    mockedFetch.mockResolvedValue(settingsWithBranch);
    mockedUpdate.mockResolvedValue(toggled);

    const { result } = renderHookWithProviders(() => useProjectSettings("my-project"));

    await waitFor(() => {
      expect(result.current.settings?.defaultBranch).toBe("main");
    });

    await act(async () => {
      result.current.updateSettings(toggled);
    });

    // Optimistic state must preserve defaultBranch from the previous response
    expect(result.current.settings?.defaultBranch).toBe("main");
  });

  it("invalidates the query after a successful mutation", async () => {
    const updated: ProjectSettings = {
      worktreeSource: { branchFromDefault: false, pullLatest: true },
    };
    mockedFetch.mockResolvedValue(defaultSettings);
    mockedUpdate.mockResolvedValue(updated);

    const { result } = renderHookWithProviders(() => useProjectSettings("my-project"));

    await waitFor(() => {
      expect(result.current.settings).toEqual(defaultSettings);
    });

    const callsBefore = mockedFetch.mock.calls.length;

    await act(async () => {
      result.current.updateSettings(updated);
    });

    await waitFor(() => {
      expect(mockedFetch.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
