/**
 * Public types exposed to plugin authors.
 *
 * Shapes mirror what the host expects across the JSON-RPC boundary;
 * the SDK is the contract source-of-truth for plugin authors and the
 * canonical reference for new bundled plugins.
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
  // Keys match facet ids returned by `filterFacets`; core uses this map to
  // filter the cut list. Plugins built against host-API 1.0.0 omit this and
  // core treats absence as an empty map.
  facetValues?: Record<string, string | string[]>;
}

/**
 * Self-reported connectivity for a plugin (host-API 1.1.0+). Plugins that omit
 * `getConnectionStatus` are tolerated; the host falls back to `validateConfig`
 * and infers `connected` vs `auth-problem` from the result.
 */
export interface ConnectionStatus {
  state: "connected" | "disconnected" | "auth-problem" | "errored";
  detail?: string;
  /** ISO-8601 timestamp; the plugin (or host fallback) sets this at observation. */
  checkedAt: string;
  /**
   * Present on `connected` when the plugin can cheaply resolve the
   * authenticated account (e.g. from the same `GET /user` probe). The host
   * forwards it verbatim to the UI's "Connected as <login>" label; omit it
   * otherwise. Kept in sync with `ConnectionStatus` in `@roubo/shared`.
   */
  account?: { login: string };
}

/**
 * One descriptor returned by `filterFacets`. Core renders generic filter UI
 * from these; for `enum-async` the host requests options lazily on dropdown
 * open via `getFacetOptions`. Plugins built against host-API 1.0.0 omit
 * `filterFacets` and core falls back to a fixed common-facet set.
 */
export interface FilterFacet {
  id: string;
  label: string;
  type: "enum" | "enum-async" | "multi-enum";
  // Present iff the facet's option set is small and stable enough to ship
  // inline (typical for `enum`/`multi-enum`). Absent for `enum-async` and for
  // large facets whose options are populated lazily via `getFacetOptions`.
  options?: FilterFacetOption[];
}

/**
 * One option for a `FilterFacet`. Used both inline (eager `enum`/`multi-enum`)
 * and as the return shape of `getFacetOptions` (lazy `enum-async`).
 */
export interface FilterFacetOption {
  value: string;
  label: string;
}

/**
 * One sort field returned by `getSortFields` (host-API 1.2.0+, CLI-FR-009).
 * Core renders a sort picker from these; `defaultDir` is the direction first
 * applied when the user selects the field. Plugins built against host-API
 * 1.0.0 / 1.1.0 omit `getSortFields` and core renders no picker (CLI-FR-011).
 * Mirrored as `SortField` in `@roubo/shared`.
 */
export interface SortField {
  id: string;
  label: string;
  defaultDir: "asc" | "desc";
}

