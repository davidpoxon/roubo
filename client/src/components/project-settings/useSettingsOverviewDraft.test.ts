// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useSettingsOverviewDraft } from "./useSettingsOverviewDraft";
import type { RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";

vi.mock("../../hooks/useProjectSettings");
vi.mock("../../hooks/useProjectDefaultBlueprint");
vi.mock("../../hooks/useProjectBenchOverrides");
vi.mock("../../hooks/useIssueTypes");

import { useProjectSettings } from "../../hooks/useProjectSettings";
import { useUpdateProjectDefaultBlueprint } from "../../hooks/useProjectDefaultBlueprint";
import { useUpdateProjectBenchOverrides } from "../../hooks/useProjectBenchOverrides";
import { useIssueTypeMappings, useUpdateIssueTypeMappings } from "../../hooks/useIssueTypes";

const mockedUseProjectSettings = vi.mocked(useProjectSettings);
const mockedUseUpdateProjectDefaultBlueprint = vi.mocked(useUpdateProjectDefaultBlueprint);
const mockedUseUpdateProjectBenchOverrides = vi.mocked(useUpdateProjectBenchOverrides);
const mockedUseIssueTypeMappings = vi.mocked(useIssueTypeMappings);
const mockedUseUpdateIssueTypeMappings = vi.mocked(useUpdateIssueTypeMappings);

const worktreeSource = { branchFromDefault: true, pullLatest: true };

const baseConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
    type: "web" as const,
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
  mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);
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

  it("marks blueprint dirty when changed", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftBlueprint("some-blueprint");
    });
    expect(result.current.isBlueprintDirty).toBe(true);
    expect(result.current.hasAnyDirty).toBe(true);
  });

  it("marks autoClear dirty when changed", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftAutoClear(true);
    });
    expect(result.current.isAutoClearDirty).toBe(true);
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

  it("marks workUnitAutoClear dirty when changed", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftWorkUnitAutoClear(false);
    });
    expect(result.current.isWorkUnitAutoClearDirty).toBe(true);
    expect(result.current.hasAnyDirty).toBe(true);
  });

  it("discard resets all drafts to original", () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );
    act(() => {
      result.current.setDraftBlueprint("some-blueprint");
      result.current.setDraftAutoClear(true);
      result.current.setDraftEnforceIssueDependencies(true);
      result.current.setDraftWorkUnitAutoClear(false);
    });
    act(() => {
      result.current.discard();
    });
    expect(result.current.hasAnyDirty).toBe(false);
    expect(result.current.draftBlueprint).toBe(null);
    expect(result.current.draftAutoClear).toBe(null);
    expect(result.current.draftEnforceIssueDependencies).toBe(null);
    expect(result.current.draftWorkUnitAutoClear).toBe(null);
  });

  it("save calls only mutations for dirty fields", async () => {
    const updateSettingsAsync = vi.fn().mockResolvedValue(undefined);
    const updateBlueprintAsync = vi.fn().mockResolvedValue(undefined);
    mockedUseProjectSettings.mockReturnValue(
      makeProjectSettings({ updateSettingsAsync }) as unknown as ReturnType<
        typeof useProjectSettings
      >,
    );
    mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
      mutateAsync: updateBlueprintAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftBlueprint("my-bp");
    });

    let saveResult: { ok: boolean; failed: string[] } | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(updateBlueprintAsync).toHaveBeenCalledWith("my-bp");
    expect(updateSettingsAsync).not.toHaveBeenCalled();
    expect(saveResult?.ok).toBe(true);
  });

  it("save sends all dirty bench override fields in a single mutation", async () => {
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
      result.current.setDraftAutoClear(true);
      result.current.setDraftEnforceIssueDependencies(false);
    });

    await act(async () => {
      await result.current.save();
    });

    // Both dirty bench overrides sent in one call
    expect(updateBenchOverridesAsync).toHaveBeenCalledTimes(1);
    expect(updateBenchOverridesAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        autoClear: true,
        enforceIssueDependencies: false,
      }),
    );
  });

  it("save returns ok=false and failed list when a mutation rejects", async () => {
    const updateBlueprintAsync = vi.fn().mockRejectedValue(new Error("Server error"));
    mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
      mutateAsync: updateBlueprintAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);

    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftBlueprint("my-bp");
    });

    let saveResult: { ok: boolean; failed: string[] } | undefined;
    await act(async () => {
      saveResult = await result.current.save();
    });

    expect(saveResult?.ok).toBe(false);
    expect(saveResult?.failed).toContain("Blueprint override");
    expect(result.current.saveErrors).toContain("Blueprint override");
    // blueprint is still dirty because save failed
    expect(result.current.isBlueprintDirty).toBe(true);
  });

  it("partial failure: bench overrides failure reported as 'Bench overrides'", async () => {
    const updateBlueprintAsync = vi.fn().mockResolvedValue(undefined);
    const updateBenchOverridesAsync = vi.fn().mockRejectedValue(new Error("Server error"));
    mockedUseUpdateProjectDefaultBlueprint.mockReturnValue({
      mutateAsync: updateBlueprintAsync,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useUpdateProjectDefaultBlueprint>);
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
      result.current.setDraftBlueprint("my-bp");
      result.current.setDraftAutoClear(true);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.saveErrors).toContain("Bench overrides");
    expect(result.current.saveErrors).not.toContain("Blueprint override");
  });

  it("hasAnyDirty is false immediately after a successful save", async () => {
    const { result } = renderHookWithProviders(() =>
      useSettingsOverviewDraft("my-app", baseProject),
    );

    act(() => {
      result.current.setDraftBlueprint("my-bp");
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
      result.current.setDraftBlueprint("my-bp");
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
      result.current.setDraftBlueprint("my-bp");
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.justSavedRef.current).toBe(true);

    act(() => {
      result.current.setDraftAutoClear(true);
    });
    expect(result.current.justSavedRef.current).toBe(false);
  });

  it("re-seeds all drafts when projectId changes", () => {
    const projectA: RegisteredProject = {
      ...baseProject,
      id: "project-a",
      config: {
        ...baseConfig,
        blueprints: { defaultBlueprint: "bp-a" },
        benches: {
          max: 3,
          autoClear: true,
          enforceIssueDependencies: false,
          workUnitAutoClear: true,
        },
      },
    };
    const projectB: RegisteredProject = {
      ...baseProject,
      id: "project-b",
      config: {
        ...baseConfig,
        blueprints: { defaultBlueprint: "bp-b" },
        benches: {
          max: 3,
          autoClear: false,
          enforceIssueDependencies: true,
          workUnitAutoClear: false,
        },
      },
    };

    const { result, rerender } = renderHookWithProviders(
      ({ projectId, project }: { projectId: string; project: RegisteredProject }) =>
        useSettingsOverviewDraft(projectId, project),
      { initialProps: { projectId: "project-a", project: projectA } },
    );

    expect(result.current.draftBlueprint).toBe("bp-a");
    expect(result.current.draftAutoClear).toBe(true);
    expect(result.current.draftEnforceIssueDependencies).toBe(false);
    expect(result.current.draftWorkUnitAutoClear).toBe(true);

    rerender({ projectId: "project-b", project: projectB });

    expect(result.current.draftBlueprint).toBe("bp-b");
    expect(result.current.draftAutoClear).toBe(false);
    expect(result.current.draftEnforceIssueDependencies).toBe(true);
    expect(result.current.draftWorkUnitAutoClear).toBe(false);
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
