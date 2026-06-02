// ── roubo.yaml configuration types (derived from Zod schema in config-schema.ts) ──

import type {
  RouboConfig,
  ComponentConfig,
  LoginConfig,
  ToolConfig,
  JigSettings,
} from "./config-schema.js";

export type {
  RouboConfig,
  ProjectConfig,
  LayoutConfig,
  ComponentType,
  ComponentConfig,
  DockerComponentConfig,
  MigrationConfig,
  ConnectionConfig,
  PortConfig,
  LoginStep,
  LoginConfig,
  ToolConfig,
  InspectionConfig,
  BenchesConfig,
  JigsConfig,
  UserConfig,
  IntegrationConfig,
  IntegrationAdvanced,
  IntegrationOverride,
  CapturedUserId,
  ConfigFieldError,
  JigSettings,
  SourceEntry,
} from "./config-schema.js";

export {
  RouboConfigSchema,
  ProjectConfigSchema,
  LayoutConfigSchema,
  ComponentConfigSchema,
  PortConfigSchema,
  ToolConfigSchema,
  InspectionConfigSchema,
  BenchesConfigSchema,
  UserConfigSchema,
  IntegrationConfigSchema,
  IntegrationAdvancedSchema,
  IntegrationOverrideSchema,
  CapturedUserIdSchema,
  SourceEntrySchema,
  zodIssuesToValidationErrors,
  zodIssuesToFieldMap,
} from "./config-schema.js";

export { deepMergeIntegration } from "./deep-merge.js";

// ── roubo-plugin.yaml manifest types (derived from Zod schema in plugin-manifest-schema.ts) ──

export {
  PluginManifestSchema,
  CredentialSlotSchema,
  NetworkPermissionsSchema,
  CredentialsPermissionsSchema,
  FilesystemPermissionsSchema,
  ProcessesPermissionSchema,
  PluginPermissionsSchema,
  PluginCapabilitiesSchema,
  PluginDefaultIntegrationConfigSchema,
  PluginIconSchema,
} from "./plugin-manifest-schema.js";

export type {
  PluginManifest,
  CredentialSlot,
  NetworkPermissions,
  CredentialsPermissions,
  FilesystemPermissions,
  ProcessesPermission,
  PluginPermissions,
  PluginCapabilities,
  PluginDefaultIntegrationConfig,
  PluginIcon,
} from "./plugin-manifest-schema.js";

export { parseManifest } from "./plugin-manifest.js";
export type { ParseManifestResult } from "./plugin-manifest.js";

export {
  PLUGIN_ENABLE_STATE_SCHEMA_VERSION,
  BUNDLED_PLUGIN_IDS,
  PluginEnableStateSchema,
  PluginEnableStateValueSchema,
} from "./plugin-enable-state-schema.js";
export type {
  PluginEnableState,
  PluginEnableStateValue,
  BundledPluginId,
} from "./plugin-enable-state-schema.js";

export type {
  SourceCandidateIcon,
  SourceCandidateItem,
  SourceCandidateCategory,
  SourceCandidatesShape,
  SourceCandidatesResponse,
  SourceSelection,
  SourceSelectionEntry,
} from "./integration-types.js";

export type {
  PluginStatus,
  PluginSource,
  RestartEvent,
  PluginError,
  LogLine,
  PluginRecord,
} from "./plugin-runtime-types.js";

import type { CapturedUserId, IntegrationConfig } from "./config-schema.js";
import type { PluginPermissions } from "./plugin-manifest-schema.js";
import type { PluginStatus } from "./plugin-runtime-types.js";
import type { PluginManifest } from "./plugin-manifest-schema.js";

/**
 * Result of the first stage of the plugin install flow
 * (`POST /api/plugins/install`). The host has cloned (Git URL flow) or copied
 * (local directory flow) the candidate plugin into a staging directory under
 * `~/.roubo/plugins/.staging/<stagingToken>/`, parsed and validated its
 * `roubo-plugin.yaml`, and is now waiting for the user to either accept the
 * declared permissions (`POST /install/:token/confirm`) or cancel
 * (`POST /install/:token/cancel`, which removes the staging directory).
 */
export interface InstallPreview {
  stagingToken: string;
  manifest: PluginManifest;
  source: InstallSource;
}

export type InstallSource = { type: "git"; url: string } | { type: "local"; path: string };

/**
 * Stable error codes emitted by the install pipeline. Routes map these to
 * HTTP status codes; the client surfaces the human-readable message in an
 * inline red banner.
 */
export type InstallErrorCode =
  | "invalid-input"
  | "clone-failed"
  | "missing-manifest"
  | "invalid-manifest"
  | "incompatible-host"
  | "duplicate-id"
  | "unknown-token"
  | "internal";

export interface InstallErrorBody {
  error: string;
  code: InstallErrorCode;
}

/**
 * Tells the Issue source tile which caption to render under the configured
 * variant. Derived server-side from the committed roubo.yaml integration block
 * and the per-user override.
 */
export type IntegrationCaptionKey = "yaml-only" | "override-only" | "yaml-and-override" | "none";

