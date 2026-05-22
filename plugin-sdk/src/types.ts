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
}

export interface NormalizedComment {
  externalId: string;
  author: { externalId: string; displayName: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListIssuesParams {
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
}

export interface ListIssuesResult {
  items: NormalizedIssue[];
  nextCursor: string | null;
}

export interface SourceCandidate {
  category: string;
  externalId: string;
  displayName: string;
  description?: string;
}

export interface CurrentUser {
  externalId: string;
  displayName: string;
}

export interface ValidateConfigResult {
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
  listSourceCandidates?: () => Promise<SourceCandidate[]> | SourceCandidate[];
  listIssues?: (params: ListIssuesParams) => Promise<ListIssuesResult> | ListIssuesResult;
  getIssue?: (params: { externalId: string }) => Promise<NormalizedIssue> | NormalizedIssue;
  getComments?: (params: {
    externalId: string;
  }) => Promise<NormalizedComment[]> | NormalizedComment[];
  getCurrentUser?: () => Promise<CurrentUser> | CurrentUser;
  validateConfig?: (params: {
    config: Record<string, unknown>;
  }) => Promise<ValidateConfigResult> | ValidateConfigResult;
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
  listIssueTypes?: () => Promise<IssueTypeOption[]> | IssueTypeOption[];
  listLabels?: () => Promise<string[]> | string[];
}

export type ContractMethodName = keyof PluginContract;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
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
