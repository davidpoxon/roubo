import type {
  RegisteredProject,
  Bench,
  CreateBenchRequest,
  BrowseDirectoryResponse,
  RepoScanResult,
  ConfigValidationResult,
  SaveConfigResponse,
  RouboConfig,
  CheckConfigResult,
  ResolvedTool,
  ToolResult,
  TerminalSession,
  TerminalCreateResponse,
  InspectionRun,
  NormalizedIssue,
  NormalizedComment,
  PaginatedIssues,
  AssignIssueResponse,
  GitHubProject,
  CreateBenchWithIssueResponse,
  JigMeta,
  JigDetail,
  InjectJigResponse,
  JigCreateRequest,
  JigUpdateRequest,
  JigDeleteConflictResponse,
  JigPreviewRequest,
  JigPreviewResponse,
  UserPreferences,
  SettingsResponse,
  BenchNotification,
  ProjectPermissions,
  ProjectSettings,
  ProjectSettingsResponse,
  ProjectDefaultJigResponse,
  ProjectIssueTypesV2Response,
  ProjectIssueTypeMappingsResponse,
  ProjectIntegrationState,
  GlobalPluginIntegrationState,
  IntegrationConfigUpdate,
  IntegrationFields,
  IntegrationFieldsUpdate,
  IntegrationTestResult,
  FilterFacet,
  FilterFacetOption,
  SortField,
  InstalledPluginSummary,
  DirtyReason,
  PluginRecord,
  PluginPermissions,
  ConsentRecord,
  ConnectionStatus,
  ComponentLogLine,
  AuditEntry,
  LogLine,
  InstallPreview,
  InstallSource,
  MarketplaceCatalogResponse,
  MarketplaceKind,
  MarketplaceListing,
  MigrationRecord,
  SourceCandidatesResponse,
  StatusCategoriesResponse,
  SourceOptionsResult,
  SourceSelection,
} from "@roubo/shared";
import type {
  Note,
  TestCasesPlan,
  BenchResults,
  CaseResult,
  CaseStatus,
} from "@roubo/shared/testbench-contracts";
import type { ReconcileClassification } from "@roubo/shared/testbench-domain";

export interface MigrationStatusResponse {
  schemaVersion: number | null;
  migration: MigrationRecord | null;
  // One-time notice markers keyed by marker id -> ISO 8601 timestamp (or the
  // "seeded" sentinel for a fresh-install marker). FR-018 / issue #558.
  notices?: Record<string, string>;
}

const BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getApiErrorParams(err: ApiError): Record<string, string> {
  if (!err.details || typeof err.details !== "object") return {};
  const details = err.details as Record<string, unknown>;
  const nested = details.params;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return {};
}

export function isDirtyBenchError(err: unknown): err is ApiError & {
  code: "bench-dirty";
  details: { reasons: DirtyReason[] };
} {
  return (
    err instanceof ApiError &&
    err.code === "bench-dirty" &&
    typeof err.details === "object" &&
    err.details !== null &&
    Array.isArray((err.details as { reasons?: unknown }).reasons)
  );
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? `Request failed: ${res.status}`, res.status, body.code, body);
  }
  return res.json();
}

async function requestVoid(path: string, options?: RequestInit): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? `Request failed: ${res.status}`, res.status, body.code, body);
  }
}

// Projects
export function fetchProjects(): Promise<RegisteredProject[]> {
  return request("/projects");
}

export function registerProject(repoPath: string): Promise<RegisteredProject> {
  return request("/projects", {
    method: "POST",
    body: JSON.stringify({ repoPath }),
  });
}

export function unregisterProject(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const query = opts.force ? "?force=true" : "";
  return requestVoid(`/projects/${projectId}${query}`, { method: "DELETE" });
}

export function reloadProjectConfig(projectId: string): Promise<RegisteredProject> {
  return request(`/projects/${projectId}/reload-config`, { method: "POST" });
}

export function fetchProjectConfig(projectId: string) {
  return request<{ config: RouboConfig; configValid: boolean }>(`/projects/${projectId}/config`);
}

// Benches
export function fetchAllBenches(): Promise<Bench[]> {
  return request("/benches");
}

export function fetchBenches(projectId: string): Promise<Bench[]> {
  return request(`/projects/${projectId}/benches`);
}

export function fetchBench(projectId: string, benchId: number): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}`);
}

export function createBench(
  projectId: string,
  opts: {
    branch?: string;
    // Every integration assigns by externalId; the server resolves the issue via
    // the active plugin's getIssue.
    externalId?: string;
    branchConflictResolution?: "resume" | "new";
    // TestBench variant (#418): when "testbench", the create path binds the bench
    // to focusedSpecPath rather than to an issue/branch.
    variant?: "testbench";
    focusedSpecPath?: string;
  } = {},
): Promise<Bench | CreateBenchWithIssueResponse> {
  const body: CreateBenchRequest = {};
  if (opts.branch) body.branch = opts.branch;
  if (opts.externalId) body.externalId = opts.externalId;
  if (opts.branchConflictResolution) body.branchConflictResolution = opts.branchConflictResolution;
  if (opts.variant) body.variant = opts.variant;
  if (opts.focusedSpecPath) body.focusedSpecPath = opts.focusedSpecPath;
  return request(`/projects/${projectId}/benches`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function teardownBench(
  projectId: string,
  benchId: number,
  removeWorkspace = true,
  force = false,
): Promise<Bench> {
  const params = new URLSearchParams({
    removeWorkspace: String(removeWorkspace),
  });
  if (force) params.set("force", "true");
  return request<Bench>(`/projects/${projectId}/benches/${benchId}?${params.toString()}`, {
    method: "DELETE",
  });
}

export function dismissBenchNotifications(
  projectId: string,
  benchId: number,
): Promise<BenchNotification[]> {
  return request<BenchNotification[]>(`/projects/${projectId}/benches/${benchId}/notifications`, {
    method: "DELETE",
  });
}

export function dismissNotification(
  projectId: string,
  benchId: number,
  notificationId: string,
): Promise<BenchNotification[]> {
  return request<BenchNotification[]>(
    `/projects/${projectId}/benches/${benchId}/notifications/${notificationId}`,
    { method: "DELETE" },
  );
}

export function cleanupAndRetryBench(projectId: string, benchId: number): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/cleanup-and-retry`, { method: "POST" });
}