/**
 * Snapshot of a project's effective integration state, returned by
 * `GET /api/projects/:projectId/integration`. The tile consumes this directly
 * and routes to one of three variants:
 *   - `plugin == null`                       → unconfigured
 *   - `plugin != null && !plugin.installed`  → missing-plugin
 *   - otherwise                              → configured
 */
export interface ProjectIntegrationState {
  effective: IntegrationConfig;
  committed: IntegrationConfig | null;
  override: IntegrationConfig | null;
  plugin: {
    id: string;
    installed: boolean;
    status: PluginStatus | null;
    manifest: {
      name: string;
      /**
       * JSON-Schema-derived shape describing the per-project config form.
       * Opaque to roubo; rendered by the client's ConfigSchemaForm.
       */
      configSchema?: Record<string, unknown>;
      /**
       * Full declared permissions for the plugin. The Configure dialog reads
       * `credentials.slots[*].description` to label password fields.
       */
      permissions?: PluginPermissions;
    } | null;
  } | null;
  captionKey: IntegrationCaptionKey;
  /**
   * Set when the committed roubo.yaml resolves to a different integration than
   * the effective (override-resolved) one, along either axis that changes which
   * host a teammate would reach: the `plugin` id, or (for multi-instance
   * plugins like `ghe`) the `instance`. The integration works locally because
   * the per-user override wins, but a teammate cloning the repo would resolve
   * the committed values instead, against a host they likely cannot reach. The
   * tile surfaces this and offers to promote the effective integration into the
   * committed config. `null` when committed and effective agree, or the
   * committed config names no plugin.
   */
  integrationMismatch?: {
    committedPlugin: string;
    effectivePlugin: string;
    committedInstance: string | null;
    effectiveInstance: string | null;
  } | null;
}

/**
 * Result of GET /api/plugins/:pluginId/integration: the global-defaults
 * read used by the Plugins settings page's Configure dialog. Mirrors the
 * `plugin` and `effective` shape of `ProjectIntegrationState` so the
 * existing dialog can seed itself the same way, but omits the
 * committed/override/captionKey fields that only make sense in a project
 * scope.
 */
export interface GlobalPluginIntegrationState {
  effective: IntegrationConfig;
  plugin: NonNullable<ProjectIntegrationState["plugin"]>;
}

/**
 * Classifier for plugin-reported test-connection failures. The host
 * translates raw plugin error strings into one of these kinds so the
 * Configure dialog can render the right result-strip variant and the
 * inline "Enable self-signed TLS" recovery affordance (TC-060/061/062).
 */
export type IntegrationTestErrorKind = "auth" | "network" | "tls" | "other";

export interface IntegrationTestErrorPayload {
  kind: IntegrationTestErrorKind;
  message: string;
}

/**
 * Stable identifier for a row in the Test Connection result strip. `"issues"`
 * is always present on a successful test; the three alert categories appear
 * only when the project has at least one source with that category enabled.
 */
export type IntegrationCategoryId = "issues" | "code-scanning" | "secret-scanning" | "dependabot";

/**
 * Per-row status in the Test Connection result strip (FR-047, WU-041, WU-034).
 *
 * - `ok`: probe succeeded
 * - `scope-missing`: token lacks the required scope (401/403)
 * - `not-enabled`: feature is not enabled for the probed repo (404/410/451)
 * - `timed-out`: probe exceeded the per-probe cap (rendered amber; does not
 *   fail the overall test)
 * - `error`: probe returned an unexpected status or threw a non-timeout error
 */
export type IntegrationCategoryStatus =
  | "ok"
  | "scope-missing"
  | "not-enabled"
  | "timed-out"
  | "error";

/**
 * One row in the Test Connection result strip. `label` is the human-facing
 * string the strip renders (sourced from `INTEGRATION_CATEGORY_LABELS` below).
 * `detail` is rendered verbatim
 * underneath the row when present (e.g. "Timed out", "Token missing
 * `security_events` scope"). `httpStatus` is included for diagnostics and
 * tests; the UI does not render it directly.
 */
export interface IntegrationCategoryReport {
  category: IntegrationCategoryId;
  label: string;
  status: IntegrationCategoryStatus;
  detail?: string;
  httpStatus?: number;
}

/**
 * Response shape for `POST /api/projects/:projectId/integration/test` and
 * `POST /api/plugins/:pluginId/integration/test`. On `ok: true`, `identity`
 * carries the value returned by `plugin.getCurrentUser`, which the dialog
 * stashes and submits as `capturedUserId` when the user saves. `categories`
 * drives the per-row Test Connection result strip (WU-041); the host always
 * emits at least an Issues row on success, and adds alert-category rows for
 * each category enabled by at least one saved source. Omitted on the failure
 * variant.
 */
export type IntegrationTestResult =
  | { ok: true; identity: CapturedUserId; categories?: IntegrationCategoryReport[] }
  | { ok: false; error: IntegrationTestErrorPayload };

/**
 * Human-facing labels for each Test Connection result-strip row. Kept in
 * `shared/` so client, server, and plugin code all read from one place.
 */
export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategoryId, string> = {
  issues: "Issues",
  "code-scanning": "Code Scanning alerts",
  "secret-scanning": "Secret Scanning alerts",
  dependabot: "Dependabot alerts",
};

