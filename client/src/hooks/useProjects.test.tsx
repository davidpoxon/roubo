// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";
import {
  useProjects,
  useCheckConfig,
  useRegisterProject,
  useUnregisterProject,
  useReloadProjectConfig,
} from "./useProjects";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

describe("useProjects", () => {
  it("calls fetchProjects and returns data", async () => {
    const projects = [{ id: "p1", repoPath: "/path", config: {}, configValid: true }];
    mockedApi.fetchProjects.mockResolvedValue(projects as never);
    const { result } = renderHookWithProviders(() => useProjects());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchProjects).toHaveBeenCalled();
    expect(result.current.data).toEqual(projects);
  });
});

describe("useCheckConfig", () => {
  it("is disabled when repoPath is empty", () => {
    mockedApi.checkConfig.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useCheckConfig(""));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.checkConfig).not.toHaveBeenCalled();
  });

  it("is disabled when repoPath is whitespace only", () => {
    mockedApi.checkConfig.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useCheckConfig("   "));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.checkConfig).not.toHaveBeenCalled();
  });

  it("calls checkConfig with trimmed path when enabled", async () => {
    const configResult = { hasConfig: true, configValid: true, alreadyRegistered: false };
    mockedApi.checkConfig.mockResolvedValue(configResult as never);
    const { result } = renderHookWithProviders(() => useCheckConfig("  /my/repo  "));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.checkConfig).toHaveBeenCalledWith("/my/repo");
  });
});

describe("useRegisterProject", () => {
  it("calls registerProject with repoPath", async () => {
    const project = { id: "p1", repoPath: "/path" };
    mockedApi.registerProject.mockResolvedValue(project as never);
    const { result } = renderHookWithProviders(() => useRegisterProject());
    result.current.mutate("/path");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.registerProject).toHaveBeenCalledWith("/path");
  });
});

describe("useUnregisterProject", () => {
  it("calls unregisterProject with projectId", async () => {
    mockedApi.unregisterProject.mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useUnregisterProject());
    result.current.mutate({ projectId: "p1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.unregisterProject).toHaveBeenCalledWith("p1", { force: undefined });
  });

  it("forwards force=true to the API client", async () => {
    mockedApi.unregisterProject.mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useUnregisterProject());
    result.current.mutate({ projectId: "p1", force: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.unregisterProject).toHaveBeenCalledWith("p1", { force: true });
  });
});

// The views that read the project set: the project list and the settings
// screens, the bench views, the cut list, and each project's config,
// integration, settings and jig list.
const PROJECT_SET_KEYS = [
  ["projects"],
  ["benches"],
  ["issues"],
  ["project-settings"],
  ["project-integration"],
  ["raw-config"],
  ["jigs"],
];

describe("the project set views", () => {
  it("HR-TC-033 an unregister refreshes the cut list, the bench views and the settings screens", async () => {
    mockedApi.unregisterProject.mockResolvedValue(undefined);
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useUnregisterProject(), { queryClient });
    result.current.mutate({ projectId: "lantern" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy.mock.calls.map(([arg]) => arg)).toEqual(
      PROJECT_SET_KEYS.map((queryKey) => ({ queryKey })),
    );
  });

  it("HR-TC-026 a register refreshes the cut list, the bench views and the settings screens", async () => {
    mockedApi.registerProject.mockResolvedValue({ id: "lantern-2" } as never);
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useRegisterProject(), { queryClient });
    result.current.mutate("/repos/lantern-2");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy.mock.calls.map(([arg]) => arg)).toEqual(
      PROJECT_SET_KEYS.map((queryKey) => ({ queryKey })),
    );
  });
});

describe("useReloadProjectConfig", () => {
  it("HR-TC-009 calls the manual reload route with projectId", async () => {
    const project = { id: "p1", repoPath: "/path", configValid: true };
    mockedApi.reloadProjectConfig.mockResolvedValue(project as never);
    const { result } = renderHookWithProviders(() => useReloadProjectConfig());
    result.current.mutate("p1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.reloadProjectConfig).toHaveBeenCalledWith("p1");
  });
});
