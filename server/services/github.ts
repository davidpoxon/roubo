import { Octokit } from "octokit";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubProject,
  GitHubProjectItem,
  ProjectIssueTypesResponse,
} from "@roubo/shared";
import { DEFAULT_GITHUB_SETTINGS } from "@roubo/shared";
import { ServiceError } from "./service-error.js";
import { classifyGitHubError, classifyGitHubErrors } from "./github-error.js";
import { loadSettings } from "./state.js";
import * as credentialStore from "./credential-store.js";
import { GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT } from "./github-oauth.js";

// ── Module-level state ──

let octokit: Octokit | null = null;

const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 60_000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL = 30_000;
const MAX_CACHE_SIZE = 100;
const issueCache = new Map<string, CacheEntry<GitHubIssue[]>>();
const projectCache = new Map<string, CacheEntry<GitHubProject[]>>();
const projectItemCache = new Map<
  string,
  CacheEntry<{ items: GitHubProjectItem[]; projectTitle: string }>
>();
const blockingCache = new Map<string, CacheEntry<BlockingRelationshipsResult>>();
const issueTypesCache = new Map<string, CacheEntry<ProjectIssueTypesResponse>>();

// ETag store: separate from TTL caches. TTL caches skip the network entirely
// within 30s; ETag caching skips data transfer on requests that miss the TTL
// window by sending If-None-Match and handling 304 Not Modified. Only GET
// requests participate in ETag caching.
interface EtagEntry {
  etag: string;
  data: unknown;
}

const MAX_ETAG_ENTRIES = 200;
const etagStore = new Map<string, EtagEntry>();

// Injectable sleep for testability — avoids fake-timer fragility with vi.resetModules()
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace the sleep implementation. Only call this in tests. */
export function __setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

// ── Cache helpers ──

function pruneCache<T>(cache: Map<string, CacheEntry<T>>): void {
  if (cache.size <= MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= CACHE_TTL) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

function pruneEtagStore(): void {
  while (etagStore.size > MAX_ETAG_ENTRIES) {
    const oldest = etagStore.keys().next().value;
    if (oldest !== undefined) etagStore.delete(oldest);
    else break;
  }
}

// ── Auth ──

let cachedToken: string | undefined;

// Reads the GitHub token from the github-com plugin's keychain slot and caches
// it in memory so the synchronous getOctokit() path stays sync. Call after
// server startup and after any plugin-OAuth exchange.
export async function refreshAuth(): Promise<void> {
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    resetOctokit();
    return;
  }
  try {
    const stored = await credentialStore.get(GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT);
    cachedToken = stored ?? undefined;
  } catch {
    // Keychain unavailable (headless Linux without secret-tool, etc.) —
    // surface as "no token" so callers get a clean 401 rather than crashing.
    cachedToken = undefined;
  }
  resetOctokit();
}

/** Returns the configured GitHub token, or undefined if not connected. */
export function getGithubToken(): string | undefined {
  // process.env.GITHUB_TOKEN always wins so tests and explicit overrides do not
  // depend on refreshAuth() having been called.
  return process.env.GITHUB_TOKEN || cachedToken;
}

function getOctokit(): Octokit {
  if (octokit) return octokit;

  const token = getGithubToken();
  if (!token) {
    throw new ServiceError(
      401,
      "GitHub is not connected. Connect your GitHub account in Settings.",
    );
  }

  octokit = new Octokit({ auth: token });
  return octokit;
}

export function resetOctokit(): void {
  octokit = null;
  issueCache.clear();
  projectCache.clear();
  projectItemCache.clear();
  blockingCache.clear();
  issueTypesCache.clear();
  etagStore.clear();
}

// Test-only seed for the in-memory token cache.
export function __setTokenForTests(token: string | undefined): void {
  cachedToken = token;
  resetOctokit();
}

function parseRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new ServiceError(400, `Invalid repo name: ${repoFullName}. Expected format: owner/repo`);
  }
  return { owner, repo };
}

