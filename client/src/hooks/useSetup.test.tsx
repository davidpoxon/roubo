// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import {
  useScanRepo,
  useSaveConfig,
  useRawConfig,
  useValidateConfig,
  useEnvKeys,
  useGitHubProjects,
} from "./useSetup";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

describe("useScanRepo", () => {
  it("is disabled when enabled is false", () => {
    mockedApi.scanRepo.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useScanRepo("/repo", false));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.scanRepo).not.toHaveBeenCalled();
  });

  it("is disabled when repoPath is empty even if enabled is true", () => {
    mockedApi.scanRepo.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useScanRepo("", true));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.scanRepo).not.toHaveBeenCalled();
  });

  it("calls scanRepo when enabled and repoPath is non-empty", async () => {
    const scanResult = { detected: { hasGit: true }, existingConfig: null };
    mockedApi.scanRepo.mockResolvedValue(scanResult as never);
    const { result } = renderHookWithProviders(() => useScanRepo("/my/repo", true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.scanRepo).toHaveBeenCalledWith("/my/repo");
    expect(result.current.data).toEqual(scanResult);
  });
});

describe("useSaveConfig", () => {
  it("calls saveConfig with repoPath and config", async () => {
    const saveResult = { path: "/repo/roubo.yaml", config: {} };
    mockedApi.saveConfig.mockResolvedValue(saveResult as never);
    const { result } = renderHookWithProviders(() => useSaveConfig());
    const config = { project: { name: "test" } } as never;
    result.current.mutate({ repoPath: "/repo", config });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.saveConfig).toHaveBeenCalledWith("/repo", config);
  });
});

describe("useValidateConfig", () => {
  it("calls validateConfig with config and currentProjectId", async () => {
    const validationResult = { valid: true, errors: [], portConflicts: [] };
    mockedApi.validateConfig.mockResolvedValue(validationResult as never);
    const { result } = renderHookWithProviders(() => useValidateConfig());
    const config = { project: { name: "test" } } as never;
    result.current.mutate({ config, currentProjectId: "project1" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.validateConfig).toHaveBeenCalledWith(config, "project1");
  });
});

describe("useEnvKeys", () => {
  it("calls fetchEnvKeys", async () => {
    mockedApi.fetchEnvKeys.mockResolvedValue({ keys: ["DB_URL", "API_KEY"] });
    const { result } = renderHookWithProviders(() => useEnvKeys());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchEnvKeys).toHaveBeenCalled();
    expect(result.current.data).toEqual({ keys: ["DB_URL", "API_KEY"] });
  });
});

describe("useGitHubProjects", () => {
  it("is disabled when repo is empty", () => {
    mockedApi.fetchGitHubProjects.mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useGitHubProjects(""));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchGitHubProjects).not.toHaveBeenCalled();
  });

  it("is disabled when repo has no slash (not owner/repo format)", () => {
    mockedApi.fetchGitHubProjects.mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useGitHubProjects("myrepo"));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchGitHubProjects).not.toHaveBeenCalled();
  });

  it("calls fetchGitHubProjects when repo is owner/repo format", async () => {
    const projects = [{ number: 1, title: "My Project" }];
    mockedApi.fetchGitHubProjects.mockResolvedValue(projects as never);
    const { result } = renderHookWithProviders(() => useGitHubProjects("owner/repo"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchGitHubProjects).toHaveBeenCalledWith("owner/repo");
  });
});

describe("useRawConfig", () => {
  it("is disabled when projectId is undefined", () => {
    mockedApi.fetchRawConfig.mockResolvedValue({} as never);
    const { result } = renderHookWithProviders(() => useRawConfig(undefined));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.fetchRawConfig).not.toHaveBeenCalled();
  });

  it("calls fetchRawConfig when projectId is provided", async () => {
    const rawResult = { yaml: "project:\n  name: test" };
    mockedApi.fetchRawConfig.mockResolvedValue(rawResult);
    const { result } = renderHookWithProviders(() => useRawConfig("project1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchRawConfig).toHaveBeenCalledWith("project1");
    expect(result.current.data).toEqual(rawResult);
  });
});
