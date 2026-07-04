import { useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import {
  Check,
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
  SourceSelection,
} from "@roubo/shared";
import { ApiError, disconnectGithubPluginOauth, startGithubPluginOauth } from "../lib/api";
import {
  useSaveIntegrationConfig,
  useSaveIntegrationSources,
  useSourceCandidates,
  useStatusCategories,
  useTestIntegrationConnection,
} from "../hooks/useProjectIntegration";
import {
  useSaveGlobalPluginIntegration,
  useTestGlobalPluginIntegration,
} from "../hooks/useGlobalPluginIntegration";
import { useIntegrationFields, useSaveIntegrationFields } from "../hooks/useIntegrationFields";
import { useDerivedGithubSources } from "../hooks/useDerivedGithubSources";
import { useConnectionStatus, useOpportunisticRecheckOnMount } from "../hooks/usePlugins";
import GitHubErrorState from "./GitHubErrorState";
import { useQueryClient } from "@tanstack/react-query";
import ConfigSchemaForm from "./ConfigSchemaForm";
import Spinner from "./Spinner";
import SubmodulesEditor from "./project-settings/SubmodulesEditor";
import { passwordFieldKeys } from "./config-schema-utils";
import { INPUT } from "./setup/styles";
import ConnectionStatusPill from "./settings/plugins/ConnectionStatusPill";
import { derivePluginConnectionState } from "./settings/plugins/derivePluginConnectionState";
import SourcePicker from "./SourcePicker";

// FR-070 (WU-057): plugins listed here host the Repository / GitHub Project /
// Submodules controls inside their Configure modal. The GitHub family
// (github-com, ghe) derives its sources from the repo entered here on save.
// Other plugins continue to surface the controls elsewhere (or not at all)
// until their own WU lands.
const PLUGINS_WITH_INTEGRATION_FIELDS = new Set(["github-com", "ghe"]);

// FR-019: the GitHub family derives its sources from the repo (the
// derived-sources preview), so it does not render the declarative source
// picker. Every other plugin (Jira, third-party) selects sources through the
// host-rendered picker. GHE's own consolidation onto the picker is deferred to
// its consolidation work unit.
const PLUGINS_WITHOUT_SOURCE_PICKER = new Set(["github-com", "ghe"]);

// FR-010 (issue #435): Jira's three system status categories. The Configure
// dialog's exclusion toggle offers these by default; any category already
// present in the saved/default set is unioned in so a custom value stays
// visible and removable. A plugin opts in by declaring
// `defaultIntegrationConfig.excludedStatusCategories` in its manifest.
const CANONICAL_STATUS_CATEGORIES = ["To Do", "In Progress", "Done"];

// FR-013 (issue #558): the actionable "To-Do" category is what the cut list
// exists to surface, so it can never be excluded. Its row renders disabled and
// it is stripped from any persisted exclusion set. Matched case-insensitively
// against the discovered/canonical category names so a real instance's "To Do"
// (or "To-Do") label is recognised regardless of spacing/casing.
function isActionableCategory(category: string): boolean {
  return (
    category
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "") === "todo"
  );
}

// FR-014 (issue #558): plugins with no native In Progress status category
// (the GitHub family) map only-to-do to their closest approximation: the cut
// list already drops closed/done issues via its open-only fetch, and there is
// no faithful board-independent "In Progress" category to exclude. The Configure
// dialog explains this (STRINGS.statusMappingNote) instead of a category toggle.
const GITHUB_FAMILY_PLUGIN_IDS = new Set(["github-com", "ghe"]);

