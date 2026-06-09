// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useSettingsOverviewDraft } from "./useSettingsOverviewDraft";
import type { RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";

vi.mock("../../hooks/useProjectSettings");
vi.mock("../../hooks/useProjectDefaultJig");
vi.mock("../../hooks/useProjectBenchOverrides");
vi.mock("../../hooks/useIssueTypes");

import { useProjectSettings } from "../../hooks/useProjectSettings";
import { useUpdateProjectDefaultJig } from "../../hooks/useProjectDefaultJig";
import { useUpdateProjectBenchOverrides } from "../../hooks/useProjectBenchOverrides";
import { useIssueTypeMappings, useUpdateIssueTypeMappings } from "../../hooks/useIssueTypes";

const mockedUseProjectSettings = vi.mocked(useProjectSettings);
const mockedUseUpdateProjectDefaultJig = vi.mocked(useUpdateProjectDefaultJig);
const mockedUseUpdateProjectBenchOverrides = vi.mocked(useUpdateProjectBenchOverrides);
const mockedUseIssueTypeMappings = vi.mocked(useIssueTypeMappings);
const mockedUseUpdateIssueTypeMappings = vi.mocked(useUpdateIssueTypeMappings);

const worktreeSource = { branchFromDefault: true, pullLatest: true };

const baseConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
    repo: "org/my-app",
  },
  layout: { type: "monorepo" as const },
  components: {},
  ports: {},
  benches: { max: 3 },
};

const baseProject: RegisteredProject = {
  id: "my-app",
  repoPath: "/home/user/my-app",
  configValid: true,
  config: baseConfig,
  settings: DEFAULT_PROJECT_SETTINGS,
};

function makeProjectSettings(overrides: Partial<ReturnType<typeof useProjectSettings>> = {}) {
  return {
    settings: {
      worktreeSource,
      defaultBranch: undefined,
      defaultBranchError: undefined,
    },
    isLoading: false,
    updateSettings: vi.fn(),
    updateSettingsAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    isFetchError: false,
    fetchError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseProjectSettings.mockReturnValue(
    makeProjectSettings() as unknown as ReturnType<typeof useProjectSettings>,
  );
  mockedUseUpdateProjectDefaultJig.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);
  mockedUseUpdateProjectBenchOverrides.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateProjectBenchOverrides>);
  mockedUseIssueTypeMappings.mockReturnValue({
    data: { mappings: {} },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useIssueTypeMappings>);
  mockedUseUpdateIssueTypeMappings.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateIssueTypeMappings>);
});

