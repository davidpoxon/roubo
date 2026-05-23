import { useReducer, useEffect, useRef, useCallback, useState, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import * as YAML from "yaml";
import type { Diagnostic } from "@codemirror/lint";
import type { RouboConfig } from "@roubo/shared";
import { useProjects, useRegisterProject, useReloadProjectConfig } from "../../hooks/useProjects";
import { ApiError } from "../../lib/api";
import {
  useScanRepo,
  useValidateConfig,
  useSaveConfig,
  useSaveRawConfig,
  useRawConfig,
  useEnvKeys,
} from "../../hooks/useSetup";
import { useProjectBenches } from "../../hooks/useBenches";
import {
  wizardReducer,
  createInitialState,
  WIZARD_SECTIONS,
  validateSection,
} from "./wizardReducer";
import { useConfigValidation } from "./useConfigValidation";
import type { SetupMode } from "./GuidedYamlToggle";
import type { SetupYamlEditorRef } from "./SetupYamlEditor";
import type { ValidationStatus, ValidationError } from "./SetupValidationPanel";
import { computeImpact } from "./computeImpact";
import SetupGuided from "./SetupGuided";
import UnsavedChangesDialog from "../jig-editor/UnsavedChangesDialog";

export default function Setup() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const { data: projects } = useProjects();

  const isEditMode = !!projectId;
  const editProject = isEditMode ? projects?.find((a) => a.id === projectId) : undefined;
  const repoPath = isEditMode
    ? (editProject?.repoPath ?? "")
    : (searchParams.get("repoPath") ?? "");

  const [state, dispatch] = useReducer(
    wizardReducer,
    createInitialState(repoPath, isEditMode, projectId),
  );

  // Client-side Zod validation
  const { fieldErrors } = useConfigValidation(state.config);
  useEffect(() => {
    dispatch({ type: "SET_VALIDATION_ERRORS", payload: fieldErrors });
  }, [fieldErrors]);

  // Track guided-mode dirty state
  const configSnapshot = useRef<string | null>(null);
  const [guidedDirty, setGuidedDirty] = useState(false);

  // YAML mode state
  const [mode, setMode] = useState<SetupMode>("guided");
  const [rawYaml, setRawYaml] = useState("");
  const rawYamlInitialized = useRef(false);

  // Discard dialog for YAML→Guided when YAML has parse errors
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const pendingModeRef = useRef<SetupMode | null>(null);

  // Load raw config from server
  const { data: rawConfigData } = useRawConfig(projectId);
  useEffect(() => {
    if (rawConfigData?.yaml && !rawYamlInitialized.current) {
      rawYamlInitialized.current = true;
      setRawYaml(rawConfigData.yaml);
    }
  }, [rawConfigData]);

  // Scan repo
  const { data: scanData } = useScanRepo(repoPath, !!repoPath);

  // Primes the React Query cache so child components' useEnvKeys() calls get an immediate cache hit.
  useEnvKeys();

  // Benches for summary + impact panels
  const { data: benches } = useProjectBenches(projectId);

  // Apply scan results (once)
  const scanApplied = useRef(false);
  useEffect(() => {
    if (!scanData || scanApplied.current) return;
    scanApplied.current = true;
    if (isEditMode) {
      dispatch({
        type: "APPLY_SCAN_RESULT",
        payload: { ...scanData, existingConfig: null },
      });
    } else {
      dispatch({ type: "APPLY_SCAN_RESULT", payload: scanData });
    }
  }, [scanData, isEditMode]);

  // Load existing config in edit mode
  const configLoaded = useRef(false);
  useEffect(() => {
    if (!isEditMode || configLoaded.current || !editProject?.configValid || !editProject?.config)
      return;
    configLoaded.current = true;
    dispatch({ type: "LOAD_EXISTING_CONFIG", payload: editProject.config });
    // Capture snapshot after initial load
    configSnapshot.current = JSON.stringify(editProject.config);
  }, [isEditMode, editProject]);

  // Track guided dirty state
  useEffect(() => {
    if (configSnapshot.current === null) return;
    const current = JSON.stringify(state.config);
    if (current !== configSnapshot.current) {
      setGuidedDirty(true);
    }
  }, [state.config]);

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
          {
            config: c as RouboConfig,
            currentProjectId: state.currentProjectId,
          },
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
  }, [state.currentProjectId, validateConfig]);

  // Validate all sections whenever config changes
  useEffect(() => {
    const sections = WIZARD_SECTIONS.filter((s) => s !== "review");
    for (const section of sections) {
      const status = validateSection(section, state.config);
      if (status !== undefined && status !== state.sectionStatus[section]) {
        dispatch({ type: "SET_SECTION_STATUS", payload: { section, status } });
      }
    }
  }, [state.config, state.sectionStatus]);

  // Check port conflicts whenever config changes
  useEffect(() => {
    checkConflicts();
  }, [state.config, checkConflicts]);

  // ── Validation panel state (lifted from SetupYaml) ─────────────────────────
  const editorRef = useRef<SetupYamlEditorRef>(null);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>("idle");
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | undefined>();
  const [formatError, setFormatError] = useState<string | null>(null);
  const validatedOnce = useRef(false);

  const schemaValidation = useValidateConfig();
  const { mutate: mutateValidate, isPending: isValidating } = schemaValidation;

  const runValidate = useCallback(() => {
    validatedOnce.current = true;
    let configToValidate: RouboConfig;

    if (mode === "yaml") {
      let parsed: unknown;
      try {
        parsed = YAML.parse(rawYaml);
      } catch (err) {
        const yamlErr = err as {
          linePos?: [{ line: number }, { line: number }];
          message: string;
        };
        setValidationStatus("errors");
        setValidationErrors([
          {
            path: "roubo.yaml",
            message: yamlErr.message,
            line: yamlErr.linePos?.[0].line,
          },
        ]);
        setLastCheckedAt(new Date());
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setValidationStatus("errors");
        setValidationErrors([
          { path: "roubo.yaml", message: "YAML must be a mapping, not a scalar or sequence." },
        ]);
        setLastCheckedAt(new Date());
        return;
      }
      configToValidate = parsed as RouboConfig;
    } else {
      configToValidate = state.config as RouboConfig;
    }

    setValidationStatus("pending");
    mutateValidate(
      { config: configToValidate, currentProjectId: projectId },
      {
        onSuccess: (result) => {
          if (result.valid) {
            setValidationStatus("valid");
            setValidationErrors([]);
          } else {
            setValidationStatus("errors");
            setValidationErrors(result.errors);
          }
          setLastCheckedAt(new Date());
        },
        onError: () => {
          setValidationStatus("idle");
        },
      },
    );
  }, [mode, rawYaml, state.config, projectId, mutateValidate]);

  // Auto-re-validate after first manual check — YAML mode
  useEffect(() => {
    if (!validatedOnce.current || mode !== "yaml") return;
    const timer = setTimeout(runValidate, 600);
    return () => clearTimeout(timer);
  }, [rawYaml, mode, runValidate]);

  // Auto-re-validate after first manual check — Guided mode
  useEffect(() => {
    if (!validatedOnce.current || mode !== "guided") return;
    const timer = setTimeout(runValidate, 600);
    return () => clearTimeout(timer);
  }, [state.config, mode, runValidate]);

  // Diagnostics for CodeMirror (YAML parse errors only)
  const diagnostics: Diagnostic[] = useMemo(() => {
    if (validationStatus !== "errors") return [];
    const rawLines = rawYaml.split("\n");
    return validationErrors
      .filter((e) => e.line != null)
      .map((e) => {
        const lineIdx = (e.line ?? 1) - 1;
        const from = rawLines.slice(0, lineIdx).reduce((acc, l) => acc + l.length + 1, 0);
        const to = from + (rawLines[lineIdx]?.length ?? 0);
        return {
          from,
          to: Math.max(from + 1, to),
          severity: "error" as const,
          message: `${e.path}: ${e.message}`,
        };
      });
  }, [validationStatus, validationErrors, rawYaml]);

  // Impact panel data
  const pendingConfig = useMemo(() => {
    if (mode === "guided") return state.config as RouboConfig;
    try {
      return YAML.parse(rawYaml) as RouboConfig;
    } catch {
      return undefined;
    }
  }, [mode, rawYaml, state.config]);

  const impact = useMemo(() => {
    if (!pendingConfig || !benches) return null;
    return computeImpact(pendingConfig, editProject?.config, benches);
  }, [pendingConfig, editProject?.config, benches]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const saveConfig = useSaveConfig();
  const saveRawConfig = useSaveRawConfig(projectId);
  const reloadConfig = useReloadProjectConfig();
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const registerProject = useRegisterProject();

  const handleSave = () => {
    setSaveError(undefined);
    if (mode === "yaml") {
      saveRawConfig.mutate(
        { yaml: rawYaml },
        {
          onSuccess: () => {
            try {
              const parsed = YAML.parse(rawYaml);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                dispatch({
                  type: "LOAD_EXISTING_CONFIG",
                  payload: parsed as RouboConfig,
                });
                configSnapshot.current = JSON.stringify(parsed);
              }
            } catch {
              // parse failure after successful save — non-fatal
            }
            if (isEditMode && projectId) {
              reloadConfig.mutate(projectId);
            }
            setGuidedDirty(false);
          },
          onError: (err) => {
            if (err instanceof ApiError) {
              const body = err.details as Record<string, unknown> | undefined;
              if (
                Array.isArray(body?.errors) &&
                typeof (body.errors as unknown[])[0] === "object"
              ) {
                const serverErrors = body.errors as Array<{
                  path: string;
                  message: string;
                }>;
                const errorMap = Object.fromEntries(serverErrors.map((e) => [e.path, e.message]));
                dispatch({
                  type: "MERGE_VALIDATION_ERRORS",
                  payload: errorMap,
                });
                setSaveError(
                  `Save failed: ${serverErrors.length} field${serverErrors.length === 1 ? "" : "s"} need attention`,
                );
                return;
              }
              if (body?.yamlError && typeof body.yamlError === "object") {
                const ye = body.yamlError as {
                  line?: number;
                  message?: string;
                };
                setSaveError(
                  `YAML parse error${ye.line != null ? ` on line ${ye.line}` : ""}: ${ye.message ?? ""}`,
                );
                return;
              }
            }
            setSaveError(err instanceof Error ? err.message : String(err));
          },
        },
      );
    } else {
      saveConfig.mutate(
        {
          repoPath: state.repoPath || repoPath,
          config: state.config as RouboConfig,
        },
        {
          onSuccess: () => {
            if (!isEditMode) {
              registerProject.mutate(state.repoPath || repoPath);
            }
            if (isEditMode && projectId) {
              reloadConfig.mutate(projectId);
            }
            setGuidedDirty(false);
            configSnapshot.current = JSON.stringify(state.config);
          },
          onError: (err) => {
            if (err instanceof ApiError) {
              const body = err.details as Record<string, unknown> | undefined;
              if (
                Array.isArray(body?.errors) &&
                typeof (body.errors as unknown[])[0] === "object"
              ) {
                const serverErrors = body.errors as Array<{
                  path: string;
                  message: string;
                }>;
                const errorMap = Object.fromEntries(serverErrors.map((e) => [e.path, e.message]));
                dispatch({
                  type: "MERGE_VALIDATION_ERRORS",
                  payload: errorMap,
                });
                setSaveError("Please fix the highlighted fields above");
                return;
              }
            }
            setSaveError(err instanceof Error ? err.message : String(err));
          },
        },
      );
    }
  };

  const isSaving = saveConfig.isPending || saveRawConfig.isPending;

  const handleModeChange = (newMode: SetupMode) => {
    if (newMode === mode) return;
    setSaveError(undefined);

    if (newMode === "yaml") {
      // Guided → YAML
      if (guidedDirty) {
        // Serialize current guided config (comments lost, but user is explicitly
        // switching to YAML to edit anyway)
        const serialized = YAML.stringify(state.config as Record<string, unknown>, {
          indent: 2,
          lineWidth: 0,
          defaultStringType: "QUOTE_DOUBLE",
          defaultKeyType: "PLAIN",
        });
        setRawYaml(serialized);
      }
      // If clean: keep rawYaml untouched (preserves comments — AC#6)
      setMode("yaml");
    } else {
      // YAML → Guided
      try {
        const parsed = YAML.parse(rawYaml);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          dispatch({
            type: "LOAD_EXISTING_CONFIG",
            payload: parsed as RouboConfig,
          });
          configSnapshot.current = JSON.stringify(parsed);
          setGuidedDirty(false);
        }
        setMode("guided");
      } catch {
        // YAML has parse errors — prompt discard
        pendingModeRef.current = "guided";
        setShowDiscardDialog(true);
      }
    }
  };

  const handleDiscardConfirm = () => {
    setShowDiscardDialog(false);
    if (pendingModeRef.current) {
      setMode(pendingModeRef.current);
      pendingModeRef.current = null;
    }
  };

  const handleDiscardCancel = () => {
    setShowDiscardDialog(false);
    pendingModeRef.current = null;
  };

  return (
    <>
      <SetupGuided
        state={state}
        dispatch={dispatch}
        repoPath={state.repoPath || repoPath}
        projectId={projectId}
        isSaving={isSaving}
        saveError={saveError}
        onSave={handleSave}
        isCreateMode={!isEditMode}
        mode={mode}
        onModeChange={handleModeChange}
        rawYaml={rawYaml}
        onRawYamlChange={setRawYaml}
        editorRef={editorRef}
        diagnostics={diagnostics}
        formatError={formatError}
        onFormatErrorChange={setFormatError}
        validationStatus={validationStatus}
        validationErrors={validationErrors}
        lastCheckedAt={lastCheckedAt}
        onValidate={runValidate}
        isValidating={isValidating}
        impact={impact}
        benches={benches}
      />
      <UnsavedChangesDialog
        isOpen={showDiscardDialog}
        onConfirm={handleDiscardConfirm}
        onCancel={handleDiscardCancel}
      />
    </>
  );
}
