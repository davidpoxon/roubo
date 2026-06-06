import { host } from "@roubo/plugin-sdk";
import type {
  ConfiguredSource,
  ConnectionStatus,
  CurrentUser,
  FilterFacet,
  FilterFacetOption,
  GetFacetOptionsParams,
  GetSourceOptionsParams,
  ListIssuesParams,
  ListIssuesResult,
  NormalizedComment,
  NormalizedIssue,
  PluginContract,
  SearchableSourceCategory,
  SetActiveConfigResult,
  SourceCandidatesResponse,
  SourceOptionsResult,
  ValidateConfigResult,
} from "@roubo/plugin-sdk";
import { parseFormConfig, parseIntegrationConfig, type JiraPluginConfig } from "./config.js";
import {
  jiraFetch,
  JiraApiError,
  isStatusCategoryUnsupportedError,
  type JiraRequestContext,
} from "./jira-client.js";
import { assertProjectKey, buildIssueListJql, type SourceClause, type SourceKind } from "./jql.js";
import { resolveBoardClause } from "./board-resolve.js";
import {
  normalizeComment,
  normalizeIssue,
  type JiraCommentResponse,
  type JiraIssueResponse,
} from "./normalize.js";
import { fetchEpicIssues } from "./source-picker.js";
import { getSourceOptions as runGetSourceOptions } from "./source-options.js";
import { applyTransition as runApplyTransition } from "./transitions.js";
import { assignIssue as runAssignIssue, unassignIssue as runUnassignIssue } from "./assignment.js";
import { getLastPoll, setLastPoll, _resetCacheForTests } from "./state-store.js";

/**
 * The declarative source-picker categories the Jira plugin exposes. Items are
 * never shipped inline; the host loads each category lazily via
 * `getSourceOptions`. Board / filter / epic are gated behind a project scope
 * (project-first cascade); "assigned to me" offers in-project vs anywhere modes.
 */
const SEARCHABLE_CATEGORIES: SearchableSourceCategory[] = [
  { id: "project", label: "Projects", icon: "project" },
  { id: "board", label: "Boards", icon: "board", scopedBy: "project" },
  { id: "filter", label: "Filters", icon: "filter", scopedBy: "project" },
  { id: "epic", label: "Epics", icon: "epic", scopedBy: "project" },
  {
    id: "mine",
    label: "Assigned to me",
    options: [
      { id: "in-project", label: "In scoped projects" },
      { id: "anywhere", label: "Anywhere" },
    ],
  },
];

/**
 * Build the plugin contract object. Kept as a factory so tests can
 * instantiate a fresh contract per case with a fresh in-process config
 * cache, and so `index.ts` stays a thin bootstrap.
 *
 * The host invokes `listSourceCandidates`, `getCurrentUser`,
 * `listLabels`, and `listIssueTypes` with `{ config }` in the live
 * codebase, but the SDK's `PluginContract` still declares them as
 * no-arg. We cast through `unknown` at the return site so we can accept
 * `params: unknown` at runtime; remove the cast once the SDK type is
 * widened (tracked separately).
 *
 * Source selection for `listIssues` arrives inline on `params.sources`
 * (a flat `ConfiguredSource[]`), matching the `github-com` / `ghe`
 * pattern. The in-process cache only holds plugin-wide config (instance
 * URL, link-type names), which the host primes via `setActiveConfig`
 * before each source-bound call.
 */