export function startBench(projectId: string, benchId: number): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/start`, {
    method: "POST",
  });
}

export function stopBench(projectId: string, benchId: number): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/stop`, {
    method: "POST",
  });
}

export function startComponent(
  projectId: string,
  benchId: number,
  component: string,
): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/components/${component}/start`, {
    method: "POST",
  });
}

export function stopComponent(
  projectId: string,
  benchId: number,
  component: string,
): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/components/${component}/stop`, {
    method: "POST",
  });
}

export function fetchComponentLogs(
  projectId: string,
  benchId: number,
  component: string,
  tail = 200,
): Promise<{ logs: ComponentLogLine[] }> {
  return request(
    `/projects/${projectId}/benches/${benchId}/components/${component}/logs?tail=${tail}`,
  );
}

export function fetchAuditLog(
  projectId: string,
  benchId: number,
  pluginId?: string,
): Promise<AuditEntry[]> {
  const query = pluginId ? `?pluginId=${encodeURIComponent(pluginId)}` : "";
  return request<AuditEntry[]>(`/projects/${projectId}/benches/${benchId}/audit-log${query}`);
}

// Filesystem
export function browseDirectory(
  dirPath?: string,
  showHidden = false,
): Promise<BrowseDirectoryResponse> {
  const params = new URLSearchParams();
  if (dirPath) params.set("path", dirPath);
  if (showHidden) params.set("showHidden", "true");
  return request(`/filesystem/browse?${params.toString()}`);
}

// Config check
export function checkConfig(repoPath: string): Promise<CheckConfigResult> {
  return request("/projects/check-config", {
    method: "POST",
    body: JSON.stringify({ repoPath }),
  });
}

// Config Creator
export function scanRepo(repoPath: string): Promise<RepoScanResult> {
  return request("/projects/scan", {
    method: "POST",
    body: JSON.stringify({ repoPath }),
  });
}

export function validateConfig(
  config: RouboConfig,
  currentProjectId?: string,
): Promise<ConfigValidationResult> {
  return request("/projects/validate-config", {
    method: "POST",
    body: JSON.stringify({ config, currentProjectId }),
  });
}

export function saveConfig(repoPath: string, config: RouboConfig): Promise<SaveConfigResponse> {
  return request("/projects/save-config", {
    method: "POST",
    body: JSON.stringify({ repoPath, config }),
  });
}

export function fetchRawConfig(projectId: string): Promise<{ yaml: string }> {
  return request(`/projects/${projectId}/config/raw`);
}

export function saveRawConfig(projectId: string, yaml: string): Promise<{ path: string }> {
  return request(`/projects/${projectId}/config/raw`, {
    method: "PUT",
    body: JSON.stringify({ yaml }),
  });
}

// Tools
export function fetchTools(projectId: string, benchId: number): Promise<ResolvedTool[]> {
  return request(`/projects/${projectId}/benches/${benchId}/tools`);
}

export function executeTool(
  projectId: string,
  benchId: number,
  index: number,
  userName?: string,
): Promise<ToolResult> {
  return request(`/projects/${projectId}/benches/${benchId}/tools/${index}/execute`, {
    method: "POST",
    body: JSON.stringify({ userName }),
  });
}

// Container assignment
export function assignContainer(
  projectId: string,
  benchId: number,
  containerId: string,
  component: string,
): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/assign-container`, {
    method: "POST",
    body: JSON.stringify({ containerId, component }),
  });
}

export function unassignContainer(
  projectId: string,
  benchId: number,
  component: string,
): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/assign-container/${component}`, {
    method: "DELETE",
  });
}

// Containers
export function fetchContainers() {
  return request<
    Array<{
      id: string;
      name: string;
      image: string;
      port?: number;
      status: string;
    }>
  >("/containers");
}

// Terminals
export function createTerminal(
  projectId: string,
  benchId: number,
  command?: string,
  jigId?: string,
): Promise<TerminalCreateResponse> {
  return request(`/projects/${projectId}/benches/${benchId}/terminals`, {
    method: "POST",
    body: JSON.stringify({ command, ...(jigId ? { jigId } : {}) }),
  });
}

export function fetchTerminals(projectId: string, benchId: number): Promise<TerminalSession[]> {
  return request(`/projects/${projectId}/benches/${benchId}/terminals`);
}

