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
  DatabaseTable,
  DatabaseQueryResult,
  DatabaseTableSchema,
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
  InstalledPluginSummary,
  DirtyReason,
  PluginRecord,
  ConnectionStatus,
  LogLine,
  InstallPreview,
  InstallSource,
  MigrationRecord,
} from "@roubo/shared";

export interface MigrationStatusResponse {
  schemaVersion: number | null;
  migration: MigrationRecord | null;
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
    issueNumber?: number;
    // Security alerts assign by externalId (no bare numeric form); plain issues
    // continue to assign by issueNumber.
    externalId?: string;
    branchConflictResolution?: "resume" | "new";
  } = {},
): Promise<Bench | CreateBenchWithIssueResponse> {
  const body: CreateBenchRequest = {};
  if (opts.branch) body.branch = opts.branch;
  if (opts.issueNumber) body.issueNumber = opts.issueNumber;
  if (opts.externalId) body.externalId = opts.externalId;
  if (opts.branchConflictResolution) body.branchConflictResolution = opts.branchConflictResolution;
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

export function syncBenchWorkUnits(projectId: string, benchId: number): Promise<Bench> {
  return request(`/projects/${projectId}/benches/${benchId}/sync`, {
    method: "POST",
  });
}

export function setWorkUnitIgnoredForAutoClear(
  projectId: string,
  benchId: number,
  submodule: string,
  ignored: boolean,
): Promise<Bench> {
  return request(
    `/projects/${projectId}/benches/${benchId}/work-units/${encodeURIComponent(submodule)}/ignore-for-auto-clear`,
    { method: "POST", body: JSON.stringify({ ignored }) },
  );
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
): Promise<{ logs: string[] }> {
  return request(
    `/projects/${projectId}/benches/${benchId}/components/${component}/logs?tail=${tail}`,
  );
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

// Database
export function fetchDbTables(projectId: string, benchId: number): Promise<DatabaseTable[]> {
  return request(`/projects/${projectId}/benches/${benchId}/database/tables`);
}

export function fetchDbTableData(
  projectId: string,
  benchId: number,
  schema: string,
  table: string,
  page: number,
  pageSize: number,
): Promise<DatabaseQueryResult> {
  return request(
    `/projects/${projectId}/benches/${benchId}/database/tables/${encodeURIComponent(table)}/data?schema=${encodeURIComponent(schema)}&page=${page}&pageSize=${pageSize}`,
  );
}

export function fetchDbTableSchema(
  projectId: string,
  benchId: number,
  schema: string,
  table: string,
): Promise<DatabaseTableSchema> {
  return request(
    `/projects/${projectId}/benches/${benchId}/database/tables/${encodeURIComponent(table)}/schema?schema=${encodeURIComponent(schema)}`,
  );
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
  opts: { cursor?: string | null; pageSize?: number; labels?: string; search?: string },
): Promise<PaginatedIssues> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
  if (opts.labels) params.set("labels", opts.labels);
  if (opts.search) params.set("search", opts.search);
  const qs = params.toString();
  return request(`/projects/${projectId}/issues${qs ? `?${qs}` : ""}`);
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
  issueNumber: number,
): Promise<AssignIssueResponse> {
  return request(`/projects/${projectId}/benches/${benchId}/assign-issue`, {
    method: "POST",
    body: JSON.stringify({ issueNumber }),
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
  autoClear: boolean | null;
  enforceIssueDependencies: boolean | null;
  workUnitAutoClear: boolean | null;
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
      },
    ];
  });
}

// github-com plugin OAuth — returns the URL to open in a browser.
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

export function fetchConnectionStatus(pluginId: string): Promise<ConnectionStatus> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/connection-status`);
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

// Migration (WU-024 / issue #42)
export function fetchMigrationStatus(): Promise<MigrationStatusResponse> {
  return request("/migration/status");
}