const STRINGS = {
  titlePrefix: "Configure ",
  globalSuffix: "(global defaults)",
  integrationFieldsHeading: "Repository & metadata",
  statusExclusionHeading: "Excluded status categories",
  statusExclusionHelp: "Issues in checked categories are hidden from the cut list.",
  // FR-013 (issue #558): label on the non-excludable actionable To-Do row.
  statusActionableHint: "always shown",
  // FR-014 (issue #558): mapping note for plugins with no native status category.
  statusMappingNote:
    "This integration has no In Progress status category, only Open and Closed. The cut list already hides Closed items and shows Open ones; In Progress is not excluded by default.",
  // CLI-FR-014 / FR-015 (issue #423): shown when live discovery reports that
  // this instance does not expose native status categories, so the cut list
  // matches excluded statuses by name instead of by category.
  statusNameFallbackNote:
    "This instance does not expose native status categories, so exclusions are matched by status name instead.",
  repositoryLabel: "Repository",
  repositoryPlaceholder: "org/repo-name",
  verify: "Verify",
  verifying: "Verifying…",
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
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  connectGithub: "Connect GitHub",
  postOauthHintPrefix: "After authorizing in the browser, click ",
  postOauthHintCta: "Verify",
  postOauthHintSuffix: " to confirm the credential.",
  derivedSourcesLoading: "Looking up what Roubo will pull from your repo…",
  derivedSourcesNoRepo:
    "Set a repository above so Roubo knows where to pull issues, projects, and alerts from.",
  derivedSourcesPrefix: "Roubo will pull from ",
  derivedSourcesNoRepos:
    "Roubo did not find this repository. Check the owner and name in roubo.yaml.",
  derivedSourcesUnknown: "Could not preview derived sources. Save will still try.",
  connectedAccountFallback: "GitHub",
  derivedSourcesProjectsLabel: (n: number) =>
    n === 1 ? "1 GitHub Project" : `${n} GitHub Projects`,
  derivedSourcesAlertsLabel: "security alerts when enabled on the repo",
  sourcesLoading: "Loading available sources…",
  sourcesError: "Could not load sources. Check the connection and try again.",
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
    const def = (raw ?? {}) as { default?: unknown; type?: string };
    // Skip non-scalar schema properties the form cannot edit (e.g. `sources`,
    // an array). These are host-managed top-level IntegrationConfig keys;
    // seeding one injects an invalid non-array value into the validateConfig
    // test snapshot, which the GitHub-family plugins reject ("sources must be
    // an array"). This check runs BEFORE the `advanced` passthrough below:
    // a stale `advanced.sources` that survives into `effective` (issue #125)
    // must not ride into the form values just because it appears in advanced.
    if (def.type === "array" || def.type === "object") continue;
    if (key in advanced) {
      out[key] = advanced[key];
      continue;
    }
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
  const saveFieldsMutation = useSaveIntegrationFields(projectId);
  const isBusy = testMutation.isPending || saveMutation.isPending || saveFieldsMutation.isPending;

  return (
    <ModalOverlay
      isDismissable={!isBusy}
      isKeyboardDismissDisabled={isBusy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col min-h-0 max-h-[inherit] overflow-hidden">
          {({ close }) => (
            <ConfigureFlow
              mode="project"
              projectId={projectId}
              plugin={plugin}
              effective={effective}
              close={close}
              testMutation={testMutation}
              saveMutation={saveMutation}
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
      <Modal className="w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col min-h-0 max-h-[inherit] overflow-hidden">
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

type ConfigureFlowProps =
  | {
      mode: "project";
      projectId: string;
      plugin: InstalledPlugin;
      effective: IntegrationConfig;
      close: () => void;
      testMutation: ReturnType<typeof useTestIntegrationConnection>;
      saveMutation: ReturnType<typeof useSaveIntegrationConfig>;
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

  // WU-064 (FR-052): surface the same connection-status chip the
  // PluginCard renders, in the modal header. The header is one of the
  // three placements TC-168 asserts on.
  const connectionQuery = useConnectionStatus(plugin.id, plugin.status === "enabled");
  const pillState = derivePluginConnectionState(plugin.status, effective, connectionQuery.data);
  const pillStatus = {
    state: pillState,
    detail: connectionQuery.data?.detail,
    checkedAt: connectionQuery.data?.checkedAt,
  };

  const initialValues = useMemo(
    () => seedInitialValues(manifest?.configSchema, effective),
    [manifest?.configSchema, effective],
  );

  const [values, setValuesState] = useState<Record<string, unknown>>(initialValues);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

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
      submodules: next.submodules,
    });
  };
  const isMetaRepo = fields.layoutType === "meta-repo";

  // FR-010 (issue #435): project-scoped status-category exclusion toggle. A
  // plugin opts in by declaring `defaultIntegrationConfig.excludedStatusCategories`.
  // Seed from the effective override if set, otherwise the manifest default, so
  // the checked state matches what the cut list actually excludes today.
  const manifestDefaultCategories = manifest?.defaultIntegrationConfig?.excludedStatusCategories;
  const showStatusExclusion = mode === "project" && manifestDefaultCategories !== undefined;
  // FR-014 (issue #558): the GitHub family has no native status categories, so
  // it shows the open/closed mapping note instead of a category toggle.
  const showStatusMappingNote =
    mode === "project" && !showStatusExclusion && GITHUB_FAMILY_PLUGIN_IDS.has(plugin.id);
  const seededCategories = useMemo(
    () => effective.excludedStatusCategories ?? manifestDefaultCategories ?? [],
    [effective.excludedStatusCategories, manifestDefaultCategories],
  );
  const [excludedCategories, setExcludedCategories] = useState<string[]>(seededCategories);
  // Discover the connected instance's real status categories (issue #453) and
  // use them as the option base; fall back to the canonical set when discovery
  // is unsupported, failed, or empty. Either way the seeded values are unioned
  // in so a saved/default category stays visible and removable.
  const statusCategoriesQuery = useStatusCategories(
    props.mode === "project" ? props.projectId : "",
    showStatusExclusion,
  );
  const categoryOptions = useMemo(() => {
    const discovery = statusCategoriesQuery.data;
    const base =
      discovery?.supported && discovery.categories.length > 0
        ? discovery.categories
        : CANONICAL_STATUS_CATEGORIES;
    return [...new Set([...base, ...seededCategories])];
  }, [statusCategoriesQuery.data, seededCategories]);
  // Diff against the seed captured at open, not the live-computed one: a parent
  // re-render that refetches `effective` must not, on its own, flip "changed" to
  // true and cause an untouched set to be written on the next Save. A useState
  // initializer captures the first-render seed once (and is render-safe, unlike
  // reading a ref during render).
  const [initialCategories] = useState(seededCategories);
  const excludedCategoriesChanged = useMemo(
    () =>
      JSON.stringify([...excludedCategories].sort()) !==
      JSON.stringify([...initialCategories].sort()),
    [excludedCategories, initialCategories],
  );
  function toggleCategory(category: string, excluded: boolean) {
    // The actionable To-Do category can never be excluded (FR-013): ignore any
    // attempt to toggle it on, defensively, even though its row is disabled.
    if (isActionableCategory(category)) return;
    setExcludedCategories((prev) =>
      excluded ? [...new Set([...prev, category])] : prev.filter((c) => c !== category),
    );
  }

  const passwordKeys = useMemo(
    () => new Set(passwordFieldKeys(manifest?.configSchema)),
    [manifest?.configSchema],
  );
  const tlsFieldKey = useMemo(
    () => findTlsFieldKey(manifest?.configSchema),
    [manifest?.configSchema],
  );

  // Connection state is the single gate on whether the rest of the form is
  // editable. The header pill already uses `pillState`; we read it as a plain
  // boolean here so the legacy `hasTestedSuccessfully` interlock is gone.
  const connected = pillState === "connected";
  // The connection gate only fits OAuth-driven plugins (github-com), where
  // credentials are bootstrapped outside the form via GithubOauthSection. For
  // other plugins the form itself is the only place to enter `instance` /
  // `token`, so it must stay reachable even when the pill reads disconnected
  // (e.g. first-time setup or expired credentials).
  const isOauthPlugin = plugin.id === "github-com";
  const showForm = connected || !isOauthPlugin;

  // FR-019: the declarative source picker renders for project-scoped plugins
  // that are NOT in the GitHub-specific integration-fields set (GitHub.com /
  // GHE drive sources from the repo via the derived-sources preview instead).
  // It needs a live connection because `listSourceCandidates` runs server-side
  // against the saved config.
  const sourcesProjectId = props.mode === "project" ? props.projectId : "";
  const showSourcePicker =
    mode === "project" && !PLUGINS_WITHOUT_SOURCE_PICKER.has(plugin.id) && connected;
  const sourceCandidatesQuery = useSourceCandidates(sourcesProjectId, showSourcePicker);
  const saveSourcesMutation = useSaveIntegrationSources(sourcesProjectId);
  const initialSources = useMemo<SourceSelection>(
    () => (effective.sources as SourceSelection | undefined) ?? {},
    [effective.sources],
  );
  const [sources, setSources] = useState<SourceSelection>(initialSources);
  const sourcesChanged = useMemo(
    () => JSON.stringify(sources) !== JSON.stringify(initialSources),
    [sources, initialSources],
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
    // Only persist the exclusion set when the user actually changed it, so
    // merely verifying an untouched dialog doesn't convert the implicit
    // manifest default into an explicit stored override (issue #435).
    if (showStatusExclusion && excludedCategoriesChanged) {
      // Never persist the actionable To-Do category as excluded (FR-013), even
      // if a stale saved set somehow carried it in.
      update.excludedStatusCategories = excludedCategories.filter((c) => !isActionableCategory(c));
    }
    return update;
  }

  function setValues(next: Record<string, unknown>) {
    setValuesState(next);
    // Clear any stale test strip so a value-change-driven re-render doesn't
    // claim the previous-snapshot's identity. The connection-status hook is
    // the source of truth for whether the form is editable, so no other state
    // resets are needed here.
    setTestResult(null);
  }

  async function runTest(snapshot: Record<string, unknown>): Promise<IntegrationTestResult | null> {
    setSubmitError(null);
    try {
      const result = await testMutation.mutateAsync(snapshot);
      setTestResult(result);
      return result;
    } catch (err) {
      const failure: IntegrationTestResult = {
        ok: false,
        error: {
          kind: "other",
          message: err instanceof ApiError ? err.message : (err as Error).message,
        },
      };
      setTestResult(failure);
      return failure;
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
    setSubmitError(null);
    // Save runs Verify implicitly so capturedUserId is fresh and instance /
    // advanced get persisted with the latest values. If Verify fails the
    // ResultStrip already explains why; bail without writing.
    const result = await runTest(values);
    if (!result || !result.ok) return;

    try {
      await saveMutation.mutateAsync(buildUpdate(values, result));
      if (mode === "project") {
        const update = diffIntegrationFields(serverFields, fields);
        if (update) {
          await props.saveFieldsMutation.mutateAsync(update);
        }
      }
      if (showSourcePicker && sourcesChanged) {
        await saveSourcesMutation.mutateAsync(sources);
      }
      close();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  const saveFieldsPending = mode === "project" ? props.saveFieldsMutation.isPending : false;
  const isBusy =
    testMutation.isPending ||
    saveMutation.isPending ||
    saveFieldsPending ||
    saveSourcesMutation.isPending;

  return (
    <>
      <div
        data-testid="plugin-configure-dialog-header"
        className="flex items-start gap-3 px-5 py-4 border-b border-stone-200 dark:border-stone-800/60 shrink-0"
      >
        <Heading
          slot="title"
          className="flex-1 min-w-0 text-sm font-semibold text-stone-900 dark:text-stone-100"
        >
          {STRINGS.titlePrefix}
          {manifest?.name ?? plugin.id}
          {mode === "global" && (
            <span className="ml-2 text-[11px] font-normal text-stone-400 dark:text-stone-500">
              {STRINGS.globalSuffix}
            </span>
          )}
        </Heading>
        <ConnectionStatusPill status={pillStatus} rechecking={connectionQuery.isFetching} />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-4">
        {plugin.id === "github-com" && (
          <GithubOauthSection
            connected={connected}
            accountLogin={
              connectionQuery.data?.account?.login ?? effective.capturedUserId?.externalId
            }
            onAfterDisconnect={() => setTestResult(null)}
          />
        )}

        {showForm && (
          <>
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
                {mode === "project" && plugin.id === "github-com" && (
                  <DerivedSourcesPreview projectId={props.projectId} repo={fields.repo} />
                )}
                {isMetaRepo && (
                  <SubmodulesEditor
                    value={fields.submodules ?? {}}
                    onChange={(next) => setFields({ ...fields, submodules: next })}
                  />
                )}
              </div>
            )}

            {showSourcePicker && (
              <SourcePickerSection
                query={sourceCandidatesQuery}
                projectId={sourcesProjectId}
                value={sources}
                onChange={setSources}
              />
            )}

            {showStatusExclusion && (
              <div className="flex flex-col gap-2.5" data-testid="status-exclusion-section">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
                    {STRINGS.statusExclusionHeading}
                  </span>
                  <p className="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed mt-1">
                    {STRINGS.statusExclusionHelp}
                  </p>
                  {statusCategoriesQuery.data?.supported === false && (
                    <p
                      data-testid="status-name-fallback-note"
                      className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed mt-1"
                    >
                      {STRINGS.statusNameFallbackNote}
                    </p>
                  )}
                </div>
                {categoryOptions.map((category) => {
                  const actionable = isActionableCategory(category);
                  return (
                    <Checkbox
                      key={category}
                      isSelected={!actionable && excludedCategories.includes(category)}
                      isDisabled={actionable}
                      onChange={(next) => toggleCategory(category, next)}
                      aria-label={category}
                      className={`flex items-center gap-2 group ${
                        actionable ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }`}
                    >
                      {({ isSelected }) => (
                        <>
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                              isSelected
                                ? "bg-stone-600 border-stone-500"
                                : "bg-stone-200 dark:bg-stone-800 border-stone-400 dark:border-stone-600"
                            }`}
                          >
                            {isSelected && <Check size={10} className="text-stone-100" />}
                          </div>
                          <span className="text-sm text-stone-700 dark:text-stone-300">
                            {category}
                          </span>
                          {actionable && (
                            <span className="text-[11px] text-stone-400 dark:text-stone-600">
                              {STRINGS.statusActionableHint}
                            </span>
                          )}
                        </>
                      )}
                    </Checkbox>
                  );
                })}
              </div>
            )}

            {showStatusMappingNote && (
              <div className="flex flex-col gap-1" data-testid="status-mapping-note-section">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
                  {STRINGS.statusExclusionHeading}
                </span>
                <p
                  className="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed mt-1"
                  data-testid="status-mapping-note"
                >
                  {STRINGS.statusMappingNote}
                </p>
              </div>
            )}
          </>
        )}

        {submitError && (
          <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
            {submitError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 shrink-0">
        {showForm ? (
          <Button
            isDisabled={isBusy}
            onPress={() => void runTest(values)}
            data-testid="test-connection"
            className="px-2.5 py-1 text-[11px] font-medium rounded-md text-stone-500 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {testMutation.isPending ? STRINGS.verifying : STRINGS.verify}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button
            isDisabled={isBusy}
            onPress={close}
            className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {STRINGS.cancel}
          </Button>
          <Button
            isDisabled={!showForm || isBusy}
            onPress={() => void handleSave()}
            data-testid="save-config"
            className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            {saveMutation.isPending || saveFieldsPending || saveSourcesMutation.isPending
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

function GithubOauthSection({
  connected,
  accountLogin,
  onAfterDisconnect,
}: {
  connected: boolean;
  accountLogin?: string;
  onAfterDisconnect: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // The connection-status hook caches per-plugin under
  // ["plugin-connection-status", pluginId]; this id matches the GitHub plugin
  // and lets us invalidate after a disconnect so the pill flips immediately
  // instead of waiting for its next poll cycle.
  const GITHUB_PLUGIN_ID = "github-com";

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

  async function handleDisconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      await disconnectGithubPluginOauth();
      void queryClient.invalidateQueries({
        queryKey: ["plugin-connection-status", GITHUB_PLUGIN_ID],
      });
      onAfterDisconnect();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setDisconnecting(false);
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
              <span className="font-mono text-stone-900 dark:text-stone-100">
                {accountLogin ?? STRINGS.connectedAccountFallback}
              </span>
            </p>
          ) : (
            <p className="text-[12px] text-stone-500 dark:text-stone-500 mt-1 leading-relaxed">
              {STRINGS.connectPrompt}
            </p>
          )}
        </div>
        {connected ? (
          <Button
            isDisabled={disconnecting}
            onPress={() => void handleDisconnect()}
            data-testid="github-disconnect"
            className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-md text-stone-500 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 shrink-0"
          >
            {disconnecting ? STRINGS.disconnecting : STRINGS.disconnect}
          </Button>
        ) : (
          <Button
            isDisabled={pending}
            onPress={() => void handleConnect()}
            data-testid="github-connect"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-amber-500 bg-amber-500 text-stone-950 hover:bg-amber-400 hover:border-amber-400 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 shrink-0"
          >
            {pending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <ExternalLink size={12} aria-hidden />
            )}
            {STRINGS.connectGithub}
          </Button>
        )}
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

function SourcePickerSection({
  query,
  projectId,
  value,
  onChange,
}: {
  query: ReturnType<typeof useSourceCandidates>;
  projectId: string;
  value: SourceSelection;
  onChange: (next: SourceSelection) => void;
}) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-stone-400 dark:text-stone-600">
        <Spinner />
        {STRINGS.sourcesLoading}
      </div>
    );
  }
  if (!query.data) {
    return (
      <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-relaxed">
        {STRINGS.sourcesError}
      </p>
    );
  }
  return (
    <SourcePicker candidates={query.data} value={value} onChange={onChange} projectId={projectId} />
  );
}

function DerivedSourcesPreview({
  projectId,
  repo,
}: {
  projectId: string;
  repo: string | undefined;
}) {
  const trimmedRepo = repo?.trim() ?? "";
  const query = useDerivedGithubSources(trimmedRepo.length > 0 ? projectId : undefined);

  if (trimmedRepo.length === 0) {
    return (
      <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
        {STRINGS.derivedSourcesNoRepo}
      </p>
    );
  }
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-stone-400 dark:text-stone-600">
        <Spinner />
        {STRINGS.derivedSourcesLoading}
      </div>
    );
  }
  if (!query.data) {
    // An actionable GitHub-domain failure (e.g. ORG_APPROVAL_REQUIRED when the
    // repo's org hasn't approved the Roubo app) gets the full GitHubErrorState
    // card with its fix link, rather than the generic "could not preview" line.
    if (
      query.error instanceof ApiError &&
      typeof query.error.code === "string" &&
      query.error.code !== "UNKNOWN"
    ) {
      return (
        <GitHubErrorState
          error={query.error}
          variant="inline"
          onRetry={() => void query.refetch()}
        />
      );
    }
    // Other failures don't block saving; the soft warning sets expectations
    // rather than gating.
    return (
      <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-relaxed">
        {STRINGS.derivedSourcesUnknown}
      </p>
    );
  }

  const { repos, projects, alertsRequested } = query.data;
  if (repos.length === 0) {
    return (
      <p
        className="text-[11px] text-amber-600 dark:text-amber-500 leading-relaxed"
        data-testid="derived-sources-preview"
      >
        {STRINGS.derivedSourcesNoRepos}
      </p>
    );
  }

  const parts: string[] = [];
  parts.push(repos.join(", "));
  if (projects.length > 0) parts.push(STRINGS.derivedSourcesProjectsLabel(projects.length));
  if (alertsRequested.length > 0) parts.push(STRINGS.derivedSourcesAlertsLabel);

  return (
    <p
      className="text-[11px] text-stone-500 dark:text-stone-500 leading-relaxed"
      data-testid="derived-sources-preview"
    >
      {STRINGS.derivedSourcesPrefix}
      {parts.join(" · ")}.
    </p>
  );
}
