# Brief: Cut list performance, ordering, and filtering improvements

> One-line pitch: Make the cut list fast, deterministically ordered, and free of noise (in-progress work, stale filter choices), with pagination instead of an endless scroll, by extending both the cut list UI and the integration plugin contract.

## Problem

The cut list (the list of pickable work items a user draws from to start a bench) is slow and noisy in daily use, and the friction compounds for the users who need it most. Concretely:

- **Slow loads.** Every load hits the external system (GitHub.com, GitHub Enterprise, self-hosted Jira) through the active integration plugin. The only cache today (`server/services/issue-snapshot-cache.ts`) is first-page-only and serves solely as a crash fallback when a plugin is `errored`/`disabled`; React Query holds results for just 30s (`staleTime: 30_000`). So the first load is always a full round-trip, a relaunch is always cold, and revisits past 30s refetch from scratch.
- **No refresh feedback.** The reload control (`useRefreshIssues`) invalidates the query but surfaces no visible in-progress state, so the user cannot tell whether a refresh is happening, stalled, or done.
- **Non-deterministic order.** There is no sort in the contract (`ListIssuesParams` has no sort field); the plugin's return order wins, so the list can reshuffle between loads and the same item is hard to find twice.
- **Noisy contents.** In-progress work is shown alongside to-do work, even though the cut list is for picking up *new* work. Done-category issues are already excluded in-query (`excludedStatusCategories`), but in-progress is not.
- **Stale filter choices.** Closed/done/archived milestones and epics still appear as filter options, cluttering the picker with choices that match nothing useful.
- **Unnavigable long list.** Infinite scroll (`useInfiniteQuery`) sounds good but, on a large backlog, produces one very long list that is hard to navigate.

Evidence it is real: these were raised directly from daily use, and the prior `integration-plugins` work already logged "cut-list status exclusion + plugin-declared filter facets + chip colour discrimination" as a follow-on (its 2026-05-25 re-interview), so the surface is known to need more.

## Target users

- **Primary:** Roubo users selecting their next work item onto a bench, especially those backed by larger backlogs on GitHub Enterprise or self-hosted Jira, where the list is long and the external round-trip is slow. They want to open the cut list, see the right to-do items immediately and in a stable order, and start work.
- **Not the user:** Plugin authors as such (the SDK/runtime is prior work, not the focus here, though this adds to the contract they implement), and brand-new users with a handful of issues (they benefit but are not where the pain concentrates).

## Jobs to be done

- "When I want to start work, let me open the cut list and immediately see the actionable (to-do) items, in a predictable order, without waiting on a slow fetch or wading through in-progress items and dead filter choices."
- "When I refresh, tell me clearly that it is working and when the data was last current."

## Current alternatives & their gaps

- **Today's cut list** (infinite scroll, no sort, Done excluded but In Progress shown, snapshot cache only on plugin failure, refresh without feedback): slow on every load, reshuffles, shows non-actionable items, and gets unwieldy at scale.
- **Mirroring/working around slowness** (e.g. living with the 30s React Query window, or just tolerating cold loads): not a fix; the cold first load and relaunch cost remain.

## Core capabilities

1. **Persistent warm cache with stale-while-revalidate.** Serve the last snapshot instantly on load, revalidate in the background, swap in fresh data when it lands, and persist the cache across app restart so cold-start after relaunch is fast too. This is the primary speed lever and the largest single piece of work.
2. **Refresh feedback.** A visible in-progress state on the reload control plus a last-updated indicator, so refresh is legible.
3. **Pagination replacing infinite scroll.** Prev/Next stepping (cursor-based, matching the forward-only opaque-cursor contract), reusing the existing `pageSize` (default 50). No more endless single list.
4. **Plugin-declared sort fields.** A new plugin RPC (mirroring the existing `filterFacets` pattern) by which each plugin advertises the sort fields it actually supports; the host renders the picker and the chosen sort is applied source-side (so it is correct across pages). Default: ascending by item key, giving determinism out of the box.
5. **Only-To-Do by default.** Exclude both In Progress and Done categories in-query (extending today's Done-only exclusion), configurable via `excludedStatusCategories`; plugins without native status categories (GitHub's open/closed) map to the closest approximation.
6. **Source-side facet-value exclusion.** Plugins drop closed/done/archived facet values (e.g. closed milestones, done epics) when returning filter options, so the picker offers only live choices.

