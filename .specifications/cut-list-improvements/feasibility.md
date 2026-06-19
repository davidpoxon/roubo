# Feasibility: Cut list performance, ordering, and filtering improvements

> **Recommendation: DE-RISK**: every dimension is feasible-with-conditions at high confidence and the work is additive, but two high-severity risks (persistent-cache invalidation correctness and a silent default-behaviour flip on upgrade) plus an undeclared prerequisite (the GHE plugin may not yet implement the existing facet contract) must be resolved with spikes before committing the build.

**Brief:** ./brief.md

## Per-dimension summary

| Dimension | Verdict | Confidence | Top risk | Mitigation |
|-----------|---------|------------|----------|------------|
| Technical | feasible-with-conditions | high | Persistent-cache key omits sort / status-exclusion / pageSize, so a config change silently serves a stale-shaped snapshot | Extend the cache key to all query-determining params + a cache schema version that rejects older-shaped files on load |
| Effort / delivery | feasible-with-conditions | high | The plugin-declared sort RPC is a coordinated host-API bump across SDK + 3 plugins, and GHE has not implemented the existing 1.1.0 facet contract yet | Make the RPC additive with a MethodNotFound fallback; treat the GHE facet gap as a filed prerequisite; ship the low-risk batch (refresh, only-to-do, pagination) first |
| Operational / scale | feasible-with-conditions | high | The only-to-do default flip silently removes in-progress items for existing users on upgrade | One-time dismissible migration banner keyed to a state.json marker, linking to the exclusion control |
| Compliance / data | feasible-with-conditions | high | The persistent cache is the first place private GHE/Jira issue content is written to plaintext disk under ~/.roubo/ | Write the cache file mode 0o600 via atomicWrite; wire eviction to plugin uninstall / disable / project unregister; hand-roll a JSON store (no new dependency) |

## Dimension detail

### Technical (feasible-with-conditions, high)

All six capabilities have clear primitives and well-established code patterns, so the work is additive rather than structural. The persistent warm cache is the largest single piece and carries the most risk; the sort RPC is the most cross-cutting.

