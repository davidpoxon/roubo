import type {
  ListIssuesParams,
  ListIssuesWarning,
  NormalizedIssue,
  PaginatedIssues,
} from "@roubo/shared";
import { partitionUnblockedFirst } from "@roubo/shared/cut-list-order";
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
  hashCacheKey,
  type CacheKey,
  type DiscardLogEvent,
  type ProjectEvictReason,
} from "./disk-snapshot-store.js";

/**
 * Bounded page-walk caps for the whole-set materialisation (#844).
 *
 * Cross-page unblocked-first ordering is only decidable with every result in one
 * place: blocked state is knowable per fetched page (the GitHub plugin resolves
 * `blockedBy` with a per-page call over that page's ids) and no source can sort
 * on it, so the host walks the plugin's cursor chain to exhaustion and orders
 * the whole set before slicing pages out of it. A cold load therefore costs one
 * plugin call per source page, so the walk is bounded: it stops at whichever cap
 * it reaches first, orders what it walked, and reports the truncation as a
 * non-fatal warning. Past the cap the unblocked-first guarantee holds only over
 * the walked prefix.
 */
export const MAX_WALK_PAGES = 20;
/** Item-count cap for the same walk; the walk stops once the set reaches it. */
export const MAX_WALK_ITEMS = 2000;
/**
 * Category of the non-fatal warning emitted when the walk hits a cap. Host-owned
 * rather than source-owned, so `sourceExternalId` is empty: the truncation is a
 * property of the walk across every configured source, not of any one of them.
 */
export const WALK_TRUNCATED_CATEGORY = "cut-list-walk-truncated";

/**
 * Lifetime of an in-process materialised set. Long enough that Prev/Next paging
 * slices an already-walked set instead of re-walking every page, short enough
 * that a page served minutes later is not silently ancient. Deliberately not the
 * disk snapshot: `DiskSnapshotStore` caps an entry at `PER_ENTRY_MAX_BYTES` and
 * skips anything larger, so a whole result set would evict itself and make every
 * Next click re-walk. The disk snapshot stays first-ordered-page-only.
 */
const MATERIALIZATION_TTL_MS = 60_000;
/** LRU bound on the in-process materialisation cache. */
const MATERIALIZATION_MAX_ENTRIES = 4;

/** Version tag on the host-issued cut-list cursor, so a format change is detectable. */
const CURSOR_VERSION = 1;

/**
 * Encode a host-owned cut-list cursor: an offset into the ordered, materialised
 * result set (#844). The host, not the plugin, now owns the cursor the client
 * echoes back, because a page is a slice of the host's ordered set rather than
 * whatever window the plugin would return for its own cursor.
 */
export function encodeCutListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: offset }), "utf8").toString(
    "base64url",
  );
}

/**
 * Decode a host-owned cut-list cursor back into an offset. Anything unreadable
 * (a plugin-issued cursor from a client that has not reloaded since the format
 * changed, a truncated token, a hand-edited query string) degrades to offset 0,
 * mirroring how the plugin-side composite cursor decodes malformed input rather
 * than throwing. The worst case is a re-render of page 1.
 */
