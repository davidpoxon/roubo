# Architecture: Cut list performance, ordering, and filtering improvements

## Context

**PRD:** ./prd.md

The cut list loads slowly on every open (full external round-trip; the only cache is an in-memory, first-page-only crash fallback), has no deterministic order, shows non-actionable in-progress items, clutters its filters with dead values, and grows into an unnavigable infinite-scroll list with no refresh feedback. The architectural choice is non-trivial because the dominant, spike-gated risk is **cache-invalidation correctness** (FR-003, FR-004) under a hard security invariant (NFR-001: cache files mode `0600`, no secrets in payload, server-owned eviction on uninstall/disable/unregister/version-change/reconfig), while simultaneously extending the plugin contract (a new sort RPC, NFR-008 non-breaking host-API 1.1.0 to 1.2.0) and meeting concrete performance budgets (NFR-002 warm load < 200ms p95, NFR-003 cache overhead < 50ms, NFR-004 page step < 150ms p95, NFR-005 client `applyFilters` p95 < 50ms @ ~500 issues). Constraints carried verbatim from the PRD: persistent first-page warm cache served on every load including after restart (FR-001/FR-002); plugin-declared sort with graceful `MethodNotFound` fallback to key-ascending (FR-009/FR-010/FR-011); only-to-do default with per-project override (FR-012/FR-013) and best-effort mapping for category-less plugins (FR-014); source-side facet-value exclusion (FR-015); the confirmed GHE 1.1.0 facet prerequisite (FR-016); WCAG 2.1 AA new controls (NFR-007); degrade-safely-and-indicate (NFR-006); cache/degradation observability (NFR-009).

## Decision summary

**Lens:** Extract a service (server-side cut-list query/cache service), with two pragmatic borrowings from the rejected lenses (see below).

A new server-side **CutListQueryService** becomes the single owner of everything between a thinned issues route and `pluginManager`: it builds the full `listIssues` params (including the new `sortBy`/`sortDir`), resolves sort capability via a new **PluginSortFieldsService** (mirroring the existing `plugin-filter-facets` wrapper), owns the persistent first-page snapshot cache through an internal **DiskSnapshotStore** (on-disk JSON under `~/.roubo/`, written via the existing `atomicWrite` at mode `0600`, stale-while-revalidate), applies the full FR-003 cache-key/FR-004 invalidation matrix, and runs the existing dedup and stall-detection before returning a structured result. The issues route is reduced to query-string parsing, delegation, and HTTP serialisation. This lens won because the PRD's hardest, spike-gated risk (cache invalidation, FR-003/FR-004) and its security invariant (NFR-001) get **one authoritative, independently-testable home** (the tradeoff that tipped it: testability and a single eviction surface, which directly serve the repo's 80% coverage gate, over the lower-ceremony of editing the route in place). The existing in-memory `issue-snapshot-cache` is retained, unextended, solely for the current plugin-errored/disabled serve path until the disk store demonstrably covers it, avoiding a regression window.

**Borrowings folded in (not separate lenses):**

- From extend-in-place: reuse `atomicWrite` + the `~/.roubo/` convention and the established `MethodNotFound` fallback pattern; introduce **no** new runtime dependency (hand-rolled JSON store, Node built-in `crypto` for key hashing).
- From client-tier: drive the FR-005/FR-006 refresh-in-progress and last-updated indicators from React Query's native `isRefetching` / `dataUpdatedAt` rather than inventing client state.

### Considered and rejected