// ── githubRequest helper ──

type GitHubRequestInput =
  | { kind: "rest"; route: string; params?: Record<string, unknown>; etag?: boolean }
  | { kind: "graphql"; query: string; variables?: Record<string, unknown>; opName?: string };

type GitHubRequestResult<T> =
  | { kind: "rest"; notModified: false; data: T; etag: string | undefined; status: number }
  | { kind: "rest"; notModified: true; data: T; etag: string; status: 304 }
  | { kind: "graphql"; data: T };

/** JSON.stringify with keys sorted alphabetically at every level for stable key generation. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const sorted = Object.keys(value as object)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]));
  return "{" + sorted.join(",") + "}";
}

/**
 * Builds the ETag store key for a REST request.
 * Substitutes path params into the URL template and serializes the remaining
 * query params stably so keys are consistent regardless of param insertion order.
 */
function buildEtagKey(route: string, params?: Record<string, unknown>): string {
  const spaceIdx = route.indexOf(" ");
  if (spaceIdx === -1) return route; // no method prefix — skip ETag keying
  const method = route.slice(0, spaceIdx);
  const urlTemplate = route.slice(spaceIdx + 1);

  const pathParams = new Set<string>();
  const url = urlTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
    pathParams.add(key);
    return params?.[key] !== undefined ? String(params[key]) : `{${key}}`;
  });

  const query: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!pathParams.has(k) && k !== "headers") {
      query[k] = v;
    }
  }

  return `${method} ${url}?${stableStringify(query)}`;
}

/** Duck-type guard for Octokit-style request errors (also matches plain mocked error objects). */
function isRequestError(err: unknown): err is {
  status: number;
  response?: { headers: Record<string, string | undefined> };
  message?: string;
} {
  return (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

/**
 * Returns the number of milliseconds to wait before retrying, or null if the
 * error is not a rate-limit and should be re-thrown immediately.
 */
function computeBackoffMs(err: unknown, attempt: number): number | null {
  if (!isRequestError(err)) return null;

  const { status } = err;
  const headers = err.response?.headers ?? {};
  const message = err.message ?? "";

  const exponential = (): number =>
    Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, attempt) + Math.random() * 250);

  if (status === 429) {
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) return Math.min(parsed * 1000, MAX_BACKOFF_MS);
    }
    return exponential();
  }

  if (status === 403) {
    // Primary rate limit: GitHub signals remaining=0 + reset time
    if (headers["x-ratelimit-remaining"] === "0") {
      const reset = headers["x-ratelimit-reset"];
      if (reset) {
        const waitMs = parseInt(reset, 10) * 1000 - Date.now();
        return Math.min(Math.max(waitMs, 0), MAX_BACKOFF_MS);
      }
      return exponential();
    }
    // Secondary rate limit: detected via message
    if (/secondary rate limit|abuse/i.test(message)) {
      const retryAfter = headers["retry-after"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) return Math.min(parsed * 1000, MAX_BACKOFF_MS);
      }
      return exponential();
    }
  }

  return null;
}

/**
 * Central GitHub API helper. Handles auth (via getOctokit), rate-limit backoff
 * with retry, and ETag/If-None-Match caching for GET requests.
 *
 * REST requests use raw octokit.request() for a uniform response envelope
 * (data, headers, status). GraphQL requests use octokit.graphql(); they inherit
 * auth and backoff but do not participate in ETag caching.
 *
 * On 304 Not Modified, returns { notModified: true, data } where data is the
 * previously-cached response body. Callers can inspect notModified to skip
 * downstream work (useful for Phase 2 PR sync); existing callers simply use .data.
 */
