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
  BlueprintMeta,
  BlueprintDetail,
  InjectBlueprintResponse,
  BlueprintCreateRequest,
  BlueprintUpdateRequest,
  BlueprintDeleteConflictResponse,
  BlueprintPreviewRequest,
  BlueprintPreviewResponse,
  UserPreferences,
  SettingsResponse,
  GitHubAuthStatus,
  GitHubAuthUrl,
  BenchNotification,
  ProjectPermissions,
  ProjectSettings,
  ProjectSettingsResponse,
  ProjectDefaultBlueprintResponse,
  ProjectIssueTypesV2Response,
  ProjectIssueTypeMappingsResponse,
  ProjectIntegrationState,
  IntegrationConfigUpdate,
  IntegrationTestResult,
  SourceCandidatesResponse,
  SourceSelection,
  InstalledPluginSummary,
  DirtyReason,
  PluginRecord,
  LogLine,
  InstallPreview,
  InstallSource,
} from "@roubo/shared";

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

export function buildNotConnectedError(): ApiError {
  return new ApiError("GitHub not connected", 401, "NOT_CONNECTED");
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
  branch?: string,
  issueNumber?: number,
  branchConflictResolution?: "resume" | "new",
): Promise<Bench | CreateBenchWithIssueResponse> {
  const body: CreateBenchRequest = {};
  if (branch) body.branch = branch;
  if (issueNumber) body.issueNumber = issueNumber;
  if (branchConflictResolution) body.branchConflictResolution = branchConflictResolution;
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
  blueprintId?: string,
): Promise<TerminalCreateResponse> {
  return request(`/projects/${projectId}/benches/${benchId}/terminals`, {
    method: "POST",
    body: JSON.stringify({ command, ...(blueprintId ? { blueprintId } : {}) }),
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

// Blueprints
export function fetchGlobalBlueprints(): Promise<BlueprintMeta[]> {
  return request("/blueprints");
}

export function fetchBlueprints(projectId: string): Promise<BlueprintMeta[]> {
  return request(`/projects/${projectId}/blueprints`);
}

export function fetchBlueprint(projectId: string, blueprintId: string): Promise<BlueprintDetail> {
  return request(`/projects/${projectId}/blueprints/${blueprintId}`);
}

export function injectBlueprint(
  projectId: string,
  benchId: number,
  blueprintId: string,
  sessionId?: string,
): Promise<InjectBlueprintResponse> {
  return request(`/projects/${projectId}/benches/${benchId}/inject-blueprint`, {
    method: "POST",
    body: JSON.stringify({ blueprintId, ...(sessionId ? { sessionId } : {}) }),
  });
}

export function fetchGlobalBlueprint(blueprintId: string): Promise<BlueprintDetail> {
  return request(`/blueprints/${blueprintId}`);
}

export function createGlobalBlueprint(body: BlueprintCreateRequest): Promise<BlueprintDetail> {
  return request("/blueprints", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateGlobalBlueprint(
  blueprintId: string,
  body: BlueprintUpdateRequest,
): Promise<BlueprintDetail> {
  return request(`/blueprints/${blueprintId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteGlobalBlueprint(blueprintId: string): Promise<void> {
  return requestVoid(`/blueprints/${blueprintId}`, { method: "DELETE" });
}

export function createProjectBlueprint(
  projectId: string,
  body: BlueprintCreateRequest,
): Promise<BlueprintDetail> {
  return request(`/projects/${projectId}/blueprints`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateProjectBlueprint(
  projectId: string,
  blueprintId: string,
  body: BlueprintUpdateRequest,
): Promise<BlueprintDetail> {
  return request(`/projects/${projectId}/blueprints/${blueprintId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteProjectBlueprint(projectId: string, blueprintId: string): Promise<void> {
  return requestVoid(`/projects/${projectId}/blueprints/${blueprintId}`, {
    method: "DELETE",
  });
}

export function isBlueprintReferencedError(err: unknown): err is ApiError & {
  code: "BLUEPRINT_REFERENCED";
  details: BlueprintDeleteConflictResponse;
} {
  return (
    err instanceof ApiError &&
    err.code === "BLUEPRINT_REFERENCED" &&
    typeof err.details === "object" &&
    err.details !== null &&
    Array.isArray((err.details as BlueprintDeleteConflictResponse).references)
  );
}

export function previewBlueprint(
  params: BlueprintPreviewRequest,
): Promise<BlueprintPreviewResponse> {
  return request("/blueprints/preview", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function fetchProjectDefaultBlueprint(
  projectId: string,
): Promise<ProjectDefaultBlueprintResponse> {
  return request(`/projects/${projectId}/blueprints/default`);
}

export function updateProjectDefaultBlueprint(
  projectId: string,
  blueprintId: string | null,
): Promise<{ blueprintId: string | null }> {
  return request(`/projects/${projectId}/blueprints/default`, {
    method: "PUT",
    body: JSON.stringify({ blueprintId }),
  });
}

export function fetchIssueTypes(projectId: string): Promise<ProjectIssueTypesV2Response> {
  return request(`/projects/${projectId}/issue-types`);
}

export function fetchProjectIssueTypeMappings(
  projectId: string,
): Promise<ProjectIssueTypeMappingsResponse> {
  return request(`/projects/${projectId}/blueprints/issue-type-mappings`);
}

export function updateProjectIssueTypeMappings(
  projectId: string,
  mappings: Record<string, string>,
): Promise<ProjectIssueTypeMappingsResponse> {
  return request(`/projects/${projectId}/blueprints/issue-type-mappings`, {
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

export function fetchSourceCandidates(projectId: string): Promise<SourceCandidatesResponse> {
  return request(`/projects/${projectId}/integration/sources`);
}

export function saveProjectSources(
  projectId: string,
  sources: SourceSelection,
): Promise<ProjectIntegrationState> {
  return request(`/projects/${projectId}/integration/sources`, {
    method: "PUT",
    body: JSON.stringify({ sources }),
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

// GitHub Auth
export function fetchGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  return request("/auth/github/status");
}

export function fetchGitHubAuthUrl(): Promise<GitHubAuthUrl> {
  return request("/auth/github/authorize");
}

export function disconnectGitHub(): Promise<void> {
  return requestVoid("/auth/github", { method: "DELETE" });
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
