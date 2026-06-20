# PRD: Cut list performance, ordering, and filtering improvements

|                 |                       |
| --------------- | --------------------- |
| **Slug**        | cut-list-improvements |
| **Status**      | draft                 |
| **Brief**       | ./brief.md            |
| **Feasibility** | ./feasibility.md      |

## Problem statement

The cut list (the list of pickable work items a Roubo user draws from to start a bench) is slow and noisy in daily use, and the friction compounds for the users who need it most (large backlogs on GitHub Enterprise or self-hosted Jira). Every load is a full round-trip to the external system through the active integration plugin; the only cache (`server/services/issue-snapshot-cache.ts`) is in-memory, first-page-only, and serves solely as a crash fallback, and React Query holds results for just 30s. The refresh control gives no feedback. There is no deterministic order (`ListIssuesParams` has no sort field), so the list reshuffles between loads. In-progress work is shown even though the cut list is for picking up _new_ work (today only Done-category issues are excluded). Closed/done/archived milestones and epics still clutter the filter choices. And the infinite-scroll list becomes unnavigable at scale. Feasibility returned **DE-RISK**: the work is buildable and additive, gated on three spikes (cache invalidation contract, the confirmed GHE facet-contract prerequisite, and per-plugin sort/status capability mapping).

## Goals & non-goals

- **Goals:** make the cut list measurably faster to load (cold and warm) and instant on revisit; give it a deterministic, configurable order; show only actionable to-do items by default; keep filter choices live; replace infinite scroll with pagination; make refresh legible. Extend the integration plugin contract (sort RPC, source-side facet exclusion, status mapping) to support these as plugin capabilities configured per project.
- **Non-goals:** numbered-page jumps, saved filter/sort presets, per-source sort/filter overrides, "hide empty facets", client-side sorting, full paginated caching (only the first-page snapshot is cached), and any change to credential storage (tokens stay in the OS keyring).

## In scope

- Persistent, on-disk, first-page warm cache with stale-while-revalidate, surviving app restart.
- Visible refresh in-progress state and a last-updated / stale-snapshot indicator.
- Prev/Next pagination replacing infinite scroll, reusing the configured page size.
- A new host-API plugin RPC by which a plugin declares its supported sort fields; a host-rendered sort picker; default ascending by item key; sort applied source-side.
- Default in-query exclusion of both In Progress and Done status categories (only-to-do), configurable per project.
- Source-side exclusion of closed/done/archived facet values from filter options.
- Bringing the GitHub Enterprise plugin up to the existing host-API 1.1.0 filter-facet contract (a confirmed prerequisite).
- Per-project storage of the new tunables (sort field/direction, status exclusion) via the `roubo.yaml` integration block + per-user override, with plugin-declared capabilities.
- A one-time migration notice for the only-to-do default flip.

## Out of scope

- Numbered-page jumps (forward-only cursor contract; would need a contract extension). Possible follow-up.
- Saved filter/sort presets. Possible follow-up.
- Per-individual-source sort/filter overrides. Possible follow-up.
- "Hide empty facets" (only show a filter if items use it): dropped because it cannot be correct client-side under pagination and is costly server-side. A selected-but-empty facet simply returns zero results.
- Client-side sorting (all ordering is source-side for cross-page correctness).
- Full multi-page caching (only the first-page snapshot is the warm hint).

## User stories

- **CLI-US-001** As a Roubo user, I want the cut list to appear quickly when I open it (and after relaunch), so I can start work without waiting on the external system. _(P0)_
- **CLI-US-002** As a Roubo user, I want clear feedback when the cut list is refreshing and when its data was last updated, so I know whether I am looking at current data. _(P1)_
- **CLI-US-003** As a Roubo user with a large backlog, I want to page through the cut list (Prev/Next) instead of an endless scroll, so a long list stays navigable. _(P0)_
- **CLI-US-004** As a Roubo user, I want the cut list to have a stable, deterministic order (default by item key) and to choose how it is sorted, so the same item is in the same place each time. _(P0)_
- **CLI-US-005** As a Roubo user, I want the cut list to show only actionable (to-do) items by default, hiding in-progress and done work, so I am only choosing from what is ready to pick up. _(P0)_
- **CLI-US-006** As a Roubo user, I want filter choices to exclude stale closed/done/archived milestones and epics, so I am not cluttered with dead filter options. _(P1)_
- **CLI-US-007** As a Roubo project owner, I want these cut-list behaviours configured per project (driven by what the active plugin supports), so my team shares consistent settings. _(P1)_
- **CLI-US-008** As an existing Roubo user upgrading, I want to be told when the new default hides my in-progress items, so the behaviour change is not a silent surprise. _(P1)_

