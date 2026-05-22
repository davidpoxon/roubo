// ── roubo.yaml configuration types (derived from Zod schema in config-schema.ts) ──

import type {
  RouboConfig,
  ComponentConfig,
  LoginConfig,
  ToolConfig,
  BlueprintSettings,
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
  BlueprintsConfig,
  UserConfig,
  IntegrationConfig,
  IntegrationOverride,
  ConfigFieldError,
  BlueprintSettings,
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
  IntegrationOverrideSchema,
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
} from "./plugin-manifest-schema.js";

export { parseManifest } from "./plugin-manifest.js";
export type { ParseManifestResult } from "./plugin-manifest.js";

export type {
  PluginStatus,
  PluginSource,
  RestartEvent,
  PluginError,
  LogLine,
  PluginRecord,
} from "./plugin-runtime-types.js";

import type { IntegrationConfig } from "./config-schema.js";
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
    manifest: { name: string } | null;
  } | null;
  captionKey: IntegrationCaptionKey;
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
 * (e.g. per-project blueprint defaults, per-project Claude Code overrides)
 * should be added as new top-level keys alongside `worktreeSource`, not
 * nested inside it. A missing `settings` key in persisted state is
 * interpreted as all defaults — see `project-registry.ts` for the
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
 * These two extras are read-only — never persisted, never accepted by PUT.
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
   * The ID of the blueprint that was auto-injected when this bench was created
   * via an issue assignment. Absent on benches created without issue assignment
   * or when auto-injection was disabled.
   */
  injectedBlueprintId?: string;
  /**
   * Where the injected blueprint came from in the resolution hierarchy.
   * Always `undefined` when `injectedBlueprintId` is `undefined`.
   */
  injectedBlueprintSource?: BlueprintDefaultSource;
}

/**
 * One submodule's slice of a meta-repo bench. Each participating submodule
 * in a meta-repo bench maps to one BenchWorkUnit; the meta-repo root may
 * optionally have an entry as well.
 *
 * Single-repo and monorepo benches do not use this type — their branch and
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
  /** GitHub updatedAt — used for ETag-style short-circuiting. */
  updatedAt: string;
}

// ── Git dirty-state types ──

export type DirtyReasonKind = "dirty-worktree" | "stash" | "unpushed-commits" | "no-upstream";

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

// ── Database viewer types ──

export interface DatabaseTable {
  schema: string;
  name: string;
  type: "BASE TABLE" | "VIEW";
  rowCount?: number;
}

export interface DatabaseColumn {
  name: string;
  dataType: string;
  maxLength: number | null;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isIdentity: boolean;
}

export interface DatabaseIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimaryKey: boolean;
  type: string;
}

export interface DatabaseForeignKey {
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface DatabaseTableSchema {
  columns: DatabaseColumn[];
  indexes: DatabaseIndex[];
  foreignKeys: DatabaseForeignKey[];
}

export interface DatabaseQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
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
  /** Persisted mirror of Bench.injectedBlueprintId. */
  injectedBlueprintId?: string;
  /** Persisted mirror of Bench.injectedBlueprintSource. */
  injectedBlueprintSource?: BlueprintDefaultSource;
  /**
   * Persisted mirror of `bench.components[name].setupComplete`, keyed by
   * component name. Components themselves are runtime-only; only this flag
   * survives reboots so a future Start can skip re-running setup.
   * Absent on benches written before this field existed — load-time migration
   * coerces missing entries to `true` (those benches were created under the
   * old full-provisioning flow, so setup already ran).
   */
  componentSetupState?: Record<string, boolean>;
}

export interface PersistedState {
  benches: PersistedBench[];
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
    webFrameworks: string[];
    nativeFrameworks: string[];
    suggestedName: string;
    suggestedRepo: string | null;
    suggestedProjectType: "web" | "native" | "api-only" | null;
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
  type: "web" | "native" | "api-only";
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
  blueprintId?: string;
}