- **Persistent warm cache (CAP-1).** `server/services/issue-snapshot-cache.ts` is in-memory, first-page-only, crash-fallback-only. Its `makeKey()` (`issue-snapshot-cache.ts:28-34`) composes pluginId+projectId+sources+filters but **not** sort, `excludedStatusCategories`, or pageSize, so the key must be extended before persistence is safe. `server/services/state.ts:53` `atomicWrite` + the `~/.roubo/` convention give a ready write path; eviction, TTL/size cap, and stale-while-revalidate promotion are entirely new.
- **Stale-while-revalidate / refresh feedback (CAP-1/CAP-2).** `useIssues.ts` already uses `useInfiniteQuery` with `staleTime: 30_000` (`useIssues.ts:57`); React Query `placeholderData`/`initialData` can serve the on-disk snapshot immediately then revalidate. `query.isRefetching` and `query.dataUpdatedAt` are native fields not currently destructured; surfacing them drives both the in-progress spinner and the last-updated indicator. The `RefreshCw` button already exists (`IssueQueuePanel.tsx:208-213`) and just needs a spinning state.
- **Prev/Next pagination (CAP-3).** Purely client-side: retain visited cursors in an array (first cursor `null`, then each page's `nextCursor`). No server or plugin change; the forward-only opaque-cursor contract (`shared/types.ts:1120-1136`) is respected. Grouping collapse state (`IssueQueuePanel.tsx:109-113`) is currently keyed on the full set and must be re-scoped to a single page.
- **Plugin-declared sort fields (CAP-4).** No sort exists anywhere; `ListIssuesParams` (`shared/types.ts:1092-1107`) has no `sortBy`/`sortDir`. A new RPC must follow the `server/services/plugin-filter-facets.ts` pattern with a `MethodNotFound` fallback defaulting to key-ascending. `HOST_API_VERSION` is `1.1.0` (`server/services/plugin-manager.ts:32`) and must bump to `1.2.0`, with `@roubo/plugin-sdk` + all three bundled plugins updated. Jira supports arbitrary JQL `ORDER BY` (the JQL builder currently hard-codes `ORDER BY updated ASC`); GitHub REST exposes only created/updated/comments, with no native key sort.
- **Only-to-do default (CAP-5).** `resolveExclusion` (`server/services/plugin-activation.ts`) already does the three-layer merge; adding "In Progress" to the default is a manifest/config-schema default change. GitHub (open/closed, no native category) cannot represent "In Progress" without a user-defined label convention, so the mapping is lossy and must be documented.
- **Source-side facet exclusion (CAP-6).** Already feasible and partly precedented: Jira's `getFacetOptions('epic')` already filters `resolution = Unresolved`; GitHub's milestone fetch uses `state: 'all'` and switching to `state: 'open'` is a one-line change (mirrored in GHE).

### Effort / delivery (feasible-with-conditions, high)

Aggregate size **L** (~6-10 engineer-weeks of focused full-stack work). Per capability: refresh feedback **S**; only-to-do **S-M**; pagination **M**; source-side facet exclusion **M** (x3 plugins); persistent cache **L**; sort RPC **L** (cross-cutting). The two large items are independent of each other but both gate a clean e2e story, and the 80% coverage gate (`vitest.config.ts`) applies to every layer including all three plugins.

- **Recommended sequencing:** ship the lower-risk batch first (refresh feedback, only-to-do default, pagination), then the two large cross-cutting items (cache, sort RPC).
- **What makes this 3x longer:** the cache invalidation matrix; the 3-plugin coordination for sort + facet exclusion; and the **GHE facet-contract gap** (**CONFIRMED** during this stage: `github-com` registers `filterFacets` + `getFacetOptions` at `plugins/github-com/src/index.ts:37-38`, but `plugins/ghe` has neither method file nor registration, so GHE has not implemented the existing host-API 1.1.0 facet contract at all). Closing that gap is an unplanned prerequisite to source-side facet exclusion and the sort RPC on GHE.

### Operational / scale (feasible-with-conditions, high)

Roubo is a local Electron + Node tool (no hosting/on-call), so this is runtime robustness on the user's machine. Three failure modes need explicit mitigation:

- **Stale persistent cache** served after a sort / status-exclusion / sources / instance change if those are not in the key (high).
- **Silent default flip:** existing users lose in-progress items on upgrade with no explanation; the setting is reachable in `PluginConfigureDialog.tsx` but only if found (high).
- **Prev with forward-only cursors** is client-stateful; when external data shifts between steps the stored cursor re-fetches a different set, recoverable only as a "results may have changed" hint (medium). Existing per-page (`issues.ts:99-103`) and cross-page (`useIssues.ts:66-76`) dedupe defend against duplicates but cannot recover vanished items.
- Corrupt/partial-write cache files must be treated as a cold miss, never a fatal startup error. Plugin version change should invalidate (include the version in the key). Extra source-side facet queries are bounded by the existing 5s RPC timeout (worst case: empty dropdown, not an error).

### Compliance / data (feasible-with-conditions, high)

No statutory regulation applies (local tool, developer is their own data controller), so the dimension is narrow: the persistent cache is the **first** place private enterprise issue content (titles, bodies, assignees from private GHE / self-hosted Jira) is written to plaintext disk under `~/.roubo/`. Tokens stay in the OS keychain (`credential-store.ts`), never in the cache.

- All existing `~/.roubo/` state is plaintext JSON via `atomicWrite` (`state.ts:53-66`), so a plaintext cache is consistent, but `atomicWrite` defaults to mode `0o666`; the cache should be `0o600`.
- The in-memory cache is cleared on plugin uninstall/disable/shutdown (`plugin-manager.ts:836,1034`); a disk cache also needs **project-unregister** eviction (`project-registry.ts` does not touch the cache today) and **integration-instance** keying so a snapshot from a prior Jira tenant is never served.
- Hand-roll the JSON store (reuse `atomicWrite`); introduce no caching library, so zero new license risk.

## Top risks (ranked, cross-dimension)

1. **Persistent-cache invalidation correctness** (high; flagged by technical, effort, operational, compliance): the on-disk snapshot must miss on any change to plugin id, **plugin version**, integration **instance/endpoint**, sources, filters, `excludedStatusCategories`/`excludedStatuses`, `sortBy`/`sortDir`, and pageSize, plus a cache `schema_version`. Owner: Spike A.
2. **Silent default-behaviour flip on upgrade** (high; operational): only-to-do removes in-progress items existing users relied on, with no notice. Owner: a one-time migration banner (state.json marker, mirroring the existing `MigrationRecord` pattern).
3. **GHE facet-contract prerequisite** (high; effort): **CONFIRMED** that GHE does not implement the existing 1.1.0 `filterFacets`/`getFacetOptions` (github-com does; GHE has no such method or registration), which the sort RPC and source-side facet exclusion build on. Owner: a filed prerequisite issue to bring GHE up to the 1.1.0 facet contract before the sort/facet-exclusion work on GHE (Spike B is now a scoping task, not a discovery one).
4. **Per-plugin sort + status capability divergence** (medium; technical/operational): GitHub has no native key sort and no "In Progress" category. Owner: Spike C (capability mapping) + additive `MethodNotFound` fallback so the host never offers a sort/category a plugin can't honour.
5. **Cache data-at-rest of private issue content** (medium; compliance): mode `0o600` + lifecycle eviction (uninstall/disable/unregister) + instance keying.
6. **Stable sort across page boundaries under concurrent mutation** (low; operational): document as best-effort, consistent with the existing dedupe rationale (issue #548); do not promise strict no-skip/no-duplicate across live edits.

## De-risking plan (resolve before / early in the build)

- [x] **Spike A: Persistent-cache key + invalidation + lifecycle contract.** Define the full composite key (pluginId + plugin version + integration instance/endpoint hash + projectId + sources + filters + `excludedStatusCategories`/`excludedStatuses` + `sortBy`/`sortDir` + pageSize), a cache `schema_version` (reject older-shaped files on load), stale-while-revalidate semantics (first-page-only snapshot vs paginated state), eviction policy (size/age cap), corrupt-file recovery (parse failure = cold miss, never fatal), file mode `0o600`, and the eviction hooks (plugin uninstall/disable, project unregister, plugin version change, integration reconfig). Write the invalidation **test matrix** before code. Resolves risks 1 and 5. **Resolved by Spike 553 (#553):** the 12-field SHA-256 cache key is frozen, with the `cacheSchemaVersion` bump strategy, a 1 MB/50 MB/7-day eviction policy, evict-on-disable, and the invalidation test matrix all settled.
- [x] **Spike B: Confirm the GHE facet-contract status.** RESOLVED during feasibility: `plugins/ghe` does **not** implement `filterFacets`/`getFacetOptions` (host-API 1.1.0), while `github-com` does (`plugins/github-com/src/index.ts:37-38`). Action carried forward: file a prerequisite issue to bring GHE up to the 1.1.0 facet contract before the sort RPC and source-side facet exclusion land on GHE. Resolves risk 3.
- [x] **Spike C: Per-plugin sort + status-category capability mapping.** For each of GitHub.com / GHE / Jira, enumerate the sort fields the plugin can honour source-side (Jira JQL `ORDER BY`; GitHub created/updated/comments; no native key sort) and the status-category mapping for only-to-do (Jira native categories; GitHub open/closed has no "In Progress"). Decide GitHub defaults: stay `excludedStatusCategories: ["Done"]` and declare a limited/empty sort-field set rather than a lossy implicit label mapping. Resolves risk 4 and the host-API graceful-degradation design. **Resolved by Spike 554 (#554):** Jira sorts key/updated/created/priority/rank (rank instance-conditional) with native In Progress + Done exclusion; github-com/ghe sort created/updated/comments with no native key sort and stay Closed-only (no implicit In Progress mapping).

_(These become `spike` issues when `breakdown` runs.)_

## Recommendation

**DE-RISK**: proceed to `/product-dev:prd`, but resolve Spikes A-C first (or sequence them as the opening work units). The feature is buildable on the existing stack with no structural change; the conditions are about getting cache invalidation provably correct, not surprising existing users with the default flip, and confirming the GHE prerequisite before committing the cross-cutting sort work. The low-risk batch (refresh feedback, only-to-do default with banner, pagination) can ship first while the spikes de-risk the two large items.

## Assumptions to validate

- The persistent cache stores only the **first-page** snapshot (matching today's in-memory behaviour) as the warm hint; full paginated caching is out of scope (it multiplies invalidation complexity).
- The on-disk cache is a **hand-rolled JSON file** under `~/.roubo/` via `atomicWrite` (no SQLite, no caching library) keeping the dependency footprint zero.
- The host-API bump to `1.2.0` is a non-breaking minor; plugins built against 1.0.0/1.1.0 keep working via the `MethodNotFound` fallback on the new sort RPC.
- The three bundled plugins live in this monorepo and can be updated atomically in one PR, eliminating out-of-sync deployment risk.
- The Prev/Next cursor history lives in client React state (resets on reload/panel close), acceptable for v1.
- Client-side `applyFilters` is retained only as a per-page search-as-you-type enhancement; all filtering that determines which items are fetched moves source-side.

## Open questions

- [x] Persistent-cache eviction policy specifics: max entry size, max total directory size, max age (a 50-issue page with `raw` fields can be ~50-200 KB/entry). **Resolved by Spike 553 (#553):** 1 MB/entry, 50 MB total (LRU), 7-day max age.
- [x] Cache key/filename strategy: composite-key hashing to respect filesystem name-length limits; per-project file vs single store. **Resolved by Spike 553 (#553):** SHA-256 hash of the canonicalised 12-field key; one file per key under a per-project subdirectory.
- [x] For Jira instances without `statusCategory` JQL support (TC-037 path in the legacy spec), does only-to-do work via the status-name fallback list, or must the user configure exact in-progress status names? **Resolved by Spike 554 (#554):** rides the existing `statusCategory`-400 to `excludedStatuses` name-list fallback; exact in-progress names are user-configurable for non-standard workflows.
- [x] Does GitHub Projects v2 custom status columns create a genuine "In Progress" category that the GitHub plugin could exclude, or is it strictly open/closed? **Resolved by Spike 554 (#554):** the Projects v2 "Status" column is free-form (no canonical In Progress) and absent on the repo path, so the github family stays Closed-only with no implicit In Progress mapping.
- [ ] On upgrade, do existing projects with no `excludedStatusCategories` set inherit the new in-progress-excluded default silently (then banner), or is the banner shown before the default takes effect?
- [x] Should disabling (not uninstalling) a plugin evict the disk cache, or intentionally keep it warm for re-enable? **Resolved by Spike 553 (#553):** the disk cache evicts on disable; the in-memory cache keeps its snapshot warm for the disabled-plugin stale fallback.
