import type {
  ListIssuesParams,
  ListIssuesWarning,
  NormalizedIssue,
  PaginatedIssues,
} from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import {
  resolveSources,
  resolveExclusion,
  resolveInstanceEndpoint,
  resolveSortForActivePlugin,
} from "./plugin-activation.js";
import {
  DiskSnapshotStore,
  buildCacheKey,
  type CacheKey,
  type DiscardLogEvent,
  type ProjectEvictReason,
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
  /**
   * The sort selection from the request's `sortBy`/`sortDir` query params
   * (CLI-FR-009). When present these win over the persisted per-project sort
   * (so the picker's live selection takes effect immediately); when absent the
   * service falls back to `resolveSort(projectId)` (CLI-FR-013/CLI-FR-017).
   */
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /**
   * A one-shot force-refresh request from the cut-list refresh control (#653).
   * When true on a first-page request the warm disk snapshot is NOT served:
   * the live `listIssues` RPC runs synchronously, its fresh result is persisted
   * back to the disk snapshot (keeping the cache warm with current data), and
   * the response reports `cacheStatus: "miss"`. This is what makes an explicit
   * refresh actually pull current data (closed items drop, newly-unblocked
   * items appear) instead of re-serving the stale warm snapshot. Normal
   * (non-refresh) loads keep the stale-while-revalidate behaviour unchanged.
   */
  refresh?: boolean;
}

/** A resolved sort selection (field id + direction), or natural order when both are undefined. */
export interface ResolvedSort {
  sortBy: string | undefined;
  sortDir: "asc" | "desc" | undefined;
}

/**
 * The stale-while-revalidate cache-state signal, aligned to the architecture's
 * HTTP contract (`PaginatedIssues.cacheStatus`):
 * - `revalidating`: the persisted disk snapshot was served instantly and a
 *   background revalidation is in flight (the warm path, disk-hit).
 * - `miss`: no usable snapshot, so the live RPC ran (and, for a first page, the
 *   result was persisted). Also the value for paginated / bypassed queries that
 *   never consult the disk cache.
 * - `hit`: served from the snapshot without triggering a revalidation. Carried
 *   in the contract for completeness; the warm path emits `revalidating`.
 */
export type CacheStatus = "hit" | "miss" | "revalidating";

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

/**
 * Cache-pipeline observability events (NFR-009). Carries only cache-state and
 * identity, never issue content, credentials, or tokens. Surfaced through the
 * service's `onObserve` hook (defaulting to a structured `console` line) so the
 * unit tests can assert the events fire without leaking into test stdout.
 */