export function decodeCutListCursor(cursor: string | null): number {
  if (typeof cursor !== "string" || cursor.length === 0) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { v?: unknown }).v === CURSOR_VERSION
    ) {
      const offset = (parsed as { o?: unknown }).o;
      if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) return offset;
    }
  } catch {
    // Fall through to the first page.
  }
  return 0;
}

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
 * The whole result set for one query: every page the plugin would have returned,
 * deduped once across the walk and ordered unblocked-first across the lot
 * (#844). Host pages are slices of `items`.
 */
interface MaterializedSet {
  items: NormalizedIssue[];
  stalled?: boolean;
  warnings?: ListIssuesWarning[];
  excludedCount?: number;
}

/** An in-process materialisation cache entry, with the time it was walked. */
interface MemoEntry {
  at: number;
  set: MaterializedSet;
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
  /**
   * In-process materialisation cache (#844), keyed by the same cache-key hash
   * the disk snapshot uses so it discriminates plugin, instance, project,
   * sources, filters, exclusions, sort, and pageSize exactly as the disk store
   * does. It exists so Prev/Next slices an already-walked set rather than
   * re-walking every plugin page per click; first-page loads always re-walk, so
   * it never shadows the disk snapshot's stale-while-revalidate behaviour.
   * Process-local and short-lived by design; never persisted.
   */
  private readonly memo = new Map<string, MemoEntry>();

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
   * miss the plugin's whole cursor chain is walked, deduped, ordered
   * unblocked-first, and the first ordered page is persisted. Paginated requests
   * (cursor set) bypass the disk cache, which is first-page-only, and slice
   * their page out of the materialised set instead.
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
    // The cursor is host-owned (#844): an offset into the ordered materialised
    // set, not a plugin token. A cursor the host cannot read degrades to 0.
    const offset = isFirstPage ? 0 : decodeCutListCursor(input.cursor);
    const key = this.buildKey(projectId, active.pluginId, params);
    const memoKey = hashCacheKey(key);

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
      // Force-refresh (#653): an explicit refresh is a request for current
      // data, so skip the warm-serve entirely. Run the live RPC synchronously,
      // persist the fresh result so the cache stays warm with current data, and
      // report a `miss`. The disk snapshot is never read on this path, so a
      // stale snapshot can never shadow the fresh fetch.
      if (input.refresh) {
        const result = await this.pageFrom(active.pluginId, memoKey, params, offset, false);
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
        this.reval(active.pluginId, projectId, key, memoKey, params);
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

      const result = await this.pageFrom(active.pluginId, memoKey, params, offset, false);
      this.disk.put(key, this.toPersistable(result));
      this.observe({ kind: "cache", status: "miss", pluginId: active.pluginId, projectId });
      return { ...result, cacheStatus: "miss" };
    }

    // Paginated requests slice the materialised set, reusing the in-process
    // walk when one is still fresh so Prev/Next does not re-walk every plugin
    // page per click. A first page reaching this branch (bypassed disk, or an
    // unhealthy plugin) always re-walks, so the memo never shadows the disk
    // snapshot's stale-while-revalidate behaviour.
    const result = await this.pageFrom(active.pluginId, memoKey, params, offset, !isFirstPage);
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
   * re-walks the plugin's pages, re-orders the whole set, and overwrites the
   * disk snapshot with the fresh first ordered page so the next read serves
   * fresher data. It is deliberately not awaited by the request: a `.catch` logs
   * (NFR-009) and discards any rejection so it never rejects into the request
   * and never crashes Node on the unhandled-rejection default (NFR-006 /
   * CLI-TC-014).
   */
  private reval(
    pluginId: string,
    projectId: string,
    key: CacheKey,
    memoKey: string,
    params: ListIssuesParams,
  ): void {
    const run = async (): Promise<void> => {
      // A first-page revalidation always re-walks from offset 0.
      const fresh = await this.pageFrom(pluginId, memoKey, params, 0, false);
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

  /**
   * Resolve one host-owned page: the slice of the ordered materialised set that
   * starts at `offset`. `useMemo` decides whether an in-process materialisation
   * may serve it; a fresh walk always refreshes the memo either way.
   */
  private async pageFrom(
    pluginId: string,
    memoKey: string,
    params: ListIssuesParams,
    offset: number,
    useMemo: boolean,
  ): Promise<Omit<CutListQueryResult, "cacheStatus">> {
    let set = useMemo ? this.readMemo(memoKey) : undefined;
    if (!set) {
      set = await this.materialize(pluginId, params);
      this.writeMemo(memoKey, set);
    }
    return this.slicePage(set, offset, params.pageSize);
  }

  /**
   * Walk the plugin's whole cursor chain, dedup across the walk, and order the
   * result unblocked-first (#844).
   *
   * The ordering has to sit above the page boundary: `blockedBy` is resolved by
   * the plugin per fetched page and no source can sort on it, so partitioning a
   * single page can only ever order that page. Walking to exhaustion puts the
   * whole result set in one place, so the partition is global and page 1 holds
   * unblocked items until they run out.
   *
   * Bounded three ways: the page cap, the item cap, and the stall check (a
   * plugin that echoes back the cursor it was given ends the chain rather than
   * looping forever, IP-TC-071). Hitting either cap truncates the set and adds a
   * `WALK_TRUNCATED_CATEGORY` warning.
   */
  private async materialize(pluginId: string, params: ListIssuesParams): Promise<MaterializedSet> {
    // Dedup keyed on (integrationId, externalId) across the whole walk, not just
    // one page (FR-020 / IP-TC-023): a multi-source composite cursor can surface
    // the same issue on two pages, and a duplicate would otherwise consume a
    // slot in the ordered set.
    const seen = new Set<string>();
    const items: NormalizedIssue[] = [];
    const warnings: ListIssuesWarning[] = [];
    const warningKeys = new Set<string>();
    let excludedCount: number | undefined;
    let stalled = false;
    let truncated = false;
    let cursor: string | null = null;

    for (let page = 0; ; page += 1) {
      if (page >= MAX_WALK_PAGES) {
        truncated = true;
        break;
      }
      const raw: RawListIssues = await pluginManager.invoke<RawListIssues>(pluginId, "listIssues", {
        ...params,
        cursor,
      });
      for (const item of raw.items) {
        const dedupKey = `${item.integrationId}::${item.externalId}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        items.push(item);
      }
      for (const warning of raw.warnings ?? []) {
        // Warnings repeat per page (they describe a source, not a page), so keep
        // one of each rather than one per walked page.
        const warningKey = JSON.stringify(warning);
        if (warningKeys.has(warningKey)) continue;
        warningKeys.add(warningKey);
        warnings.push(warning);
      }
      if (typeof raw.excludedCount === "number") {
        excludedCount = (excludedCount ?? 0) + raw.excludedCount;
      }

      if (raw.nextCursor === null) break;
      // Stall detection (IP-TC-071): the plugin echoed back the cursor it was
      // given, so following it would fetch the same window forever.
      if (raw.nextCursor === cursor) {
        stalled = true;
        break;
      }
      if (items.length >= MAX_WALK_ITEMS) {
        truncated = true;
        break;
      }
      cursor = raw.nextCursor;
    }

    if (truncated) {
      warnings.push({
        category: WALK_TRUNCATED_CATEGORY,
        sourceExternalId: "",
        cause: `Ordering covers the first ${items.length} item(s): the cut list exceeded the ${MAX_WALK_PAGES}-page / ${MAX_WALK_ITEMS}-item walk limit, so items beyond it are not listed.`,
      });
    }

    const set: MaterializedSet = { items: partitionUnblockedFirst(items) };
    if (stalled) set.stalled = true;
    if (warnings.length > 0) set.warnings = warnings;
    if (typeof excludedCount === "number") set.excludedCount = excludedCount;
    return set;
  }

  /** Cut one host page out of the ordered set and mint the next offset cursor. */
  private slicePage(
    set: MaterializedSet,
    offset: number,
    pageSize: number,
  ): Omit<CutListQueryResult, "cacheStatus"> {
    const start = Math.min(offset, set.items.length);
    const end = Math.min(start + pageSize, set.items.length);
    const shaped: Omit<CutListQueryResult, "cacheStatus"> = {
      items: set.items.slice(start, end),
      nextCursor: end < set.items.length ? encodeCutListCursor(end) : null,
    };
    if (set.stalled) shaped.stalled = true;
    if (set.warnings) shaped.warnings = set.warnings;
    if (typeof set.excludedCount === "number") shaped.excludedCount = set.excludedCount;
    return shaped;
  }

  /** Read a still-fresh materialisation, refreshing its LRU recency. */
  private readMemo(memoKey: string): MaterializedSet | undefined {
    const entry = this.memo.get(memoKey);
    if (!entry) return undefined;
    if (Date.now() - entry.at > MATERIALIZATION_TTL_MS) {
      this.memo.delete(memoKey);
      return undefined;
    }
    this.memo.delete(memoKey);
    this.memo.set(memoKey, entry);
    return entry.set;
  }

  /** Store a materialisation, evicting the least recently used over the bound. */
  private writeMemo(memoKey: string, set: MaterializedSet): void {
    this.memo.delete(memoKey);
    this.memo.set(memoKey, { at: Date.now(), set });
    while (this.memo.size > MATERIALIZATION_MAX_ENTRIES) {
      const oldest = this.memo.keys().next().value;
      if (oldest === undefined) break;
      this.memo.delete(oldest);
    }
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