/**
 * Discrete states a plugin's connection can be in. Drives the
 * `ConnectionStatusPill` taxonomy (mockups §21) and will back the
 * `getConnectionStatus()` plugin RPC (FR-055) when that lands in a later WU.
 *
 * - `connected`: healthy, last check succeeded
 * - `disconnected`: plugin is enabled but no credentials are configured
 * - `auth-problem`: token expired / 401 / re-auth needed
 * - `errored`: rate-limited, unreachable, crashed, or never-checked
 * - `disabled`: plugin not enabled; never reflects connectivity
 */
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "auth-problem"
  | "errored"
  | "disabled";

/**
 * Cached connection-status snapshot for a plugin. `detail` is surfaced in the
 * pill's tooltip on `auth-problem` and `errored`. `checkedAt` is an ISO
 * timestamp the pill renders as an "as of HH:MM" suffix; omit for the
 * `disabled` variant (which never carries a timestamp).
 */
export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  checkedAt?: string;
  // Present on `connected` when the plugin can cheaply resolve the
  // authenticated account (e.g. from the same `GET /user` probe). Drives the
  // "Connected as <login>" label in the Configure dialog; omitted otherwise.
  account?: { login: string };
}

/**
 * Body shape for `PUT /api/projects/:projectId/integration/config`. Every key
 * is optional; provided keys replace their counterpart in the existing
 * override (per FR-023's "arrays REPLACE" rule, which extends to objects
 * here since the override is shallow per top-level key).
 */
export interface IntegrationConfigUpdate {
  instance?: string;
  sources?: Record<string, Array<string | number>>;
  advanced?: Record<string, unknown>;
  capturedUserId?: CapturedUserId;
}

/**
 * Project-scoped fields owned by the active integration plugin (FR-070).
 * Returned by `GET /api/projects/:projectId/integration/fields`. Stored
 * canonically in roubo.yaml; the plugin's Configure modal is the edit
 * surface and the legacy config/raw PUT shims forward into the setter.
 */
export interface IntegrationFields {
  repo?: string;
  githubProject?: number;
  submodules?: Record<string, string>;
  /** Echoed so the client can hide meta-repo-only controls without a second fetch. */
  layoutType?: "meta-repo" | "monorepo" | "single-repo";
}

/**
 * Body shape for `PUT /api/projects/:projectId/integration/fields`. Each key
 * is optional; provided keys overwrite their counterpart, `undefined` keys
 * are left alone, and an explicit `null` clears the field in roubo.yaml.
 */
export interface IntegrationFieldsUpdate {
  repo?: string | null;
  githubProject?: number | null;
  submodules?: Record<string, string> | null;
}

/**
 * Serializable subset of `PluginRecord` returned by `GET /api/plugins`. Drives
 * the radio list inside the Switch integration dialog.
 */
export interface InstalledPluginSummary {
  id: string;
  name: string;
  status: PluginStatus;
  lastError?: string;
}

export const DONE_STATUSES = new Set(["done", "closed", "archived", "cancelled"]);

// ── Project registry types ──

/**
 * Per-project settings. Keep this shape extensible: new per-project features
 * (e.g. per-project jig defaults, per-project Claude Code overrides)
 * should be added as new top-level keys alongside `worktreeSource`, not
 * nested inside it. A missing `settings` key in persisted state is
 * interpreted as all defaults. See `project-registry.ts` for the
 * "missing = on" defaulting rule (R4).
 */
export interface ProjectSettings {
  worktreeSource: {
    branchFromDefault: boolean;
    pullLatest: boolean;
  };
}

/**
 * Default `ProjectSettings` used when persisted state has no `settings` key.
 * NOTE: both toggles default to `true`, which is the OPPOSITE of the usual
 * "missing field = false" convention. See R4 in
 * `specs/prd-worktree-source-settings.md`.
 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  worktreeSource: {
    branchFromDefault: true,
    pullLatest: true,
  },
};

/**
 * GET /:projectId/settings response: persisted ProjectSettings plus the
 * server-computed default branch (or the R1 error if detection fails).
 * These two extras are read-only: never persisted, never accepted by PUT.
 */
export interface ProjectSettingsResponse extends ProjectSettings {
  defaultBranch?: string;
  defaultBranchError?: string;
}

export interface RegisteredProject {
  id: string;
  repoPath: string;
  config?: RouboConfig;
  configValid: boolean;
  configError?: string;
  settings: ProjectSettings;
}

// ── Bench types ──

export type BenchStatus = "idle" | "preparing" | "active" | "error" | "clearing";
export type ComponentStatusValue = "stopped" | "starting" | "running" | "error" | "stopping";

export type ProvisioningStepStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface ProvisioningStep {
  id: string;
  label: string;
  status: ProvisioningStepStatus;
  error?: string;
  phases?: ComponentPhase[];
}

export type ComponentPhaseStatus = "pending" | "running" | "done" | "error";

export interface ComponentPhase {
  label: string;
  status: ComponentPhaseStatus;
}