## Functional requirements

- **CLI-FR-001** The host maintains a persistent, on-disk, first-page issue snapshot cache that is served immediately when the cut list loads, including after an application restart. _(serves CLI-US-001; P0)_
- **CLI-FR-002** After serving a cached snapshot, the cut list revalidates in the background and swaps in fresh data when it arrives (stale-while-revalidate). _(serves CLI-US-001, CLI-US-002; P0)_
- **CLI-FR-003** The cache key incorporates every query-determining input (plugin id, plugin version, integration instance/endpoint, project, sources, filters, excluded status categories/statuses, sort field, sort direction, page size) plus a cache schema version, so any change to those inputs yields a cache miss rather than a stale-shaped hit. _(serves CLI-US-001; P0; resolves feasibility Spike A)_
- **CLI-FR-004** Cache entries are evicted on plugin uninstall, plugin disable, project unregister, plugin version change, and integration reconfiguration; an unparseable or partially written cache file is treated as a cold miss and never causes a fatal or startup error. _(serves CLI-US-001; P0; resolves feasibility Spike A)_
- **CLI-FR-005** The cut-list refresh control shows a visible in-progress state while a refresh is running. _(serves CLI-US-002; P1)_
- **CLI-FR-006** The cut list displays when its data was last updated, and indicates distinctly when it is showing a cached/stale snapshot (e.g. the plugin is unavailable); when a stale snapshot is shown because the plugin is unavailable, the cut list offers a retry action to re-attempt the refresh. _(serves CLI-US-002; P1)_
- **CLI-FR-007** The cut list presents one page at a time with Prev/Next controls, replacing infinite scroll, reusing the configured page size (default 50). _(serves CLI-US-003; P0)_
- **CLI-FR-008** Prev navigation returns to the previous page using client-retained cursors; changing filters, sort, or sources resets navigation to the first page. _(serves CLI-US-003; P0)_
- **CLI-FR-009** Each integration plugin declares the sort fields it supports via a new host-API RPC, and the host renders a sort picker from the declared fields. _(serves CLI-US-004; P0; resolves feasibility Spike C)_
- **CLI-FR-010** The cut list defaults to ascending order by item key, and the selected sort is applied source-side so ordering is stable across pages. _(serves CLI-US-004; P0)_
- **CLI-FR-011** A plugin that does not implement the sort RPC degrades gracefully: the host renders no sort picker and uses the plugin's natural / key-ascending order, surfacing no error. _(serves CLI-US-004; P0)_
- **CLI-FR-012** By default the cut list excludes both the In Progress and Done status categories in-query, showing only to-do items. _(serves CLI-US-005; P0)_
- **CLI-FR-013** The status-category exclusion set is configurable per project (extending `excludedStatusCategories`), so a project can re-include In Progress; the actionable to-do category (Jira "To Do", GitHub open) can never be excluded, since it is the set the cut list draws from. _(serves CLI-US-005, CLI-US-007; P0)_
- **CLI-FR-014** For integrations without native status categories (e.g. GitHub open/closed), the plugin maps the to-do exclusion to its closest available approximation, and the default stays Done-only when no faithful mapping exists. _(serves CLI-US-005; P1; resolves feasibility Spike C)_
- **CLI-FR-015** Integration plugins exclude closed/done/archived facet values (e.g. closed milestones, resolved epics) from the filter options they return, so only live choices appear. _(serves CLI-US-006; P1)_
- **CLI-FR-016** The GitHub Enterprise plugin implements the host-API 1.1.0 filter-facet contract (`filterFacets` / `getFacetOptions`) as a prerequisite to source-side facet exclusion and sort support on GHE. _(serves CLI-US-006, CLI-US-004; P0; resolves feasibility Spike B, confirmed gap)_
- **CLI-FR-017** The new tunables (sort field/direction, status-category exclusion) are stored per project via the `roubo.yaml` integration block plus the per-user override, with the available options determined by what the active plugin declares it supports. _(serves CLI-US-007; P0)_
- **CLI-FR-018** On first launch after upgrade, a one-time dismissible notice explains the new only-to-do default and links to the exclusion control, so the behaviour change is not silent. _(serves CLI-US-008; P1)_

