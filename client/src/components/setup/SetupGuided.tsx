import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { TextField, Label, Input } from "react-aria-components";
import * as YAML from "yaml";
import type { Diagnostic } from "@codemirror/lint";
import type { BenchesConfig, Bench } from "@roubo/shared";
import type { WizardState, WizardAction } from "./wizardReducer";
import { isWizardSaveDisabled, legacyComponents } from "./wizardReducer";
import SectionProjectInfo from "./SectionProjectInfo";
import SectionInspection from "./SectionInspection";
import ToolChipList from "./ToolChipList";
import ComponentsList from "./ComponentsList";
import GuidedYamlToggle, { type SetupMode } from "./GuidedYamlToggle";
import ExtraFieldsIndicator from "./ExtraFieldsIndicator";
import { detectExtraFields } from "./detectExtraFields";
import SetupYaml from "./SetupYaml";
import SaveBar from "../settings/SaveBar";
import SetupSidebar from "./SetupSidebar";
import type { PortConflict } from "./SetupSidebar";
import type { ValidationStatus, ValidationError } from "./SetupValidationPanel";
import type { SetupYamlEditorRef } from "./SetupYamlEditor";
import type { ImpactResult } from "./computeImpact";

interface Props {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  repoPath: string;
  projectId?: string;
  isSaving: boolean;
  saveError?: string;
  onSave: () => void;
  isCreateMode: boolean;
  embedded?: boolean;
  mode?: SetupMode;
  onModeChange?: (mode: SetupMode) => void;
  rawYaml?: string;
  onRawYamlChange?: (next: string) => void;
  editorRef?: React.RefObject<SetupYamlEditorRef | null>;
  diagnostics?: Diagnostic[];
  formatError?: string | null;
  onFormatErrorChange?: (err: string | null) => void;
  validationStatus?: ValidationStatus;
  validationErrors?: ValidationError[];
  lastCheckedAt?: Date;
  onValidate?: () => void;
  isValidating?: boolean;
  impact?: ImpactResult | null;
  benches?: Bench[];
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-4">
      {children}
    </h3>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/30 p-6">
      {children}
    </div>
  );
}