async function githubRequest<T>(input: GitHubRequestInput): Promise<GitHubRequestResult<T>> {
  const client = getOctokit();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (input.kind === "graphql") {
        const data = await client.graphql<T>(input.query, input.variables ?? {});
        return { kind: "graphql", data };
      }

      // REST: use raw request() for uniform headers/status access
      const spaceIdx = input.route.indexOf(" ");
      const method = input.route.slice(0, spaceIdx);
      const useEtag = (input.etag ?? true) && method === "GET";
      const key = useEtag ? buildEtagKey(input.route, input.params) : undefined;
      const cached = key !== undefined ? etagStore.get(key) : undefined;

      const headers: Record<string, string> = {};
      if (cached) headers["if-none-match"] = cached.etag;

      let res;
      try {
        res = await client.request(input.route, { ...input.params, headers });
      } catch (innerErr) {
        // Octokit throws RequestError on 304 — return cached data with sentinel
        if (isRequestError(innerErr) && innerErr.status === 304) {
          if (cached) {
            return {
              kind: "rest",
              notModified: true,
              data: cached.data as T,
              etag: cached.etag,
              status: 304,
            };
          }
          // 304 with no cached data — cache was cleared between request dispatch and
          // response receipt (e.g., concurrent resetOctokit call). Throw a clear error
          // rather than propagating the raw 304 object to callers.
          throw new Error("[github] Unexpected 304 Not Modified with no cached ETag data", {
            cause: innerErr,
          });
        }
        throw innerErr;
      }

      // Some Octokit plugin configurations may surface 304 as a normal response
      if (res.status === 304) {
        if (cached) {
          return {
            kind: "rest",
            notModified: true,
            data: cached.data as T,
            etag: cached.etag,
            status: 304,
          };
        }
        throw new Error("[github] Unexpected 304 Not Modified with no cached ETag data");
      }

      const etag = res.headers?.etag as string | undefined;
      if (useEtag && key !== undefined && etag) {
        etagStore.set(key, { etag, data: res.data });
        pruneEtagStore();
      }

      return { kind: "rest", notModified: false, data: res.data as T, etag, status: res.status };
    } catch (err) {
      const wait = computeBackoffMs(err, attempt);
      if (wait === null || attempt >= MAX_RETRIES) throw err;
      await sleepImpl(wait);
    }
  }

  // Unreachable: the loop always returns or throws before exhausting iterations.
  throw new Error("[github] githubRequest: internal error");
}

// ── Public fetchers ──

export async function fetchIssues(
  repoFullName: string,
  options?: { labels?: string; search?: string },
): Promise<GitHubIssue[]> {
  const cacheKey = `${repoFullName}:${options?.labels ?? ""}:${options?.search ?? ""}`;
  const cached = issueCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const { owner, repo } = parseRepo(repoFullName);

  let issues: GitHubIssue[];

  if (options?.search) {
    const q = `repo:${repoFullName} is:issue is:open ${options.search}`;
    const result = await githubRequest<SearchIssuesResult>({
      kind: "rest",
      route: "GET /search/issues",
      params: { q, per_page: 50, sort: "updated", order: "desc" },
    });
    issues = result.data.items.filter((item) => !item.pull_request).map(mapIssue);
  } else {
    const params: Record<string, unknown> = {
      owner,
      repo,
      state: "open",
      per_page: 50,
      sort: "updated",
      direction: "desc",
    };
    if (options?.labels) {
      params.labels = options.labels;
    }
    const result = await githubRequest<RawIssue[]>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params,
    });
    issues = result.data.filter((item) => !item.pull_request).map(mapIssue);
  }

  issueCache.set(cacheKey, { data: issues, timestamp: Date.now() });
  pruneCache(issueCache);
  return issues;
}

export async function fetchIssueDetail(
  repoFullName: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const { owner, repo } = parseRepo(repoFullName);

  const result = await githubRequest<RawIssue>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
    params: { owner, repo, issue_number: issueNumber },
  });

  return mapIssue(result.data);
}