Config model for the tunables (pagination mode, sort field/direction, status exclusion, facet exclusion): they are **plugin capabilities**, with the **chosen values stored per-project** via the existing `roubo.yaml` integration block plus the per-user per-project override (`~/.roubo/integrations/<projectId>.yaml`).

## Out of scope (v1)

- **"Hide empty facets"** (only show a filter if items use it). Dropped deliberately: under pagination the client holds only one page so a client-side version would wrongly hide facets that have items on later pages, and a correct server-side version is costly. A selected-but-empty facet simply returns zero results.
- **Numbered-page jumps** ("go to page N"): v1 ships Prev/Next stepping only; arbitrary jumps would need a contract extension beyond forward-only cursors.
- **Saved filter/sort presets** (user-saved combinations).
- **Per-source sort/filter overrides**: v1 settings apply uniformly at the project + plugin level, not per individual source.
- **Client-side sorting**: all ordering is source-side for cross-page correctness.

## Success definition

- **Faster cold first load** (a measurable reduction in first-load latency, the primary metric) **and instant-feeling revisits** (cached content renders immediately, fresh data fills in behind), including after an app relaunch.
- **Correctness:** the list is deterministically ordered (default by item key), shows only to-do items by default, offers only live filter choices, and every load/refresh has clear feedback.

## Open questions & risks

- [ ] **Persistent-cache invalidation correctness** across restart and across config/source/filter changes (the cache key already composes plugin + project + sources + filters; persistence must not serve a snapshot for a now-changed selection).
- [ ] **Per-plugin sort-capability divergence:** GitHub.com / GHE / Jira support different sortable fields; the plugin-declared RPC must degrade gracefully and the host must not offer a sort a plugin cannot honour.
- [ ] **"Only to-do" approximation for category-less systems** (GitHub issues are open/closed with no native to-do/in-progress/done category): define the per-plugin mapping.
- [ ] **Cost and API support for source-side facet-value exclusion:** confirm each external system can cheaply exclude closed/archived milestones/epics in the facet-options query.
- [ ] **Host-API version bump:** the new sort RPC implies a `hostApiVersion` increment and a coordinated `@roubo/plugin-sdk` change across the three bundled plugins; confirm backward compatibility for plugins that do not implement it (default to key sort, no picker).
- [ ] **Pagination + sort interaction:** stable ordering must hold across page boundaries (no item appearing twice or vanishing as pages advance), building on the existing cross-page dedupe (issue #548).

## Source notes

- Raw input: user request to improve the cut list and integration plugins together in a single spec, covering slow loads/caching, refresh-button feedback, filtering (exclude closed milestones/epics at the source; only show in-use filters), pagination vs infinite scroll, deterministic ordering by item key, and hiding in-progress items (show only to-do).
- Related prior art (reference, not parent): the completed legacy-schema spec at `.specifications/integration-plugins/` (uses `flow-state.json`/`work-units.json`, predates the current `manifest.json` contract) built the plugin runtime, the snapshot cache, status-category exclusion (FR-009/FR-010), and plugin-declared filter facets (host-API 1.1.0+). This spec extends that surface. The user explicitly chose a new combined greenfield spec rather than amending the legacy folder.
- Codebase touchpoints: `client/src/hooks/useIssues.ts`, `client/src/components/IssueQueuePanel.tsx`, `CutListFilterBar.tsx`, `client/src/lib/cut-list-filters.ts`, `server/services/issue-snapshot-cache.ts`, `server/routes/issues.ts`, `shared/types.ts` (`ListIssuesParams`, `PaginatedIssues`, `FilterFacet`), `shared/integration-types.ts`, `shared/config-schema.ts` (`IntegrationConfig`), and the three bundled plugins + `@roubo/plugin-sdk`.
- Interview changelog (2026-06-19): resolved pagination = replace infinite scroll (Prev/Next, cursor-based); status = only-to-do by default, configurable; ordering = plugin-declared sort fields, default key ascending, source-side; config = plugin capability with per-project stored values; facet hygiene = source-side exclusion only (hide-empty dropped); performance = persistent warm cache with stale-while-revalidate; success = faster first load plus instant revisit; out of scope = numbered-page jumps, saved presets, per-source overrides, hide-empty facets, client-side sort.