export function destroyTerminal(
  projectId: string,
  benchId: number,
  sessionId: string,
): Promise<void> {
  return requestVoid(`/projects/${projectId}/benches/${benchId}/terminals/${sessionId}`, {
    method: "DELETE",
  });
}

// Inspection
export function startInspection(
  projectId: string,
  benchId: number,
  filter?: string,
): Promise<InspectionRun> {
  return request(`/projects/${projectId}/benches/${benchId}/inspection`, {
    method: "POST",
    body: JSON.stringify({ filter }),
  });
}

export function fetchInspectionRun(
  projectId: string,
  benchId: number,
  since?: number,
): Promise<InspectionRun> {
  const params = since !== undefined ? `?since=${since}` : "";
  return request(`/projects/${projectId}/benches/${benchId}/inspection${params}`);
}

export function abortInspection(projectId: string, benchId: number): Promise<void> {
  return requestVoid(`/projects/${projectId}/benches/${benchId}/inspection`, {
    method: "DELETE",
  });
}

// TestBench
//
// The plan endpoint returns the server-computed staleness view: the source plan,
// this bench's recorded results (or null), and the `stale` flag derived from a
// canonical-hash comparison server-side, so a whitespace/format-only source edit
// never flips `stale` (FR-016, NFR-003). The client renders these as-is; no
// staleness or classification logic lives in the UI.
export interface TestbenchPlanResponse {
  plan: TestCasesPlan;
  results: BenchResults | null;
  stale: boolean;
  planHash: string;
  recovered: boolean;
  // Present only when the plan was fetched with a ?gateIds= subset filter (#702,
  // FR-008): the gate ids the plan was narrowed to. Absent on a full-plan fetch.
  filteredToGateIds?: string[];
}

// The evaluated state of one verify gate (#702, FR-012). Mirrors the server's
// `GateStateResponse` projection from the pure evaluator: the gate's id plus its
// computed status, the unresolved gating case ids, and the covering slice unit
// ids those cases trace to (the gate's `covers`). For a passed gate both id
// arrays are empty; per NFR-007 the server never reports a stale/unverified gate
// as passed.
export type GateStatus = "passed" | "failed" | "pending" | "stale";

export interface GateState {
  gateId: string;
  status: GateStatus;
  unresolvedCaseIds: string[];
  coveringUnitIds: string[];
  // Whether the gate's batch is signed off, derived from the gate's tracker-issue
  // state on the server (issue #830). True only when a `passed` gate's tracker
  // issue is closed; a non-passed gate (or one with no active integration / no
  // tracker ref) is `false` by definition.
  signedOff: boolean;
}

// The list endpoint returns one GateState per verify unit; the single endpoint
// returns one GateState (or 404 for an unknown gate id). Both reuse the same
// projection shape, so GateStateResponse is an alias kept for symmetry with the
// server's named type and the issue's requested vocabulary (#702).
export type GateStateResponse = GateState;

// The reconcile endpoint classifies cases (added/unchanged/changed/removed) and
// reports whether the reconciled, orphan-not-delete results were persisted
// (`applied` is false for a preview). Orphan purge requires confirm + purgeOrphans.
export interface ReconcileResponse {
  classification: ReconcileClassification;
  applied: boolean;
}

// Fetch the bench's plan + results. With `gateIds` the server narrows the plan's
// cases to the union of those gates' declared gating sets (the ?gateIds= subset
// filter, #702 FR-008) and stamps `filteredToGateIds` on the response; without
// it the full-plan shape is returned unchanged. An empty `gateIds` array still
// sends the param (narrowing to no cases), so callers that want the full plan
// must omit the argument entirely.
export function fetchTestbenchPlan(
  projectId: string,
  benchId: number,
  gateIds?: string[],
): Promise<TestbenchPlanResponse> {
  const query = gateIds !== undefined ? `?gateIds=${encodeURIComponent(gateIds.join(","))}` : "";
  return request(`/projects/${projectId}/benches/${benchId}/testbench/plan${query}`);
}

// A spec folder whose work-units.json EXISTS but failed contract validation, so
// it was skipped by the aggregate gates load (#371). Carries the slug plus its
// human-readable validation errors so the overview can warn the operator by name
// instead of showing a bare "no verify gates yet". Named distinctly from the
// specs-picker `InvalidSpec` (which also carries a `path`), since a gate diagnostic
// has no file path to surface.
export interface InvalidGateSpec {
  slug: string;
  errors: string[];
}

// The GET /gates payload (#371): the effective gate list plus any specs whose
// work-units.json was present-but-invalid (skipped, not aborting the load). Both
// arrays empty is a genuinely-empty project (the normal empty state); a non-empty
// `invalidSpecs` is a misconfiguration the operator must see.
export interface GatesResponse {
  gates: GateState[];
  invalidSpecs: InvalidGateSpec[];
}

// Gate state (#702, FR-012; #371). Gates are PROJECT-level, so both endpoints are
// keyed by projectId, not by bench: `fetchGates` returns the gate list plus any
// present-but-invalid skipped specs (`invalidSpecs`); `fetchGate` returns one gate
// (or rejects with a 404 ApiError for an unknown gate id).
export function fetchGates(projectId: string): Promise<GatesResponse> {
  return request(`/projects/${projectId}/gates`);
}

export function fetchGate(projectId: string, gateId: string): Promise<GateState> {
  return request(`/projects/${projectId}/gates/${encodeURIComponent(gateId)}`);
}