describe("useSettingsOverviewDraft", () => {
  it("starts with hasAnyDirty = false", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    expect(result.current.hasAnyDirty).toBe(false);
  });

  it("marks worktreeSource dirty when changed", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftWorktreeSource({
        branchFromDefault: false,
        pullLatest: true,
      });
    });
    expect(result.current.isWorktreeSourceDirty).toBe(true);
    expect(result.current.hasAnyDirty).toBe(true);
  });

  it("marks jig dirty when changed", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftJig("some-jig");
    });
    expect(result.current.isJigDirty).toBe(true);
    expect(result.current.hasAnyDirty).toBe(true);
  });

  it("marks enforceIssueDependencies dirty when changed", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftEnforceIssueDependencies(true);
    });
    expect(result.current.isEnforceIssueDependenciesDirty).toBe(true);
    expect(result.current.hasAnyDirty).toBe(true);
  });

  it("discard resets all drafts to original", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftJig("some-jig");
      result.current.setDraftEnforceIssueDependencies(true);
    });
    act(() => {
      result.current.discard();
    });
    expect(result.current.hasAnyDirty).toBe(false);
    expect(result.current.draftJig).toBe(null);
    expect(result.current.draftEnforceIssueDependencies).toBe(null);
  });

  it("save calls only mutations for dirty fields", async () => {
    const updateSettingsAsync = vi.fn().mockResolvedValue(undefined);
    const updateJigAsync = vi.fn().mockResolvedValue(undefined);
    mockedUseProjectSettings.mockReturnValue(
      makeProjectSettings({ updateSettingsAsync }) as unknown as ReturnType<
        typeof useProjectSettings
      >,
    );
    mockedUseUpdateProjectDefaultJig.mockReturnValue({
      mutateAsync: updateJigAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftJig("my-bp");
    });

    let saveResult: { ok: boolean; failed: string[] } | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(updateJigAsync).toHaveBeenCalledWith("my-bp");
    expect(updateSettingsAsync).not.toHaveBeenCalled();
    expect(saveResult?.ok).toBe(true);
  });

  it("save sends the dirty bench override field in a single mutation", async () => {
    const updateBenchOverridesAsync = vi.fn().mockResolvedValue(undefined);
    mockedUseUpdateProjectBenchOverrides.mockReturnValue({
      mutateAsync: updateBenchOverridesAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectBenchOverrides>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftEnforceIssueDependencies(false);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(updateBenchOverridesAsync).toHaveBeenCalledTimes(1);
    expect(updateBenchOverridesAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceIssueDependencies: false,
      }),
    );
  });

  it("save returns ok=false and failed list when a mutation rejects", async () => {
    const updateJigAsync = vi.fn().mockRejectedValue(new Error("Server error"));
    mockedUseUpdateProjectDefaultJig.mockReturnValue({
      mutateAsync: updateJigAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftJig("my-bp");
    });

    let saveResult: { ok: boolean; failed: string[] } | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult?.ok).toBe(false);
    expect(saveResult?.failed).toContain("Jig override");
    expect(result.current.saveErrors).toContain("Jig override");
    // jig is still dirty because save failed
    expect(result.current.isJigDirty).toBe(true);
  });

  it("partial failure: bench overrides failure reported as 'Bench overrides'", async () => {
    const updateJigAsync = vi.fn().mockResolvedValue(undefined);
    const updateBenchOverridesAsync = vi.fn().mockRejectedValue(new Error("Server error"));
    mockedUseUpdateProjectDefaultJig.mockReturnValue({
      mutateAsync: updateJigAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);
    mockedUseUpdateProjectBenchOverrides.mockReturnValue({
      mutateAsync: updateBenchOverridesAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectBenchOverrides>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftJig("my-bp");
      result.current.setDraftEnforceIssueDependencies(true);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.saveErrors).toContain("Bench overrides");
    expect(result.current.saveErrors).not.toContain("Jig override");
  });

  it("hasAnyDirty is false immediately after a successful save", async () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftJig("my-bp");
    });
    expect(result.current.hasAnyDirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    // hasAnyDirty must be false immediately (not waiting for cache invalidation)
    expect(result.current.hasAnyDirty).toBe(false);
  });

  it("sets justSavedRef to true after a successful save", async () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftJig("my-bp");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.justSavedRef.current).toBe(true);
  });

  it("resets justSavedRef when a setter is called after save", async () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftJig("my-bp");
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.justSavedRef.current).toBe(true);

    act(() => {
      result.current.setDraftEnforceIssueDependencies(true);
    });
    expect(result.current.justSavedRef.current).toBe(false);
  });

  it("re-seeds all drafts when projectId changes", () => {
    const projectA: RegisteredProject = {
      ...baseProject,
      id: "project-a",
      config: {
        ...baseConfig,
        jigs: { defaultJig: "bp-a" },
        benches: {
          max: 3,
          enforceIssueDependencies: false,
        },
      },
    };
    const projectB: RegisteredProject = {
      ...baseProject,
      id: "project-b",
      config: {
        ...baseConfig,
        jigs: { defaultJig: "bp-b" },
        benches: {
          max: 3,
          enforceIssueDependencies: true,
        },
      },
    };

    const { result, rerender } = renderHookWithProviders(
      ({ projectId, project }: { projectId: string; project: RegisteredProject }) =>
        useSettingsOverviewDraft(projectId, project),
      { initialProps: { projectId: "project-a", project: projectA } },
    );

    expect(result.current.draftJig).toBe("bp-a");
    expect(result.current.draftEnforceIssueDependencies).toBe(false);

    rerender({ projectId: "project-b", project: projectB });

    expect(result.current.draftJig).toBe("bp-b");
    expect(result.current.draftEnforceIssueDependencies).toBe(true);
  });

  it("hasAnyDirty stays false as issue type mappings load with existing data", () => {
    mockedUseIssueTypeMappings.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypeMappings>);

    const { result, rerender } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    expect(result.current.hasAnyDirty).toBe(false);

    mockedUseIssueTypeMappings.mockReturnValue({
      data: { mappings: { Bug: "bp-bug" } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypeMappings>);

    rerender();

    // After the load effect seeds the draft, there should be no dirty state
    expect(result.current.hasAnyDirty).toBe(false);
    expect(result.current.isIssueTypeMappingsDirty).toBe(false);
  });

  it("marks issueTypeMappings dirty when an entry is added", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftIssueTypeMappings({ Bug: "bp-bug" });
    });
    expect(result.current.isIssueTypeMappingsDirty).toBe(true);
    expect(result.current.hasAnyDirty).toBe(true);
  });

  it("issueTypeMappings is not dirty when keys reordered with same values", () => {
    mockedUseIssueTypeMappings.mockReturnValue({
      data: { mappings: { Bug: "bp-bug", Feature: "bp-feat" } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypeMappings>);
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftIssueTypeMappings({
        Feature: "bp-feat",
        Bug: "bp-bug",
      });
    });
    expect(result.current.isIssueTypeMappingsDirty).toBe(false);
    expect(result.current.hasAnyDirty).toBe(false);
  });

  it("save calls updateIssueTypeMappingsAsync when mappings dirty", async () => {
    const updateMappingsAsync = vi.fn().mockResolvedValue(undefined);
    mockedUseUpdateIssueTypeMappings.mockReturnValue({
      mutateAsync: updateMappingsAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateIssueTypeMappings>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftIssueTypeMappings({ Bug: "bp-bug" });
    });

    let saveResult: { ok: boolean; failed: string[] } | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(updateMappingsAsync).toHaveBeenCalledWith({ Bug: "bp-bug" });
    expect(saveResult?.ok).toBe(true);
  });

  it("save reports 'Issue type mappings' on failure", async () => {
    const updateMappingsAsync = vi.fn().mockRejectedValue(new Error("Server error"));
    mockedUseUpdateIssueTypeMappings.mockReturnValue({
      mutateAsync: updateMappingsAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateIssueTypeMappings>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftIssueTypeMappings({ Bug: "bp-bug" });
    });

    let saveResult: { ok: boolean; failed: string[] } | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult?.ok).toBe(false);
    expect(saveResult?.failed).toContain("Issue type mappings");
    expect(result.current.saveErrors).toContain("Issue type mappings");
  });

  it("discard resets issue type mappings to server value", () => {
    mockedUseIssueTypeMappings.mockReturnValue({
      data: { mappings: { Bug: "bp-bug" } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypeMappings>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftIssueTypeMappings({
        Bug: "bp-other",
        Feature: "bp-feat",
      });
    });
    expect(result.current.isIssueTypeMappingsDirty).toBe(true);

    act(() => {
      result.current.discard();
    });
    expect(result.current.draftIssueTypeMappings).toEqual({ Bug: "bp-bug" });
    expect(result.current.isIssueTypeMappingsDirty).toBe(false);
  });

  it("re-seeds worktreeSource draft when projectId changes", async () => {
    const newSettings = makeProjectSettings({
      settings: {
        worktreeSource: { branchFromDefault: false, pullLatest: false },
        defaultBranch: undefined,
        defaultBranchError: undefined,
      },
    });

    let currentProjectId = "project-a";
    mockedUseProjectSettings.mockReturnValue(
      makeProjectSettings() as unknown as ReturnType<typeof useProjectSettings>,
    );

    const { result, rerender } = renderHookWithProviders(
      ({ projectId }: { projectId: string }) => useSettingsOverviewDraft(projectId, baseProject),
      { initialProps: { projectId: currentProjectId } },
    );

    expect(result.current.draftWorktreeSource.branchFromDefault).toBe(true);

    // Switch to a different project whose settings have different values
    mockedUseProjectSettings.mockReturnValue(
      newSettings as unknown as ReturnType<typeof useProjectSettings>,
    );
    currentProjectId = "project-b";
    rerender({ projectId: currentProjectId });

    expect(result.current.draftWorktreeSource.branchFromDefault).toBe(false);
  });
});
