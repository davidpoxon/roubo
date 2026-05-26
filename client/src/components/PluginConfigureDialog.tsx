import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  ExternalLink,
  MinusCircle,
  ShieldAlert,
} from "lucide-react";
import type {
  IntegrationCategoryReport,
  IntegrationCategoryStatus,
  IntegrationConfig,
  IntegrationConfigUpdate,
  IntegrationFields,
  IntegrationFieldsUpdate,
  IntegrationTestResult,
  ProjectIntegrationState,
  SourceCandidatesResponse,
  SourceSelection,
} from "@roubo/shared";
import { ApiError, startGithubPluginOauth } from "../lib/api";
import {
  useSaveIntegrationConfig,
  useTestIntegrationConnection,
} from "../hooks/useProjectIntegration";
import {
  useSaveGlobalPluginIntegration,
  useTestGlobalPluginIntegration,
} from "../hooks/useGlobalPluginIntegration";
import { useSourceCandidates } from "../hooks/useSourceCandidates";
import { useSaveProjectSources } from "../hooks/useSaveProjectSources";
import { useIssueListWarnings } from "../hooks/useIssues";
import { useIntegrationFields, useSaveIntegrationFields } from "../hooks/useIntegrationFields";
import { useOpportunisticRecheckOnMount } from "../hooks/usePlugins";
import { useProjectBenches } from "../hooks/useBenches";
import ConfigSchemaForm from "./ConfigSchemaForm";
import SourcePicker from "./SourcePicker";
import Spinner from "./Spinner";
import GitHubProjectField from "./project-settings/GitHubProjectField";
import SubmodulesEditor from "./project-settings/SubmodulesEditor";
import { passwordFieldKeys } from "./config-schema-utils";
import { INPUT } from "./setup/styles";

// FR-070 (WU-057): plugins listed here host the Repository / GitHub Project /
// Submodules controls inside their Configure modal. Other plugins continue to
// surface the controls elsewhere (or not at all) until their own WU lands.
const PLUGINS_WITH_INTEGRATION_FIELDS = new Set(["github-com"]);

const STRINGS = {
  titlePrefix: "Configure ",
  globalSuffix: "(global defaults)",
  sourcesHeading: "Sources",
  loadingSources: "Loading sources…",
  integrationFieldsHeading: "Repository & metadata",
  repositoryLabel: "Repository",
  repositoryPlaceholder: "org/repo-name",
  testConnection: "Test connection",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  testing: "Testing connection…",
  connectedAs: (displayName: string) => `Connected as ${displayName}.`,
  enableSelfSignedTls: "Enable self-signed TLS and retry",
  githubAccountHeading: "GitHub account",
  connectedAsPrefix: "Connected as ",
  connectPrompt: "Connect your GitHub account to authorize Roubo to read issues and projects.",
  reconnect: "Reconnect",
  connectGithub: "Connect GitHub",
  postOauthHintPrefix: "After authorizing in the browser, click ",
  postOauthHintCta: "Test connection",
  postOauthHintSuffix: " to verify the credential.",
};

type InstalledPlugin = NonNullable<ProjectIntegrationState["plugin"]>;

type Props =
  | {
      scope: "project";
      projectId: string;
      plugin: InstalledPlugin;
      effective: IntegrationConfig;
    }
  | {
      scope: "global";
      plugin: InstalledPlugin;
      effective: IntegrationConfig;
    };

const KNOWN_TLS_FIELD_KEYS = ["allowSelfSignedTls", "allow_self_signed_tls", "allowSelfSignedTLS"];

function findTlsFieldKey(schema: Record<string, unknown> | undefined): string | null {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) return null;
  for (const candidate of KNOWN_TLS_FIELD_KEYS) {
    if (candidate in props) return candidate;
  }
  // Last-resort scan: any boolean field whose key mentions both "tls" and "self".
  for (const [key, def] of Object.entries(props)) {
    if (
      def !== null &&
      typeof def === "object" &&
      (def as { type?: string }).type === "boolean" &&
      /tls/i.test(key) &&
      /self/i.test(key)
    ) {
      return key;
    }
  }
  return null;
}

function snapshotEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function seedInitialValues(
  schema: Record<string, unknown> | undefined,
  effective: IntegrationConfig,
): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const out: Record<string, unknown> = {};
  if (!props) return out;
  const advanced = (effective.advanced ?? {}) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(props)) {
    if (key === "instance") {
      out[key] = effective.instance ?? "";
      continue;
    }
    if (key in advanced) {
      out[key] = advanced[key];
      continue;
    }
    const def = (raw ?? {}) as { default?: unknown; type?: string };
    if (def.default !== undefined) {
      out[key] = def.default;
    } else if (def.type === "boolean") {
      out[key] = false;
    } else {
      out[key] = "";
    }
  }
  return out;
}

export default function PluginConfigureDialog(props: Props) {
  if (props.scope === "global") {
    return <GlobalScopeDialog plugin={props.plugin} effective={props.effective} />;
  }
  return (
    <ProjectScopeDialog
      projectId={props.projectId}
      plugin={props.plugin}
      effective={props.effective}
    />
  );
}

function ProjectScopeDialog({
  projectId,
  plugin,
  effective,
}: {
  projectId: string;
  plugin: InstalledPlugin;
  effective: IntegrationConfig;
}) {
  // Hoist the mutations so the ModalOverlay can gate dismissal on the busy
  // state: Escape / overlay-click must not unmount the dialog mid-save or
  // mid-test, otherwise the in-flight request completes invisibly and any
  // setSubmitError surface is dropped.
  const testMutation = useTestIntegrationConnection(projectId);
  const saveMutation = useSaveIntegrationConfig(projectId);
  const saveSourcesMutation = useSaveProjectSources(projectId);
  const saveFieldsMutation = useSaveIntegrationFields(projectId);
  const isBusy =
    testMutation.isPending ||
    saveMutation.isPending ||
    saveSourcesMutation.isPending ||
    saveFieldsMutation.isPending;

  return (
    <ModalOverlay
      isDismissable={!isBusy}
      isKeyboardDismissDisabled={isBusy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <ConfigureFlow
              mode="project"
              projectId={projectId}
              plugin={plugin}
              effective={effective}
              close={close}
              testMutation={testMutation}
              saveMutation={saveMutation}
              saveSourcesMutation={saveSourcesMutation}
              saveFieldsMutation={saveFieldsMutation}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function GlobalScopeDialog({
  plugin,
  effective,
}: {
  plugin: InstalledPlugin;
  effective: IntegrationConfig;
}) {
  const testMutation = useTestGlobalPluginIntegration(plugin.id);
  const saveMutation = useSaveGlobalPluginIntegration(plugin.id);
  const isBusy = testMutation.isPending || saveMutation.isPending;

  return (
    <ModalOverlay
      isDismissable={!isBusy}
      isKeyboardDismissDisabled={isBusy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <ConfigureFlow
              mode="global"
              plugin={plugin}
              effective={effective}
              close={close}
              testMutation={testMutation}
              saveMutation={saveMutation}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function initialSourceSelection(effective: IntegrationConfig): SourceSelection {
  const out: SourceSelection = {};
  const raw = effective.sources;
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.map((entry) => {
      // Primitive forms (string or number) flatten to the externalId string.
      if (typeof entry === "string") return entry;
      if (typeof entry === "number") return String(entry);
      // Object form: keep only the SourceSelectionEntry-recognized fields so
      // we round-trip the alert booleans but drop any plugin-internal extras.
      const next: {
        externalId: string;
        includeCodeQLAlerts?: boolean;
        includeSecretScanningAlerts?: boolean;
        includeDependabotAlerts?: boolean;
      } = { externalId: String(entry.externalId) };
      if (entry.includeCodeQLAlerts === true) next.includeCodeQLAlerts = true;
      if (entry.includeSecretScanningAlerts === true) next.includeSecretScanningAlerts = true;
      if (entry.includeDependabotAlerts === true) next.includeDependabotAlerts = true;
      return next;
    });
  }
  return out;
}

function submodulesEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const aMap = a ?? {};
  const bMap = b ?? {};
  const aKeys = Object.keys(aMap);
  const bKeys = Object.keys(bMap);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (aMap[k] !== bMap[k]) return false;
  return true;
}

function diffIntegrationFields(
  original: IntegrationFields | undefined,
  next: IntegrationFields,
): IntegrationFieldsUpdate | null {
  if (!original) return null;
  const update: IntegrationFieldsUpdate = {};
  let changed = false;
  const trimmedRepo = next.repo?.trim() ?? "";
  if (trimmedRepo !== (original.repo ?? "")) {
    update.repo = trimmedRepo.length > 0 ? trimmedRepo : null;
    changed = true;
  }
  if (next.githubProject !== original.githubProject) {
    update.githubProject = next.githubProject ?? null;
    changed = true;
  }
  if (!submodulesEqual(next.submodules, original.submodules)) {
    update.submodules =
      next.submodules && Object.keys(next.submodules).length > 0 ? next.submodules : null;
    changed = true;
  }
  return changed ? update : null;
}

function hasAnyCandidates(data: SourceCandidatesResponse | undefined): boolean {
  if (!data) return false;
  if (data.shape === "multi-list") return (data.items?.length ?? 0) > 0;
  return (data.categories ?? []).some((cat) => cat.items.length > 0);
}

type ConfigureFlowProps =
  | {
      mode: "project";
      projectId: string;
      plugin: InstalledPlugin;
      effective: IntegrationConfig;
      close: () => void;
      testMutation: ReturnType<typeof useTestIntegrationConnection>;
      saveMutation: ReturnType<typeof useSaveIntegrationConfig>;
      saveSourcesMutation: ReturnType<typeof useSaveProjectSources>;
      saveFieldsMutation: ReturnType<typeof useSaveIntegrationFields>;
    }
  | {
      mode: "global";
      plugin: InstalledPlugin;
      effective: IntegrationConfig;
      close: () => void;
      testMutation: ReturnType<typeof useTestGlobalPluginIntegration>;
      saveMutation: ReturnType<typeof useSaveGlobalPluginIntegration>;
    };

function ConfigureFlow(props: ConfigureFlowProps) {
  const { mode, plugin, effective, close, testMutation, saveMutation } = props;
  const manifest = plugin.manifest;

  // WU-050: opening the Configure modal triggers a fresh connection-status
  // re-check for this plugin if it is enabled. Skipped for any other status
  // (disabled, errored, incompatible, invalid) per FR-054.
  const recheckIds = useMemo(
    () => (plugin.status === "enabled" ? [plugin.id] : []),
    [plugin.status, plugin.id],
  );
  useOpportunisticRecheckOnMount(recheckIds);
  const initialValues = useMemo(
    () => seedInitialValues(manifest?.configSchema, effective),
    [manifest?.configSchema, effective],
  );
  const initialSources = useMemo(() => initialSourceSelection(effective), [effective]);

  const [values, setValuesState] = useState<Record<string, unknown>>(initialValues);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [lastTestedSnapshot, setLastTestedSnapshot] = useState<Record<string, unknown> | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceSelection>(initialSources);

  // FR-070: repo / linked GitHub Project / submodules are now edited inside
  // the plugin Configure modal. Server values arrive via /integration/fields
  // and the user's pending edits are tracked as a partial overlay so we can
  // diff against the original on Save without an effect-based seed.
  const showIntegrationFields =
    mode === "project" && PLUGINS_WITH_INTEGRATION_FIELDS.has(plugin.id);
  const integrationFieldsQuery = useIntegrationFields(
    mode === "project" && showIntegrationFields ? props.projectId : undefined,
  );
  const [fieldEdits, setFieldEdits] = useState<Partial<IntegrationFields>>({});
  const serverFields = integrationFieldsQuery.data;
  const fields: IntegrationFields = { ...serverFields, ...fieldEdits };
  const setFields = (next: IntegrationFields) => {
    setFieldEdits({
      repo: next.repo,
      githubProject: next.githubProject,
      submodules: next.submodules,
    });
  };
  const isMetaRepo = fields.layoutType === "meta-repo";

  const passwordKeys = useMemo(
    () => new Set(passwordFieldKeys(manifest?.configSchema)),
    [manifest?.configSchema],
  );
  const tlsFieldKey = useMemo(
    () => findTlsFieldKey(manifest?.configSchema),
    [manifest?.configSchema],
  );

  const hasTestedSuccessfully =
    testResult?.ok === true &&
    lastTestedSnapshot !== null &&
    snapshotEquals(values, lastTestedSnapshot);

  // Per-source per-category warnings from the most recent listIssues page-1
  // pull. Global scope has no project context, so the hook is called with
  // undefined and returns [] (AC #7 clear-on-next-pull is implicit: the
  // underlying queryKey is invalidated whenever the issues query refreshes).
  const warnings = useIssueListWarnings(mode === "project" ? props.projectId : undefined);

  // Project-wide count of alert-backed benches keyed by frozen-snapshot
  // issueType. Drives the "<K> existing benches still show alerts from this
  // category." line in the security alerts disclosure (WU-035 / TC-097).
  // Global scope has no project context; the result is left empty.
  const projectIdForBenches = mode === "project" ? props.projectId : undefined;
  const benchesQuery = useProjectBenches(projectIdForBenches);
  const alertBenchCounts = useMemo(() => {
    if (!projectIdForBenches) return undefined;
    const counts: Record<string, number> = {};
    for (const bench of benchesQuery.data ?? []) {
      if (bench.projectId !== projectIdForBenches) continue;
      const it = bench.assignedIssue?.issueType;
      if (!it) continue;
      counts[it] = (counts[it] ?? 0) + 1;
    }
    return counts;
  }, [projectIdForBenches, benchesQuery.data]);

  // Sources are inherently per-project, so the global Plugins-page Configure
  // dialog never queries or renders them. Hooks must still be called
  // unconditionally; passing `null` as the pluginId disables the underlying
  // fetch and is supported by useSourceCandidates.
  const sourceCandidatesQuery = useSourceCandidates(
    mode === "project" ? props.projectId : "",
    mode === "project" && hasTestedSuccessfully ? plugin.id : null,
  );

  function buildUpdate(
    snapshot: Record<string, unknown>,
    identity: IntegrationTestResult & { ok: true },
  ): IntegrationConfigUpdate {
    // Split form values: password keys live in the credential store, `instance`
    // is a top-level override key, everything else goes under `advanced`
    // (opaque-to-roubo per FR-023).
    const advanced: Record<string, unknown> = {};
    let instance: string | undefined;
    for (const [key, value] of Object.entries(snapshot)) {
      if (passwordKeys.has(key)) continue;
      if (key === "instance") {
        instance = typeof value === "string" ? value : undefined;
        continue;
      }
      advanced[key] = value;
    }
    const update: IntegrationConfigUpdate = {
      capturedUserId: identity.identity,
    };
    if (instance !== undefined) update.instance = instance;
    if (Object.keys(advanced).length > 0) update.advanced = advanced;
    return update;
  }

  function setValues(next: Record<string, unknown>) {
    setValuesState(next);
    // Any field change invalidates the previous test success — FR-034 / TC-037.
    // Reset the source selection back to whatever the override held, since the
    // candidate list is keyed to the previously-tested connection.
    setTestResult(null);
    setLastTestedSnapshot(null);
    setSources(initialSources);
  }

  async function runTest(snapshot: Record<string, unknown>) {
    setSubmitError(null);
    try {
      const result = await testMutation.mutateAsync(snapshot);
      setTestResult(result);
      if (result.ok) {
        // Commit instance + advanced + capturedUserId so the subsequent
        // listSourceCandidates fetch sees the right effective config. The test
        // endpoint already persists credentials; this brings instance/advanced
        // into line so the source picker can populate without forcing a manual
        // intermediate Save.
        try {
          await saveMutation.mutateAsync(buildUpdate(snapshot, result));
          setLastTestedSnapshot(snapshot);
        } catch (err) {
          setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
          setLastTestedSnapshot(null);
        }
      } else {
        setLastTestedSnapshot(null);
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: {
          kind: "other",
          message: err instanceof ApiError ? err.message : (err as Error).message,
        },
      });
      setLastTestedSnapshot(null);
    }
  }

  async function handleEnableTls() {
    if (!tlsFieldKey) return;
    const next = { ...values, [tlsFieldKey]: true };
    setValuesState(next);
    // Keep `testResult` showing the TLS message until the rerun completes;
    // intentionally do NOT clear here, otherwise the strip flickers blank.
    await runTest(next);
  }

  async function handleSave() {
    if (!hasTestedSuccessfully || testResult?.ok !== true) return;
    setSubmitError(null);

    // Instance/advanced + capturedUserId were already committed in `runTest`
    // when the test passed. In project mode Save is dedicated to persisting
    // the source selection; in global mode there's nothing left to persist
    // (sources are per-project) so we just close.
    if (mode === "global") {
      close();
      return;
    }
    try {
      await props.saveSourcesMutation.mutateAsync(sources);
      const update = diffIntegrationFields(serverFields, fields);
      if (update) {
        await props.saveFieldsMutation.mutateAsync(update);
      }
      close();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  const saveSourcesPending = mode === "project" ? props.saveSourcesMutation.isPending : false;
  const saveFieldsPending = mode === "project" ? props.saveFieldsMutation.isPending : false;
  const isBusy =
    testMutation.isPending || saveMutation.isPending || saveSourcesPending || saveFieldsPending;
  const showSourcesSection =
    mode === "project" &&
    hasTestedSuccessfully &&
    (sourceCandidatesQuery.isLoading || hasAnyCandidates(sourceCandidatesQuery.data));

  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          {STRINGS.titlePrefix}
          {manifest?.name ?? plugin.id}
          {mode === "global" && (
            <span className="ml-2 text-[11px] font-normal text-stone-400 dark:text-stone-500">
              {STRINGS.globalSuffix}
            </span>
          )}
        </Heading>
      </div>

      <div className="px-5 py-4 space-y-4">
        {plugin.id === "github-com" && <GithubOauthSection testResult={testResult} />}

        <ConfigSchemaForm
          schema={manifest?.configSchema}
          permissions={manifest?.permissions}
          values={values}
          onChange={setValues}
        />

        <ResultStrip
          testing={testMutation.isPending}
          result={testResult}
          tlsFieldKey={tlsFieldKey}
          onEnableTls={handleEnableTls}
        />

        {showSourcesSection && (
          <div className="flex flex-col gap-2" data-testid="sources-section">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
              {STRINGS.sourcesHeading}
            </span>
            {sourceCandidatesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
                <Spinner />
                {STRINGS.loadingSources}
              </div>
            ) : sourceCandidatesQuery.data ? (
              <SourcePicker
                response={sourceCandidatesQuery.data}
                value={sources}
                onChange={setSources}
                warnings={warnings}
                alertBenchCounts={alertBenchCounts}
                chipContext={{
                  pluginId: plugin.id,
                  // GHE PAT settings link target, derived from whichever
                  // instance the user has typed (or saved). The chip falls
                  // back to the generic "Unavailable" pill if absent, so the
                  // missing-instance edge case still renders gracefully.
                  gheInstanceUrl:
                    plugin.id === "ghe"
                      ? typeof values.instance === "string" && values.instance.length > 0
                        ? values.instance
                        : (effective.instance ?? undefined)
                      : undefined,
                  // OAuth re-consent fallback for the github-com chip.
                  // Reuses the same window.open call as the standalone
                  // GithubOauthSection's "Connect" button so the chip and
                  // the button funnel through one flow.
                  onReconnectOAuth:
                    plugin.id === "github-com"
                      ? () => {
                          void (async () => {
                            try {
                              const { url } = await startGithubPluginOauth();
                              window.open(url, "_blank", "noopener,noreferrer");
                            } catch (err) {
                              setSubmitError(
                                err instanceof ApiError ? err.message : (err as Error).message,
                              );
                            }
                          })();
                        }
                      : undefined,
                }}
              />
            ) : null}
          </div>
        )}

        {showIntegrationFields && (
          <div className="flex flex-col gap-4" data-testid="integration-fields-section">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
              {STRINGS.integrationFieldsHeading}
            </span>
            <TextField
              value={fields.repo ?? ""}
              onChange={(v) => setFields({ ...fields, repo: v })}
            >
              <Label className="block text-xs text-stone-500 mb-1.5">
                {STRINGS.repositoryLabel}
              </Label>
              <Input placeholder={STRINGS.repositoryPlaceholder} className={INPUT} />
            </TextField>
            <GitHubProjectField
              repo={fields.repo}
              value={fields.githubProject}
              onChange={(next) => setFields({ ...fields, githubProject: next })}
            />
            {isMetaRepo && (
              <SubmodulesEditor
                value={fields.submodules ?? {}}
                onChange={(next) => setFields({ ...fields, submodules: next })}
              />
            )}
          </div>
        )}

        {submitError && (
          <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
            {submitError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          isDisabled={isBusy}
          onPress={() => void runTest(values)}
          data-testid="test-connection"
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {STRINGS.testConnection}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            isDisabled={isBusy}
            onPress={close}
            className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {STRINGS.cancel}
          </Button>
          <Button
            isDisabled={!hasTestedSuccessfully || isBusy}
            onPress={() => void handleSave()}
            data-testid="save-config"
            className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            {saveMutation.isPending || saveSourcesPending || saveFieldsPending
              ? STRINGS.saving
              : STRINGS.save}
          </Button>
        </div>
      </div>
    </>
  );
}

// Worst-status colour for the outer container when per-category rows render:
// any `error` => red, else any `scope-missing` => amber, else green. Keeps the
// outer card readable at a glance while the per-row icons carry the detail.
type StripTone = "green" | "amber" | "red";

const TONE_BORDER: Record<StripTone, string> = {
  green: "border-green-200 dark:border-green-900/40",
  amber: "border-amber-200 dark:border-amber-900/40",
  red: "border-red-200 dark:border-red-900/40",
};

const TONE_BG: Record<StripTone, string> = {
  green: "bg-green-50 dark:bg-green-950/20",
  amber: "bg-amber-50 dark:bg-amber-950/20",
  red: "bg-red-50 dark:bg-red-950/20",
};

function worstStatusTone(categories: readonly IntegrationCategoryReport[]): StripTone {
  let tone: StripTone = "green";
  for (const c of categories) {
    if (c.status === "error") return "red";
    if (c.status === "scope-missing" || c.status === "timed-out") tone = "amber";
  }
  return tone;
}

const STATUS_TEXT: Record<IntegrationCategoryStatus, string> = {
  ok: "ok",
  "scope-missing": "scope missing",
  "not-enabled": "not enabled",
  "timed-out": "timed out",
  error: "error",
};

export function CategoryRow({ category }: { category: IntegrationCategoryReport }) {
  const testId = `test-result-category-${category.category}-${category.status}`;
  const iconClass = "shrink-0";
  let Icon: typeof CheckCircle2;
  let iconColor: string;
  let textColor: string;
  switch (category.status) {
    case "ok":
      Icon = CheckCircle2;
      iconColor = "text-green-600 dark:text-green-400";
      textColor = "text-green-800 dark:text-green-300";
      break;
    case "scope-missing":
      Icon = ShieldAlert;
      iconColor = "text-amber-600 dark:text-amber-400";
      textColor = "text-amber-800 dark:text-amber-300";
      break;
    case "not-enabled":
      Icon = MinusCircle;
      iconColor = "text-stone-400 dark:text-stone-500";
      textColor = "text-stone-500 dark:text-stone-500";
      break;
    case "timed-out":
      Icon = Clock;
      iconColor = "text-amber-600 dark:text-amber-400";
      textColor = "text-amber-800 dark:text-amber-300";
      break;
    case "error":
      Icon = AlertCircle;
      iconColor = "text-red-500";
      textColor = "text-red-800 dark:text-red-300";
      break;
  }
  return (
    <li data-testid={testId} className="flex items-start gap-2 text-[12px] leading-snug">
      <Icon size={13} className={`${iconClass} ${iconColor} mt-0.5`} />
      <div className="min-w-0 flex-1">
        <p className={textColor}>
          <span className="font-medium">{category.label}</span>
          <span className="mx-1.5 text-stone-400 dark:text-stone-600">·</span>
          <span>{STATUS_TEXT[category.status]}</span>
        </p>
        {category.detail && (
          <p className="text-[11px] text-stone-500 dark:text-stone-500 mt-0.5">{category.detail}</p>
        )}
      </div>
    </li>
  );
}

function ResultStrip({
  testing,
  result,
  tlsFieldKey,
  onEnableTls,
}: {
  testing: boolean;
  result: IntegrationTestResult | null;
  tlsFieldKey: string | null;
  onEnableTls: () => void;
}) {
  if (testing) {
    return (
      <div
        role="status"
        className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40"
      >
        <Loader2 size={14} className="animate-spin text-stone-500" />
        <p className="text-[12px] text-stone-600 dark:text-stone-400">{STRINGS.testing}</p>
      </div>
    );
  }
  if (!result) return null;

  if (result.ok) {
    const categories = result.categories ?? [];
    if (categories.length === 0) {
      return (
        <div
          role="status"
          data-testid="test-result-success"
          className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-950/20"
        >
          <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />
          <p className="text-[12px] text-green-800 dark:text-green-300">
            {STRINGS.connectedAs(result.identity.displayName)}
          </p>
        </div>
      );
    }
    const containerTone = worstStatusTone(categories);
    return (
      <div
        role="status"
        data-testid="test-result-success"
        className={`px-3 py-2 rounded-md border ${TONE_BORDER[containerTone]} ${TONE_BG[containerTone]}`}
      >
        <div className="flex items-center gap-2.5">
          <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />
          <p className="text-[12px] text-green-800 dark:text-green-300">
            {STRINGS.connectedAs(result.identity.displayName)}
          </p>
        </div>
        <ul className="mt-2 flex flex-col gap-1.5">
          {categories.map((category) => (
            <CategoryRow key={category.category} category={category} />
          ))}
        </ul>
      </div>
    );
  }

  const isTls = result.error.kind === "tls";
  return (
    <div
      role="alert"
      data-testid={`test-result-error-${result.error.kind}`}
      className="flex items-start gap-2.5 px-3 py-2 rounded-md border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20"
    >
      <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-[12px] text-red-800 dark:text-red-300 leading-relaxed">
          {result.error.message}
        </p>
        {isTls && tlsFieldKey && (
          <Button
            onPress={onEnableTls}
            data-testid="enable-self-signed-tls"
            className="px-2.5 py-1 text-[11px] font-medium rounded-md border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {STRINGS.enableSelfSignedTls}
          </Button>
        )}
      </div>
    </div>
  );
}

function GithubOauthSection({ testResult }: { testResult: IntegrationTestResult | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = testResult?.ok === true;
  const username = connected ? testResult.identity.displayName : null;

  async function handleConnect() {
    setPending(true);
    setError(null);
    try {
      const { url } = await startGithubPluginOauth();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-2 px-3 py-2.5 rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40"
      data-testid="github-oauth-section"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500 dark:text-stone-500">
            {STRINGS.githubAccountHeading}
          </p>
          {connected ? (
            <p className="text-[12px] text-stone-700 dark:text-stone-300 mt-1">
              {STRINGS.connectedAsPrefix}
              <span className="font-mono text-stone-900 dark:text-stone-100">{username}</span>
            </p>
          ) : (
            <p className="text-[12px] text-stone-500 dark:text-stone-500 mt-1 leading-relaxed">
              {STRINGS.connectPrompt}
            </p>
          )}
        </div>
        <Button
          isDisabled={pending}
          onPress={() => void handleConnect()}
          data-testid="github-connect"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 shrink-0"
        >
          {pending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ExternalLink size={12} aria-hidden />
          )}
          {connected ? STRINGS.reconnect : STRINGS.connectGithub}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
          {error}
        </p>
      )}
      {!connected && (
        <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
          {STRINGS.postOauthHintPrefix}
          <span className="font-medium">{STRINGS.postOauthHintCta}</span>
          {STRINGS.postOauthHintSuffix}
        </p>
      )}
    </div>
  );
}