export interface ComponentStatus {
  name: string;
  status: ComponentStatusValue;
  pid?: number;
  containerId?: string;
  error?: string;
  statusDetail?: string;
  statusDetailStartedAt?: string;
  startedAt?: string;
  phases?: ComponentPhase[];
  /**
   * True once the component's `setup` command has run successfully on this
   * bench, or trivially true if the component config defines no setup. Lets a
   * subsequent Start skip re-running setup after a Stop → Start cycle.
   */
  setupComplete: boolean;
}

export interface Bench {
  id: number;
  projectId: string;
  branch: string;
  workspacePath: string;
  status: BenchStatus;
  ports: Record<string, number>;
  components: Record<string, ComponentStatus>;
  createdAt: string;
  error?: string;
  provisioningSteps: ProvisioningStep[];
  teardownSteps: ProvisioningStep[];
  assignedContainers?: Record<string, AssignedContainer>;
  assignedIssue?: AssignedIssue;
  notifications: BenchNotification[];
  /**
   * Per-submodule work units. Present for meta-repo benches.
   * Absent on single-repo/monorepo benches (the root branch/workspacePath
   * fields above are canonical for those).
   */
  workUnits?: BenchWorkUnit[];
  /**
   * The branch the worktree was cut from (e.g. "main"). Captured at
   * provisioning time. Absent on benches created before this field existed.
   */
  baseBranch?: string;
  /**
   * The 7-character short SHA of HEAD in the new worktree immediately after
   * `git worktree add`. Absent on legacy benches or if rev-parse failed.
   */
  baseCommit?: string;
  /**
   * The ID of the jig that was auto-injected when this bench was created
   * via an issue assignment. Absent on benches created without issue assignment
   * or when auto-injection was disabled.
   */
  injectedJigId?: string;
  /**
   * Where the injected jig came from in the resolution hierarchy.
   * Always `undefined` when `injectedJigId` is `undefined`.
   */
  injectedJigSource?: JigDefaultSource;
}

/**
 * One submodule's slice of a meta-repo bench. Each participating submodule
 * in a meta-repo bench maps to one BenchWorkUnit; the meta-repo root may
 * optionally have an entry as well.
 *
 * Single-repo and monorepo benches do not use this type; their branch and
 * workspacePath are stored directly on Bench (and Bench.workUnits is absent).
 */
export interface BenchWorkUnit {
  /**
   * Submodule key from `LayoutConfig.submodules`, or the reserved literal "."
   * for the meta-repo root. A submodule key of "." in `roubo.yaml` is rejected
   * at config-parse time to prevent collision with this reserved key.
   */
  submodule: string;
  /** Git branch checked out in this submodule's worktree. */
  branch: string;
  /**
   * True when the last sync observed the submodule HEAD as detached (no branch ref).
   * The `branch` field retains the last-known branch for display continuity.
   * Always false / absent for the "." root work unit.
   */
  detached?: boolean;
  /**
   * Filesystem-level activity probed at last sync. Absent until first sync completes.
   * `modifiedCount` counts staged + unstaged (non-untracked) files.
   * `unpushedCommits` counts commits ahead of upstream, or unique commits not on any
   * remote if no upstream is configured. Zero when HEAD is detached or on error.
   */
  dirtyState?: {
    modifiedCount: number;
    untrackedCount: number;
    unpushedCommits: number;
  };
  /** Absolute path to the submodule worktree on disk. */
  workspacePath: string;
  /** The tracked open PR, if any. Absent until first sync completes. */
  pullRequest?: TrackedPullRequest;
  /** Last successful PR sync timestamp (ISO). Undefined if never synced. */
  lastSyncedAt?: string;
  /** Populated if the last sync attempt failed. */
  syncError?: string;
  /**
   * When true, this work unit is excluded from auto-clear evaluation.
   * Use as an escape hatch when a PR was closed without merging because
   * the work moved elsewhere and the bench should not be held open indefinitely.
   */
  ignoredForAutoClear?: boolean;
}

export interface TrackedPullRequest {
  /** Owner/name of the repo hosting this PR (e.g. "acme/api"). */
  repoFullName: string;
  number: number;
  title: string;
  /** Raw GitHub state: open | closed. When merged is true, state will be 'closed'. */
  state: "open" | "closed";
  merged: boolean;
  /** HTML URL for UI linking. */
  url: string;
  /** GitHub updatedAt, used for ETag-style short-circuiting. */
  updatedAt: string;
}

// ── Git dirty-state types ──

export type DirtyReasonKind =
  | "dirty-worktree"
  | "stash"
  | "unpushed-commits"
  | "no-upstream"
  | "local-only-after-merge";

/**
 * A single reason a bench is not safe to tear down.
 * `location` is `'workspace'` for the main worktree, or the submodule's
 * `$displaypath` (relative to the superproject root) for a submodule.
 * `detail` is a short human-readable qualifier, e.g. "3 modified, 1 untracked",
 * "1 stash", "2 commits ahead".
 */
export interface DirtyReason {
  kind: DirtyReasonKind;
  location: string;
  detail: string;
}

export interface DirtyState {
  clean: boolean;
  reasons: DirtyReason[];
}

// ── Notification types ──

export type NotificationType =
  | "claude-exited"
  | "claude-waiting"
  | "terminal-waiting"
  | "bench-ready"
  | "bench-error"
  | "inspection-complete"
  | "component-error"
  | "teardown-blocked"
  | "sync-error";