// One part of a split: a short label plus the source gate's covers WU- ids
// assigned to that part (#703, FR-002). The part's gating set is computed
// server-side from the WU- -> test_case_ids map.
export interface GateSplitPart {
  label: string;
  coversWorkUnitIds: string[];
}

// Operator merge (#703, FR-002, AC1). Records a merge of two or more gates and
// returns the recomputed effective gate list (the combined gate replaces its
// sources). A 409 ApiError means an involved gate is signed off (passed); a 400
// means an unknown gate id or a cross-spec merge.
export function mergeGates(projectId: string, gateIds: string[]): Promise<GateState[]> {
  return request(`/projects/${projectId}/gates/merge`, {
    method: "POST",
    body: JSON.stringify({ gateIds }),
  });
}

// Operator split (#703, FR-002, AC2). Records a split of one gate into parts and
// returns the recomputed effective gate list. A 409 ApiError means the gate is
// signed off (passed); a 400 means an unknown gate id or a non-partitioning
// assignment (loss or overlap of the source's covers).
export function splitGate(
  projectId: string,
  gateId: string,
  parts: GateSplitPart[],
): Promise<GateState[]> {
  return request(`/projects/${projectId}/gates/split`, {
    method: "POST",
    body: JSON.stringify({ gateId, parts }),
  });
}

// Reset all operator regroupings (#703). The effective gates revert to the
// externally-authored work-units.json gates.
export function resetGateOverrides(projectId: string): Promise<void> {
  return requestVoid(`/projects/${projectId}/gates/overrides`, { method: "DELETE" });
}

// Sign off a passed batch (#830, FR-007/FR-008). Closes the gate's tracker issue
// via the active integration plugin and returns the updated GateState with
// `signedOff: true`. A 409 means the gate is not passed (fail-closed) or has no
// tracker issue / no active integration; a 422 means the active plugin lacks the
// capability. The caller surfaces the error message.
export function signOffGate(projectId: string, gateId: string): Promise<GateState> {
  return request(`/projects/${projectId}/gates/${encodeURIComponent(gateId)}/sign-off`, {
    method: "POST",
  });
}

// Reopen a signed-off batch (#830, US-005). Reopens the gate's tracker issue and
// returns the updated GateState with `signedOff: false`. A 409 means the gate has
// no tracker issue / no active integration.
export function reopenGate(projectId: string, gateId: string): Promise<GateState> {
  return request(`/projects/${projectId}/gates/${encodeURIComponent(gateId)}/sign-off`, {
    method: "DELETE",
  });
}

// PUT /testbench/focus: re-point an active TestBench to a different focused spec
// (#423, FR-024). The re-point is explicit: the server preserves the prior spec's
// results untouched and re-evaluates staleness on the next plan load. Returns the
// updated Bench (with the new focusedSpecPath).
export function setTestbenchFocus(
  projectId: string,
  benchId: number,
  focusedSpecPath: string,
): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/testbench/focus`, {
    method: "PUT",
    body: JSON.stringify({ focusedSpecPath }),
  });
}

export function reconcileTestbench(
  projectId: string,
  benchId: number,
  opts: { confirm?: boolean; purgeOrphans?: boolean } = {},
): Promise<ReconcileResponse> {
  const body: { confirm?: boolean; purgeOrphans?: boolean } = {};
  if (opts.confirm !== undefined) body.confirm = opts.confirm;
  if (opts.purgeOrphans !== undefined) body.purgeOrphans = opts.purgeOrphans;
  return request(`/projects/${projectId}/benches/${benchId}/testbench/reconcile`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// GitHub Projects
export function fetchGitHubProjects(repo: string): Promise<GitHubProject[]> {
  return request(`/projects/github-projects?repo=${encodeURIComponent(repo)}`);
}

export function fetchProjectGitHubProjects(projectId: string): Promise<GitHubProject[]> {
  return request(`/projects/${projectId}/projects`);
}

// Issues: paginated through the active integration plugin (WU-016).
export function fetchIssuesPage(
  projectId: string,
  opts: {
    cursor?: string | null;
    pageSize?: number;
    labels?: string;
    search?: string;
    sortBy?: string;
    sortDir?: "asc" | "desc";
    // One-shot force-refresh (#653): bypass the server's warm snapshot and pull
    // current data. Set by the cut-list refresh control, not normal loads.
    refresh?: boolean;
  },
): Promise<PaginatedIssues> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
  if (opts.labels) params.set("labels", opts.labels);
  if (opts.search) params.set("search", opts.search);
  if (opts.sortBy) {
    params.set("sortBy", opts.sortBy);
    if (opts.sortDir) params.set("sortDir", opts.sortDir);
  }
  if (opts.refresh) params.set("refresh", "true");
  const qs = params.toString();
  return request(`/projects/${projectId}/issues${qs ? `?${qs}` : ""}`);
}

/**
 * Fetch the active integration plugin's declared cut-list sort fields
 * (CLI-FR-009). An empty array means the plugin omits `getSortFields`, so the
 * host renders no sort picker (CLI-FR-011).
 */
export function fetchSortFields(projectId: string): Promise<SortField[]> {
  return request(`/projects/${projectId}/issues/sort-fields`);
}

export function fetchIssue(projectId: string, externalId: string): Promise<NormalizedIssue> {
  return request(`/projects/${projectId}/issues/${encodeURIComponent(externalId)}`);
}

export function applyTransition(
  projectId: string,
  externalId: string,
  transitionName: string,
): Promise<NormalizedIssue> {
  return request(`/projects/${projectId}/issues/${encodeURIComponent(externalId)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transitionName }),
  });
}

