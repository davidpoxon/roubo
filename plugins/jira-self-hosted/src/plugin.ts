import { host } from "@roubo/plugin-sdk";
import type {
  ConfiguredSource,
  CurrentUser,
  FilterFacet,
  FilterFacetOption,
  GetFacetOptionsParams,
  ListIssuesParams,
  ListIssuesResult,
  NormalizedComment,
  NormalizedIssue,
  PluginContract,
  SetActiveConfigResult,
  ValidateConfigResult,
} from "@roubo/plugin-sdk";
import { parseFormConfig, parseIntegrationConfig, type JiraPluginConfig } from "./config.js";
import { jiraFetch, JiraApiError, type JiraRequestContext } from "./jira-client.js";
import { buildIssueListJql, type SourceClause, type SourceKind } from "./jql.js";
import {
  normalizeComment,
  normalizeIssue,
  type JiraCommentResponse,
  type JiraIssueResponse,
} from "./normalize.js";
import { fetchEpicIssues, listSourceCandidates } from "./source-picker.js";
import { applyTransition as runApplyTransition } from "./transitions.js";
import { assignIssue as runAssignIssue, unassignIssue as runUnassignIssue } from "./assignment.js";
import { getLastPoll, setLastPoll, _resetCacheForTests } from "./state-store.js";

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
    return { instance: config.instance, pat };
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
        await jiraFetch({ instance: parsed.config.instance, pat }, "/rest/api/2/myself");
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
     * Per-project source selection is supplied per-call on
     * `ListIssuesParams.sources` and is never stored here.
     */
    setActiveConfig({ config }: { config: Record<string, unknown> }): SetActiveConfigResult {
      const parsed = parseIntegrationConfig(config);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      cachedConfig = parsed.config;
      return { ok: true };
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

    async listSourceCandidates(params: unknown): Promise<unknown> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);
      return listSourceCandidates(ctx);
    },

    async listIssues(params: ListIssuesParams): Promise<ListIssuesResult> {
      const config = await adoptOrRecallConfig(params);
      const ctx = await ctxFor(config);

      const sources = toSourceClauses(params.sources);
      const sourceKey = sourcesCacheKey(sources);
      const lastPoll = await getLastPoll(sourceKey);
      const jql = buildIssueListJql({ sources, lastPollIso: lastPoll });

      const startAt = parseCursor(params.cursor);
      const pageSize = params.pageSize ?? 50;

      const search = await jiraFetch<{ issues?: JiraIssueResponse[]; total?: number }>(
        ctx,
        "/rest/api/2/search",
        {
          method: "POST",
          body: {
            jql,
            startAt,
            maxResults: pageSize,
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
        },
      );

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

/** Test seam: reset the state-store cache (no contract-level state to reset). */
export function _resetForTests(): void {
  _resetCacheForTests();
}

/**
 * Narrow the host's flat `ConfiguredSource[]` (which carries an opaque
 * `kind` string) to Jira-understood `SourceClause`s. Entries whose `kind`
 * is anything other than `"filter"` or `"epic"` are dropped silently; the
 * host already logged a warning for unknown categories upstream in
 * `server/services/plugin-source-translation.ts`.
 */
function toSourceClauses(sources: ConfiguredSource[] | undefined): SourceClause[] {
  if (!Array.isArray(sources)) return [];
  const clauses: SourceClause[] = [];
  for (const source of sources) {
    if (!source || typeof source.externalId !== "string" || source.externalId.length === 0) {
      continue;
    }
    if (!isJiraSourceKind(source.kind)) continue;
    clauses.push({ kind: source.kind, externalId: source.externalId });
  }
  return clauses;
}

function isJiraSourceKind(kind: unknown): kind is SourceKind {
  return kind === "filter" || kind === "epic";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sourcesCacheKey(sources: SourceClause[]): string {
  if (sources.length === 0) return "__all__";
  return sources
    .map((s) => `${s.kind}:${s.externalId}`)
    .sort()
    .join("|");
}