## Non-functional requirements

Each NFR has a measurable target and a verification method.

- **CLI-NFR-001** _(Security)_ The persistent cache protects private issue content (titles, bodies, assignees from private GHE/Jira). **Target:** cache files written owner-only (mode `0600`); the cache payload contains no credentials or tokens (those remain in the OS keyring); cache entries are cleared on plugin uninstall, plugin disable, project unregister, plugin version change, and integration reconfiguration; corrupt files are discarded. **Verify:** unit test asserting file mode `0600`; assertion that a serialized cache entry contains none of the credential field names; eviction tests per lifecycle event; `security`-type test case.
- **CLI-NFR-002** _(Performance)_ Warm cut-list load is near-instant when a snapshot exists. **Target:** first meaningful paint < 200ms p95 on revisit and after an application relaunch (snapshot present). **Verify:** performance test / timing instrumentation around cut-list mount; `performance`-type test case.
- **CLI-NFR-003** _(Performance)_ Caching adds negligible overhead and does not regress cold load. **Target:** cache read+write adds < 50ms per request; cold first-load latency is no worse than today beyond the snapshot write. **Verify:** before/after benchmark of the issues route with caching enabled vs disabled.
- **CLI-NFR-004** _(Performance)_ Paging is responsive. **Target:** a Prev/Next page step renders in < 150ms p95 from loaded/cached state (fresh fetches are bounded by the external system, not this budget). **Verify:** performance test on the pagination interaction.
- **CLI-NFR-005** _(Performance)_ Client-side filtering stays cheap. **Target:** `applyFilters` p95 < 50ms for ~500 issues (retains the existing budget, cf. the existing `cut-list-filter-recompute.perf` test). **Verify:** the existing/extended client perf test.
- **CLI-NFR-006** _(Reliability / graceful degradation)_ Every failure path degrades safely and is indicated. **Target:** a corrupt cache file is treated as a cold miss (never fatal); an errored/disabled plugin serves the last snapshot with a visible stale indicator; a plugin missing the sort/facet RPC falls back to defaults (key-ascending, no picker) with no error surfaced. **Verify:** fault-injection tests per path (corrupt file, plugin down, `MethodNotFound`).
- **CLI-NFR-007** _(Accessibility)_ The new controls (Prev/Next pagination, sort picker, refresh in-progress state) meet WCAG 2.1 AA. **Target:** full keyboard operation, screen-reader labels and announcements (refresh state and page changes announced), visible focus, built with React Aria Components per repo convention. **Verify:** accessibility unit tests plus a manual keyboard/screen-reader pass; `accessibility`-type test case.
- **CLI-NFR-008** _(Compatibility / backward-compat)_ Adding the sort RPC does not break existing plugins. **Target:** the host-API minor bump (1.1.0 to 1.2.0) is non-breaking; plugins built against 1.0.0/1.1.0 keep working via the `MethodNotFound` fallback (CLI-FR-011) with no sort picker shown and no incompatibility error. **Verify:** contract test invoking the sort RPC against a stub plugin that does not implement it.
- **CLI-NFR-009** _(Observability)_ Cache behaviour and degradation are diagnosable. **Target:** cache hit/miss outcomes and degradation events (corrupt-file discard, stale-snapshot serve, RPC fallback) are logged with enough context to diagnose, without writing any new secret/credential material to logs. **Verify:** unit test asserting the log events fire on the relevant paths (mocked logger), and that the log payload excludes credential fields.

## Success indicators

### Leading

| Indicator                           | Baseline                                | Target                                                     | Source                                    | Validates                          |
| ----------------------------------- | --------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| Warm cut-list time-to-first-paint   | unmeasured (no warm cache today)        | < 200ms p95                                                | perf test / mount timing instrumentation  | CLI-US-001, CLI-FR-001, CLI-FR-002 |
| Cold first-load latency vs today    | current p95 (to be captured pre-change) | measurable reduction (or no regression beyond cache write) | route benchmark                           | CLI-US-001, CLI-FR-003             |
| Cache hit rate on cut-list load     | 0% (warm cache is new)                  | majority of loads served warm in a typical session         | in-app cache metric (CLI-NFR-009)         | CLI-FR-001                         |
| Repeated refresh clicks per session | unmeasured                              | reduced (feedback removes the "did it work?" re-click)     | client interaction logging (if available) | CLI-US-002, CLI-FR-005             |

### Lagging