// Plugin RPC assignment (WU-019). Distinct from `assignIssue` below, which
// attaches an issue to a local bench. These call into the active integration
// plugin's assignIssue / unassignIssue methods to update the remote tracker.
export function assignIssueToUser(
  projectId: string,
  externalId: string,
  assigneeExternalId: string,
): Promise<void> {
  return requestVoid(`/projects/${projectId}/issues/${encodeURIComponent(externalId)}/assign`, {
    method: "POST",
    body: JSON.stringify({ assigneeExternalId }),
  });
}

export function unassignIssueFromUser(
  projectId: string,
  externalId: string,
  assigneeExternalId: string,
): Promise<void> {
  return requestVoid(`/projects/${projectId}/issues/${encodeURIComponent(externalId)}/assign`, {
    method: "DELETE",
    body: JSON.stringify({ assigneeExternalId }),
  });
}

export function fetchIssueComments(
  projectId: string,
  externalId: string,
): Promise<NormalizedComment[]> {
  return request(`/projects/${projectId}/issues/${encodeURIComponent(externalId)}/comments`);
}

export function fetchLabels(projectId: string): Promise<string[]> {
  return request(`/projects/${projectId}/labels`);
}

export function assignIssue(
  projectId: string,
  benchId: number,
  externalId: string,
): Promise<AssignIssueResponse> {
  return request(`/projects/${projectId}/benches/${benchId}/assign-issue`, {
    method: "POST",
    body: JSON.stringify({ externalId }),
  });
}

