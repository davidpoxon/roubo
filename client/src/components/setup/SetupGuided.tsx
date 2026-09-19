import { useMemo } from "react";
import { Link } from "react-router";
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
    <h3 className="text-11 font-semibold uppercase tracking-label text-text-secondary mb-4">
      {children}
    </h3>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-bg-base p-6">{children}</div>;
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
            className="flex items-center gap-2 text-12 text-text-secondary mb-2"
          >
            <Link
              to=".."
              relative="path"
              className="inline-flex items-center gap-1 hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronLeft size={12} />
              Settings
            </Link>
            <span aria-hidden="true" className="text-text-secondary">
              /
            </span>
            <span aria-current="page" className="text-text-body">
              Project setup
            </span>
          </nav>
          <h2 className="text-20 font-semibold text-text-primary">Project setup</h2>
        </div>
      )}

      {/* Mode toggle bar: bottom border anchors the scrolling region below it */}
      {!embedded && (
        <div className="flex items-center justify-between gap-4 px-8 py-3 shrink-0 border-b border-border/40">
          <div className="flex items-center gap-3">
            {!isCreateMode && (
              <>
                <GuidedYamlToggle mode={mode} onChange={onModeChange} />
                <span className="text-11 text-text-secondary hidden sm:block">{modeHint}</span>
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
                <div className="mb-4 px-4 py-3 rounded-lg bg-accent-muted border border-accent-border text-13 text-accent-text">
                  {errorSummary}
                </div>
              )}

              {saveError && (
                <div
                  role="alert"
                  className="px-4 py-3 rounded-lg bg-danger-surface border border-danger-border text-13 text-danger-text"
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
                    <p className="text-13 text-text-secondary">
                      No ports configured. Add components to assign ports.
                    </p>
                  ) : (
                    <div>
                      <div className="space-y-1">
                        {portEntries.map(([name, port]) => (
                          <div key={name} className="flex items-center gap-3 text-12 font-mono">
                            <span className="text-text-secondary shrink-0">{name}</span>
                            {benchMax > 0 ? (
                              <span className="text-text-secondary tabular-nums">
                                {port.base} – {port.base + benchMax - 1}
                              </span>
                            ) : (
                              <span className="text-text-secondary tabular-nums">{port.base}</span>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-11 text-text-secondary">
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
          <Label className="block text-12 text-text-secondary mb-1.5">
            Maximum concurrent benches
          </Label>
          <Input
            type="number"
            min={1}
            max={99}
            placeholder="9"
            className="w-24 rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
          />
        </TextField>
        {max > 99 && <p className="mt-1 text-11 text-danger-text">Must be between 1 and 99</p>}
      </div>

      <div>
        <TextField
          value={benches.setup ?? ""}
          onChange={(v) => updateBenches({ setup: v || undefined })}
        >
          <Label className="block text-12 text-text-secondary mb-1.5">Setup command</Label>
          <Input
            type="text"
            placeholder="e.g. cd app && npm ci"
            className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
          />
        </TextField>
        <p className="text-11 text-text-secondary mt-1">
          Runs once at workspace root before components start, through your login shell, so shell
          syntax works (e.g. <span className="font-mono">cd app &amp;&amp; npm ci</span>)
        </p>
      </div>
    </div>
  );
}