export function createPluginContract(): PluginContract {
  // Plugin-wide config (instance URL, link-type names) cached so the host
  // doesn't have to round-trip `setActiveConfig` on every call.
  // `setActiveConfig` is the canonical writer; `validateConfig` and
  // `listSourceCandidates` also populate it because the host already has
  // the config in those code paths.
  let cachedConfig: JiraPluginConfig | null = null;

  async function ctxFor(config: JiraPluginConfig): Promise<JiraRequestContext> {
    const pat = await host.credentials.get("pat");
    if (pat === null || pat.length === 0) {
      throw new Error("Jira PAT is not configured. Open the Configure dialog and Test connection.");
    }
    return { instance: config.instance, pat, allowSelfSignedTls: config.allowSelfSignedTls };
  }

  function adoptFromIntegration(raw: Record<string, unknown>): JiraPluginConfig {
    const parsed = parseIntegrationConfig(raw);
    if (!parsed.ok) {
      const first = parsed.errors[0];
      throw new Error(`Invalid Jira plugin config (${first.field}): ${first.message}`);
    }
    cachedConfig = parsed.config;
    return parsed.config;
  }

  async function adoptOrRecallConfig(params: unknown): Promise<JiraPluginConfig> {
    // Only adopt a fresh config when params.config carries a full
    // IntegrationConfig (has an `instance`). The host omits config on
    // most per-issue calls, in which case we read from the cache;
    // it also sends partial { sources: ... } payloads from tests / future
    // hosts which mustn't clobber the cached connection details.
    if (
      isRecord(params) &&
      isRecord(params.config) &&
      typeof params.config.instance === "string" &&
      params.config.instance.length > 0
    ) {
      return adoptFromIntegration(params.config);
    }
    if (cachedConfig !== null) return cachedConfig;
    throw new Error(
      "Jira plugin has no active config. Call validateConfig or listSourceCandidates first.",
    );
  }

  const contract = {
    async validateConfig({
      config,
    }: {
      config: Record<string, unknown>;
    }): Promise<ValidateConfigResult> {
      const parsed = parseFormConfig(config);
      if (!parsed.ok) {
        return { ok: false, errors: parsed.errors };
      }
      cachedConfig = parsed.config;
      try {
        const pat = await host.credentials.get("pat");
        if (pat === null || pat.length === 0) {
          return {
            ok: false,
            errors: [{ field: "pat", message: "Personal access token is required." }],
          };
        }
        await jiraFetch(
          {
            instance: parsed.config.instance,
            pat,
            allowSelfSignedTls: parsed.config.allowSelfSignedTls,
          },
          "/rest/api/2/myself",
        );
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, errors: [{ message }] };
      }
    },

    /**
     * Receive the plugin-wide config (instance URL, link-type names) from
     * the host. Called before every source-bound RPC by
     * `server/services/plugin-activation.ts#ensurePluginActivated`, so the
     * cache survives plugin process restarts without the user having to
     * re-open Configure.
     *
     * The host sends a flat shape here: `buildPluginConfig` flattens the
     * IntegrationConfig's `advanced.*` onto the top level before invoking
     * setActiveConfig, so we parse with `parseFormConfig` (top-level
     * lookup), not `parseIntegrationConfig` (which expects `advanced.*`).
     *
     * Per-project source selection is supplied per-call on
     * `ListIssuesParams.sources` and is never stored here.
     */
    setActiveConfig({ config }: { config: Record<string, unknown> }): SetActiveConfigResult {
      const parsed = parseFormConfig(config);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      cachedConfig = parsed.config;
      return { ok: true };
    },

    /**
     * Report plugin-level connectivity for the connection-status chips
     * (FR-052). The host primes `setActiveConfig` with the instance URL before
     * calling this on a cold process, so the cached config is available here.
     * Probes `/rest/api/2/myself` once and maps the result to the four-state
     * model: 401/403 -> auth-problem, transport/5xx -> errored, otherwise
     * connected (surfacing the resolved login). The host caches the result for
     * 30s, so this method does no caching of its own.
     */
    async getConnectionStatus(): Promise<ConnectionStatus> {
      const checkedAt = new Date().toISOString();
      if (cachedConfig === null) {
        return {
          state: "disconnected",
          detail: "Jira instance is not configured yet.",
          checkedAt,
        };
      }
      const pat = await host.credentials.get("pat");
      if (pat === null || pat.length === 0) {
        return {
          state: "auth-problem",
          detail: "Jira personal access token is not set.",
          checkedAt,
        };
      }
      try {
        const me = await jiraFetch<{ key?: string; name?: string; displayName?: string }>(
          {
            instance: cachedConfig.instance,
            pat,
            allowSelfSignedTls: cachedConfig.allowSelfSignedTls,
          },
          "/rest/api/2/myself",
        );
        const login = me.name ?? me.key;
        return {
          state: "connected",
          checkedAt,
          ...(login ? { account: { login } } : {}),
        };
      } catch (err) {
        if (err instanceof JiraApiError && (err.status === 401 || err.status === 403)) {
          return {
            state: "auth-problem",
            detail: "Jira rejected the personal access token (401/403).",
            checkedAt,
          };
        }
        const detail = err instanceof Error ? err.message : String(err);
        return { state: "errored", detail, checkedAt };
      }
    },

    async getCurrentUser(params: unknown): Promise<CurrentUser> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const me = await jiraFetch<{
        accountId?: string;
        key?: string;
        name?: string;
        displayName?: string;
      }>(ctx, "/rest/api/2/myself");
      return {
        externalId: me.accountId ?? me.key ?? me.name ?? "",
        displayName: me.displayName ?? me.name ?? "Unknown",
      };
    },

    async listSourceCandidates(params: unknown): Promise<SourceCandidatesResponse> {
      // The Jira picker is the declarative `searchable-categorized` shape: no
      // items are loaded here (no instance-wide board / epic / filter scan).
      // The host renders one type-ahead per category and fetches matches lazily
      // through `getSourceOptions`. We still adopt config so later source-bound
      // calls can recall the connection details, but make no Jira request.
      await adoptOrRecallConfig(params);
      return { shape: "searchable-categorized", searchableCategories: SEARCHABLE_CATEGORIES };
    },

    async getSourceOptions(
      params: GetSourceOptionsParams & { config?: Record<string, unknown> },
    ): Promise<SourceOptionsResult> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      return runGetSourceOptions(ctx, params);
    },

    async listIssues(params: ListIssuesParams): Promise<ListIssuesResult> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);

      const sources = await prepareSourceClauses(ctx, params.sources);
      const sourceKey = sourcesCacheKey(sources);
      const lastPoll = await getLastPoll(sourceKey);

      const startAt = parseCursor(params.cursor);
      const pageSize = params.pageSize ?? 50;

      const buildJql = (statusCategorySupported: boolean): string =>
        buildIssueListJql({
          sources,
          lastPollIso: lastPoll,
          excludedStatusCategories: params.excludedStatusCategories,
          excludedStatuses: params.excludedStatuses,
          statusCategorySupported,
        });

      const search = await searchWithExclusionFallback(ctx, config.instance, buildJql, {
        startAt,
        pageSize,
      });

      const items = (search.issues ?? []).map((i) => normalizeIssue(config, i, config.instance));

      const total = typeof search.total === "number" ? search.total : items.length;
      const consumed = startAt + items.length;
      const nextCursor = consumed < total ? String(consumed) : null;

      // Only advance the watermark once pagination is exhausted. Writing it
      // after every page would change the JQL between pages, so a `startAt`
      // offset into the narrower next-page result set silently skips issues
      // whose `updated` falls between the original watermark and the
      // current page's highest `updated`. See TC-030.
      if (nextCursor === null) {
        const highest = items.reduce<string | null>((max, item) => {
          if (max === null || item.updatedAt > max) return item.updatedAt;
          return max;
        }, lastPoll);
        if (highest !== null && highest !== lastPoll) {
          await setLastPoll(sourceKey, highest);
        }
      }

      return { items, nextCursor };
    },

    async getIssue(params: {
      externalId: string;
      config?: Record<string, unknown>;
    }): Promise<NormalizedIssue> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const issue = await jiraFetch<JiraIssueResponse>(
        ctx,
        `/rest/api/2/issue/${encodeURIComponent(params.externalId)}`,
        { query: { expand: "transitions" } },
      );
      return normalizeIssue(config, issue, config.instance);
    },

    async getComments(params: {
      externalId: string;
      config?: Record<string, unknown>;
    }): Promise<NormalizedComment[]> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const data = await jiraFetch<{ comments?: JiraCommentResponse[] }>(
        ctx,
        `/rest/api/2/issue/${encodeURIComponent(params.externalId)}/comment`,
      );
      return (data.comments ?? []).map(normalizeComment);
    },

    async getAvailableTransitions(params: {
      externalId: string;
      config?: Record<string, unknown>;
    }): Promise<string[]> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const data = await jiraFetch<{ transitions?: Array<{ name?: string }> }>(
        ctx,
        `/rest/api/2/issue/${encodeURIComponent(params.externalId)}/transitions`,
      );
      return (data.transitions ?? [])
        .map((t) => t.name?.trim())
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    },

    async applyTransition(params: {
      externalId: string;
      transition?: string;
      transitionName?: string;
      config?: Record<string, unknown>;
    }): Promise<void> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      // The host's bench-view route sends `transitionName`; the SDK type
      // exposes `transition`. Accept both for forward-compatibility.
      const widened = params as {
        externalId: string;
        transition?: string;
        transitionName?: string;
      };
      const name = widened.transition ?? widened.transitionName ?? "";
      if (name.length === 0) {
        throw new JiraApiError("No transition name supplied.", 400, "");
      }
      await runApplyTransition(ctx, params.externalId, name);
    },

    async assignIssue(params: {
      externalId: string;
      assigneeExternalId: string;
      config?: Record<string, unknown>;
    }): Promise<void> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      await runAssignIssue(ctx, params.externalId, params.assigneeExternalId);
    },

    async unassignIssue(params: {
      externalId: string;
      assigneeExternalId: string;
      config?: Record<string, unknown>;
    }): Promise<void> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      await runUnassignIssue(ctx, params.externalId);
    },

    async listLabels(params: unknown): Promise<string[]> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const data = await jiraFetch<{ values?: string[] } | string[]>(ctx, "/rest/api/2/label");
      if (Array.isArray(data)) return data;
      return Array.isArray(data.values) ? data.values : [];
    },

    async listIssueTypes(params: unknown): Promise<Array<{ id: string; name: string }>> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const data = await jiraFetch<Array<{ id?: string | number; name?: string }>>(
        ctx,
        "/rest/api/2/issuetype",
      );
      return data
        .filter(
          (t): t is { id: string | number; name: string } =>
            typeof t.name === "string" && t.name.length > 0,
        )
        .map((t) => ({ id: String(t.id), name: t.name }));
    },

    filterFacets(): FilterFacet[] {
      return [{ id: "epic", label: "Epic", type: "enum-async" }];
    },

    async getFacetOptions(
      params: GetFacetOptionsParams & { config?: Record<string, unknown> },
    ): Promise<FilterFacetOption[]> {
      if (params.facetId !== "epic") return [];
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      const issues = await fetchEpicIssues(ctx);
      const options: FilterFacetOption[] = issues.map((issue) => ({
        value: issue.key,
        label: issue.fields?.summary ?? issue.key,
      }));
      if (!params.search) return options;
      const needle = params.search.toLowerCase();
      return options.filter(
        (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
      );
    },
  };
  return contract as unknown as PluginContract;
}