export type NotificationPriority = "info" | "action-needed";

export interface BenchNotification {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  sourceSessionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ── Resolved tool types ──

export interface ResolvedTool {
  name: string;
  icon: string;
  type: "browser" | "shell";
  url?: string;
  command?: string;
  requires?: string;
  login?: LoginConfig;
  enabled: boolean;
  requiresUserPicker: boolean;
}

export interface ExecuteToolRequest {
  userName?: string;
}

export interface ToolResult {
  success: boolean;
  error?: string;
  login?: LoginConfig;
}

// ── Container assignment types ──

export interface AssignedContainer {
  containerId: string;
  containerName: string;
  port: number;
}

export interface AssignContainerRequest {
  containerId: string;
  component: string;
}

// ── API request/response types ──

export interface RegisterProjectRequest {
  repoPath: string;
}

export interface CreateBenchRequest {
  branch?: string;
  issueNumber?: number;
  /**
   * Fully-qualified issue/alert id (e.g. `owner/repo#code-scanning-117`). Used
   * for security alerts, whose externalId has no bare numeric form. When set,
   * the server fetches the redacted issue via the active plugin's `getIssue`.
   * `issueNumber` remains the path for plain GitHub issues.
   */
  externalId?: string;
  branchConflictResolution?: "resume" | "new";
}

export interface ApiError {
  error: string;
  details?: string;
}

// ── Persisted state types ──

export interface PersistedProjectEntry {
  id: string;
  repoPath: string;
  settings?: ProjectSettings;
}

export interface PersistedBench {
  id: number;
  projectId: string;
  branch: string;
  workspacePath: string;
  ports: Record<string, number>;
  createdAt: string;
  assignedContainers?: Record<string, AssignedContainer>;
  assignedIssue?: AssignedIssue;
  notifications?: BenchNotification[];
  /** Persisted mirror of Bench.workUnits. */
  workUnits?: BenchWorkUnit[];
  /** Persisted mirror of Bench.baseBranch. */
  baseBranch?: string;
  /** Persisted mirror of Bench.baseCommit. */
  baseCommit?: string;
  /** Persisted mirror of Bench.injectedJigId. */
  injectedJigId?: string;
  /** Persisted mirror of Bench.injectedJigSource. */
  injectedJigSource?: JigDefaultSource;
  /**
   * Persisted mirror of `bench.components[name].setupComplete`, keyed by
   * component name. Components themselves are runtime-only; only this flag
   * survives reboots so a future Start can skip re-running setup.
   * Absent on benches written before this field existed; load-time migration
   * coerces missing entries to `true` (those benches were created under the
   * old full-provisioning flow, so setup already ran).
   */
  componentSetupState?: Record<string, boolean>;
}

export interface PersistedState {
  benches: PersistedBench[];
  /**
   * Single commit point for the pre-plugin → plugin migration (WU-024 / issue #42).
   * Absent on pre-migration installs; bumped to 1 only after every migration
   * side-effect has succeeded. Used as the idempotency gate.
   */
  schemaVersion?: number;
  /** Set alongside `schemaVersion` so the one-time banner can pick its variant. */
  migration?: MigrationRecord;
}

export interface MigrationRecord {
  status: "success" | "rolled-back";
  /** ISO 8601. The banner uses this as the dismissal-marker key. */
  at: string;
  reason?: string;
  migratedProjectIds: string[];
}

export interface PersistedProjects {
  projects: PersistedProjectEntry[];
}

export interface ProjectPermissions {
  allow: string[];
  deny: string[];
  // optional for legacy state files written before ask support was added
  ask?: string[];
}

// ── Filesystem browsing types ──

export interface DirectoryEntry {
  name: string;
  path: string;
  hasGit: boolean;
}

export interface BrowseDirectoryResponse {
  path: string;
  entries: DirectoryEntry[];
}

// ── Config creator types ──

export interface SuggestedComponent {
  key: string;
  config: ComponentConfig;
  source: string;
}

export interface SuggestedTool {
  config: ToolConfig;
  source: string;
}

export interface RepoScanResult {
  detected: {
    hasGit: boolean;
    submodules: Record<string, string>;
    structureType: "meta-repo" | "monorepo" | "single-repo";
    dockerComposeFiles: string[];
    dockerComposeServiceNames: Record<string, string[]>;
    dockerComposePortVars: Record<string, Record<string, string | null>>; // composeFile → serviceName → port env var name (or null if hardcoded)
    dockerComposeVars: Record<string, Record<string, Record<string, string | null>>>; // composeFile → serviceName → varName → default value (or null)
    dotnetProjects: string[];
    solutionFiles: string[];
    viteProjects: string[];
    envFiles: string[];
    suggestedName: string;
    suggestedRepo: string | null;
    suggestedComponents: SuggestedComponent[];
    suggestedTools: SuggestedTool[];
  };
  existingConfig: { path: string; config: RouboConfig } | null;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  portConflicts: Array<{
    port: string;
    base: number;
    conflictsWith: {
      projectId: string;
      projectName: string;
      port: string;
      range: [number, number];
    };
  }>;
}

export interface SaveConfigRequest {
  repoPath: string;
  config: RouboConfig;
}

export interface SaveConfigResponse {
  path: string;
  config: RouboConfig;
}

export interface ValidateConfigRequest {
  config: RouboConfig;
  currentProjectId?: string;
}

export interface ScanRepoRequest {
  repoPath: string;
}

export interface CheckConfigRequest {
  repoPath: string;
}

export interface CheckConfigPreview {
  name: string;
  displayName: string;
  ports: { name: string; base: number }[];
  benchCap: number;
}

export interface CheckConfigResult {
  hasConfig: boolean;
  configValid: boolean;
  projectName?: string;
  displayName?: string;
  error?: string;
  alreadyRegistered: boolean;
  project?: RegisteredProject;
  preview?: CheckConfigPreview;
}

// ── Terminal types ──

export type ClaudeCodeMode = "auto" | "plan" | "plan-auto";

export function deriveClaudeCodeMode(settings?: ClaudeCodeSettings): ClaudeCodeMode | undefined {
  if (!settings) return undefined;
  const { enableAutoMode, startInPlanMode } = settings;
  if (enableAutoMode && startInPlanMode) return "plan-auto";
  if (enableAutoMode) return "auto";
  if (startInPlanMode) return "plan";
  return undefined;
}

export interface TerminalSession {
  id: string;
  benchKey: string;
  label: string;
  createdAt: string;
  command?: string;
  status: "live" | "ended";
  exitCode?: number;
  claudeCodeMode?: ClaudeCodeMode;
}

export interface PersistedTerminalSession {
  session: TerminalSession;
  buffer: string[];
  persistedAt: string;
}

export interface TerminalCreateRequest {
  command?: string;
  jigId?: string;
}

export interface TerminalCreateResponse {
  sessionId: string;
  label: string;
  wsUrl: string;
  jigInjected?: boolean;
  /** Set when autoExecute=false: jig is scheduled to be written to PTY, not yet sent */
  jigScheduled?: boolean;
  /** Set when the resolved jig content exceeds MAX_CLI_PROMPT_LENGTH and was truncated */
  sizeWarning?: boolean;
}

// ── Inspection run types ──

export type InspectionRunStatus = "running" | "passed" | "failed" | "error" | "aborted";

export interface InspectionRun {
  id: string;
  projectId: string;
  benchId: number;
  status: InspectionRunStatus;
  filter?: string;
  output: string[];
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
}

export interface StartInspectionRequest {
  filter?: string;
}

// ── GitHub issue types ──
// Legacy: not on the issue-retrieval request path after WU-016. Still used by
// internal bench-assignment flows (server/services/{issue-assignment,auto-clear}.ts)
// pending a follow-up WU that migrates bench state to externalId.

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  assignee?: string;
  milestone?: string;
  type?: string;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  htmlUrl: string;
  blockedBy?: Array<{ number: number; title: string }>;
  blockingCount?: number;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

/**
 * Plugin-produced normalized issue contract. Every integration plugin
 * (github-com, github-enterprise, jira, third-party) returns issues in
 * this shape; every Roubo consumer reads this shape.
 *
 * Intentionally excludes sprint, fixVersion, custom fields, attachments,
 * comments, and hierarchical links (parent/children/epic). See FR-021.
 */
export interface NormalizedIssue {
  integrationId: string;
  externalId: string;
  externalUrl: string;
  title: string;
  body: string | null;
  currentState: string;
  allowedTransitions: string[];
  assignees: Array<{ externalId: string; displayName: string }>;
  labels: string[];
  issueType: string | null;
  blocks: string[];
  blockedBy: string[];
  updatedAt: string;
  raw: unknown;
  // Keys match facet ids returned by `filterFacets` (host-API 1.1.0+). Plugins
  // built against 1.0.0 omit this; core treats absence as an empty map.
  facetValues?: Record<string, string | string[]>;
}

/**
 * A normalized comment on a NormalizedIssue, returned by the active
 * integration plugin's `getComments` JSON-RPC method (WU-016).
 */
export interface NormalizedComment {
  externalId: string;
  author: { externalId: string; displayName: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One entry of the source list the host passes into source-bound contract
 * methods. Mirrors `ConfiguredSource` in `@roubo/plugin-sdk`.
 */
export interface ConfiguredSource {
  kind: string;
  externalId: string;
  /**
   * GitHub family only: per-source toggles for Code Scanning, Secret Scanning,
   * and Dependabot alerts. Default false on each. Other plugins ignore.
   */
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

/**
 * Discriminator for `ListIssuesWarning.code`. Mirrors
 * `ListIssuesWarningCode` in `@roubo/plugin-sdk`. The cut-list source picker
 * uses this to pick chip variants for the GitHub family's PAT/OAuth
 * remediation affordances.
 */
export type ListIssuesWarningCode =
  | "missing-scope"
  | "scope-unverifiable"
  | "feature-disabled"
  | "insufficient-permission"
  | "not-found"
  | "rate-limited"
  | "unknown";

/**
 * Non-fatal warning about a single source / category for a `listIssues` call.
 * Mirrors `ListIssuesWarning` in `@roubo/plugin-sdk`. A given
 * `(sourceExternalId, category)` warning clears on the next successful
 * page-1 pull that omits it.
 *
 * `code` is an optional discriminator the client uses to pick a chip variant.
 */
export interface ListIssuesWarning {
  category: "code-scanning" | "secret-scanning" | "dependabot" | string;
  sourceExternalId: string;
  cause: string;
  code?: ListIssuesWarningCode;
  detail?: { status?: number; code?: string; missingScope?: string };
}

/**
 * Descriptor returned by the active integration plugin's `filterFacets` RPC
 * (host-API 1.1.0+). The cut-list filter row renders one section per facet;
 * `enum-async` sections load their options lazily via `getFacetOptions`.
 * Mirrors `FilterFacet` in `@roubo/plugin-sdk` so the web client can consume
 * the server's `/integration/filter-facets` response without depending on
 * the plugin SDK.
 */
export interface FilterFacet {
  id: string;
  label: string;
  type: "enum" | "enum-async" | "multi-enum";
  options?: FilterFacetOption[];
}

/**
 * One option for a `FilterFacet`. Used both inline (eager `enum`/`multi-enum`)
 * and as the response shape of `getFacetOptions` (lazy `enum-async`). Mirrors
 * `FilterFacetOption` in `@roubo/plugin-sdk`.
 */
export interface FilterFacetOption {
  value: string;
  label: string;
}

/** Parameters for the plugin's paginated `listIssues` JSON-RPC call (FR-022). */
export interface ListIssuesParams {
  sources: ConfiguredSource[];
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
}

/**
 * Server response to `GET /api/projects/:projectId/issues`.
 * `stalled` is set by the host when the plugin paginator misbehaves
 * (TC-071): in that case `nextCursor` is forced to `null` so the
 * client stops fetching, and the UI surfaces a note.
 *
 * FR-014: when the active plugin is `errored` or `disabled` and a prior
 * first-page response was cached, the host serves that snapshot with
 * `stale: true` and `snapshotCapturedAt` set to the ISO timestamp of the
 * captured response. The matching cut-list banner is tracked in #263.
 */
export interface PaginatedIssues {
  items: NormalizedIssue[];
  nextCursor: string | null;
  stalled?: boolean;
  /** Per-source per-category non-fatal warnings from the underlying plugin call. */
  warnings?: ListIssuesWarning[];
  /** True when this response is a cached snapshot served because the plugin is unavailable. */
  stale?: boolean;
  /** ISO timestamp of the cached response, present iff `stale` is true. */
  snapshotCapturedAt?: string;
}

/** Server response to `GET /api/projects/:projectId/issue-types` (WU-016). */
export type ProjectIssueTypesV2Response =
  | { configured: true; types: string[] }
  | {
      configured: false;
      reason: ProjectIssueTypesUnavailableReason;
      types: string[];
    };

export interface AssignedIssue {
  // Legacy GitHub issue number. Today only github-com produces issues, so this
  // is always present; load-time migration derives externalId from this for
  // pre-plugin benches. A later WU makes this optional when non-github plugins
  // land and updates downstream consumers accordingly.
  number: number;
  integrationId: string;
  externalId: string;
  title: string;
  blockedBy?: Array<{ number: number; title: string }>;
  /**
   * PRs seeded at assignment time from CrossReferencedEvent timeline items
   * (e.g. `Closes #123` in PR bodies). Does not include PRs linked via
   * GitHub's UI sidebar (DevelopmentEvent/ConnectedEvent).
   * This seeds the bench's workUnits[].pullRequest map at provisioning time.
   */
  // Optional for backwards compat: state.json persisted before this field was added will lack it.
  linkedPullRequests?: Array<{
    repoFullName: string;
    number: number;
  }>;
  /**
   * Frozen snapshot of the issue's type at assignment time (e.g. "bug",
   * "security-dependabot"). Drives blueprint-by-issue-type counting in the
   * source-picker Configure dialog and survives the user toggling the alert
   * category off afterwards. Never re-validated against current listIssueTypes.
   * Optional: benches assigned before this field was added persist without it.
   */
  issueType?: string | null;
  /**
   * Plugin-scoped opaque payload (NFR-004). Allowed on the active bench's
   * assignedIssue so a plugin can re-hydrate context across Roubo restarts.
   * Removed from state.json when the bench is cleared (removeBench filters
   * the bench record out entirely). Plugins MUST NOT include PII here
   * unless functionally required.
   */
  raw?: unknown;
}

export interface AssignIssueRequest {
  issueNumber?: number;
  /**
   * Fully-qualified alert id (e.g. `owner/repo#code-scanning-117`) for security
   * alerts. Exactly one of `issueNumber` or `externalId` must be provided.
   */
  externalId?: string;
}

export interface AssignIssueResponse {
  bench: Bench;
  terminalSessionId: string | undefined;
}

// ── GitHub project types ──

export interface GitHubProject {
  number: number;
  title: string;
}

// ── GitHub project item types ──

export interface GitHubProjectItem {
  issue: GitHubIssue;
  status?: string | null;
}

// ── GitHub issue type types ──

export interface GitHubIssueType {
  id: string;
  name: string;
  description?: string;
  color?: string;
}

export type ProjectIssueTypesUnavailableReason = "none-defined" | "not-connected";

export type ProjectIssueTypesResponse =
  | { configured: true; types: GitHubIssueType[] }
  | {
      configured: false;
      reason: ProjectIssueTypesUnavailableReason;
      types: GitHubIssueType[];
    };

// ── Jig management types ──

export type JigSource = "app" | "project";

export interface JigMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
  source: JigSource;
  createdAt?: string; // ISO-8601; absent for the embedded global default
  updatedAt?: string; // ISO-8601
  approxTokens?: number; // chars/4 estimate, lets UIs render a context-usage signal
}

export interface JigDetail extends JigMeta {
  content: string;
  sizeBytes: number;
  sizeWarning?: boolean;
  approxTokens: number; // always present on detail responses
}

export const GLOBAL_DEFAULT_JIG_ID = "__global_default__";

/** Default Claude context window size in tokens. Used for jig context-usage estimates. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Prefix for component provisioning step IDs; must stay in sync between server and client. */
export const COMPONENT_STEP_PREFIX = "component:";

/**
 * Delay (ms) between creating a Claude terminal session and writing to it.
 * Claude Code needs time to start and begin accepting stdin; writing too early
 * causes the jig to be silently dropped. If Claude starts slowly (e.g. slow
 * machine, heavy load), this delay may still not be enough; the injection will
 * fail without any error signal.
 */
export const CLAUDE_STARTUP_DELAY_MS = 1500;

export const DEFAULT_JIG_SETTINGS: JigSettings = {
  autoInject: true,
  autoExecute: true,
};

export interface InjectJigRequest {
  jigId: string;
  sessionId?: string;
}

export interface InjectJigResponse {
  success: boolean;
  resolvedLength: number;
}

export interface JigCreateRequest {
  name: string; // 1–100 chars after trim
  description: string; // 1–300 chars after trim
  icon?: string; // optional; defaults to 'file-text'
  content: string; // non-empty; max 200 KB utf-8
}

export interface JigUpdateRequest {
  name?: string;
  description?: string;
  icon?: string;
  content?: string;
}

export type JigReference =
  | { type: "app-default" }
  | { type: "project-default"; projectId: string; projectName: string }
  | {
      type: "issue-type-mapping";
      projectId: string;
      projectName: string;
      issueType: string;
    };

export interface JigDeleteConflictResponse {
  error: string;
  code: "JIG_REFERENCED";
  references: JigReference[];
}

export type JigDefaultSource = "issue-type-mapping" | "project" | "app" | "global";

export interface ProjectDefaultJigResponse {
  jigId: string;
  source: JigDefaultSource;
}

export interface UpdateProjectDefaultJigRequest {
  jigId: string | null;
}

export interface JigPreviewRequest {
  content: string;
  projectId?: string;
  benchId?: number;
}

export interface JigPreviewResponse {
  resolved: string;
  unresolvedVariables: string[];
}

export interface ProjectIssueTypeMappingsResponse {
  mappings: Record<string, string>;
}

export interface UpdateProjectIssueTypeMappingsRequest {
  mappings: Record<string, string>;
}

// ── User preferences types ──

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface BenchSettings {
  autoClear: boolean;
  enforceIssueDependencies: boolean;
  workUnitAutoClear: boolean;
  autoStartComponents: boolean;
  /** Application-wide cap on initialised benches. Positive integer (>= 1); absent means unlimited. */
  maxGlobal?: number;
}

export const DEFAULT_BENCH_SETTINGS: BenchSettings = {
  autoClear: true,
  enforceIssueDependencies: false,
  workUnitAutoClear: true,
  autoStartComponents: false,
};

export interface ClaudeCodeSettings {
  enableAutoMode: boolean;
  startInPlanMode: boolean;
}

export const DEFAULT_CLAUDE_CODE_SETTINGS: ClaudeCodeSettings = {
  enableAutoMode: false,
  startInPlanMode: false,
};

export interface GitHubSettings {
  issueTypesCacheTtlSeconds: number;
}

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = {
  issueTypesCacheTtlSeconds: 300,
};

export interface UserPreferences {
  theme: ThemeMode;
  jigs?: JigSettings;
  benches?: BenchSettings;
  claudeCode?: ClaudeCodeSettings;
  github?: GitHubSettings;
}

export interface SettingsResponse extends UserPreferences {
  claudeCodeAutoModeAvailable: boolean;
  claudeCodeAutoModeReason?: string;
  contextWindow: number;
}

// ── Combined create-and-assign types ──

export interface BranchConflictInfo {
  branchExists: boolean;
  workspaceExists: boolean;
  branchName: string;
}

export type CreateBenchWithIssueResponse =
  | { status: "success"; bench: Bench; terminalSessionId: string | undefined }
  | { status: "conflict"; branchConflict: BranchConflictInfo };

export type GitHubErrorCode =
  | "NOT_CONNECTED"
  | "SCOPES_OUTDATED"
  | "ORG_APPROVAL_REQUIRED"
  | "SAML_SSO_REQUIRED"
  | "OWNER_NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK"
  | "UNKNOWN";