export interface NormalizedComment {
  externalId: string;
  author: { externalId: string; displayName: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One entry of the source list a host passes into source-bound contract
 * methods. `kind` is plugin-defined (e.g. `"repo"`, `"project"` for the
 * GitHub plugins); `externalId` is the plugin-native id for that source
 * (e.g. `"owner/repo"`, `"owner/#42"`). The host derives this list per
 * request from the project's `roubo.yaml` integration block, so plugins
 * never share source state across projects.
 */
export interface ConfiguredSource {
  kind: string;
  externalId: string;
  /**
   * Jira self-hosted only: the project key this source is scoped to under the
   * project-first selection model. Plugins outside the Jira family ignore it.
   */
  project?: string;
  /**
   * Jira self-hosted only: for a `board` source, whether to resolve to the
   * board's active sprint (default) or the whole board's backing filter.
   */
  boardMode?: "active-sprint" | "whole-board";
  /**
   * Jira self-hosted only: for the synthetic `mine` ("assigned to me") source,
   * whether it is scoped to the in-scope projects or matches anywhere.
   */
  mineScope?: "in-project" | "anywhere";
  /**
   * github.com / GHE only: per-source toggles for the GitHub Advanced Security
   * alert categories surfaced as security-* issue types. Plugins outside the
   * GitHub family ignore these fields. Default false on each.
   */
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

/**
 * Discriminator for `ListIssuesWarning.code`. The client maps these to chip
 * variants in the cut-list source picker. `missing-scope` and
 * `scope-unverifiable` drive the GitHub family's PAT/OAuth remediation
 * affordances (WU-032); other codes share the generic "Unavailable" chip.
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
 * Non-fatal warning emitted alongside a `listIssues` result. Used by the
 * GitHub plugins to surface per-source per-category fetch failures without
 * failing the entire pull. Categories are stable string identifiers; the
 * host treats unknown values as opaque and surfaces `cause` verbatim to UI.
 *
 * `code` is an optional discriminator the client uses to pick a chip variant
 * (e.g. `missing-scope` → link chip pointing at PAT settings / OAuth re-auth).
 * Absent means the client renders the generic chip with `cause` as the tooltip.
 *
 * A warning with a given `(sourceExternalId, category)` is cleared on the
 * next successful pull for that pair: a subsequent `listIssues` page-1
 * result that omits it constitutes a clear.
 */
export interface ListIssuesWarning {
  category: "code-scanning" | "secret-scanning" | "dependabot" | string;
  sourceExternalId: string;
  cause: string;
  code?: ListIssuesWarningCode;
  detail?: { status?: number; code?: string; missingScope?: string };
}

export interface ListIssuesParams {
  sources: ConfiguredSource[];
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
  /**
   * Status exclusion resolved by the host from the three-layer merge (FR-009,
   * FR-010), applied in the query so excluded issues never occupy a result
   * page. `excludedStatusCategories` is the category-first default (e.g.
   * `["Done"]`); `excludedStatuses` is the status-name list a plugin uses as
   * the fallback when the instance does not support `statusCategory` in its
   * query language. A plugin that does not do server-side exclusion ignores both.
   */
  excludedStatusCategories?: string[];
  excludedStatuses?: string[];
  /**
   * Plugin-declared sort selection (CLI-FR-009/CLI-FR-010). `sortBy` is one of
   * the field ids the plugin returned from `getSortFields`; `sortDir` is the
   * direction. Plugins MUST apply the sort source-side so the order is stable
   * across pages. Absent means the plugin's natural order; a plugin that does
   * not declare any sort fields (and so never receives these) is unaffected.
   */
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface ListIssueTypesParams {
  sources: ConfiguredSource[];
}

export interface ListLabelsParams {
  sources: ConfiguredSource[];
}

/**
 * Params for the lazy facet-option loader. `facetId` matches a `FilterFacet.id`
 * the plugin previously returned from `filterFacets()`. `sources` follows the
 * existing source-bound pattern so plugins remain stateless across projects.
 * `search` is the optional user-typed prefix/substring; plugins MAY ignore it
 * and return the full set.
 */
export interface GetFacetOptionsParams {
  facetId: string;
  sources: ConfiguredSource[];
  search?: string;
}

export interface ListIssuesResult {
  items: NormalizedIssue[];
  nextCursor: string | null;
  /** Absent or empty means "no per-category problems on this page." */
  warnings?: ListIssuesWarning[];
  /**
   * Count of issues the plugin dropped in-query (e.g. the status-category
   * exclusion of FR-009/FR-010), surfaced so the cut list can show "N filtered
   * out by status". Additive and optional: the host sums it across pages and
   * treats absence as "unknown". Plugins that filter in memory report it
   * per page; the jira-self-hosted plugin excludes server-side in JQL, so it
   * reports the whole-result-set count once on the first page via a count-only
   * companion query (and omits it when the companion count is unavailable).
   */
  excludedCount?: number;
}

export type SourceCandidateIcon = "repo" | "project" | "board" | "epic" | "filter";

export interface SourceCandidateItem {
  externalId: string;
  label: string;
  sublabel?: string;
  icon?: SourceCandidateIcon;
}

export interface SourceCandidateCategory {
  id: string;
  label: string;
  items: SourceCandidateItem[];
}

export type SourceCandidatesShape =
  | "multi-list"
  | "categorized-multi-list"
  | "searchable-categorized";

// One selectable mode within a synthetic searchable category (e.g. "assigned to
// me": in-project vs anywhere). Distinct from a SourceCandidateItem in that it
// has no externalId and is not fetched via search; the host renders it inline.
export interface SourceCategoryOption {
  id: string;
  label: string;
}

// A category declared by the "searchable-categorized" shape. The plugin ships
// no items here; it only declares which categories exist, their icon, and
// whether each is gated behind a parent selection. Items arrive later via the
// host's `getSourceOptions` search RPC.
export interface SearchableSourceCategory {
  id: "project" | "board" | "filter" | "epic" | "mine";
  label: string;
  icon?: SourceCandidateIcon;
  // Gate: the category is disabled until the named parent selection exists.
  scopedBy?: "project";
  // Inline modes for synthetic categories like "mine".
  options?: SourceCategoryOption[];
}

/**
 * Declarative source-picker payload returned by `listSourceCandidates`. Roubo's
 * host renders the UI from this envelope; plugins ship no React. See
 * `.specifications/integration-plugins/architecture.md`.
 */
export interface SourceCandidatesResponse {
  shape: SourceCandidatesShape;
  // Present iff shape === "multi-list".
  items?: SourceCandidateItem[];
  // Present iff shape === "categorized-multi-list".
  categories?: SourceCandidateCategory[];
  // Present iff shape === "searchable-categorized". Each category's items are
  // fetched lazily via `getSourceOptions`, never shipped inline here.
  searchableCategories?: SearchableSourceCategory[];
  // Reserved for future pagination; v1 plugins return undefined.
  nextCursor?: string | null;
}

/**
 * Params for the scoped, paginated source-option search (`getSourceOptions`).
 * Generalizes `getFacetOptions` with a parent `scope` (e.g. the Jira project
 * keys a board/filter/epic search is confined to) and an opaque `cursor`.
 * `search` is the optional user-typed term (debounced client-side); plugins
 * MAY ignore it. Scoped categories with no `scope.project` return an empty page.
 */
export interface GetSourceOptionsParams {
  category: "project" | "board" | "filter" | "epic";
  scope?: { project?: string[] };
  search?: string;
  cursor?: string | null;
}

/**
 * One page of source options. `nextCursor` is an opaque token the host passes
 * back verbatim to fetch the following page; `null` means the result set is
 * exhausted (NFR-004: every item reachable, no page dropped or duplicated).
 */
export interface SourceOptionsResult {
  items: SourceCandidateItem[];
  nextCursor: string | null;
}

export interface CurrentUser {
  externalId: string;
  displayName: string;
}

export interface ValidateConfigResult {
  ok: boolean;
  errors?: Array<{ field?: string; message: string; code?: string }>;
}

/**
 * Result of a lightweight activation call (`setActiveConfig`). Plugins that
 * hold plugin-wide configuration (e.g. an API instance URL, TLS toggles)
 * implement this to receive that configuration before source-bound RPCs run.
 *
 * `setActiveConfig` is no longer used to convey per-project state: source
 * selections flow through `sources` on each source-bound call so the plugin
 * process holds no per-project state. Plugins with no plugin-wide config
 * (e.g. github.com, which has a fixed API host) can skip implementing this
 * method entirely.
 */
export interface SetActiveConfigResult {
  ok: boolean;
  errors?: Array<{ field?: string; message: string; code?: string }>;
}

export interface IssueTypeOption {
  id: string;
  name: string;
}

/**
 * Result of the privileged `createIssue` op (verify-gate FR-011, spike #704).
 * `ref` is the created issue's external id in the plugin's own form
 * (`owner/repo#number` for GitHub) so the host can immediately use it (e.g. as
 * `blockerRef` in `addBlockedBy`). `nodeId` is the provider's GraphQL node id
 * when the tracker exposes one, omitted otherwise.
 */
export interface CreateIssueResult {
  ref: string;
  url: string;
  nodeId?: string;
}

/**
 * Stable identifier for an alert category probed by `probeAlertCategories`.
 * The host's Test Connection result strip surfaces one row per probe result.
 */
export type ProbeAlertCategory = "code-scanning" | "secret-scanning" | "dependabot";

/**
 * Per-probe status returned by `probeAlertCategories`. The host maps these
 * directly into result-strip rows; semantics match the host's
 * `IntegrationCategoryStatus`:
 *
 * - `ok`: probe succeeded (HTTP 2xx)
 * - `scope-missing`: token lacks the required scope (HTTP 401/403)
 * - `not-enabled`: feature is not enabled for the probed repo (HTTP 404/410/451)
 * - `timed-out`: probe exceeded the per-probe cap. Rendered as an amber
 *   warning; does not fail the overall Test Connection result.
 * - `error`: probe returned an unexpected status or threw a non-timeout error
 */
export type ProbeAlertCategoryStatus =
  | "ok"
  | "scope-missing"
  | "not-enabled"
  | "timed-out"
  | "error";

export interface ProbeAlertCategoriesParams {
  /**
   * The same source list a host would pass to `listIssues`. The plugin picks
   * its sample target from this list (typically the first repo source) and
   * may return an `error` row for every requested category if none of the
   * sources are probeable.
   */
  sources: ConfiguredSource[];
  /** Subset of categories the host wants probed; never empty. */
  enabledCategories: ProbeAlertCategory[];
  /**
   * Host-supplied hint for the per-probe timeout. Plugins SHOULD honour this;
   * the host defaults to 5000ms when omitted (FR-047: 5s per-probe cap).
   */
  timeoutMsPerProbe?: number;
}

export interface ProbeAlertCategoryReport {
  category: ProbeAlertCategory;
  status: ProbeAlertCategoryStatus;
  detail?: string;
  httpStatus?: number;
}

export interface ProbeAlertCategoriesResult {
  reports: ProbeAlertCategoryReport[];
}

/**
 * Result of directly probing access to a single source (e.g. a GitHub repo).
 * Lets the host distinguish "no such source" from "access blocked by policy"
 * when a source is missing from `listSourceCandidates`: `status` and `message`
 * carry the underlying HTTP error verbatim so the host can classify it into an
 * actionable code rather than a generic miss.
 */
export interface ProbeRepoAccessResult {
  accessible: boolean;
  status?: number;
  message?: string;
}

/**
 * The contract methods a plugin may implement. All methods are optional;
 * a host call to an unimplemented method receives JSON-RPC MethodNotFound.
 */
export interface PluginContract {
  listSourceCandidates?: () => Promise<SourceCandidatesResponse> | SourceCandidatesResponse;
  listIssues?: (params: ListIssuesParams) => Promise<ListIssuesResult> | ListIssuesResult;
  getIssue?: (params: { externalId: string }) => Promise<NormalizedIssue> | NormalizedIssue;
  getComments?: (params: {
    externalId: string;
  }) => Promise<NormalizedComment[]> | NormalizedComment[];
  getCurrentUser?: () => Promise<CurrentUser> | CurrentUser;
  validateConfig?: (params: {
    config: Record<string, unknown>;
  }) => Promise<ValidateConfigResult> | ValidateConfigResult;
  setActiveConfig?: (params: {
    config: Record<string, unknown>;
  }) => Promise<SetActiveConfigResult> | SetActiveConfigResult;
  applyTransition?: (params: { externalId: string; transition: string }) => Promise<void> | void;
  /**
   * Create a tracker issue (verify-gate FR-011, spike #704). Privileged write
   * routed only through the host's TrackerActionGateway, which gates it on the
   * `supportsCreateIssue` manifest capability and the plugin's consent. Returns
   * the created issue's external ref (the same `owner/repo#number` form the
   * other issue-scoped methods accept), its URL, and the provider node id when
   * the tracker exposes one (GitHub's GraphQL node id, used to wire blocking
   * links without a second lookup).
   */
  createIssue?: (params: {
    repoFullName: string;
    title: string;
    body?: string;
    labels?: string[];
  }) => Promise<CreateIssueResult> | CreateIssueResult;
  /**
   * Register an "is blocked by" relationship: `blockedRef` is blocked by
   * `blockerRef` (verify-gate FR-010/FR-011, spike #704). Privileged write
   * routed only through the host's TrackerActionGateway, which gates it on the
   * `supportsBlockingLinks` manifest capability and the plugin's consent. Both
   * refs are external ids in the plugin's own form (`owner/repo#number` for
   * GitHub).
   */
  addBlockedBy?: (params: { blockedRef: string; blockerRef: string }) => Promise<void> | void;
  assignIssue?: (params: {
    externalId: string;
    assigneeExternalId: string;
  }) => Promise<void> | void;
  unassignIssue?: (params: {
    externalId: string;
    assigneeExternalId: string;
  }) => Promise<void> | void;
  getAvailableTransitions?: (params: { externalId: string }) => Promise<string[]> | string[];
  listIssueTypes?: (params: ListIssueTypesParams) => Promise<IssueTypeOption[]> | IssueTypeOption[];
  /**
   * Enumerate the connected instance's available status categories (issue #453).
   * The host exposes these as the option list for the Configure dialog's
   * status-category exclusion toggle, falling back to a canonical set when a
   * plugin does not implement this method (`MethodNotFound`) or discovery fails.
   * Returned names must be valid wherever the plugin consumes excluded
   * categories (e.g. Jira returns `statusCategory` names usable in JQL).
   */
  listStatusCategories?: () => Promise<string[]> | string[];
  listLabels?: (params: ListLabelsParams) => Promise<string[]> | string[];
  getConnectionStatus?: () => Promise<ConnectionStatus> | ConnectionStatus;
  /**
   * Probe each requested alert-category endpoint for a sample source and
   * return one report per category. Invoked by the host as part of Test
   * Connection (FR-047, WU-041). A throw or `MethodNotFound` is treated by
   * the host as "no per-category data"; it never fails the overall test.
   */
  probeAlertCategories?: (
    params: ProbeAlertCategoriesParams,
  ) => Promise<ProbeAlertCategoriesResult> | ProbeAlertCategoriesResult;
  /**
   * Directly probe access to a single repo (`GET /repos/{owner}/{repo}`) so the
   * host can explain why a configured repo is missing from
   * `listSourceCandidates` (e.g. org OAuth App access restrictions), rather than
   * silently reporting "not found".
   */
  probeRepoAccess?: (params: {
    repoFullName: string;
  }) => Promise<ProbeRepoAccessResult> | ProbeRepoAccessResult;
  filterFacets?: () => Promise<FilterFacet[]> | FilterFacet[];
  getFacetOptions?: (
    params: GetFacetOptionsParams,
  ) => Promise<FilterFacetOption[]> | FilterFacetOption[];
  /**
   * Declare the sort fields the cut-list picker offers (host-API 1.2.0+,
   * CLI-FR-009). Each field carries a stable `id` (forwarded back as
   * `ListIssuesParams.sortBy`), a human `label`, and a `defaultDir`. Plugins
   * omitting this method resolve to `MethodNotFound`, which core maps to an
   * empty list so no picker renders (CLI-FR-011). A plugin that declares fields
   * MUST honour `sortBy`/`sortDir` source-side in `listIssues` (CLI-FR-010).
   */
  getSortFields?: () => Promise<SortField[]> | SortField[];
  /**
   * Scoped, paginated, type-ahead search over a plugin's selectable source
   * categories (project / board / filter / epic). The host calls this from the
   * searchable source picker as the user types and pages; the plugin stays
   * stateless across calls (the parent `scope` is supplied each time).
   */
  getSourceOptions?: (
    params: GetSourceOptionsParams,
  ) => Promise<SourceOptionsResult> | SourceOptionsResult;
}

export type ContractMethodName = keyof PluginContract;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * When true, the host's underlying TLS agent uses `rejectUnauthorized: false`
   * for this request, allowing self-signed certificates. Scoped to a single
   * `host.fetch` call: it does not mutate global Node TLS state and only
   * affects the dispatcher used for this request.
   */
  allowSelfSignedTls?: boolean;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export type LogPayload = string | { message: string; data?: unknown };

export interface HostClient {
  fetch(url: string, init?: FetchInit): Promise<FetchResult>;
  credentials: {
    get(slot: string): Promise<string | null>;
    set(slot: string, value: string): Promise<void>;
  };
  logger: {
    info(payload: LogPayload): void;
    warn(payload: LogPayload): void;
    error(payload: LogPayload): void;
  };
}

export interface DefinePluginOptions {
  /**
   * Replace the default stdio streams. Test harnesses inject paired streams;
   * production plugin code never sets this.
   */
  streams?: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  };
}

export interface PluginHandle {
  /** The connected host client. Available before any contract method is called. */
  host: HostClient;
  /** Tear down the RPC connection. Tests use this; production plugins do not. */
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component plugins (FR-002, US-005)
//
// A component plugin launches and supervises a bench component (a database, a
// process, a one-shot deploy) instead of answering integration-issue queries.
// It runs over the same vscode-jsonrpc/stdio transport as an integration
// plugin, registered via `defineComponentPlugin()` rather than `definePlugin()`.
//
// See:
//   .specifications/component-plugins/architecture.md ('Component contract')
//   .specifications/component-plugins/prd.md (CP-FR-002, CP-US-005)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SDK-level contract version a component plugin declares. The host gates
 * compatibility at validation time (a mismatch is rejected before any
 * lifecycle method is called, never at call time). A single integer mirrors
 * the `schemaVersion: 1` precedent on `ProvisionDescriptor`.
 */
export const SUPPORTED_CONTRACT_VERSION = 1 as const;

/**
 * Minimal structural copy of `@roubo/shared`'s `ProvisionDescriptor` union.
 *
 * `@roubo/plugin-sdk` is a published, dependency-light package (`private:
 * false`, only `vscode-jsonrpc`) whereas `@roubo/shared` is a `private: true`
 * workspace package that ships raw TypeScript. Taking a workspace dependency on
 * it would break both `npm publish` (an unpublished dependency) and the SDK's
 * own `tsc` build (`rootDir: ./src` cannot import a `.ts` file outside `src`).
 * So the descriptor shape is restated here. It MUST stay structurally in sync
 * with `shared/provision-descriptor-schema.ts` (the Zod schema is the
 * authority; the host validates every descriptor against it).
 */
export interface DockerProvisionDescriptor {
  schemaVersion: 1;
  kind: "docker";
  composeFile: string;
  service: string;
  initService?: string;
  portEnvVar?: string;
  migration?: { command: string; args?: string[] };
  connection?: { template: string };
  assignedContainerId?: string;
  // Component-level env merged into the compose interpolation environment (and
  // the migration process env) alongside the allocated port. Mirrors the
  // built-in database env injection so a plugin-backed database reaches parity.
  // MUST stay in sync with `DockerProvisionDescriptorSchema` in shared/.
  env?: Record<string, string>;
  healthcheck?: boolean;
}

export interface ProcessProvisionDescriptor {
  schemaVersion: 1;
  kind: "process";
  command: string;
  env?: Record<string, string>;
  envFile?: string;
  cwd?: string;
  setup?: string;
  dependsOn?: string[];
}

export interface OneshotProvisionDescriptor {
  schemaVersion: 1;
  kind: "oneshot";
  command: string;
  env?: Record<string, string>;
  envFile?: string;
  cwd?: string;
  dependsOn?: string[];
  timeoutMs?: number;
}

/**
 * Discriminated (on `kind`) union a declarative component plugin returns from
 * `translate`. The host's `LifecycleEngine` validates it against the supported
 * `schemaVersion` and then executes it.
 */
export type ProvisionDescriptor =
  | DockerProvisionDescriptor
  | ProcessProvisionDescriptor
  | OneshotProvisionDescriptor;

/**
 * Per-bench context the host resolves (ports allocated, env merged) before any
 * lifecycle method runs. A component plugin is spawned once per plugin and
 * multiplexes benches; `benchId` distinguishes the active bench so a single
 * process serves several concurrently. Mirrors `BenchContext` in
 * architecture.md ('Data model').
 */
export interface BenchContext {
  projectId: string;
  benchId: number;
  componentName: string;
  workspacePath: string;
  ports: Record<string, number>;
  env: Record<string, string>;
}

/**
 * Lifecycle status a component plugin reports (imperative `health`, or pushed
 * via `host.component.reportStatus`). `completed` is the terminal state for a
 * successful one-shot lifecycle (FR-014 / FR-022 delta), distinct from
 * `stopped` (idle) and `error`. This SDK-facing shape intentionally diverges
 * from `@roubo/shared`'s `ComponentStatus`: it adds the `completed` status,
 * treats `name` / `setupComplete` as optional (or absent) rather than required,
 * and models `phases` as a `Record<string, string>` rather than a
 * `ComponentPhase[]`. The shared type stays authoritative host-side; keep the
 * two reconciled deliberately, not field-for-field identical.
 */
export interface ComponentStatus {
  status: "stopped" | "starting" | "running" | "error" | "stopping" | "completed";
  pid?: number;
  containerId?: string;
  phases?: Record<string, string>;
  setupComplete?: boolean;
  error?: string;
  statusDetail?: string;
  startedAt?: string;
}

/**
 * Declarative (preferred) component contract: a pure function mapping the
 * plugin's `config` plus the `BenchContext` to a `ProvisionDescriptor` the host
 * executes. A plugin implements EITHER `translate` OR the imperative hooks
 * below, never both (`defineComponentPlugin` rejects both at validation time).
 */
export interface DeclarativeComponentContract {
  translate: (params: {
    config: Record<string, unknown>;
    context: BenchContext;
  }) => Promise<ProvisionDescriptor> | ProvisionDescriptor;
  start?: never;
  stop?: never;
  health?: never;
  cleanup?: never;
}

/**
 * Imperative (escape-hatch) component contract: lifecycle hooks the plugin
 * drives through the broker (`host.process.*`, `host.docker.*`, `host.ports.*`)
 * for a novel lifecycle a `ProvisionDescriptor` cannot express. All four hooks
 * are required so the host never reaches a half-implemented lifecycle (a plugin
 * missing `stop` is rejected at validation, not at stop-time).
 */
export interface ImperativeComponentContract {
  start: (context: BenchContext) => Promise<void> | void;
  stop: (context: BenchContext) => Promise<void> | void;
  health: (context: BenchContext) => Promise<ComponentStatus> | ComponentStatus;
  cleanup: (context: BenchContext) => Promise<void> | void;
  translate?: never;
}

/**
 * The contract a component plugin implements: the declarative `translate` path
 * XOR the imperative lifecycle hooks. The TypeScript `never` guards make the
 * two variants mutually exclusive at compile time; `defineComponentPlugin` also
 * enforces the rule at runtime/validation time.
 */
export type ComponentContract = DeclarativeComponentContract | ImperativeComponentContract;

export type ComponentContractMethodName = "translate" | "start" | "stop" | "health" | "cleanup";

/** Options for `defineComponentPlugin`. */
export interface DefineComponentPluginOptions {
  /**
   * The contract version the plugin declares. Must equal
   * `SUPPORTED_CONTRACT_VERSION`; a mismatch is rejected synchronously at
   * definition (validation) time, never deferred to a lifecycle call.
   * Defaults to `SUPPORTED_CONTRACT_VERSION` when omitted.
   */
  contractVersion?: number;
  /**
   * Replace the default stdio streams. Test harnesses inject paired streams;
   * production plugin code never sets this.
   */
  streams?: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  };
}

/** Result of `host.process.run` (a blocking run-to-completion). */
export interface ProcessRunResult {
  exitCode: number;
}

/** Result of `host.process.status`. */
export interface ProcessStatusResult {
  alive: boolean;
  exitCode?: number;
}

/** Result of `host.capability.query` (the FR-017 graceful version gate). */
export interface CapabilityQueryResult {
  available: boolean;
  introducedIn?: string;
}

/**
 * The host client surface available to a component plugin inside its contract
 * methods. Each call is an RPC request (or notification) over the bound
 * connection. The host owns every process and container handle; the plugin
 * never spawns anything itself. Mirrors the broker surface in architecture.md.
 */
export interface ComponentHostClient {
  process: {
    start(params: {
      id: string;
      command: string;
      args?: string[];
      env: Record<string, string>;
      cwd: string;
    }): Promise<{ pid: number }>;
    run(params: {
      id: string;
      command: string;
      args?: string[];
      env: Record<string, string>;
      cwd: string;
      timeoutMs: number;
    }): Promise<ProcessRunResult>;
    stop(params: { id: string }): Promise<void>;
    status(params: { id: string }): Promise<ProcessStatusResult>;
    logs(params: { id: string }): Promise<string[]>;
  };
  docker: {
    composeUp(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      service: string;
      env: Record<string, string>;
    }): Promise<{ containerId: string }>;
    waitForHealthy(params: {
      projectName: string;
      service: string;
      timeoutMs: number;
    }): Promise<{ healthy: boolean }>;
    composeRunInit(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      initService: string;
    }): Promise<void>;
    composeStop(params: {
      projectName: string;
      composeFile: string;
      cwd: string;
      service?: string;
    }): Promise<void>;
    composeDown(params: { projectName: string; composeFile: string; cwd: string }): Promise<void>;
    assignContainer(params: { componentName: string; containerId: string }): Promise<void>;
  };
  ports: {
    get(params: { componentName: string }): Promise<number>;
  };
  component: {
    reportStatus(status: ComponentStatus): void;
    reportLog(params: { source: "stdout" | "stderr"; text: string; ts: number }): void;
  };
  capability: {
    query(params: { method: string }): Promise<CapabilityQueryResult>;
  };
}

export interface ComponentPluginHandle {
  /** The connected component host client. Available before any hook is called. */
  host: ComponentHostClient;
  /** Tear down the RPC connection. Tests use this; production plugins do not. */
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent plugins (AP-FR-001, AP-US-001)
//
// An agent plugin translates a launch request into the argv, environment, and
// declared capabilities the host needs to start an AI coding agent in a bench
// workspace. It runs over the same vscode-jsonrpc/stdio transport as an
// integration or component plugin, registered via `defineAgentPlugin()`.
//
// The contract is DECLARATIVE ONLY: there is deliberately no imperative escape
// hatch. The host owns the PTY spawn, every workspace write, hook receipt, and
// quiescence detection, so an agent plugin holds no privilege the runtime
// sandbox does not already grant an integration plugin (AP-NFR-001). In
// particular a plugin can never write a bench workspace itself; it declares
// `capabilities.workspaceWrites` and the host executes them.
//
// See:
//   .specifications/agent-plugins/prd.md (AP-FR-001, AP-NFR-001, AP-US-001)
//   .specifications/agent-plugins/spikes/spike-502-agent-contract-shape.md
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SDK-level contract version an agent plugin declares, versioned explicitly
 * and separately from `SUPPORTED_CONTRACT_VERSION` so the component and agent
 * contracts can move independently. The host gates compatibility at validation
 * time (a mismatch is rejected before `translateLaunch` is ever called).
 */
export const SUPPORTED_AGENT_CONTRACT_VERSION = 1 as const;

/**
 * Minimal structural copy of `@roubo/shared`'s `AgentLaunchDescriptor` shapes.
 *
 * `@roubo/plugin-sdk` is a published, dependency-light package (`private:
 * false`, only `vscode-jsonrpc`) whereas `@roubo/shared` is a `private: true`
 * workspace package that ships raw TypeScript. Taking a workspace dependency on
 * it would break both `npm publish` (an unpublished dependency) and the SDK's
 * own `tsc` build (`rootDir: ./src` cannot import a `.ts` file outside `src`).
 * So the descriptor shape is restated here. It MUST stay structurally in sync
 * with `shared/agent-launch-descriptor-schema.ts` (the Zod schema is the
 * authority; the host validates every descriptor against it).
 */
export type WriteOp =
  | { op: "unionArray"; path: string; values: string[] }
  | { op: "set"; path: string; value: unknown }
  | { op: "delete"; path: string };

/**
 * A workspace file mutation the plugin DECLARES and the host executes, resolved
 * with `resolveWithin` against the bench workspace (escapes rejected). Ops are
 * applied in order against the parsed existing file, so unknown keys survive.
 */
export interface WorkspaceWriteSpec {
  relPath: string;
  format: "json" | "text";
  ops: WriteOp[];
}

/**
 * How the agent signals the host. `http-hook` covers an agent that POSTs to the
 * host itself (the hook registration rides a workspace write); `spawned-notifier`
 * covers an agent that spawns a notifier program per event (the registration
 * rides argv). Carrier strings may embed `{{sessionId}}` / `{{port}}` /
 * `{{workspace}}`, which the host resolves: a plugin declares shape and never
 * learns a real port or mints a session id.
 */
export type NotificationWiring =
  | {
      kind: "http-hook";
      event: "waiting";
      carrier: { workspaceWrite: WorkspaceWriteSpec };
      correlation: { field: "session_id"; source: "agent-native" };
    }
  | {
      kind: "spawned-notifier";
      event: "turn-complete";
      carrier: { args: string[] };
      payload: "json-arg";
      correlation: { source: "template"; template: string };
    };

/**
 * Pre-launch agent-CLI version probe: args, semver extraction, floor, ceiling.
 *
 * `minVersion` and `testedCeiling` must each be a bare `major.minor.patch`
 * version: never a range, never `v`-prefixed, and no prerelease or build-metadata
 * suffix. The host compares them numerically segment by segment, so anything else
 * is uncomparable. TypeScript cannot express that, so the host's Zod schema
 * enforces it and rejects the descriptor when it does not hold.
 */
export interface VersionProbeSpec {
  args: string[];
  parse: "semver";
  minVersion?: string;
  testedCeiling?: string;
}

/** How the host decides the agent is waiting on the user. */
export type WaitingDetectionSpec =
  | { kind: "hook-driven"; quiescenceFallbackMs?: number }
  | { kind: "quiescence-only"; debounceMs: number };

/** The universal permission axis every agent plugin maps to its native mechanism. */
export type AgentPosture = "read-only" | "guarded" | "auto-edit" | "full-auto";

/**
 * The user-facing permissions model (AP-FR-016, as narrowed by spike #502): the
 * fine-grained rules the host always sends, plus an optional universal posture,
 * absent whenever the project has never chosen one. Rule strings are opaque to
 * the host; only the declaring plugin interprets them.
 */
export interface AgentPermissionsModel {
  posture?: AgentPosture;
  rules: { allow: string[]; ask: string[]; deny: string[] };
}

/** How this agent realises each posture, and whether it honours rules at all. */
export interface PermissionsCapability {
  postures: Partial<
    Record<AgentPosture, { args?: string[]; workspaceWrites?: WorkspaceWriteSpec[] }>
  >;
  /** Absent means the fine-grained rules editor is hidden for this agent. */
  rules?: { carrier: "workspace-write"; resync: boolean };
}

/**
 * Optional declared capabilities. Absence is first-class: no `workspaceWrites`
 * means the host writes nothing, no `notification` means nothing is wired, no
 * `versionProbe` means no gate, no `waitingDetection` means the generic
 * quiescence debounce, no `permissions` means the host injects nothing. An agent
 * declaring none launches as a plain terminal session.
 */
export interface AgentCapabilities {
  workspaceWrites?: WorkspaceWriteSpec[];
  notification?: NotificationWiring;
  versionProbe?: VersionProbeSpec;
  waitingDetection?: WaitingDetectionSpec;
  permissions?: PermissionsCapability;
}

/**
 * What `translateLaunch` returns. `command` + `args` are the entire mandatory
 * surface; `args` is an argv array that is NEVER shell-interpreted.
 */
export interface AgentLaunchDescriptor {
  schemaVersion: 1;
  kind: "agent-launch";
  command: string;
  args: string[];
  /** Additive over the host env AFTER the host strips its internal keys. */
  env?: Record<string, string>;
  /** Defaults to the bench workspace path. */
  cwd?: string;
  initialPrompt?: { mode: "argv-positional"; maxLength?: number };
  capabilities?: AgentCapabilities;
}

/**
 * Per-launch context the host resolves before `translateLaunch` runs. The
 * `sessionId` is minted by the host (a plugin never mints one) and
 * `effectiveConfig` is the already-merged app defaults, project overrides,
 * preset, and per-launch values (AP-FR-011).
 */
export interface AgentLaunchContext {
  projectId: string;
  benchId: number;
  workspacePath: string;
  sessionId: string;
  effectiveConfig: Record<string, unknown>;
  initialPrompt?: string;
}

/**
 * The contract an agent plugin implements: one pure function mapping the
 * plugin's `config` plus the `AgentLaunchContext` to an `AgentLaunchDescriptor`
 * the host validates and executes. There is exactly one method by design; every
 * privileged action is expressed as declarative data on the descriptor.
 */
export interface DeclarativeAgentContract {
  translateLaunch: (params: {
    config: Record<string, unknown>;
    context: AgentLaunchContext;
  }) => Promise<AgentLaunchDescriptor> | AgentLaunchDescriptor;
}

export type AgentContract = DeclarativeAgentContract;

export type AgentContractMethodName = "translateLaunch";

/** Options for `defineAgentPlugin`. */
export interface DefineAgentPluginOptions {
  /**
   * The agent contract version the plugin declares. Must equal
   * `SUPPORTED_AGENT_CONTRACT_VERSION`; a mismatch is rejected synchronously at
   * definition (validation) time, never deferred to a launch.
   * Defaults to `SUPPORTED_AGENT_CONTRACT_VERSION` when omitted.
   */
  contractVersion?: number;
  /**
   * Replace the default stdio streams. Test harnesses inject paired streams;
   * production plugin code never sets this.
   */
  streams?: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  };
}

/**
 * The handle `defineAgentPlugin` returns. There is deliberately no `host`
 * client: an agent plugin is granted no component broker surface
 * (`host.process.start`/`run`/`stop`/`status`/`logs`, `host.docker.*`,
 * `host.ports.*`), only the same v1 host surface an integration plugin gets,
 * which is the mechanism by which AP-NFR-001 (no new privileges) holds.
 */
export interface AgentPluginHandle {
  /** Tear down the RPC connection. Tests use this; production plugins do not. */
  dispose(): void;
}