/**
 * Per-instance memo of "this Jira does not accept `statusCategory` in JQL".
 * Populated the first time a category-based exclusion query is rejected with a
 * `statusCategory` JQL parse error (TC-037); thereafter the builder emits the
 * status-name fallback directly for that instance, so the 400 round-trip is
 * paid at most once per process. Keyed by the instance URL.
 */
const statusCategoryUnsupportedInstances = new Set<string>();

/** Issue one page against `/rest/api/2/search` for a prebuilt JQL string. */
function jiraSearch(
  ctx: JiraRequestContext,
  jql: string,
  page: { startAt: number; pageSize: number },
): Promise<{ issues?: JiraIssueResponse[]; total?: number }> {
  return jiraFetch<{ issues?: JiraIssueResponse[]; total?: number }>(ctx, "/rest/api/2/search", {
    method: "POST",
    body: {
      jql,
      startAt: page.startAt,
      maxResults: page.pageSize,
      fields: [
        "summary",
        "description",
        "status",
        "issuelinks",
        "assignee",
        "labels",
        "issuetype",
        "updated",
      ],
    },
  });
}

/**
 * Run the cut-list search with the category-first status exclusion (FR-009),
 * falling back to status-name exclusion when the instance rejects
 * `statusCategory` in JQL (TC-037). The fallback flips a per-instance memo so
 * later pages and polls build the name form directly. The decision is logged
 * with no JQL, search term, PAT, or issue content (NFR-003).
 */