export async function fetchIssueComments(
  repoFullName: string,
  issueNumber: number,
): Promise<GitHubIssueComment[]> {
  const { owner, repo } = parseRepo(repoFullName);

  const result = await githubRequest<RawComment[]>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    params: { owner, repo, issue_number: issueNumber, per_page: 100 },
  });

  return result.data.map((comment) => ({
    id: comment.id,
    body: comment.body ?? "",
    user: comment.user?.login ?? "unknown",
    createdAt: comment.created_at,
  }));
}

export async function fetchLabels(repoFullName: string): Promise<string[]> {
  const { owner, repo } = parseRepo(repoFullName);

  const result = await githubRequest<Array<{ name: string }>>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/labels",
    params: { owner, repo, per_page: 100 },
  });

  return result.data.map((l) => l.name);
}

// ── Blocking relationships ──

interface BlockedByNode {
  number: number;
  title: string;
  state: string;
  blockedBy?: {
    nodes: BlockedByNode[];
  };
}

interface BlockingRelationshipsResponse {
  repository: Record<
    string,
    | {
        blockedBy: { nodes: BlockedByNode[] };
        blocking: { nodes: Array<{ state: string }>; pageInfo: { hasNextPage: boolean } };
      }
    | null
    | undefined
  >;
}

export interface BlockingRelationshipsResult {
  blockedBy: Record<number, Array<{ number: number; title: string }>>;
  blockingCount: Record<number, number>;
}

const BLOCKING_BATCH_SIZE = 20;

function flattenBlockers(
  nodes: BlockedByNode[],
  depth: number,
  seen: Set<number>,
): Array<{ number: number; title: string }> {
  if (depth === 0) return [];
  const result: Array<{ number: number; title: string }> = [];
  for (const node of nodes) {
    if (node.state !== "OPEN" || seen.has(node.number)) continue;
    seen.add(node.number);
    result.push({ number: node.number, title: node.title });
    if (node.blockedBy?.nodes) {
      result.push(...flattenBlockers(node.blockedBy.nodes, depth - 1, seen));
    }
  }
  return result;
}

function buildBlockingQuery(issueNumbers: number[]): string {
  const issueAliases = issueNumbers
    .map(
      (n) => `
    issue_${n}: issue(number: ${n}) {
      blockedBy(first: 10) {
        nodes {
          ... on Issue {
            number title state
            blockedBy(first: 10) {
              nodes {
                ... on Issue {
                  number title state
                  blockedBy(first: 10) {
                    nodes {
                      ... on Issue { number title state }
                    }
                  }
                }
              }
            }
          }
        }
      }
      blocking(first: 100) {
        nodes {
          ... on Issue { state }
        }
        pageInfo { hasNextPage }
      }
    }`,
    )
    .join("");

  return `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {${issueAliases}
    }
  }`;
}

