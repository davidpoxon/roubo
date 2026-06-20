import type {
  ListIssuesParams,
  ListIssuesWarning,
  NormalizedIssue,
  PaginatedIssues,
} from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import { resolveSources, resolveExclusion, resolveInstanceEndpoint } from "./plugin-activation.js";
import {
  DiskSnapshotStore,
  buildCacheKey,
  type CacheKey,
  type DiscardLogEvent,
} from "./disk-snapshot-store.js";

/** The active plugin descriptor the route resolves and hands to the service. */
export interface ActivePluginContext {
  pluginId: string;
  integrationId: string;
  pageSize: number;
}

/** Inputs the route parses out of the query string. */
export interface QueryFirstOrPageInput {
  cursor: string | null;
  pageSize: number;
  filters: ListIssuesParams["filters"];
}

/** Where a first-page result came from. */
export type CacheStatus = "disk-hit" | "disk-miss" | "uncached";

/** Structured result the route serialises into the HTTP body. */
export interface CutListQueryResult {
  items: NormalizedIssue[];
  nextCursor: string | null;
  stalled?: boolean;
  warnings?: ListIssuesWarning[];
  excludedCount?: number;
  /** Present when the first page was served from a persisted disk snapshot. */
  snapshotCapturedAt?: string;
  cacheStatus: CacheStatus;
}

/** The raw shape the plugin's `listIssues` RPC returns. */
interface RawListIssues {
  items: NormalizedIssue[];
  nextCursor: string | null;
  warnings?: ListIssuesWarning[];
  excludedCount?: number;
}

/**
 * Owns the cut-list query path: source/exclusion resolution, the persistent
 * first-page disk cache (DiskSnapshotStore), the `listIssues` RPC, and the
 * per-request dedup + stall detection the route used to carry inline. The
 * issues route is reduced to parse/delegate/serialise.
 *
 * The in-memory `issue-snapshot-cache.ts` (errored/disabled fallback) is left
 * untouched and stays in the route; this service does not route the
 * errored-fallback through the disk store (out of scope for this slice).
 */
export class CutListQueryService {
  private readonly disk: DiskSnapshotStore;

  constructor(opts?: { disk?: DiskSnapshotStore; onDiscard?: (e: DiscardLogEvent) => void }) {
    this.disk = opts?.disk ?? new DiskSnapshotStore({ onDiscard: opts?.onDiscard });
  }

  /**
   * Build the `listIssues` params for a request. Exposed so the route's
   * errored/disabled in-memory fallback can reuse the exact same params shape
   * it always has.
   */
  buildListParams(projectId: string, input: QueryFirstOrPageInput): ListIssuesParams {
    const filters =
      input.filters && Object.keys(input.filters).length > 0 ? input.filters : undefined;
    const exclusion = resolveExclusion(projectId);
    return {
      sources: resolveSources(projectId),
      cursor: input.cursor,
      pageSize: input.pageSize,
      filters,
      excludedStatusCategories: exclusion.excludedStatusCategories,
      excludedStatuses: exclusion.excludedStatuses,
    };
  }

  private buildKey(projectId: string, pluginId: string, params: ListIssuesParams): CacheKey {
    return buildCacheKey({
      pluginId,
      pluginVersion: pluginManager.getRecord(pluginId)?.manifest?.version ?? "",
      instanceEndpoint: resolveInstanceEndpoint(projectId),
      projectId,
      sources: params.sources,
      filters: params.filters,
      excludedStatusCategories: params.excludedStatusCategories ?? [],
      excludedStatuses: params.excludedStatuses ?? [],
      // The sort RPC is out of scope for this slice; the key carries the fields
      // (so a later sort change invalidates) but they are always null here.
      sortBy: null,
      sortDir: null,
      pageSize: params.pageSize,
    });
  }

  /**
   * Resolve the first page (or a paginated page) for the cut list. On a
   * first-page request the persistent disk snapshot is consulted first and
   * served immediately on a hit (including after an application restart); on a
   * miss the live `listIssues` RPC runs, the page is deduped + stall-checked,
   * and the first page is persisted. Paginated requests (cursor set) bypass the
   * disk cache, which is first-page-only.
   */
  async queryFirstOrPage(
    projectId: string,
    active: ActivePluginContext,
    input: QueryFirstOrPageInput,
  ): Promise<CutListQueryResult> {
    const params = this.buildListParams(projectId, input);
    const isFirstPage = input.cursor === null;

    if (isFirstPage) {
      const key = this.buildKey(projectId, active.pluginId, params);
      const cached = this.disk.get(key);
      if (cached) {
        return {
          items: cached.response.items,
          nextCursor: cached.response.nextCursor,
          stalled: cached.response.stalled,
          warnings: cached.response.warnings,
          excludedCount: cached.response.excludedCount,
          snapshotCapturedAt: cached.capturedAt,
          cacheStatus: "disk-hit",
        };
      }

      const result = await this.fetchAndShape(active.pluginId, params, input.cursor);
      this.disk.put(key, this.toPersistable(result));
      return { ...result, cacheStatus: "disk-miss" };
    }

    const result = await this.fetchAndShape(active.pluginId, params, input.cursor);
    return { ...result, cacheStatus: "uncached" };
  }

  /** Run the RPC and apply the per-request dedup + stall detection. */
  private async fetchAndShape(
    pluginId: string,
    params: ListIssuesParams,
    requestCursor: string | null,
  ): Promise<Omit<CutListQueryResult, "cacheStatus">> {
    const raw = await pluginManager.invoke<RawListIssues>(pluginId, "listIssues", params);

    // Per-request dedup keyed on (integrationId, externalId) (FR-020 / TC-023).
    const seen = new Set<string>();
    const items = raw.items.filter((item) => {
      const dedupKey = `${item.integrationId}::${item.externalId}`;
      if (seen.has(dedupKey)) return false;
      seen.add(dedupKey);
      return true;
    });

    // Stall detection (TC-071): the host marks the page stalled when the plugin
    // echoes back the same cursor it was given.
    const stalled = raw.nextCursor !== null && raw.nextCursor === requestCursor;

    const shaped: Omit<CutListQueryResult, "cacheStatus"> = {
      items,
      nextCursor: stalled ? null : raw.nextCursor,
      stalled: stalled || undefined,
    };
    if (raw.warnings && raw.warnings.length > 0) shaped.warnings = raw.warnings;
    if (typeof raw.excludedCount === "number") shaped.excludedCount = raw.excludedCount;
    return shaped;
  }

  /** Project a shaped result down to the `PaginatedIssues` the disk store persists. */
  private toPersistable(result: Omit<CutListQueryResult, "cacheStatus">): PaginatedIssues {
    const body: PaginatedIssues = {
      items: result.items,
      nextCursor: result.nextCursor,
    };
    if (result.stalled) body.stalled = true;
    if (result.warnings) body.warnings = result.warnings;
    if (typeof result.excludedCount === "number") body.excludedCount = result.excludedCount;
    return body;
  }
}

/** Process-wide default instance used by the route. */
export const cutListQueryService = new CutListQueryService();