- **Extend in place (Lens 1):** Works and is lowest-ceremony, but by its own assessment concentrates disk I/O, composite-key hashing, the eviction matrix, `0600` enforcement, and corrupt-file recovery into one unbounded module (self-rated L complexity, high risk). Rejected: the riskiest logic deserves a boundary, not a 300-line file.
- **Client-tier cache (Lens 3):** Elegant for pagination/sort/refresh and avoids a server disk store, but **deliberately violates NFR-001** (browser storage cannot set POSIX `0600` and cannot be cleared by the server's plugin-uninstall/disable/project-unregister lifecycle hooks) and FR-001's on-disk-server framing. Rejected on the security invariant; its good ideas (native `isRefetching`/`dataUpdatedAt`) are folded into the chosen client work.

## Components

| Name                                                      | Kind    | New / existing / extended | Responsibility                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CutListQueryService**                                   | service | new                       | Owns the cut-list first-page query pipeline: param construction, sort/exclusion resolution, read-through stale-while-revalidate cache, dedup, stall-detection; returns a structured result with cache status.                                                                                                                                 |
| **DiskSnapshotStore**                                     | module  | new                       | Internal to CutListQueryService: serialises/reads cache entries as JSON under `~/.roubo/`, enforces mode `0600`, validates the cache schema version on read, treats corrupt/version-mismatched files as a cold miss, and evicts by plugin / project.                                                                                          |
| **PluginSortFieldsService**                               | service | new                       | Wraps the new `getSortFields` plugin RPC with a `MethodNotFound` fallback that returns an empty list (host then renders no picker, no error), mirroring `plugin-filter-facets`.                                                                                                                                                               |
| **issues route**                                          | module  | extended                  | Thinned to parse query inputs (`cursor`, `pageSize`, `labels`, `search`, `sortBy`, `sortDir`), delegate to CutListQueryService, and serialise the result; cache/sort logic moves out. Adds a sort-fields read endpoint.                                                                                                                       |
| **plugin-activation (resolveExclusion / resolveSources)** | module  | extended                  | `resolveExclusion` default gains the In Progress category alongside Done (FR-012); resolves the per-project `sortBy`/`sortDir` (FR-013/FR-017) for the service to consume.                                                                                                                                                                    |
| **plugin-manager**                                        | service | extended                  | `HOST_API_VERSION` bumped 1.1.0 to 1.2.0 (NFR-008); no structural change (the `MethodNotFound` contract already exists).                                                                                                                                                                                                                      |
| **project-registry (unregisterProject)**                  | service | extended                  | Calls `CutListQueryService.evictProject(projectId)` so project unregister clears disk cache (FR-004, NFR-001).                                                                                                                                                                                                                                |
| **shared config schema (IntegrationConfig)**              | library | extended                  | Adds optional `sortBy: string` and `sortDir: 'asc'\|'desc'` to the integration block + per-user override, alongside existing `excludedStatusCategories`/`pageSize` (FR-017).                                                                                                                                                                  |
| **shared types (ListIssuesParams, SortField)**            | library | extended/new              | `ListIssuesParams` gains optional `sortBy`/`sortDir`; new `SortField` descriptor (`id`, `label`, `defaultDir`) mirrored into `@roubo/plugin-sdk`.                                                                                                                                                                                             |
| **useIssues hook**                                        | module  | extended                  | Converts from `useInfiniteQuery` to a single-page paged query with client-retained cursor history; exposes `hasPrev`/`hasNext`/`prevPage`/`nextPage`, `isRefetching`, `dataUpdatedAt`, `stale`; passes `sortBy`/`sortDir`.                                                                                                                    |
| **IssueQueuePanel**                                       | client  | extended                  | Replaces the IntersectionObserver infinite-scroll with Prev/Next controls, adds the sort picker (from declared fields), the refresh in-progress spinner, and the last-updated / stale indicator; all controls WCAG 2.1 AA via React Aria (NFR-007). Cursor history resets on filter/sort/source change.                                       |
| **CutListFilterBar**                                      | client  | existing                  | Unchanged; client `applyFilters` retained only as a per-page search-as-you-type enhancement. The existing `cut-list-filter-recompute.perf` test continues to enforce the NFR-005 budget (`applyFilters` p95 < 50ms @ ~500 issues), now over a single page rather than an unbounded list; the per-page scope change does not relax the budget. |
| **github-com plugin**                                     | module  | extended                  | Implements `getSortFields` (created/updated/comments; no native key sort, FR-014); switches milestone facet options to live-only (FR-015); declares the only-to-do approximation (default stays Done-only where no faithful mapping, FR-014).                                                                                                 |
| **ghe plugin**                                            | module  | extended                  | Prerequisite: implements the host-API 1.1.0 `filterFacets`/`getFacetOptions` it currently lacks (FR-016), then `getSortFields` + source-side facet exclusion to reach parity.                                                                                                                                                                 |
| **jira-self-hosted plugin**                               | module  | extended                  | Implements `getSortFields` (JQL `ORDER BY` fields including key), source-side exclusion of resolved epics / archived sprints (FR-015), and In-Progress category exclusion (FR-012).                                                                                                                                                           |
| **migration marker (state.json)**                         | module  | extended                  | One-time only-to-do-default marker written on first post-upgrade launch, consumed by the client banner (FR-018), following the existing migration-record pattern.                                                                                                                                                                             |

## Data model

| Entity                           | Owner                                         | Shape                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CacheKey**                     | CutListQueryService                           | `pluginId: string, pluginVersion: string, instanceHash: string (hash of the integration endpoint/instance), projectId: string, sources: ConfiguredSource[], filters: {labels?, search?}, excludedStatusCategories: string[], excludedStatuses: string[], sortBy: string\|null, sortDir: 'asc'\|'desc'\|null, pageSize: number, cacheSchemaVersion: number`, serialised then SHA-256-hashed for the on-disk filename (FR-003). |
| **DiskCacheEntry**               | DiskSnapshotStore                             | `cacheSchemaVersion: number, cacheKeyHash: string, capturedAt: ISO8601, pluginVersion: string, response: PaginatedIssues` (first page only; **no credentials/tokens** in payload, NFR-001). File written at mode `0600`.                                                                                                                                                                                                      |
| **SortField**                    | shared types / PluginSortFieldsService        | `id: string, label: string, defaultDir: 'asc'\|'desc'` (empty array from the wrapper ⇒ no picker).                                                                                                                                                                                                                                                                                                                            |
| **ListIssuesParams (extended)**  | shared types                                  | existing fields + `sortBy?: string, sortDir?: 'asc'\|'desc'`.                                                                                                                                                                                                                                                                                                                                                                 |
| **IntegrationConfig (extended)** | shared config schema                          | existing fields + `sortBy?: string, sortDir?: 'asc'\|'desc'` (per-project + per-user override, FR-017).                                                                                                                                                                                                                                                                                                                       |
| **CursorHistory**                | useIssues (client React state, not persisted) | `Array<string\|null>` (index 0 is `null` = first page; subsequent entries are returned `nextCursor` values); resets on filter/sort/source change (FR-008).                                                                                                                                                                                                                                                                    |
| **OnlyToDoMigrationMarker**      | state.json                                    | `{ 'only-to-do-default-v1': boolean }` written once on first post-upgrade launch; consumed/cleared by the FR-018 banner dismiss.                                                                                                                                                                                                                                                                                              |

PRD-supplied invariants: cache files **must** be mode `0600` and contain no credentials (NFR-001); the cache key **must** change a cache file's identity when any query-determining input changes (FR-003); a corrupt/partial cache file **must** be treated as a cold miss, never fatal (FR-004, NFR-006).

## Interfaces / contracts

### useIssues (client) → issues route (HTTP)

- **Endpoint:** `GET /api/projects/:projectId/issues?cursor=&pageSize=&labels=&search=&sortBy=&sortDir=`
- **New params:** `sortBy` (string, optional), `sortDir` (`asc`|`desc`, optional; default `asc`).
- **Response:** `200 PaginatedIssues` extended with a cache-status signal (`cacheStatus: 'hit'|'miss'|'revalidating'`, additive) and the existing `stale`/`snapshotCapturedAt`/`excludedCount`/`warnings`/`stalled` fields.
- **Auth:** none beyond the existing local-app session; the active plugin is resolved server-side as today.

### IssueQueuePanel (client) → issues route (HTTP, sort-fields discovery)

- **Endpoint:** `GET /api/projects/:projectId/issues/sort-fields`
- **Response:** `200 SortField[]` (empty array ⇒ host renders no sort picker, FR-011). Read on project/panel load.

### issues route → CutListQueryService (function-call)

- **Contract:** `queryFirstOrPage(projectId, active, { cursor, pageSize, filters, sortBy, sortDir }): Promise<CutListQueryResult>` where `CutListQueryResult = { items, nextCursor, stale?, snapshotCapturedAt?, warnings?, excludedCount?, cacheStatus }`.
- The route does no cache or sort logic; it parses inputs and serialises the result.

### CutListQueryService → PluginSortFieldsService → plugin-manager (function-call ⇒ JSON-RPC)

- **Contract:** `getSortFields(pluginId): Promise<SortField[]>` → `pluginManager.invoke<SortField[]>(pluginId, 'getSortFields', undefined, { timeoutMs: 5000 })`.
- **Fallback (NFR-008/FR-011):** `MethodNotFound` (older plugin) ⇒ resolve to `[]`; never throw.

### CutListQueryService → plugin-manager (function-call ⇒ JSON-RPC, listIssues)

- **Contract:** `pluginManager.invoke<PaginatedIssues>(pluginId, 'listIssues', ListIssuesParams)` with `sortBy`/`sortDir` now present. Plugins apply the sort **source-side** so order is stable across pages (FR-010); a plugin ignoring the fields yields its natural order (graceful).

### New plugin RPC: `getSortFields` (host-API 1.2.0)

- **Direction:** host → plugin (JSON-RPC over stdio).
- **Request:** none.
- **Response:** `SortField[]` (`{ id, label, defaultDir }`). Jira returns JQL-sortable fields incl. `key`; github-com/ghe return `created`/`updated`/`comments` (no `key`); a 1.0.0/1.1.0 plugin returns `MethodNotFound`.

### CutListQueryService → DiskSnapshotStore (function-call)

- **Contract:** `get(key: CacheKey): DiskCacheEntry | null` (returns null on miss, corrupt, or schema-version mismatch); `put(key, entry): void` (writes via `atomicWrite`, mode `0600`); `evictPlugin(pluginId): void`; `evictProject(projectId): void`.

### Lifecycle eviction hooks → CutListQueryService (function-call, NFR-001/FR-004)

- `plugin-manager` on uninstall / disable / version-change → `evictPlugin(pluginId)`.
- `project-registry.unregisterProject` → `evictProject(projectId)`.
- Integration reconfiguration changes `instanceHash`/`sources` in the CacheKey, so it self-invalidates (a miss), no explicit hook needed.

## Sequence flows

### Happy path: warm load (stale-while-revalidate)

1. Client opens the cut list; `useIssues` issues `GET .../issues` (first page).
2. CutListQueryService builds the CacheKey, `DiskSnapshotStore.get` returns a fresh-enough entry ⇒ respond immediately with `cacheStatus: 'revalidating'` and the cached page (NFR-002 < 200ms p95).
3. CutListQueryService fires a background `listIssues` revalidation (named async, `.catch` logs per NFR-009, never rejects into the request), and `put`s the new snapshot.
4. Client shows the cached page instantly; React Query refetch (or next load) swaps in fresh data; `dataUpdatedAt`/`isRefetching` drive the FR-006/FR-005 indicators.

### Cold load (cache miss) + write

1. `DiskSnapshotStore.get` misses ⇒ CutListQueryService calls `listIssues`, dedups, stall-detects.
2. On a first-page success it `put`s the snapshot (mode `0600`) and responds `cacheStatus: 'miss'`. Overhead of read+write stays < 50ms (NFR-003).

### Pagination: Prev/Next

1. Next: client passes the current page's `nextCursor`; appends it to CursorHistory.
2. Prev: client re-requests using the prior cursor from CursorHistory (forward-only cursors, so Prev replays a retained cursor).
3. Changing filters/sort/sources resets CursorHistory to `[null]` and returns to page 1 (FR-008); the CacheKey changes so the cache correctly misses for the new shape.

### Sort change

1. User picks a sort field/dir from the picker (populated by `GET .../sort-fields`).
2. The selection persists to the per-project config / per-user override (FR-013/FR-017); the next query carries `sortBy`/`sortDir`; the plugin orders source-side (FR-010).

### Degradation: plugin unavailable

1. `listIssues` throws and the plugin is `errored`/`disabled` ⇒ serve the last snapshot with `stale: true` + `snapshotCapturedAt` (NFR-006), reusing today's banner path.
2. A single authority resolves the disk-store hit vs the in-memory errored-fallback (the in-memory cache remains only for this path until the disk store supersedes it; see Open questions).

## Operational concerns

- **Deployment:** Local Electron + Node app; no hosting change. New on-disk cache directory created under `~/.roubo/` alongside existing state via the established `ensureDirs` pattern. The three bundled plugins + host-API bump ship in one change (no out-of-sync window).
- **Observability (NFR-009):** Log cache hit/miss/revalidating, corrupt-file discards, stale-snapshot serves, and `MethodNotFound` sort fallbacks, with enough context to diagnose and **no** credential/secret material in the payload. Tests assert these events fire (mocked logger) and that the payload excludes credential fields. (Per repo testing rules, source logging must not leak into test stdout: intentional logs are spied/asserted, not emitted.)
- **Scaling:** Single local user; the scaling unit is the number of distinct (project, plugin, sources, filters, sort, pageSize) combinations on disk. DiskSnapshotStore enforces a per-entry size cap and an age/size eviction policy (exact thresholds: open question, Spike A); per-project subdirectories make `evictProject` a single directory removal.
- **Failure modes (NFR-006):** corrupt/partial cache file ⇒ cold miss, never fatal/startup error; background revalidation rejection ⇒ logged and discarded, never crashes the Node process (Node 24 unhandled-rejection default); plugin missing the sort/facet RPC ⇒ default key-ascending order, no picker, no error.

## Security & compliance

Carried from NFR-001: the persistent cache is the first place private GHE/Jira issue content (titles, bodies, assignees) is written to local disk. DiskSnapshotStore writes every entry via a single private helper that hard-codes mode `0600` (a dedicated unit test asserts the on-disk file mode); the cache payload contains **no** credentials or tokens (those remain in the OS keyring via `credential-store`), asserted by test. Cache entries are cleared on plugin uninstall, plugin disable, project unregister, plugin version change, and integration reconfiguration (eviction hooks above + CacheKey self-invalidation); corrupt files are discarded. No statutory regime applies (local tool); no new third-party dependency is introduced (hand-rolled JSON store + Node built-in `crypto`), so no new licensing exposure (consistent with the feasibility compliance verdict).

## Supersedes / PRD deltas

None at the architecture-vs-PRD level: this design honours every PRD `FR-`/`NFR-` as written (it is the server-side shape the PRD assumed). The one intentional behaviour-supersede in play, **FR-012 changing the legacy `integration-plugins` default from Done-only to In-Progress+Done**, is a PRD-vs-prior-shipped-behaviour delta already recorded in the PRD's Dependencies & assumptions (mitigated by the FR-018 migration banner); `align` reconciles it against the legacy spec. The architecture does not introduce any further conflict.

## Open questions

- [x] **Spike A (cache key + invalidation + lifecycle):** finalise the CacheKey field set, the `cacheSchemaVersion` bump strategy, the eviction policy (max entry size, max total size, max age), and whether plugin **disable** (vs uninstall) evicts or keeps the cache warm for re-enable. Write the invalidation test matrix before implementing `makeKey`. **Resolved by Spike 553 (#553):** the 12-field CacheKey and its canonicalisation/SHA-256 filename rule are frozen; `cacheSchemaVersion` starts at 1 and bumps on any envelope/canonicalisation/payload-shape change (mismatch = cold miss); eviction policy is 1 MB/entry, 50 MB total (LRU), 7-day max age; plugin **disable evicts** the disk cache; and the invalidation test matrix is written (traced to CLI-TC-003/005/008).
- [x] **Spike C (per-plugin sort + status mapping):** the authoritative `getSortFields` set per plugin and the only-to-do mapping for category-less GitHub (open/closed; whether GitHub Projects v2 status creates a genuine In-Progress category for FR-014). **Resolved by Spike 554 (#554):** jira-self-hosted declares `key`/`updated`/`created`/`priority`/`rank` (rank instance-conditional); github-com and ghe declare `created`/`updated`/`comments` with no native key sort; the only-to-do default sets Jira `excludedStatusCategories = ["In Progress", "Done"]` while the github family stays Closed-only with no implicit In Progress mapping (Projects v2 "Status" is free-form, so no canonical In-Progress category exists for FR-014).
- [ ] Single authority for the disk-store hit vs the in-memory errored-fallback when both could serve a first-page errored request (and when to retire the in-memory cache entirely).
- [ ] Stale-while-revalidate delivery: does the server return warm data and rely on the client's next refetch, or push a freshness signal (SSE)? Default to client refetch unless Spike A says otherwise.
- [x] For Jira instances without `statusCategory` JQL support, does only-to-do work via the status-name fallback list, or must the user configure exact in-progress status names? **Resolved by Spike 554 (#554):** only-to-do rides the existing `statusCategory`-400 to `excludedStatuses` name-list fallback (cached per instance); a best-effort name list stands in for the In Progress + Done categories, and exact in-progress status names are user-configurable for non-standard workflows.

## Out of scope

- Numbered-page jumps (forward-only cursor contract; Prev/Next only). Full multi-page caching (first-page snapshot only). Client-side sorting. "Hide empty facets". Saved filter/sort presets. Per-individual-source sort/filter overrides. Any change to credential storage (tokens stay in the OS keyring).

## Phase mapping

The PRD does not mandate formal phases, but feasibility recommended shipping the low-risk batch first while the spikes de-risk the two large items. This mapping is advisory for `breakdown`:

| Phase                              | Components delivered                                                                                                                                                                                        | Interfaces live                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Phase 0 (de-risk / prerequisite)   | Spike A (cache contract), Spike C (sort/status mapping), ghe 1.1.0 facet parity (FR-016)                                                                                                                    | ghe `filterFacets`/`getFacetOptions`                                                  |
| Phase 1 (low-risk batch)           | useIssues paged + IssueQueuePanel Prev/Next (FR-007/008), refresh + last-updated indicators (FR-005/006), only-to-do default + resolveExclusion + migration banner (FR-012/013/018)                         | `GET .../issues?...` paged; `resolveExclusion` default change                         |
| Phase 2 (warm cache)               | CutListQueryService + DiskSnapshotStore + lifecycle eviction (FR-001/002/003/004, NFR-001/002/003/006/009); thin issues route                                                                               | `queryFirstOrPage`, `evictPlugin`/`evictProject`, disk store                          |
| Phase 3 (ordering + facet hygiene) | PluginSortFieldsService + `getSortFields` across 3 plugins + host sort picker (FR-009/010/011, NFR-008); source-side facet exclusion across 3 plugins (FR-015); config + shared-type/sdk additions (FR-017) | `GET .../issues/sort-fields`; `getSortFields` RPC; `sortBy`/`sortDir` in `listIssues` |