export async function fetchBlockingRelationships(
  repoFullName: string,
  issueNumbers: number[],
): Promise<BlockingRelationshipsResult> {
  if (issueNumbers.length === 0) return { blockedBy: {}, blockingCount: {} };

  const sortedNumbers = [...issueNumbers].sort((a, b) => a - b);
  const cacheKey = `${repoFullName}:${sortedNumbers.join(",")}`;
  const cached = blockingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const { owner, repo } = parseRepo(repoFullName);
  const blockedBy: Record<number, Array<{ number: number; title: string }>> = {};
  const blockingCount: Record<number, number> = {};

  try {
    // Process in batches to stay within GraphQL query complexity limits
    for (let i = 0; i < sortedNumbers.length; i += BLOCKING_BATCH_SIZE) {
      const batch = sortedNumbers.slice(i, i + BLOCKING_BATCH_SIZE);
      const query = buildBlockingQuery(batch);
      const result = await githubRequest<BlockingRelationshipsResponse>({
        kind: "graphql",
        query,
        variables: { owner, repo },
        opName: "blockingRelationships",
      });
      for (const issueNumber of batch) {
        const issueData = result.data.repository[`issue_${issueNumber}`];
        if (!issueData) {
          blockedBy[issueNumber] = [];
          blockingCount[issueNumber] = 0;
          continue;
        }
        blockedBy[issueNumber] = flattenBlockers(issueData.blockedBy.nodes, 3, new Set());
        blockingCount[issueNumber] = issueData.blocking.nodes.filter(
          (n) => n.state === "OPEN",
        ).length;
        if (issueData.blocking.pageInfo.hasNextPage) {
          console.warn(
            `[github] issue #${issueNumber} blocks more than 100 issues; count is truncated`,
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      "[github] fetchBlockingRelationships failed, returning empty results:",
      (err as Error).message,
    );
    for (const n of sortedNumbers) {
      if (!blockedBy[n]) blockedBy[n] = [];
      if (blockingCount[n] === undefined) blockingCount[n] = 0;
    }
  }

  const result: BlockingRelationshipsResult = { blockedBy, blockingCount };
  blockingCache.set(cacheKey, { data: result, timestamp: Date.now() });
  pruneCache(blockingCache);
  return result;
}

// ── Linked Pull Requests ──

// Note: CrossReferencedEvent captures PRs that mention an issue in their body (e.g. "Closes #N").
// It does NOT capture PRs linked via GitHub's UI sidebar (DevelopmentEvent/ConnectedEvent).
// first: 25 is sufficient for typical issues; silent truncation is acceptable for this best-effort seed.
const linkedPRsQuery = `query linkedPullRequests($owner: String!, $repo: String!, $issueNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issueNumber) {
      timelineItems(first: 25, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest {
                number
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    }
  }
}`;

interface LinkedPRsResponse {
  repository: {
    issue: {
      timelineItems: {
        nodes: Array<{
          source?: {
            number?: number;
            repository?: { nameWithOwner: string };
          };
        }>;
      };
    };
  };
}

export async function fetchLinkedPullRequests(
  repoFullName: string,
  issueNumber: number,
): Promise<Array<{ repoFullName: string; number: number }>> {
  try {
    const { owner, repo } = parseRepo(repoFullName);
    const result = await githubRequest<LinkedPRsResponse>({
      kind: "graphql",
      query: linkedPRsQuery,
      variables: { owner, repo, issueNumber },
      opName: "linkedPullRequests",
    });

    const nodes = result.data.repository?.issue?.timelineItems?.nodes ?? [];
    const seen = new Set<string>();
    const prs: Array<{ repoFullName: string; number: number }> = [];
    for (const node of nodes) {
      const source = node.source;
      if (!source || source.number === undefined || !source.repository) continue;
      const key = `${source.repository.nameWithOwner}:${source.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        prs.push({ repoFullName: source.repository.nameWithOwner, number: source.number });
      }
    }
    return prs;
  } catch (err) {
    console.warn(
      "[github] fetchLinkedPullRequests failed, returning empty results:",
      (err as Error).message,
    );
    return [];
  }
}

// ── GitHub Projects v2 ──

interface ProjectsResponse {
  organization?: { projectsV2: { nodes: Array<{ number: number; title: string }> } };
  user?: { projectsV2: { nodes: Array<{ number: number; title: string }> } };
}

export async function fetchProjects(repoFullName: string): Promise<GitHubProject[]> {
  const { owner } = parseRepo(repoFullName);

  const cached = projectCache.get(owner);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const query = `query($owner: String!) {
    organization(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { number title }
      }
    }
  }`;

  const userQuery = `query($owner: String!) {
    user(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { number title }
      }
    }
  }`;

  let projects: GitHubProject[];

  try {
    const result = await githubRequest<ProjectsResponse>({
      kind: "graphql",
      query,
      variables: { owner },
    });
    projects = (result.data.organization?.projectsV2.nodes ?? []).map((n) => ({
      number: n.number,
      title: n.title,
    }));
  } catch (err) {
    try {
      const result = await githubRequest<ProjectsResponse>({
        kind: "graphql",
        query: userQuery,
        variables: { owner },
      });
      projects = (result.data.user?.projectsV2.nodes ?? []).map((n) => ({
        number: n.number,
        title: n.title,
      }));
    } catch (userErr) {
      throw classifyGitHubErrors(err, userErr, { owner });
    }
  }

  projectCache.set(owner, { data: projects, timestamp: Date.now() });
  pruneCache(projectCache);
  return projects;
}

// ── GitHub Projects v2 item listing ──

interface ProjectItemsResponse {
  organization?: { projectV2: ProjectV2Data };
  user?: { projectV2: ProjectV2Data };
}

interface ProjectV2Data {
  title: string;
  items: {
    nodes: Array<{
      content: {
        __typename?: string;
        number?: number;
        title?: string;
        body?: string | null;
        state?: string;
        labels?: { nodes: Array<{ name: string }> };
        assignees?: { nodes: Array<{ login: string }> };
        milestone?: { title: string } | null;
        issueType?: { name: string } | null;
        createdAt?: string;
        updatedAt?: string;
        comments?: { totalCount: number };
        url?: string;
      } | null;
      fieldValueByName: { name: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const projectItemsQuery = `query($owner: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      title
      items(first: 50, after: $cursor) {
        nodes {
          content {
            __typename
            ... on Issue {
              number title body state
              labels(first: 20) { nodes { name } }
              assignees(first: 5) { nodes { login } }
              milestone { title }
              issueType { name }
              createdAt updatedAt
              comments { totalCount }
              url
            }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const projectItemsUserQuery = `query($owner: String!, $projectNumber: Int!, $cursor: String) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      title
      items(first: 50, after: $cursor) {
        nodes {
          content {
            __typename
            ... on Issue {
              number title body state
              labels(first: 20) { nodes { name } }
              assignees(first: 5) { nodes { login } }
              milestone { title }
              issueType { name }
              createdAt updatedAt
              comments { totalCount }
              url
            }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function mapProjectNode(
  node: ProjectV2Data["items"]["nodes"][number],
  repoFullName: string,
): GitHubProjectItem | null {
  const content = node.content;
  // content.__typename is 'Issue', 'PullRequest', or 'DraftIssue'
  // If __typename is not returned (some GraphQL setups omit it), fall back to checking for number
  if (!content || !content.number) return null;
  if (content.__typename && content.__typename !== "Issue") return null;

  const issue: GitHubIssue = {
    number: content.number,
    title: content.title ?? "",
    body: content.body ?? null,
    state: (content.state ?? "open").toLowerCase(),
    labels: (content.labels?.nodes ?? []).map((l) => l.name),
    assignee: content.assignees?.nodes?.[0]?.login,
    milestone: content.milestone?.title,
    // issueType requires the GitHub Issues Types feature (available on Teams/Enterprise or when enabled on the org).
    // If the field is absent from the schema, the GraphQL query will fail entirely for that user.
    type: content.issueType?.name,
    createdAt: content.createdAt ?? "",
    updatedAt: content.updatedAt ?? "",
    commentsCount: content.comments?.totalCount ?? 0,
    htmlUrl: content.url ?? `https://github.com/${repoFullName}/issues/${content.number}`,
  };

  return {
    issue,
    status: node.fieldValueByName?.name,
  };
}

export async function fetchProjectItems(
  repoFullName: string,
  projectNumber: number,
): Promise<{ items: GitHubProjectItem[]; projectTitle: string }> {
  const cacheKey = `${repoFullName}:${projectNumber}`;
  const cached = projectItemCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const { owner } = parseRepo(repoFullName);

  const MAX_PAGES = 10;
  const allNodes: ProjectV2Data["items"]["nodes"] = [];
  let projectTitle = "";
  let cursor: string | null = null;
  let useOrgQuery: boolean | null = null;
  let lastPageHadMore = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let projectData: ProjectV2Data;

    if (useOrgQuery === null) {
      // First page: determine whether org or user query works
      try {
        const result = await githubRequest<ProjectItemsResponse>({
          kind: "graphql",
          query: projectItemsQuery,
          variables: { owner, projectNumber, cursor },
        });
        projectData = (
          result.data.organization as NonNullable<ProjectItemsResponse["organization"]>
        ).projectV2;
        useOrgQuery = true;
      } catch (orgErr) {
        try {
          const result = await githubRequest<ProjectItemsResponse>({
            kind: "graphql",
            query: projectItemsUserQuery,
            variables: { owner, projectNumber, cursor },
          });
          projectData = (result.data.user as NonNullable<ProjectItemsResponse["user"]>).projectV2;
          useOrgQuery = false;
        } catch (userErr) {
          throw classifyGitHubErrors(orgErr, userErr, { owner });
        }
      }
    } else {
      const query = useOrgQuery ? projectItemsQuery : projectItemsUserQuery;
      const result = await githubRequest<ProjectItemsResponse>({
        kind: "graphql",
        query,
        variables: { owner, projectNumber, cursor },
      });
      projectData = useOrgQuery
        ? (result.data.organization as NonNullable<ProjectItemsResponse["organization"]>).projectV2
        : (result.data.user as NonNullable<ProjectItemsResponse["user"]>).projectV2;
    }

    projectTitle = projectData.title;
    allNodes.push(...projectData.items.nodes);

    lastPageHadMore = projectData.items.pageInfo.hasNextPage;
    if (!lastPageHadMore) break;
    cursor = projectData.items.pageInfo.endCursor;
  }

  if (lastPageHadMore) {
    console.warn(
      `[github] fetchProjectItems for ${repoFullName} project #${projectNumber}: ` +
        `hit pagination limit of ${MAX_PAGES} pages; some items may be missing`,
    );
  }

  const items = allNodes
    .map((node) => mapProjectNode(node, repoFullName))
    .filter((item): item is GitHubProjectItem => item !== null)
    .filter((item) => item.issue.state === "open");

  const data = { items, projectTitle };
  projectItemCache.set(cacheKey, { data, timestamp: Date.now() });
  pruneCache(projectItemCache);
  return data;
}

// ── GitHub issue types ──

interface IssueTypeNode {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  isEnabled: boolean;
}

interface IssueTypesResponse {
  repository?: {
    issueTypes?: {
      nodes: IssueTypeNode[];
      pageInfo: { hasNextPage: boolean };
    } | null;
  } | null;
}

const ISSUE_TYPES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 50) {
      nodes { id name description color isEnabled }
      pageInfo { hasNextPage }
    }
  }
}`;

function resolveIssueTypesTtlMs(): number {
  const settings = loadSettings();
  const seconds =
    settings.github?.issueTypesCacheTtlSeconds ?? DEFAULT_GITHUB_SETTINGS.issueTypesCacheTtlSeconds;
  return seconds * 1000;
}

export async function fetchIssueTypes(repoFullName: string): Promise<ProjectIssueTypesResponse> {
  const cached = issueTypesCache.get(repoFullName);
  if (cached) {
    const ttlMs = resolveIssueTypesTtlMs();
    if (ttlMs > 0 && Date.now() - cached.timestamp < ttlMs) return cached.data;
  }

  const { owner, repo } = parseRepo(repoFullName);

  let nodes: IssueTypeNode[];
  try {
    const r = await githubRequest<IssueTypesResponse>({
      kind: "graphql",
      query: ISSUE_TYPES_QUERY,
      variables: { owner, name: repo },
      opName: "fetchIssueTypes",
    });
    const issueTypes = r.data.repository?.issueTypes;
    nodes = issueTypes?.nodes ?? [];
    if (issueTypes?.pageInfo.hasNextPage) {
      console.warn(
        `[roubo] fetchIssueTypes: ${repoFullName} has more than 50 issue types; only the first 50 were fetched`,
      );
    }
  } catch (err) {
    throw classifyGitHubError(err, { owner });
  }

  const enabled = nodes.filter((n) => n.isEnabled);

  let result: ProjectIssueTypesResponse;
  if (enabled.length === 0) {
    result = { configured: false, reason: "none-defined", types: [] };
  } else {
    result = {
      configured: true,
      types: enabled.map((n) => ({
        id: n.id,
        name: n.name,
        ...(n.description != null ? { description: n.description } : {}),
        ...(n.color != null ? { color: n.color } : {}),
      })),
    };
  }

  issueTypesCache.set(repoFullName, { data: result, timestamp: Date.now() });
  pruneCache(issueTypesCache);
  return result;
}

interface IssueTypeResponse {
  repository?: {
    issue?: {
      issueType?: { name: string } | null;
    } | null;
  } | null;
}

export async function fetchIssueType(
  repoFullName: string,
  issueNumber: number,
): Promise<string | null> {
  const { owner, repo } = parseRepo(repoFullName);
  const query = `query($owner: String!, $repo: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        issueType { name }
      }
    }
  }`;
  try {
    const r = await githubRequest<IssueTypeResponse>({
      kind: "graphql",
      query,
      variables: { owner, repo, issueNumber },
      opName: "fetchIssueType",
    });
    return r.data.repository?.issue?.issueType?.name ?? null;
  } catch (err) {
    console.warn(`[github] Failed to fetch issue type for #${issueNumber}:`, err);
    return null;
  }
}