export interface TerminalCreateResponse {
  sessionId: string;
  label: string;
  wsUrl: string;
  blueprintInjected?: boolean;
  /** Set when autoExecute=false: blueprint is scheduled to be written to PTY, not yet sent */
  blueprintScheduled?: boolean;
  /** Set when the resolved blueprint content exceeds MAX_CLI_PROMPT_LENGTH and was truncated */
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

/** Parameters for the plugin's paginated `listIssues` JSON-RPC call (FR-022). */
export interface ListIssuesParams {
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
}

/**
 * Server response to `GET /api/projects/:projectId/issues`.
 * `stalled` is set by the host when the plugin paginator misbehaves
 * (TC-071): in that case `nextCursor` is forced to `null` so the
 * client stops fetching, and the UI surfaces a note.
 */
export interface PaginatedIssues {
  items: NormalizedIssue[];
  nextCursor: string | null;
  stalled?: boolean;
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
}

export interface AssignIssueRequest {
  issueNumber: number;
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

// ── Blueprint management types ──

export type BlueprintSource = "app" | "project";

export interface BlueprintMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
  source: BlueprintSource;
  createdAt?: string; // ISO-8601; absent for the embedded global default
  updatedAt?: string; // ISO-8601
  approxTokens?: number; // chars/4 estimate — lets UIs render a context-usage signal
}

export interface BlueprintDetail extends BlueprintMeta {
  content: string;
  sizeBytes: number;
  sizeWarning?: boolean;
  approxTokens: number; // always present on detail responses
}

export const GLOBAL_DEFAULT_BLUEPRINT_ID = "__global_default__";

/** Default Claude context window size in tokens. Used for blueprint context-usage estimates. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Prefix for component provisioning step IDs — must stay in sync between server and client. */
export const COMPONENT_STEP_PREFIX = "component:";

/**
 * Delay (ms) between creating a Claude terminal session and writing to it.
 * Claude Code needs time to start and begin accepting stdin; writing too early
 * causes the blueprint to be silently dropped. If Claude starts slowly (e.g. slow
 * machine, heavy load), this delay may still not be enough — the injection will
 * fail without any error signal.
 */
export const CLAUDE_STARTUP_DELAY_MS = 1500;

export const DEFAULT_BLUEPRINT_SETTINGS: BlueprintSettings = {
  autoInject: true,
  autoExecute: true,
};

export interface InjectBlueprintRequest {
  blueprintId: string;
  sessionId?: string;
}

export interface InjectBlueprintResponse {
  success: boolean;
  resolvedLength: number;
}

export interface BlueprintCreateRequest {
  name: string; // 1–100 chars after trim
  description: string; // 1–300 chars after trim
  icon?: string; // optional; defaults to 'file-text'
  content: string; // non-empty; max 200 KB utf-8
}

export interface BlueprintUpdateRequest {
  name?: string;
  description?: string;
  icon?: string;
  content?: string;
}

export type BlueprintReference =
  | { type: "app-default" }
  | { type: "project-default"; projectId: string; projectName: string }
  | {
      type: "issue-type-mapping";
      projectId: string;
      projectName: string;
      issueType: string;
    };

export interface BlueprintDeleteConflictResponse {
  error: string;
  code: "BLUEPRINT_REFERENCED";
  references: BlueprintReference[];
}

export type BlueprintDefaultSource = "issue-type-mapping" | "project" | "app" | "global";

export interface ProjectDefaultBlueprintResponse {
  blueprintId: string;
  source: BlueprintDefaultSource;
}

export interface UpdateProjectDefaultBlueprintRequest {
  blueprintId: string | null;
}

export interface BlueprintPreviewRequest {
  content: string;
  projectId?: string;
  benchId?: number;
}

export interface BlueprintPreviewResponse {
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
  blueprints?: BlueprintSettings;
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

// ── GitHub OAuth types ──

export interface GitHubAuthStatus {
  connected: boolean;
  username?: string;
  scopes?: string[];
  scopesOutdated?: boolean;
  authorizedAt?: string;
}

export interface GitHubAuthUrl {
  url: string;
}

export type GitHubErrorCode =
  | "NOT_CONNECTED"
  | "SCOPES_OUTDATED"
  | "ORG_APPROVAL_REQUIRED"
  | "SAML_SSO_REQUIRED"
  | "OWNER_NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK"
  | "UNKNOWN";