async function searchWithExclusionFallback(
  ctx: JiraRequestContext,
  instance: string,
  buildJql: (statusCategorySupported: boolean) => string,
  page: { startAt: number; pageSize: number },
): Promise<{ issues?: JiraIssueResponse[]; total?: number }> {
  const supported = !statusCategoryUnsupportedInstances.has(instance);
  try {
    return await jiraSearch(ctx, buildJql(supported), page);
  } catch (err) {
    if (!supported || !isStatusCategoryUnsupportedError(err)) throw err;
    statusCategoryUnsupportedInstances.add(instance);
    host.logger.info({
      message: "Jira instance does not support statusCategory in JQL; excluding by status name.",
      data: { resolvedKind: "status-names-fallback" },
    });
    return jiraSearch(ctx, buildJql(false), page);
  }
}

/** Test seam: reset the state-store cache and the statusCategory-support memo. */
export function _resetForTests(): void {
  _resetCacheForTests();
  statusCategoryUnsupportedInstances.clear();
}

/**
 * Narrow the host's flat `ConfiguredSource[]` (which carries an opaque `kind`
 * string) to Jira-understood `SourceClause`s, resolving `board` sources to
 * their active-sprint / whole-board JQL at list time and narrowing the `mine`
 * preset to the in-scope project keys. Entries whose `kind` is not a Jira kind
 * are dropped silently; the host already logged a warning for unknown
 * categories upstream in `server/services/plugin-source-translation.ts`.
 *
 * The in-scope project set (used to narrow `mine` in-project mode) is derived
 * from the sources themselves: every `project`-kind externalId plus any
 * source's `project` field, validated as Jira project keys. A malformed key is
 * dropped rather than interpolated (defense-in-depth alongside the picker).
 */