| Indicator                              | Baseline                  | Target                | Source                                              | Validates   |
| -------------------------------------- | ------------------------- | --------------------- | --------------------------------------------------- | ----------- |
| Time from cut-list-open to bench start | unmeasured                | reduced               | usage telemetry (if available) / manual task-timing | the feature |
| Cut-list slowness/noise reports        | current volume (informal) | reduced after release | user feedback channel                               | the feature |

_(Roubo is a local developer tool, so production usage telemetry may be limited. The leading perf indicators are validated via the test/benchmark harness rather than a production analytics pipeline; the lagging indicators are tracked through the user-feedback channel and manual task-timing where telemetry is unavailable. `align`/`review` should treat the perf-test budgets, not an analytics dashboard, as the instrumentation of record.)_

## Dependencies & assumptions

- **Spike-gated (from feasibility DE-RISK):** Spike A (cache key + invalidation + lifecycle contract) and Spike C (per-plugin sort + status mapping) should be resolved before/early in the build; Spike B is resolved (GHE confirmed to lack the 1.1.0 facet contract; CLI-FR-016 closes it).
- The persistent cache stores only the **first-page** snapshot (matching today's in-memory behaviour) as a warm hint; full paginated caching is out of scope.
- The on-disk cache is a hand-rolled JSON store under `~/.roubo/` via the existing `atomicWrite` primitive (no SQLite, no new caching library), keeping the dependency footprint zero.
- The host-API bump to 1.2.0 is a non-breaking minor; the three bundled plugins (github-com, ghe, jira-self-hosted) live in this monorepo and are updated atomically in one change.
- The Prev/Next cursor history lives in client React state and resets on reload/panel close (acceptable for v1).
- Client-side `applyFilters` is retained only as a per-page search-as-you-type enhancement; all filtering that determines which items are fetched moves source-side.
- **Supersedes prior behaviour (drift to reconcile in `align`):** CLI-FR-012 intentionally changes the shipped default established by the legacy `integration-plugins` spec (today the default excludes only the Done category). The only-to-do default (exclude In Progress + Done) is a deliberate behaviour change, mitigated by the CLI-FR-018 migration notice; `align` should reconcile this against the legacy spec rather than flag it as accidental drift.

## Open questions

- [x] Persistent-cache eviction policy specifics: max entry size, max total directory size, max age (a 50-issue page with `raw` fields can be ~50-200 KB/entry). **Resolved by Spike 553 (#553):** per-entry cap 1 MB, total directory bound 50 MB (LRU eviction by mtime), max age 7 days, enforced opportunistically on `put` with read-time age rejection.
- [x] Cache key/filename strategy: hashing the composite key to respect filesystem name-length limits; one file per (project + plugin + signature) vs a single store. **Resolved by Spike 553 (#553):** serialise the 12 key fields in a fixed order with per-field canonicalisation, then SHA-256-hash to the on-disk filename; one file per key under a per-project subdirectory (so `evictProject` is a single directory removal).
- [x] For Jira instances without `statusCategory` JQL support (the legacy CLI-TC-037 path), does only-to-do work via the status-name fallback list, or must the user configure the exact in-progress status names? **Resolved by Spike 554 (#554):** the only-to-do default rides the existing `statusCategory`-400 to `excludedStatuses` name-list fallback; a best-effort name list seeds it, and exact in-progress status names are user-configurable where the workflow is non-standard (never silently inferred).
- [x] Does GitHub Projects v2 custom status create a genuine "In Progress" category the GitHub plugin could exclude, or is it strictly open/closed (bounding CLI-FR-014's approximation)? **Resolved by Spike 554 (#554):** the Projects v2 "Status" column is user-defined and free-form (and absent on the plain repo path), so there is no canonical In Progress category; the github family stays Closed-only by default and applies no implicit In Progress mapping (the CLI-FR-014 carve-out), with In Progress exclusion opt-in via `excludedStatuses`.
- [ ] On upgrade, do existing projects with no `excludedStatusCategories` set inherit the new in-progress-excluded default before or after the CLI-FR-018 notice is shown?
- [x] Does disabling (not uninstalling) a plugin evict the disk cache, or intentionally keep it warm for re-enable (interacts with CLI-NFR-001 clearing and CLI-FR-004)? **Resolved by Spike 553 (#553):** the disk cache evicts on disable (honouring CLI-NFR-001), deliberately diverging from the in-memory cache, which keeps its snapshot warm to serve the disabled-plugin stale fallback (CLI-NFR-006).