export function unassignIssue(projectId: string, benchId: number): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/assign-issue`, {
    method: "DELETE",
  });
}

// Jigs
export function fetchGlobalJigs(): Promise<JigMeta[]> {
  return request("/jigs");
}

export function fetchJigs(projectId: string): Promise<JigMeta[]> {
  return request(`/projects/${projectId}/jigs`);
}

export function fetchJig(projectId: string, jigId: string): Promise<JigDetail> {
  return request(`/projects/${projectId}/jigs/${jigId}`);
}

export function injectJig(
  projectId: string,
  benchId: number,
  jigId: string,
  sessionId?: string,
): Promise<InjectJigResponse> {
  return request(`/projects/${projectId}/benches/${benchId}/inject-jig`, {
    method: "POST",
    body: JSON.stringify({ jigId, ...(sessionId ? { sessionId } : {}) }),
  });
}

export function fetchGlobalJig(jigId: string): Promise<JigDetail> {
  return request(`/jigs/${jigId}`);
}

export function createGlobalJig(body: JigCreateRequest): Promise<JigDetail> {
  return request("/jigs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateGlobalJig(jigId: string, body: JigUpdateRequest): Promise<JigDetail> {
  return request(`/jigs/${jigId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteGlobalJig(jigId: string): Promise<void> {
  return requestVoid(`/jigs/${jigId}`, { method: "DELETE" });
}

export function createProjectJig(projectId: string, body: JigCreateRequest): Promise<JigDetail> {
  return request(`/projects/${projectId}/jigs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateProjectJig(
  projectId: string,
  jigId: string,
  body: JigUpdateRequest,
): Promise<JigDetail> {
  return request(`/projects/${projectId}/jigs/${jigId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteProjectJig(projectId: string, jigId: string): Promise<void> {
  return requestVoid(`/projects/${projectId}/jigs/${jigId}`, {
    method: "DELETE",
  });
}

export function isJigReferencedError(err: unknown): err is ApiError & {
  code: "JIG_REFERENCED";
  details: JigDeleteConflictResponse;
} {
  return (
    err instanceof ApiError &&
    err.code === "JIG_REFERENCED" &&
    typeof err.details === "object" &&
    err.details !== null &&
    Array.isArray((err.details as JigDeleteConflictResponse).references)
  );
}

export function previewJig(params: JigPreviewRequest): Promise<JigPreviewResponse> {
  return request("/jigs/preview", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function fetchProjectDefaultJig(projectId: string): Promise<ProjectDefaultJigResponse> {
  return request(`/projects/${projectId}/jigs/default`);
}

export function updateProjectDefaultJig(
  projectId: string,
  jigId: string | null,
): Promise<{ jigId: string | null }> {
  return request(`/projects/${projectId}/jigs/default`, {
    method: "PUT",
    body: JSON.stringify({ jigId }),
  });
}

export function fetchIssueTypes(projectId: string): Promise<ProjectIssueTypesV2Response> {
  return request(`/projects/${projectId}/issue-types`);
}

export function fetchProjectIssueTypeMappings(
  projectId: string,
): Promise<ProjectIssueTypeMappingsResponse> {
  return request(`/projects/${projectId}/jigs/issue-type-mappings`);
}

export function updateProjectIssueTypeMappings(
  projectId: string,
  mappings: Record<string, string>,
): Promise<ProjectIssueTypeMappingsResponse> {
  return request(`/projects/${projectId}/jigs/issue-type-mappings`, {
    method: "PUT",
    body: JSON.stringify({ mappings }),
  });
}

// Settings
export function fetchSettings(): Promise<SettingsResponse> {
  return request("/settings");
}

export function updateSettings(settings: UserPreferences): Promise<UserPreferences> {
  return request("/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function fetchEnvKeys(): Promise<{ keys: string[] }> {
  return request("/settings/env-keys");
}

export function recheckClaudeCode(): Promise<{
  claudeCodeAutoModeAvailable: boolean;
  claudeCodeAutoModeReason?: string;
}> {
  return request("/settings/claude-code/recheck", { method: "POST" });
}

// Permissions
export function fetchProjectPermissions(projectId: string): Promise<ProjectPermissions> {
  return request(`/projects/${projectId}/permissions`);
}

export function updateProjectPermissions(
  projectId: string,
  permissions: ProjectPermissions,
): Promise<ProjectPermissions> {
  return request(`/projects/${projectId}/permissions`, {
    method: "PUT",
    body: JSON.stringify(permissions),
  });
}

export interface ResyncResult {
  resynced: number;
  skipped: number;
  errors: { benchId: number; message: string }[];
}

export function resyncProjectPermissions(projectId: string): Promise<ResyncResult> {
  return request(`/projects/${projectId}/permissions/resync`, {
    method: "POST",
  });
}

// Project settings
export function fetchProjectSettings(projectId: string): Promise<ProjectSettingsResponse> {
  return request(`/projects/${projectId}/settings`);
}

export function updateProjectSettings(
  projectId: string,
  settings: ProjectSettings,
): Promise<ProjectSettings> {
  return request(`/projects/${projectId}/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// Bench behaviour overrides
export interface BenchOverrides {
  enforceIssueDependencies: boolean | null;
}

export function updateProjectBenchOverrides(
  projectId: string,
  patch: Partial<BenchOverrides>,
): Promise<BenchOverrides> {
  return request(`/projects/${projectId}/benches/overrides`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

// Integration plugins
export function fetchProjectIntegration(projectId: string): Promise<ProjectIntegrationState> {
  return request(`/projects/${projectId}/integration`);
}

export function switchProjectIntegration(
  projectId: string,
  plugin: string,
): Promise<ProjectIntegrationState> {
  return request(`/projects/${projectId}/integration/override`, {
    method: "PUT",
    body: JSON.stringify({ plugin }),
  });
}

export function promoteProjectIntegration(projectId: string): Promise<ProjectIntegrationState> {
  return request(`/projects/${projectId}/integration/promote`, {
    method: "POST",
  });
}

export function testIntegrationConnection(
  projectId: string,
  config: Record<string, unknown>,
): Promise<IntegrationTestResult> {
  return request(`/projects/${projectId}/integration/test`, {
    method: "POST",
    body: JSON.stringify({ config }),
  });
}

export function saveIntegrationConfig(
  projectId: string,
  update: IntegrationConfigUpdate,
): Promise<ProjectIntegrationState> {
  return request(`/projects/${projectId}/integration/config`, {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

export function fetchIntegrationFields(projectId: string): Promise<IntegrationFields> {
  return request(`/projects/${projectId}/integration/fields`);
}

export function saveIntegrationFields(
  projectId: string,
  update: IntegrationFieldsUpdate,
): Promise<IntegrationFields> {
  return request(`/projects/${projectId}/integration/fields`, {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

export interface DerivedGithubSourcesPreview {
  repos: string[];
  projects: Array<{ externalId: string; label: string }>;
  alertsRequested: Array<"code-scanning" | "secret-scanning" | "dependabot">;
}

export function fetchDerivedGithubSources(projectId: string): Promise<DerivedGithubSourcesPreview> {
  return request(`/projects/${projectId}/integration/derived-sources`);
}

// Declarative source picker (FR-019). The host proxies the active plugin's
// `listSourceCandidates`; the response shape (`multi-list` /
// `categorized-multi-list`) drives which picker the client renders.
export function fetchSourceCandidates(projectId: string): Promise<SourceCandidatesResponse> {
  return request(`/projects/${projectId}/integration/sources`);
}

export function fetchStatusCategories(projectId: string): Promise<StatusCategoriesResponse> {
  return request(`/projects/${projectId}/integration/status-categories`);
}

export function saveIntegrationSources(
  projectId: string,
  sources: SourceSelection,
): Promise<ProjectIntegrationState> {
  return request(`/projects/${projectId}/integration/sources`, {
    method: "PUT",
    body: JSON.stringify({ sources }),
  });
}

export function fetchFilterFacets(projectId: string): Promise<FilterFacet[]> {
  return request(`/projects/${projectId}/integration/filter-facets`);
}

export function fetchFacetOptions(
  projectId: string,
  facetId: string,
  search?: string,
): Promise<FilterFacetOption[]> {
  const params = new URLSearchParams({ facetId });
  if (search && search.length > 0) params.set("search", search);
  return request(`/projects/${projectId}/integration/facet-options?${params.toString()}`);
}

// Scoped, paginated source search (WU-002). `scope` carries the parent
// selection (e.g. the Jira project keys a board/filter/epic search is confined
// to); `cursor` is the opaque token from the previous page's `nextCursor`.
export function fetchSourceOptions(
  projectId: string,
  opts: {
    category: "project" | "board" | "filter" | "epic";
    scope?: { project?: string[] };
    search?: string;
    cursor?: string | null;
  },
): Promise<SourceOptionsResult> {
  const params = new URLSearchParams({ category: opts.category });
  if (opts.scope !== undefined) params.set("scope", JSON.stringify(opts.scope));
  if (opts.search && opts.search.length > 0) params.set("search", opts.search);
  if (opts.cursor) params.set("cursor", opts.cursor);
  return request(`/projects/${projectId}/integration/source-options?${params.toString()}`);
}

// Global plugin integration (Plugins settings page)
export function fetchGlobalPluginIntegration(
  pluginId: string,
): Promise<GlobalPluginIntegrationState> {
  return request(`/plugins/${pluginId}/integration`);
}

export function testGlobalPluginIntegration(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<IntegrationTestResult> {
  return request(`/plugins/${pluginId}/integration/test`, {
    method: "POST",
    body: JSON.stringify({ config }),
  });
}

export function saveGlobalPluginIntegration(
  pluginId: string,
  update: Omit<IntegrationConfigUpdate, "sources">,
): Promise<GlobalPluginIntegrationState> {
  return request(`/plugins/${pluginId}/integration/config`, {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

export async function fetchInstalledPlugins(): Promise<InstalledPluginSummary[]> {
  // GET /api/plugins returns { hostApiVersion, plugins: PluginRecord[] }. The
  // Switch integration dialog only needs the serializable summary shape, so we
  // adapt here rather than threading PluginRecord through the UI.
  const body = await request<{ hostApiVersion: string; plugins: PluginRecord[] }>("/plugins");
  return body.plugins.flatMap((r) => {
    if (!r.manifest) return [];
    return [
      {
        id: r.id,
        name: r.manifest.name,
        status: r.status,
        ...(r.lastError ? { lastError: r.lastError.message } : {}),
        ...(r.isolationNotices?.length ? { isolationNotices: r.isolationNotices } : {}),
      },
    ];
  });
}

// github-com plugin OAuth: returns the URL to open in a browser.
export function startGithubPluginOauth(): Promise<{ url: string }> {
  return request("/plugins/github-com/oauth/authorize", { method: "POST" });
}

// Clears the persisted github-com OAuth token. The server-side handler is
// idempotent, so calling it for an already-disconnected plugin still resolves.
export function disconnectGithubPluginOauth(): Promise<{ ok: true }> {
  return request("/plugins/github-com/oauth/disconnect", { method: "POST" });
}

// Plugins
export interface PluginsListResponse {
  hostApiVersion: string;
  plugins: PluginRecord[];
}

export function fetchPlugins(): Promise<PluginsListResponse> {
  return request("/plugins");
}

export function enablePlugin(pluginId: string): Promise<void> {
  return requestVoid(`/plugins/${encodeURIComponent(pluginId)}/enable`, { method: "POST" });
}

export function disablePlugin(pluginId: string): Promise<void> {
  return requestVoid(`/plugins/${encodeURIComponent(pluginId)}/disable`, { method: "POST" });
}

export function restartPlugin(pluginId: string): Promise<void> {
  return requestVoid(`/plugins/${encodeURIComponent(pluginId)}/restart`, { method: "POST" });
}

export function uninstallPlugin(pluginId: string): Promise<void> {
  return requestVoid(`/plugins/${encodeURIComponent(pluginId)}`, { method: "DELETE" });
}

// Issue #756: copy a bundled plugin into the shared ~/.roubo/plugins/<id>/
// location, supersede the bundled entry, and start the user copy. Returns the
// new (source: "user") record.
export function reinstallPluginShared(pluginId: string): Promise<PluginRecord> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/reinstall-shared`, {
    method: "POST",
  });
}

export function fetchConnectionStatus(pluginId: string): Promise<ConnectionStatus> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/connection-status`);
}

// Permission consent (issue #615, CP-FR-011 / CP-FR-012)
export interface PluginConsentStatus {
  declared: PluginPermissions;
  firstParty: boolean;
  consentedAt?: string;
}

export function fetchPluginConsent(pluginId: string): Promise<PluginConsentStatus> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/consent`);
}

export function grantPluginConsent(
  pluginId: string,
  acknowledgedCategories: string[],
): Promise<ConsentRecord> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/consent`, {
    method: "POST",
    body: JSON.stringify({ acknowledgedCategories }),
  });
}

export function fetchPluginLogs(
  pluginId: string,
  file: "current" | "previous" = "current",
  lines?: number,
): Promise<{ lines: LogLine[] }> {
  const params = new URLSearchParams({ file });
  if (lines !== undefined) params.set("lines", String(lines));
  return request(`/plugins/${encodeURIComponent(pluginId)}/logs?${params.toString()}`);
}

// Plugin install (WU-011): two-stage flow.
//   1) previewInstallPlugin clones/copies into staging and returns the manifest preview.
//   2) confirmInstallPlugin moves staging → ~/.roubo/plugins/<id>/ and enables it.
//      cancelInstallPlugin removes the staging directory cleanly.
export function previewInstallPlugin(body: {
  source: "git" | "local";
  value: string;
}): Promise<InstallPreview> {
  return request("/plugins/install", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function confirmInstallPlugin(stagingToken: string): Promise<{ plugin: PluginRecord }> {
  return request(`/plugins/install/${encodeURIComponent(stagingToken)}/confirm`, {
    method: "POST",
  });
}

export function cancelInstallPlugin(stagingToken: string): Promise<void> {
  return requestVoid(`/plugins/install/${encodeURIComponent(stagingToken)}/cancel`, {
    method: "POST",
  });
}

export type { InstallPreview, InstallSource };

// Marketplace catalog (CP-FR-020 / CP-US-010, issue #621). The catalog is
// first-party curated; install/update reuse the existing two-stage plugin
// install flow (they return a staging token, then confirmInstallPlugin /
// cancelInstallPlugin drive the commit step through the consent UI).
export function fetchMarketplaceCatalog(params?: {
  q?: string;
  kind?: MarketplaceKind;
}): Promise<MarketplaceCatalogResponse> {
  const search = new URLSearchParams();
  if (params?.q) search.set("q", params.q);
  if (params?.kind) search.set("kind", params.kind);
  const qs = search.toString();
  return request(`/marketplace/plugins${qs ? `?${qs}` : ""}`);
}

export function installFromMarketplace(id: string): Promise<InstallPreview> {
  return request(`/marketplace/plugins/${encodeURIComponent(id)}/install`, {
    method: "POST",
  });
}

export function updateFromMarketplace(id: string): Promise<InstallPreview> {
  return request(`/marketplace/plugins/${encodeURIComponent(id)}/update`, {
    method: "POST",
  });
}

export type { MarketplaceCatalogResponse, MarketplaceListing, MarketplaceKind };

// Migration (WU-024 / issue #42)
export function fetchMigrationStatus(): Promise<MigrationStatusResponse> {
  return request("/migration/status");
}

// TestBench spec discovery + manual-path validation (#418). These mirror the
// server-side shapes in server/lib/testbench-spec-discovery.ts; the client cannot
// import from the server package, so the response types are restated here.

// One discovered, contract-valid spec: the slug naming its
// `.specifications/<slug>/` folder, the absolute path to its test-cases.json, and
// the number of cases in it.
export interface DiscoveredSpec {
  slug: string;
  path: string;
  caseCount: number;
}

// A spec folder whose test-cases.json exists but failed to parse/validate, with
// its human-readable errors. Surfaced so the picker can explain a schema mismatch
// instead of falsely reporting "No specs found".
export interface InvalidSpec {
  slug: string;
  path: string;
  errors: string[];
}

// Result of validating a manual path: on success the resolved slug + case count,
// on failure a flat list of human-readable error messages.
export type ManualPathValidation =
  | { ok: true; slug: string; caseCount: number }
  | { ok: false; errors: string[] };

// GET /testbench/specs: enumerate specs under the project repo. Returns the
// usable `specs` plus any present-but-invalid spec files (`invalid`) with their
// validation errors, so the UI can tell a schema mismatch apart from an empty repo.
export function fetchSpecs(
  projectId: string,
): Promise<{ specs: DiscoveredSpec[]; invalid: InvalidSpec[] }> {
  return request(`/projects/${projectId}/testbench/specs`);
}

// POST /testbench/specs/validate: validate a single user-supplied path (the FR-003
// manual escape hatch). The server returns 200 for { ok: true } and 400 for
// { ok: false }; both carry the ManualPathValidation body, so we read the parsed
// JSON in either case rather than letting `request` throw on the 400.
export async function validateSpecPath(
  projectId: string,
  path: string,
): Promise<ManualPathValidation> {
  const res = await fetch(`${BASE}/projects/${projectId}/testbench/specs/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const body = await res
    .json()
    .catch(() => ({ ok: false, errors: [res.statusText] }) as ManualPathValidation);
  return body as ManualPathValidation;
}

// TestBench notes (#421). Append-only: POST returns the stamped Note (author +
// timestamp + status-at-write captured server-side). A blank or whitespace-only
// body is rejected server-side with 400 (surfaced here as an ApiError).
export function appendNote(
  projectId: string,
  benchId: number,
  caseId: string,
  text: string,
): Promise<Note> {
  return request(
    `/projects/${projectId}/benches/${benchId}/testbench/cases/${encodeURIComponent(caseId)}/notes`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    },
  );
}

// TestBench observation mark (#420, FR-007/FR-008). PUT records a pass/fail mark
// for one observation and returns the updated CaseResult: the server stamps the
// author + timestamp and recomputes derivedStatus (server is source of truth).
// Passing null clears (un-sets) the mark entirely (#508).
export function markObservation(
  projectId: string,
  benchId: number,
  caseId: string,
  observationId: string,
  result: "pass" | "fail" | null,
): Promise<CaseResult> {
  return request(
    `/projects/${projectId}/benches/${benchId}/testbench/cases/${encodeURIComponent(
      caseId,
    )}/observations/${encodeURIComponent(observationId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ result }),
    },
  );
}

// TestBench status override (#420, FR-010). PUT sets an explicit override (one of
// the five CaseStatus values) or clears it (override: null). Returns the updated
// CaseResult with statusOverride set or absent. The override is recorded
// distinctly from derivedStatus and takes precedence over later marks.
export function setStatusOverride(
  projectId: string,
  benchId: number,
  caseId: string,
  override: CaseStatus | null,
): Promise<CaseResult> {
  return request(
    `/projects/${projectId}/benches/${benchId}/testbench/cases/${encodeURIComponent(caseId)}/status`,
    {
      method: "PUT",
      body: JSON.stringify({ override }),
    },
  );
}
