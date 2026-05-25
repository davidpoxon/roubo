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
}

export interface ListIssuesParams {
  sources: ConfiguredSource[];
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
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

export type SourceCandidatesShape = "multi-list" | "categorized-multi-list";

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
  // Reserved for future pagination; v1 plugins return undefined.
  nextCursor?: string | null;
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
  listLabels?: (params: ListLabelsParams) => Promise<string[]> | string[];
  getConnectionStatus?: () => Promise<ConnectionStatus> | ConnectionStatus;
  filterFacets?: () => Promise<FilterFacet[]> | FilterFacet[];
  getFacetOptions?: (
    params: GetFacetOptionsParams,
  ) => Promise<FilterFacetOption[]> | FilterFacetOption[];
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