export default function SetupGuided({
  state,
  dispatch,
  repoPath,
  projectId,
  isSaving,
  saveError,
  onSave,
  isCreateMode,
  embedded = false,
  mode = "guided" as SetupMode,
  onModeChange = () => {},
  rawYaml = "",
  onRawYamlChange = () => {},
  editorRef,
  diagnostics = [],
  formatError = null,
  onFormatErrorChange = () => {},
  validationStatus = "idle",
  validationErrors = [],
  lastCheckedAt,
  onValidate = () => {},
  isValidating = false,
  impact = null,
  benches,
}: Props) {
  const extraFields = useMemo(() => {
    if (!rawYaml) return [];
    try {
      const parsed = YAML.parse(rawYaml);
      return detectExtraFields(parsed);
    } catch {
      return [];
    }
  }, [rawYaml]);

  const config = state.config;
  const portNames = Object.keys(config.ports ?? {});
  const componentNames = Object.keys(config.components ?? {});
  const projectName = config.project?.name ?? "";
  const tools = config.tools ?? [];
  const portEntries = Object.entries(config.ports ?? {});
  const benchMax = config.benches?.max ?? 0;

  const isSaveDisabled = useMemo(
    () => (mode === "yaml" ? isSaving : isWizardSaveDisabled(state, isSaving)),
    [mode, state, isSaving],
  );

  const saveLabel = isSaving ? "Saving…" : isCreateMode ? "Save & Register Setup" : "Save setup";

  const validationErrorCount = Object.keys(state.validationErrors).length;
  const errorSummary =
    mode !== "yaml" && validationErrorCount > 0
      ? `${validationErrorCount} field${validationErrorCount === 1 ? "" : "s"} ${
          validationErrorCount === 1 ? "needs" : "need"
        } attention`
      : undefined;

  const modeHint =
    mode === "guided"
      ? "Guided covers every field. YAML is for edits the form can't express."
      : "Direct edits to .roubo/roubo.yaml. No safety nets beyond schema validation.";

  return (
    <div className="flex flex-col h-full">
      {/* Page header: standalone only, always visible regardless of mode */}
      {!embedded && (
        <div className="px-8 pt-5 pb-2 shrink-0">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-2 text-[12px] text-stone-500 mb-2"
          >
            <Link
              to=".."
              relative="path"
              className="inline-flex items-center gap-1 hover:text-stone-900 dark:hover:text-stone-200 transition-colors"
            >
              <ChevronLeft size={12} />
              Settings
            </Link>
            <span aria-hidden="true" className="text-stone-400 dark:text-stone-600">
              /
            </span>
            <span aria-current="page" className="text-stone-700 dark:text-stone-300">
              Project setup
            </span>
          </nav>
          <h2 className="text-[18px] font-semibold text-stone-900 dark:text-stone-100">
            Project setup
          </h2>
        </div>
      )}

      {/* Mode toggle bar: bottom border anchors the scrolling region below it */}
      {!embedded && (
        <div className="flex items-center justify-between gap-4 px-8 py-3 shrink-0 border-b border-stone-200 dark:border-stone-800/40">
          <div className="flex items-center gap-3">
            {!isCreateMode && (
              <>
                <GuidedYamlToggle mode={mode} onChange={onModeChange} />
                <span className="text-[10px] text-stone-400 dark:text-stone-500 hidden sm:block">
                  {modeHint}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {mode === "guided" && extraFields.length > 0 && (
              <ExtraFieldsIndicator extraFields={extraFields} />
            )}
          </div>
        </div>
      )}

      {/* Two-column body */}
      <div
        className={
          embedded
            ? "px-6 py-5 max-w-2xl"
            : "flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 px-8 pb-4 overflow-hidden"
        }
      >
        {/* Main column: scrolls */}
        <main className={embedded ? "" : "lg:col-span-8 overflow-auto pr-1"}>
          {mode === "yaml" ? (
            <SetupYaml
              rawYaml={rawYaml}
              onRawYamlChange={onRawYamlChange}
              onSave={onSave}
              saveError={saveError}
              editorRef={editorRef}
              diagnostics={diagnostics}
              formatError={formatError}
              onFormatErrorChange={onFormatErrorChange}
            />
          ) : (
            <div className={embedded ? "" : "space-y-4 py-2"}>
              {/* Embedded modals hide the sticky SaveBar (which normally carries the
                  errorSummary), so surface why "Save & register" is disabled here. */}
              {embedded && !saveError && errorSummary && (
                <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60 text-sm text-amber-700 dark:text-amber-400">
                  {errorSummary}
                </div>
              )}

              {saveError && (
                <div
                  role="alert"
                  className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400"
                >
                  {saveError}
                </div>
              )}

              {/* Identity */}
              <SectionCard>
                <section aria-labelledby="section-identity">
                  <SectionHeading>
                    <span id="section-identity">Identity</span>
                  </SectionHeading>
                  <SectionProjectInfo
                    project={config.project ?? {}}
                    layout={config.layout ?? {}}
                    scanResult={state.scanResult}
                    projectId={projectId}
                    validationErrors={state.validationErrors}
                    dispatch={dispatch}
                  />
                </section>
              </SectionCard>

              {/* Components */}
              <SectionCard>
                <section aria-labelledby="section-components">
                  <SectionHeading>
                    <span id="section-components">Components</span>
                  </SectionHeading>
                  <ComponentsList
                    components={legacyComponents(config.components)}
                    ports={config.ports ?? {}}
                    maxBenches={config.benches?.max ?? 0}
                    portConflicts={state.portConflicts}
                    projectId={projectId}
                    dispatch={dispatch}
                  />
                </section>
              </SectionCard>

              {/* Ports */}
              <SectionCard>
                <section aria-labelledby="section-ports">
                  <SectionHeading>
                    <span id="section-ports">Ports</span>
                  </SectionHeading>
                  {portEntries.length === 0 ? (
                    <p className="text-sm text-stone-500 dark:text-stone-600">
                      No ports configured. Add components to assign ports.
                    </p>
                  ) : (
                    <div>
                      <div className="space-y-1">
                        {portEntries.map(([name, port]) => (
                          <div key={name} className="flex items-center gap-3 text-[12px] font-mono">
                            <span className="text-stone-500 dark:text-stone-400 shrink-0">
                              {name}
                            </span>
                            {benchMax > 0 ? (
                              <span className="text-stone-400 dark:text-stone-600 tabular-nums">
                                {port.base} – {port.base + benchMax - 1}
                              </span>
                            ) : (
                              <span className="text-stone-400 dark:text-stone-600 tabular-nums">
                                {port.base}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-[10px] text-stone-400 dark:text-stone-600">
                        Stride: +1 per bench. Component port bases are set in roubo.yaml.
                      </p>
                    </div>
                  )}
                </section>
              </SectionCard>

              {/* Bench capacity */}
              <SectionCard>
                <section aria-labelledby="section-bench-capacity">
                  <SectionHeading>
                    <span id="section-bench-capacity">Bench capacity</span>
                  </SectionHeading>
                  <BenchCapacityFields benches={config.benches ?? {}} dispatch={dispatch} />
                </section>
              </SectionCard>

              {/* Tools */}
              <SectionCard>
                <section aria-labelledby="section-tools">
                  <SectionHeading>
                    <span id="section-tools">Tools</span>
                  </SectionHeading>
                  <ToolChipList
                    tools={tools}
                    portNames={portNames}
                    componentNames={componentNames}
                    ports={config.ports ?? {}}
                    components={legacyComponents(config.components)}
                    projectName={projectName}
                    dispatch={dispatch}
                  />
                </section>
              </SectionCard>

              {/* Inspections */}
              <SectionCard>
                <section aria-labelledby="section-inspections">
                  <SectionHeading>
                    <span id="section-inspections">Inspections</span>
                  </SectionHeading>
                  <SectionInspection
                    inspection={config.inspection}
                    portNames={portNames}
                    componentNames={componentNames}
                    ports={config.ports ?? {}}
                    components={legacyComponents(config.components)}
                    projectName={projectName}
                    repoPath={repoPath}
                    dispatch={dispatch}
                  />
                </section>
              </SectionCard>

              {/* Bottom padding */}
              <div className="pb-4" />
            </div>
          )}
        </main>

        {/* Right column: scrolls independently, standalone only */}
        {!embedded && projectId && (
          <aside className="hidden lg:block lg:col-span-4 overflow-y-auto overscroll-contain pl-1">
            <SetupSidebar
              mode={mode}
              config={state.config}
              portConflicts={state.portConflicts as PortConflict[]}
              saveError={saveError}
              rawYaml={rawYaml}
              onOutlineSectionClick={(_k, line) => editorRef?.current?.scrollToLine(line)}
              yamlStatus={validationStatus}
              yamlErrors={validationErrors}
              lastCheckedAt={lastCheckedAt}
              onValidate={onValidate}
              isValidating={isValidating}
              impact={impact}
              benches={benches}
            />
          </aside>
        )}
      </div>

      {/* Sticky bottom save bar (hidden when embedded in a modal) */}
      {!embedded && (
        <SaveBar
          onSave={onSave}
          isSaving={isSaving}
          isDisabled={isSaveDisabled}
          saveLabel={saveLabel}
          errorSummary={errorSummary}
        />
      )}
    </div>
  );
}

function BenchCapacityFields({
  benches,
  dispatch,
}: {
  benches: Partial<BenchesConfig>;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const max = benches.max ?? 0;

  const updateBenches = (changes: Partial<BenchesConfig>) => {
    dispatch({
      type: "UPDATE_BENCHES",
      payload: {
        ...benches,
        max: benches.max ?? 0,
        ...changes,
      } as BenchesConfig,
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <TextField
          value={max > 0 ? String(max) : ""}
          onChange={(v) => updateBenches({ max: parseInt(v, 10) || 0 })}
        >
          <Label className="block text-xs text-stone-500 mb-1.5">Maximum concurrent benches</Label>
          <Input
            type="number"
            min={1}
            max={99}
            placeholder="9"
            className="w-24 rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600"
          />
        </TextField>
        {max > 99 && <p className="mt-1 text-[11px] text-red-400">Must be between 1 and 99</p>}
      </div>

      <div>
        <TextField
          value={benches.setup ?? ""}
          onChange={(v) => updateBenches({ setup: v || undefined })}
        >
          <Label className="block text-xs text-stone-500 mb-1.5">Setup command</Label>
          <Input
            type="text"
            placeholder="e.g. cd app && npm ci"
            className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600"
          />
        </TextField>
        <p className="text-[10px] text-stone-500 mt-1">
          Runs once at workspace root before components start, through your login shell, so shell
          syntax works (e.g. <span className="font-mono">cd app &amp;&amp; npm ci</span>)
        </p>
      </div>
    </div>
  );
}
