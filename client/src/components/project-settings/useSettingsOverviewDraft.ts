import { useState, useEffect, useRef } from "react";
import type { RegisteredProject, ProjectSettings } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { useProjectSettings } from "../../hooks/useProjectSettings";
import { useUpdateProjectDefaultJig } from "../../hooks/useProjectDefaultJig";
import { useUpdateProjectBenchOverrides } from "../../hooks/useProjectBenchOverrides";
import { useIssueTypeMappings, useUpdateIssueTypeMappings } from "../../hooks/useIssueTypes";

const EMPTY_MAPPINGS: Record<string, string> = {};

function mappingsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function useSettingsOverviewDraft(projectId: string, project: RegisteredProject) {
  const { settings, updateSettingsAsync } = useProjectSettings(projectId);
  const { mutateAsync: updateJigAsync } = useUpdateProjectDefaultJig(projectId);
  const { mutateAsync: updateBenchOverridesAsync } = useUpdateProjectBenchOverrides(projectId);
  const { data: issueTypeMappingsData } = useIssueTypeMappings(projectId);
  const { mutateAsync: updateIssueTypeMappingsAsync } = useUpdateIssueTypeMappings(projectId);

  const justSavedRef = useRef(false);
  // Mirror of justSavedRef as state so it can be read during render for hasAnyDirty.
  const [justSaved, setJustSaved] = useState(false);
  // Tracks whether the async issue-type mappings query has resolved at least once.
  // Keeps the save bar from flashing dirty during the initial load when
  // serverIssueTypeMappings updates before the draft useEffect seeds the draft.
  const [issueTypeMappingsLoaded, setIssueTypeMappingsLoaded] = useState(false);

  // Originals from server state
  const serverWorktreeSource = settings?.worktreeSource ?? DEFAULT_PROJECT_SETTINGS.worktreeSource;
  const serverJig: string | null = project.config?.jigs?.defaultJig ?? null;
  const serverEnforceIssueDependencies: boolean | null =
    project.config?.benches?.enforceIssueDependencies ?? null;
  const serverIssueTypeMappings: Record<string, string> =
    issueTypeMappingsData?.mappings ?? EMPTY_MAPPINGS;

  // Draft state: init from project config (available immediately)
  // worktreeSource is initialized via useEffect once settings loads
  const [draftWorktreeSourceRaw, setDraftWorktreeSourceRaw] = useState<
    ProjectSettings["worktreeSource"]
  >(DEFAULT_PROJECT_SETTINGS.worktreeSource);
  const [draftJigRaw, setDraftJigRaw] = useState<string | null>(serverJig);
  const [draftEnforceIssueDependenciesRaw, setDraftEnforceIssueDependenciesRaw] = useState<
    boolean | null
  >(serverEnforceIssueDependencies);
  const [draftIssueTypeMappingsRaw, setDraftIssueTypeMappingsRaw] =
    useState<Record<string, string>>(serverIssueTypeMappings);

  const [isSaving, setIsSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);

  // Initialize worktreeSource draft once settings first loads.
  // Reset all drafts when projectId changes so the new project's values re-seed.
  // serverJig/serverAutoClear etc. are in deps so the effect reads current values;
  // the prevProjectIdRef guard ensures re-seeding only runs on projectId changes.
  const settingsLoadedRef = useRef(false);
  const issueTypeMappingsLoadedRef = useRef(false);
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current !== projectId) {
      prevProjectIdRef.current = projectId;
      settingsLoadedRef.current = false;
      issueTypeMappingsLoadedRef.current = false;
      setIssueTypeMappingsLoaded(false);
      setDraftJigRaw(serverJig);
      setDraftEnforceIssueDependenciesRaw(serverEnforceIssueDependencies);
      setDraftIssueTypeMappingsRaw(EMPTY_MAPPINGS);
    }
  }, [projectId, serverJig, serverEnforceIssueDependencies]);
  useEffect(() => {
    if (!settingsLoadedRef.current && settings !== undefined) {
      settingsLoadedRef.current = true;
      setDraftWorktreeSourceRaw(settings.worktreeSource ?? DEFAULT_PROJECT_SETTINGS.worktreeSource);
    }
  }, [settings]);
  useEffect(() => {
    if (!issueTypeMappingsLoadedRef.current && issueTypeMappingsData !== undefined) {
      issueTypeMappingsLoadedRef.current = true;
      setIssueTypeMappingsLoaded(true);
      setDraftIssueTypeMappingsRaw(issueTypeMappingsData.mappings ?? {});
    }
  }, [issueTypeMappingsData]);

  // Setters that reset the justSaved guard so new edits re-enable the blocker
  const setDraftWorktreeSource = (v: ProjectSettings["worktreeSource"]) => {
    justSavedRef.current = false;
    setJustSaved(false);
    setDraftWorktreeSourceRaw(v);
  };
  const setDraftJig = (v: string | null) => {
    justSavedRef.current = false;
    setJustSaved(false);
    setDraftJigRaw(v);
  };
  const setDraftEnforceIssueDependencies = (v: boolean | null) => {
    justSavedRef.current = false;
    setJustSaved(false);
    setDraftEnforceIssueDependenciesRaw(v);
  };
  const setDraftIssueTypeMappings = (v: Record<string, string>) => {
    justSavedRef.current = false;
    setJustSaved(false);
    setDraftIssueTypeMappingsRaw(v);
  };

  // Dirty flags
  const isWorktreeSourceDirty =
    draftWorktreeSourceRaw.branchFromDefault !== serverWorktreeSource.branchFromDefault ||
    draftWorktreeSourceRaw.pullLatest !== serverWorktreeSource.pullLatest;
  const isJigDirty = draftJigRaw !== serverJig;
  const isEnforceIssueDependenciesDirty =
    draftEnforceIssueDependenciesRaw !== serverEnforceIssueDependencies;
  const isIssueTypeMappingsDirty = !mappingsEqual(
    draftIssueTypeMappingsRaw,
    serverIssueTypeMappings,
  );

  // Suppress dirty state immediately after a successful save so the save bar
  // hides without waiting for React Query cache invalidation to complete.
  // Uses justSaved state (not the ref) because refs cannot be read during render.
  const hasAnyDirty =
    (isWorktreeSourceDirty ||
      isJigDirty ||
      isEnforceIssueDependenciesDirty ||
      (issueTypeMappingsLoaded && isIssueTypeMappingsDirty)) &&
    !justSaved;

  const discard = () => {
    setDraftWorktreeSourceRaw(serverWorktreeSource);
    setDraftJigRaw(serverJig);
    setDraftEnforceIssueDependenciesRaw(serverEnforceIssueDependencies);
    setDraftIssueTypeMappingsRaw(serverIssueTypeMappings);
    setSaveErrors([]);
    justSavedRef.current = false;
    setJustSaved(false);
  };

  const save = async (): Promise<{ ok: boolean; failed: string[] }> => {
    setIsSaving(true);
    setSaveErrors([]);

    const failed: string[] = [];

    const tasks: Array<Promise<unknown>> = [];

    if (isWorktreeSourceDirty) {
      tasks.push(
        updateSettingsAsync({
          worktreeSource: draftWorktreeSourceRaw,
        }).catch(() => {
          failed.push("Workspace source");
        }),
      );
    }
    if (isJigDirty) {
      tasks.push(
        updateJigAsync(draftJigRaw).catch(() => {
          failed.push("Jig override");
        }),
      );
    }

    // All bench override fields use a single atomic write to avoid yaml race
    if (isEnforceIssueDependenciesDirty) {
      const patch: Record<string, boolean | null> = {
        enforceIssueDependencies: draftEnforceIssueDependenciesRaw,
      };
      tasks.push(
        updateBenchOverridesAsync(patch).catch(() => {
          failed.push("Bench overrides");
        }),
      );
    }

    if (isIssueTypeMappingsDirty) {
      tasks.push(
        updateIssueTypeMappingsAsync(draftIssueTypeMappingsRaw).catch(() => {
          failed.push("Issue type mappings");
        }),
      );
    }

    await Promise.all(tasks);
    setIsSaving(false);

    if (failed.length > 0) {
      setSaveErrors(failed);
      return { ok: false, failed };
    }

    justSavedRef.current = true;
    setJustSaved(true);
    return { ok: true, failed: [] };
  };

  return {
    draftWorktreeSource: draftWorktreeSourceRaw,
    setDraftWorktreeSource,
    draftJig: draftJigRaw,
    setDraftJig,
    draftEnforceIssueDependencies: draftEnforceIssueDependenciesRaw,
    setDraftEnforceIssueDependencies,
    draftIssueTypeMappings: draftIssueTypeMappingsRaw,
    setDraftIssueTypeMappings,
    originalWorktreeSource: serverWorktreeSource,
    originalJig: serverJig,
    originalEnforceIssueDependencies: serverEnforceIssueDependencies,
    originalIssueTypeMappings: serverIssueTypeMappings,
    hasAnyDirty,
    isWorktreeSourceDirty,
    isJigDirty,
    isEnforceIssueDependenciesDirty,
    isIssueTypeMappingsDirty,
    isSaving,
    saveErrors,
    save,
    discard,
    // Returned as a ref (not state) so the useBlocker callback, which captures
    // a stale closure, always reads the current value at navigation time.
    justSavedRef,
  };
}