async function prepareSourceClauses(
  ctx: JiraRequestContext,
  sources: ConfiguredSource[] | undefined,
): Promise<SourceClause[]> {
  if (!Array.isArray(sources)) return [];

  const jiraSources = sources.filter(
    (s): s is ConfiguredSource =>
      Boolean(s) &&
      typeof s.externalId === "string" &&
      s.externalId.length > 0 &&
      isJiraSourceKind(s.kind),
  );

  const scopeProjectKeys = inScopeProjectKeys(jiraSources);

  const clauses: SourceClause[] = [];
  for (const source of jiraSources) {
    const kind = source.kind as SourceKind;
    if (kind === "board") {
      const boardMode = source.boardMode ?? "active-sprint";
      const boardId = source.externalId.startsWith("board:")
        ? source.externalId.slice("board:".length)
        : source.externalId;
      const resolvedClause = await resolveBoardClause(ctx, boardId, boardMode);
      clauses.push({ kind, externalId: source.externalId, boardMode, resolvedClause });
      continue;
    }
    if (kind === "mine") {
      const mineScope = source.mineScope ?? "anywhere";
      clauses.push({ kind, externalId: source.externalId, mineScope, scopeProjectKeys });
      continue;
    }
    clauses.push({ kind, externalId: source.externalId });
  }
  return clauses;
}

/** Validated union of every project key in scope across the source set. */
function inScopeProjectKeys(sources: ConfiguredSource[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const candidates = [source.kind === "project" ? source.externalId : undefined, source.project];
    for (const raw of candidates) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      try {
        keys.add(assertProjectKey(raw));
      } catch {
        // Drop malformed keys rather than interpolate them.
      }
    }
  }
  return [...keys];
}

function isJiraSourceKind(kind: unknown): kind is SourceKind {
  return (
    kind === "filter" ||
    kind === "epic" ||
    kind === "project" ||
    kind === "board" ||
    kind === "mine"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Stable per-source-set key the watermark is stored under. It captures
 * everything that changes a result set (kind, id, board mode, mine scope) but
 * NOT the volatile resolved sprint clause, so the watermark survives a sprint
 * rollover (TC-014) yet resets once when the configured set changes, including
 * a board widen or a mine-scope change (TC-031 / TC-041).
 */
function sourcesCacheKey(sources: SourceClause[]): string {
  if (sources.length === 0) return "__all__";
  return sources.map(clauseCacheKey).sort().join("|");
}

function clauseCacheKey(source: SourceClause): string {
  switch (source.kind) {
    case "board":
      return `board:${source.externalId}:${source.boardMode ?? "active-sprint"}`;
    case "mine": {
      const keys = [...(source.scopeProjectKeys ?? [])].sort().join(",");
      return `mine:${source.mineScope ?? "anywhere"}:${keys}`;
    }
    default:
      return `${source.kind}:${source.externalId}`;
  }
}