// ── PR fetch functions ──

interface MappedPR {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  url: string;
  updatedAt: string;
}

/**
 * Fetches the first open PR on `repoFullName` whose head branch matches `branch`.
 * Uses ETag-based conditional requests — on 304 Not Modified, returns `notModified: true`
 * and the previously cached PR (or null). This lets callers skip state writes when
 * nothing has changed since the last tick.
 */
export async function fetchOpenPullRequestByBranch(
  repoFullName: string,
  branch: string,
): Promise<{ notModified: boolean; pr: MappedPR | null }> {
  const { owner, repo } = parseRepo(repoFullName);

  const result = await githubRequest<RawPR[]>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/pulls",
    params: { owner, repo, head: `${owner}:${branch}`, state: "open", per_page: 1 },
  });

  if ("notModified" in result && result.notModified) {
    return { notModified: true, pr: result.data.length > 0 ? mapPR(result.data[0]) : null };
  }

  return { notModified: false, pr: result.data.length > 0 ? mapPR(result.data[0]) : null };
}

/**
 * Fetches a single PR by number, regardless of state. Used to detect closed/merged
 * transitions when a previously-tracked PR no longer appears in the open-PR list.
 */
export async function fetchPullRequestDetail(
  repoFullName: string,
  prNumber: number,
): Promise<MappedPR> {
  const { owner, repo } = parseRepo(repoFullName);

  const result = await githubRequest<RawPR>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    params: { owner, repo, pull_number: prNumber },
  });

  return mapPR(result.data);
}

// ── Internal types and mappers ──

interface RawPR {
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  html_url: string;
  updated_at: string;
}

function mapPR(pr: RawPR): MappedPR {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state === "open" ? "open" : "closed",
    merged: pr.merged ?? false,
    url: pr.html_url,
    updatedAt: pr.updated_at,
  };
}

interface SearchIssuesResult {
  total_count?: number;
  incomplete_results?: boolean;
  items: RawIssue[];
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  labels?: Array<{ name?: string } | string>;
  assignee?: { login: string } | null;
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  html_url: string;
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  body?: string | null;
  user?: { login: string } | null;
  created_at: string;
}

function mapIssue(item: RawIssue): GitHubIssue {
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? null,
    state: item.state ?? "open",
    labels: (item.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
    assignee: item.assignee?.login,
    milestone: item.milestone?.title,
    // type is not available via the REST API — it is a GitHub Projects v2 concept only
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    commentsCount: item.comments ?? 0,
    htmlUrl: item.html_url,
  };
}
