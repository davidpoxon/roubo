import {
  useReducer,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
} from "react";
import type { RouboConfig, RegisteredProject } from "@roubo/shared";
import { useRegisterProject } from "../hooks/useProjects";
import { useScanRepo, useValidateConfig, useSaveConfig, useEnvKeys } from "../hooks/useSetup";
import {
  wizardReducer,
  createInitialState,
  WIZARD_SECTIONS,
  validateSection,
  isWizardSaveDisabled,
} from "./setup/wizardReducer";
import SetupGuided from "./setup/SetupGuided";

interface Props {
  repoPath: string;
  onReady: (h: {
    save: () => void;
    isSaveDisabled: boolean;
    isSaving: boolean;
    saveError?: string;
  }) => void;
  onSaved: (project: RegisteredProject) => void;
}

export default function EmbeddedGuidedSetup({ repoPath, onReady, onSaved }: Props) {
  const [state, dispatch] = useReducer(wizardReducer, createInitialState(repoPath, false));

  const { data: scanData } = useScanRepo(repoPath, !!repoPath);
  useEnvKeys(); // prefetch env keys for child sections

  const scanApplied = useRef(false);
  useEffect(() => {
    if (!scanData || scanApplied.current) return;
    scanApplied.current = true;
    dispatch({ type: "APPLY_SCAN_RESULT", payload: scanData });
  }, [scanData]);

  // Port conflict checking (debounced)
  const validateConfig = useValidateConfig();
  const conflictTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestConfig = useRef(state.config);
  useEffect(() => {
    latestConfig.current = state.config;
  }, [state.config]);

  const checkConflicts = useCallback(() => {
    if (conflictTimer.current) clearTimeout(conflictTimer.current);
    conflictTimer.current = setTimeout(() => {
      const c = latestConfig.current;
      if (c.project?.name && c.ports && Object.keys(c.ports).length > 0 && c.benches?.max) {
        validateConfig.mutate(
          { config: c as RouboConfig, currentProjectId: undefined },
          {
            onSuccess: (result) =>
              dispatch({
                type: "SET_PORT_CONFLICTS",
                payload: result.portConflicts,
              }),
          },
        );
      }
    }, 500);
  }, [validateConfig]);

  // Validate all sections whenever config changes; dispatching the same status is
  // a no-op because SET_SECTION_STATUS returns the existing state when unchanged.
  useEffect(() => {
    const sections = WIZARD_SECTIONS.filter((s) => s !== "review");
    for (const section of sections) {
      const status = validateSection(section, state.config);
      if (status !== undefined) {
        dispatch({ type: "SET_SECTION_STATUS", payload: { section, status } });
      }
    }
  }, [state.config]);

  // Check port conflicts whenever config changes; clear pending timer on unmount
  useEffect(() => {
    checkConflicts();
    return () => {
      if (conflictTimer.current) clearTimeout(conflictTimer.current);
    };
  }, [state.config, checkConflicts]);

  const saveConfig = useSaveConfig();
  const { mutate: saveMutate } = saveConfig;
  const registerProject = useRegisterProject();
  const { mutate: registerMutate } = registerProject;
  const [error, setError] = useState<string | undefined>();

  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // Stable wrapper — the actual implementation lives in a ref updated by useLayoutEffect
  const handleSaveImplRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    handleSaveImplRef.current = () => {
      setError(undefined);
      saveMutate(
        {
          repoPath: state.repoPath || repoPath,
          config: state.config as RouboConfig,
        },
        {
          onSuccess: () => {
            registerMutate(state.repoPath || repoPath, {
              onSuccess: onSavedRef.current,
              onError: (err) =>
                setError(`Config saved, but registration failed: ${(err as Error).message}`),
            });
          },
          onError: (err) => setError((err as Error).message),
        },
      );
    };
  }, [saveMutate, registerMutate, state.repoPath, state.config, repoPath]);

  const handleSave = useCallback(() => {
    handleSaveImplRef.current();
  }, []);

  const isSaving = saveConfig.isPending || registerProject.isPending;

  const isSaveDisabled = useMemo(() => isWizardSaveDisabled(state, isSaving), [state, isSaving]);

  // Propagate handlers to parent whenever the relevant state changes
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onReadyRef.current({
      save: handleSave,
      isSaveDisabled,
      isSaving,
      saveError: error,
    });
  }, [handleSave, isSaveDisabled, isSaving, error]);

  return (
    <SetupGuided
      state={state}
      dispatch={dispatch}
      repoPath={repoPath}
      projectId={undefined}
      isSaving={isSaving}
      saveError={error}
      onSave={handleSave}
      isCreateMode
      embedded
    />
  );
}