export type CacheObserveEvent =
  | { kind: "cache"; status: CacheStatus; pluginId: string; projectId: string }
  | { kind: "revalidate-failed"; pluginId: string; projectId: string; message: string };

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
  /**
   * When true, the persistent disk snapshot is bypassed entirely (never read,
   * never written) and every query goes straight to the live RPC. Enabled under
   * the e2e harness (ROUBO_E2E=1): the disk cache persists across process
   * restarts by design, so under the single-server, many-scenario e2e suite a
   * snapshot written by one spec can be served to a later spec sharing the same
   * cache key, which is a source of cross-test nondeterminism the harness does
   * not want. The disk path stays fully exercised by the unit tests; this only
   * neutralises the persistence inside the e2e harness. Overridable for tests.
   *
   * Not `readonly`: the ROUBO_E2E-gated `/test/__set-cut-list-disk-cache` route
   * flips it at runtime so the warm-snapshot journey (CLI-TC-017, the #568 drift
   * guard) can reach the disk path the harness otherwise bypasses. `/test/__reset`
   * restores the env-derived default so other specs keep the bypass.
   */
  private bypassDisk: boolean;
  /**
   * NFR-009 observability sink for cache-pipeline events (hit/miss/revalidating
   * and background-revalidation failures). Defaults to a structured `console`
   * line carrying no issue content or credentials. Overridable for tests so the
   * events can be asserted without emitting into test stdout.
   */
  private readonly onObserve: (event: CacheObserveEvent) => void;

  constructor(opts?: {
    disk?: DiskSnapshotStore;
    onDiscard?: (e: DiscardLogEvent) => void;
    bypassDisk?: boolean;
    onObserve?: (event: CacheObserveEvent) => void;
  }) {
    // Default the store's discard sink to the NFR-009 log so corrupt-file
    // discards (and the rest of the store's lifecycle/eviction triggers) are
    // diagnosable on the singleton, not silently dropped. Tests pass an explicit
    // `onDiscard` (or `disk`) to assert the events without emitting to stdout.
    this.disk =
      opts?.disk ?? new DiskSnapshotStore({ onDiscard: opts?.onDiscard ?? defaultDiscard });
    this.bypassDisk = opts?.bypassDisk ?? process.env.ROUBO_E2E === "1";
    this.onObserve = opts?.onObserve ?? defaultObserve;
  }

  /**
   * Toggle whether the persistent disk snapshot is bypassed, at runtime. The
   * ROUBO_E2E-gated `/test/__set-cut-list-disk-cache` route uses this so the
   * warm-snapshot journey (CLI-TC-017, the #568 e2e drift guard) can reach the
   * disk path the harness bypasses by default. Passing `enabled: true` un-bypasses
   * the disk (warm serve reachable); `false` (or `/test/__reset`'s call to
   * `restoreBypassDefault`) returns to the env-derived bypass. Production never
   * calls this; the default stays env-driven.
   */
  setDiskCacheEnabled(enabled: boolean): void {
    this.bypassDisk = !enabled;
  }

  /**
   * Restore `bypassDisk` to its env-derived default (bypassed under ROUBO_E2E=1).
   * Called by `/test/__reset` so a spec that un-bypassed the disk cache via
   * `setDiskCacheEnabled` does not leak the warm path into the next spec.
   */
  restoreBypassDefault(): void {
    this.bypassDisk = process.env.ROUBO_E2E === "1";
  }

  /**
   * Lifecycle eviction (FR-004 / NFR-001): drop every persisted snapshot owned
   * by `pluginId` across all projects. A thin public delegate over the private
   * disk store so the lifecycle owners (plugin-manager uninstall / disable /
   * version change) can evict without reaching into the store. Never throws.
   */
  evictPlugin(pluginId: string): void {
    this.disk.evictPlugin(pluginId);
  }

  /**
   * Lifecycle eviction (FR-004 / NFR-001): drop every persisted snapshot for
   * `projectId`. A thin public delegate over the private disk store so
   * project-registry's unregisterProject (default `"project-evicted"`) and the
   * integration reconfiguration route (`"integration-reconfigured"`, CLI-NFR-009)
   * can evict without reaching into the store. Never throws.
   */
  evictProject(projectId: string, reason?: ProjectEvictReason): void {
    this.disk.evictProject(projectId, reason);
  }

  /**
   * Resolve the per-project persisted sort, validated against the active
   * plugin's declared sort fields (CLI-FR-017 / CLI-TC-070): an unsupported
   * persisted value falls back to the plugin's first declared field, and a
   * plugin that declares no fields yields natural order. Thin delegate over
   * `resolveSortForActivePlugin` so the route and `queryFirstOrPage` resolve the
   * fallback path identically and feed the same value into `buildListParams`.
   */
  resolvePersistedSort(projectId: string, pluginId: string): Promise<ResolvedSort> {
    return resolveSortForActivePlugin(projectId, pluginId);
  }

  /**
   * Build the `listIssues` params for a request. Exposed so the route's
   * errored/disabled in-memory fallback can reuse the exact same params shape
   * it always has.
   *
   * `persistedSort` carries the already-resolved, plugin-validated per-project
   * sort for the fallback path (when the request itself carries no `sortBy`);
   * the caller resolves it once via `resolvePersistedSort` and passes it in so
   * this stays synchronous and the live and fallback paths derive identical
   * cache keys. When omitted, the fallback path yields natural order.
   */
  buildListParams(
    projectId: string,
    input: QueryFirstOrPageInput,
    persistedSort?: ResolvedSort,
  ): ListIssuesParams {
    const filters =
      input.filters && Object.keys(input.filters).length > 0 ? input.filters : undefined;
    const exclusion = resolveExclusion(projectId);
    // The request's sort params win when present (the picker's live selection,
    // CLI-FR-009); otherwise fall back to the persisted per-project sort,
    // already validated against the active plugin's declared fields by the
    // caller (CLI-FR-017/CLI-TC-070). `sortDir` defaults to `asc` only when a
    // request `sortBy` is set without an explicit direction (CLI-FR-010
    // key-ascending default).
    const sort: ResolvedSort =
      typeof input.sortBy === "string" && input.sortBy.length > 0
        ? { sortBy: input.sortBy, sortDir: input.sortDir === "desc" ? "desc" : "asc" }
        : (persistedSort ?? { sortBy: undefined, sortDir: undefined });
    const params: ListIssuesParams = {
      sources: resolveSources(projectId),
      cursor: input.cursor,
      pageSize: input.pageSize,
      filters,
      excludedStatusCategories: exclusion.excludedStatusCategories,
      excludedStatuses: exclusion.excludedStatuses,
    };
    if (sort.sortBy) {
      params.sortBy = sort.sortBy;
      params.sortDir = sort.sortDir;
    }
    return params;
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
      // CLI-FR-003: the resolved sort participates in the cache key so a sort
      // change is a cache miss (a different field/direction is a different
      // first page). Null when no sort is selected (the natural-order default).
      sortBy: params.sortBy ?? null,
      sortDir: params.sortDir ?? null,
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
    persistedSort?: ResolvedSort,
  ): Promise<CutListQueryResult> {
    // Resolve the plugin-validated persisted sort only when the request carries
    // no live sort (the picker's selection wins and skips the RPC otherwise).
    // The caller may pass an already-resolved value (the route resolves it once
    // for its in-memory-fallback cache key); reuse it so a single `getSortFields`
    // RPC serves both paths instead of each firing its own (CLI-FR-017).
    const resolvedPersistedSort =
      typeof input.sortBy === "string" && input.sortBy.length > 0
        ? undefined
        : (persistedSort ?? (await this.resolvePersistedSort(projectId, active.pluginId)));
    const params = this.buildListParams(projectId, input, resolvedPersistedSort);
    const isFirstPage = input.cursor === null;

    // Only serve the persistent disk snapshot while the plugin is healthy. When
    // the plugin is errored/disabled (or otherwise not enabled), serving a
    // disk-hit would shadow the route's in-memory errored/disabled stale
    // fallback: it would return a fresh-looking body with no `stale` marker, so
    // the client could never surface the stale banner (FR-014). This slice
    // deliberately leaves that fallback to the in-memory cache and does not
    // route it through the disk store, so on a non-healthy plugin we skip the
    // disk read and let the live RPC fail through to the route's catch block.
    const healthy = pluginManager.getRecord(active.pluginId)?.status === "enabled";

    if (isFirstPage && healthy && !this.bypassDisk) {
      const key = this.buildKey(projectId, active.pluginId, params);
      // Force-refresh (#653): an explicit refresh is a request for current
      // data, so skip the warm-serve entirely. Run the live RPC synchronously,
      // persist the fresh result so the cache stays warm with current data, and
      // report a `miss`. The disk snapshot is never read on this path, so a
      // stale snapshot can never shadow the fresh fetch.
      if (input.refresh) {
        const result = await this.fetchAndShape(active.pluginId, params, input.cursor);
        this.disk.put(key, this.toPersistable(result));
        this.observe({ kind: "cache", status: "miss", pluginId: active.pluginId, projectId });
        return { ...result, cacheStatus: "miss" };
      }
      const cached = this.disk.get(key);
      if (cached) {
        // Stale-while-revalidate (FR-002): serve the warm snapshot immediately
        // and revalidate behind it. The revalidation is fire-and-forget so it
        // never blocks (or rejects into) the request that served the snapshot;
        // the client picks up the fresher snapshot on its next refetch.
        this.observe({
          kind: "cache",
          status: "revalidating",
          pluginId: active.pluginId,
          projectId,
        });
        this.reval(active.pluginId, projectId, key, params);
        return {
          items: cached.response.items,
          nextCursor: cached.response.nextCursor,
          stalled: cached.response.stalled,
          warnings: cached.response.warnings,
          excludedCount: cached.response.excludedCount,
          snapshotCapturedAt: cached.capturedAt,
          cacheStatus: "revalidating",
        };
      }

      const result = await this.fetchAndShape(active.pluginId, params, input.cursor);
      this.disk.put(key, this.toPersistable(result));
      this.observe({ kind: "cache", status: "miss", pluginId: active.pluginId, projectId });
      return { ...result, cacheStatus: "miss" };
    }

    const result = await this.fetchAndShape(active.pluginId, params, input.cursor);
    return { ...result, cacheStatus: "miss" };
  }

  /** Emit an NFR-009 observability event, swallowing any sink error. */
  private observe(event: CacheObserveEvent): void {
    try {
      this.onObserve(event);
    } catch {
      // Observability must never affect the request path.
    }
  }

  /**
   * Fire-and-forget background revalidation for a served disk-hit (FR-002). It
   * re-runs the live `listIssues`, re-shapes the page, and overwrites the disk
   * snapshot so the next read serves fresher data. It is deliberately not
   * awaited by the request: a `.catch` logs (NFR-009) and discards any rejection
   * so it never rejects into the request and never crashes Node on the
   * unhandled-rejection default (NFR-006 / CLI-TC-014).
   */
  private reval(
    pluginId: string,
    projectId: string,
    key: CacheKey,
    params: ListIssuesParams,
  ): void {
    const run = async (): Promise<void> => {
      // A first-page revalidation always replays the first-page cursor (null).
      const fresh = await this.fetchAndShape(pluginId, params, null);
      this.disk.put(key, this.toPersistable(fresh));
    };
    void run().catch((err: unknown) => {
      this.observe({
        kind: "revalidate-failed",
        pluginId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
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

/**
 * Default NFR-009 observability sink: a structured `console` line carrying only
 * cache-state and identity, never issue content, credentials, or tokens. A
 * `revalidate-failed` event logs at `warn`; cache state at `info`.
 */
function defaultObserve(event: CacheObserveEvent): void {
  if (event.kind === "revalidate-failed") {
    console.warn(
      `[cut-list-cache] background revalidation failed plugin=${event.pluginId} project=${event.projectId}: ${event.message}`,
    );
    return;
  }
  console.info(
    `[cut-list-cache] cache ${event.status} plugin=${event.pluginId} project=${event.projectId}`,
  );
}

/**
 * Default NFR-009 sink for the disk store's discard/eviction events (corrupt
 * file, schema / plugin-version mismatch, over-age, LRU / age sweeps, and the
 * lifecycle plugin/project evictions). Carries only the discard trigger and
 * plugin/project identity, never issue content, credentials, or tokens. A
 * `corrupt` discard logs at `warn` (it signals a partial / damaged file worth
 * noticing); the rest log at `info` as routine cache maintenance.
 */
export function defaultDiscard(event: DiscardLogEvent): void {
  const line = `[cut-list-cache] discard ${event.trigger} plugin=${event.pluginId} project=${event.projectId}`;
  if (event.trigger === "corrupt") {
    console.warn(line);
    return;
  }
  console.info(line);
}

/**
 * Process-wide default instance used by the route and the lifecycle owners.
 *
 * Constructed lazily on first access (not at module-eval) so that merely
 * importing this module, e.g. from project-registry for its evictProject
 * delegate, does not eagerly build the DiskSnapshotStore (which resolves
 * `getRouboDir()`). Several route/service unit tests mock `state.js` without a
 * `getRouboDir`, so an eager construction at import time would throw inside any
 * test that transitively imports this module. The lazy getter defers that cost
 * until an actual query/evict call, by which point the real store is wired.
 */
let _singleton: CutListQueryService | undefined;
export const cutListQueryService: CutListQueryService = new Proxy({} as CutListQueryService, {
  get(_target, prop, receiver) {
    _singleton ??= new CutListQueryService();
    const value = Reflect.get(_singleton, prop, receiver) as unknown;
    return typeof value === "function" ? value.bind(_singleton) : value;
  },
});
