// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useProjectPermissions } from "./useProjectPermissions";
import * as api from "../lib/api";
import type { ProjectPermissions } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  fetchProjectPermissions: vi.fn(),
  updateProjectPermissions: vi.fn(),
  resyncProjectPermissions: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchProjectPermissions);
const mockedUpdate = vi.mocked(api.updateProjectPermissions);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useProjectPermissions", () => {
  it("returns permissions from the API", async () => {
    const permissions: ProjectPermissions = {
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    };
    mockedFetch.mockResolvedValue(permissions);

    const { result } = renderHookWithProviders(() => useProjectPermissions("my-project"));

    await waitFor(() => {
      expect(result.current.permissions).toEqual(permissions);
    });

    expect(mockedFetch).toHaveBeenCalledWith("my-project");
  });

  it("returns empty permissions when none are saved", async () => {
    const permissions: ProjectPermissions = { allow: [], deny: [], ask: [] };
    mockedFetch.mockResolvedValue(permissions);

    const { result } = renderHookWithProviders(() => useProjectPermissions("my-project"));

    await waitFor(() => {
      expect(result.current.permissions).toEqual({ allow: [], deny: [], ask: [] });
    });
  });

  it("does not fetch when projectId is empty", () => {
    mockedFetch.mockResolvedValue({ allow: [], deny: [], ask: [] });

    renderHookWithProviders(() => useProjectPermissions(""));

    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("calls updateProjectPermissions with the new permissions", async () => {
    const initial: ProjectPermissions = {
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    };
    const updated: ProjectPermissions = {
      allow: ["Bash(npm test:*)", "Bash(git push:*)"],
      deny: [],
      ask: [],
    };
    mockedFetch.mockResolvedValue(initial);
    mockedUpdate.mockResolvedValue(updated);

    const { result } = renderHookWithProviders(() => useProjectPermissions("my-project"));

    await waitFor(() => {
      expect(result.current.permissions).toEqual(initial);
    });

    await act(async () => {
      result.current.updatePermissions(updated);
    });

    await waitFor(() => {
      expect(mockedUpdate).toHaveBeenCalledWith("my-project", updated);
    });
  });

  it("surfaces isError and error when the initial fetch fails", async () => {
    const fetchError = new Error("Network error");
    mockedFetch.mockRejectedValue(fetchError);

    const { result } = renderHookWithProviders(() => useProjectPermissions("my-project"));

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBe(fetchError);
  });

  it("reverts optimistic update when the mutation fails", async () => {
    const initial: ProjectPermissions = {
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    };
    const updated: ProjectPermissions = {
      allow: ["Bash(npm test:*)", "Bash(git push:*)"],
      deny: [],
      ask: [],
    };
    mockedFetch.mockResolvedValue(initial);
    mockedUpdate.mockRejectedValue(new Error("Server error"));

    const { result } = renderHookWithProviders(() => useProjectPermissions("my-project"));

    await waitFor(() => {
      expect(result.current.permissions).toEqual(initial);
    });

    await act(async () => {
      result.current.updatePermissions(updated);
    });

    await waitFor(() => {
      expect(result.current.permissions).toEqual(initial);
    });
  });
});
