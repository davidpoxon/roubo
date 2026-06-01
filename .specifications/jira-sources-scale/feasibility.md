# Feasibility: Scale Jira self-hosted source configuration to a Workday-sized instance

> Slug: `jira-sources-scale` · Investigated: 2026-06-01

## Recommendation

build-with-spike — Most pieces have direct prior art (the `getFacetOptions(search?)` async path is the exact pattern the picker needs, and server-side JQL exclusion is a small change), but two things are genuinely net-new and unproven: (1) a searchable/cascading variant of the host picker contract, since today's `listSourceCandidates` is a no-arg load-once RPC with no dependent selection, and (2) confirming the Jira Server/DC API surface for project/board/filter search at scale on the actual Workday instance. Spike both before committing the contract shape.

## Prior art

- **Async facet option search (the load-bearing precedent)** — `plugins/jira-self-hosted/src/plugin.ts:396-412`, `server/routes/integration.ts:454-492`, `client/src/lib/api.ts:832-840` · `getFacetOptions(facetId, search?)` already runs end-to-end: client passes `search`, the route forwards it to the plugin, the plugin returns `FilterFacetOption[]`. This is exactly the request/response contract a searchable source picker needs. The gap is that the plugin currently filters client-side over a 50-item fetch rather than querying Jira with the search term, and the source picker has no equivalent search-bearing endpoint at all.
- **Declarative picker rendering** — `client/src/components/SourcePicker.tsx:25-81` · Host renders `multi-list` (flat) and `categorized-multi-list` (tabbed) from a plugin-returned shape; plugins ship no React. New "searchable" behavior must extend this component, not fork it.
- **`MultiSelect`** — `client/src/components/MultiSelect.tsx:14-101` · React Aria `ListBox` + `Popover`. Purely synchronous over a fixed `items` array, no search input, no async loading state. A searchable picker needs a new control (search input + debounced query + loading/empty states); `MultiSelect` is not reusable as-is for async.
- **Incremental JQL builder** — `plugins/jira-self-hosted/src/jql.ts:26-42` · Builds `(<sources>) AND updated >= "<watermark>" ORDER BY updated ASC`. Extends cleanly: status exclusion is one more `AND (status not in (...))` clause; new source kinds are new `toClause` cases.
- **Boards-as-filters resolution** — `plugins/jira-self-hosted/src/source-picker.ts:72-113` · Boards resolve to their backing filter id via per-board `/board/{id}/configuration` (5-concurrent fan-out). The resolve-on-pick pattern is reusable, but the upfront fan-out over all boards must go (it is a full-list load).
- **`getCurrentUser`** — `plugins/jira-self-hosted/src/plugin.ts:205-218` · Already resolves `/myself` to an externalId/displayName. Directly reusable for the "assigned to me" preset (JQL `assignee = currentUser()` needs no id, but the resolved identity is already available if a literal is preferred).
- **Three-layer + per-source `excludedStatuses` merge** — `server/services/integration-overrides.ts:253-305` · Resolves `sourceLevel ?? rootLevel ?? pluginGlobalDefault`. The resolved list already reaches the cut-list UI; it just needs to be plumbed into the JQL instead of (or in addition to) client-side filtering.
- **Source translation** — `server/services/plugin-source-translation.ts:36-107` · `CATEGORY_TO_KIND` maps picker category ids to plugin `kind` strings. Centrally hardcoded; new categories (`project`, `board`, `mine`) must be added here.
- **Prior spec to extend** — `.specifications/integration-plugins/` (architecture.md FR-019 picker shapes, prd.md FR-023 roubo.yaml block + override, FR-026 incremental JQL, FR-062/063 per-source excludedStatuses). This redesign extends that contract.

## Capability gaps

- **Search input on the source picker contract** — `listSourceCandidates` is declared no-arg (`plugin-sdk/src/types.ts:309`) and is called once with `{ config }` (`server/routes/integration.ts:420`). No way to pass a search term or category scope. · Candidate approach: add a new picker shape (e.g. `searchable-categorized`) plus a search-bearing RPC. Cleanest is to model each source category as the same contract `getFacetOptions` already uses — a `getSourceOptions(categoryId, scope, search, cursor)` call — so the proven async path is reused rather than a second mechanism invented.
- **Dependent/cascading selection (project -> its boards/epics/filters)** — No prior art. The picker contract carries no notion of "selection in field A scopes the options in field B." Both the shape descriptor and the client renderer are single-level today. · Candidate approach: declare per-category a `scopedBy` reference plus pass the current selection as `scope` into the option-fetch RPC; the plugin maps `scope.project` into `projectKeyOrId` / JQL `project = X`. This is the largest net-new design surface.
- **Server-side status exclusion in JQL** — Today exclusion is purely client-side: `client/src/lib/cut-list-filters.ts:91` via `applyFilters(..., { excludedStatuses })` called at `IssueQueuePanel.tsx:170`. Closed issues are fetched, consume page slots, then get hidden. · Candidate approach: pass resolved `excludedStatuses` into `buildIssueListJql` and emit `status not in ("Closed",...)`; keep the client filter as defense-in-depth or remove it (see double-filter risk below).
- **New source kinds in the JQL builder and translation** — `jql.ts:14` `SourceKind` is only `"filter" | "epic"`; `toSourceClauses` (`plugin.ts:429-444`) drops everything else; `CATEGORY_TO_KIND` lacks `project`/`board`/`mine`. · Candidate approach: add `project` (`project = KEY`), `board` (resolve to filter id on pick, reuse `filter =`), `mine` (`assignee = currentUser()`); extend `isJiraSourceKind` and the translation map.
- **Project-scoped, searchable epics** — `fetchEpicIssues` (`source-picker.ts:130-149`) hardcodes `maxResults: 50`, instance-wide, no search, no project scope. · Candidate approach: JQL `project = X AND issuetype = Epic AND resolution = Unresolved AND summary ~ "<search>" ORDER BY updated DESC` with pagination; reuse the existing `/rest/api/2/search` plumbing.
- **roubo.yaml `integration.sources` new shape** — Current schema is open `Record<string, SourceEntry[]>` (`shared/config-schema.ts:243`), so the data model technically already accepts a project-scoped mixed list without a schema change. The gap is semantic, not structural: nothing encodes "this board belongs to project X." · Candidate approach: keep the `Record<category, entry[]>` envelope; encode scope inside the object-form entry (e.g. `{ externalId, project }`) by widening `SourceEntrySchema`. Clean break means no migration read path is required.

## Integration points

- **`listSourceCandidates` RPC + route** — `server/routes/integration.ts:418-428`, `plugin.ts:220-224` · Where a searchable/scoped picker contract attaches. Likely superseded or augmented by per-category option fetches.
- **Facet-options route (template to copy)** — `server/routes/integration.ts:454-492` · Already validates and forwards `search`; the source-option endpoint should mirror it exactly.
- **`buildIssueListJql` / `listIssues`** — `jql.ts:26`, `plugin.ts:226-283` · Where status exclusion and new source kinds attach. The resolved `excludedStatuses` must be threaded from config into `BuildJqlInput`.
- **Source translation map** — `plugin-source-translation.ts:36` · Must learn `project`/`board`/`mine` categories.
- **excludedStatuses resolution** — `integration-overrides.ts:253-305` · The merge already produces a resolved list; the wiring change is making `listIssues` consume it rather than the client.
- **Picker host UI + modal** — `client/src/components/SourcePicker.tsx`, mounted in `client/src/components/PluginConfigureDialog.tsx:594-600` inside a `Modal`/`Dialog` with `max-h-[85vh]` + `overflow-hidden` (`PluginConfigureDialog.tsx:220-221`). This `overflow-hidden` on the dialog is the clipping culprit for the in-flow dropdown.
- **Config schema** — `shared/config-schema.ts:224-256` · `SourceEntrySchema` / `IntegrationConfigSchema` widen here if scope is encoded on entries.

## Risks

### Technical
- The picker contract has no async-search or cascading-selection precedent; the shape must be designed from scratch and is the spine of the feature. — Resolution: spike a `searchable-categorized` shape + a `getSourceOptions(category, scope, search, cursor)` RPC modeled on the proven `getFacetOptions` path; success = project -> board cascade returns scoped, paginated results with no full-list load.
- `MultiSelect` cannot do async/search; a new debounced async-search control is needed and React Aria's combobox-with-async patterns are unproven in this codebase. — Resolution: prototype the control against the stubbed-plugin scenarios under `e2e/fixtures/stubbed-plugin/scenarios/`.

### Integration
- `CATEGORY_TO_KIND` is centrally hardcoded, so every new source category couples the plugin to a host-side edit; out of step with the "plugins advertise their own mapping" direction noted in the file. — Resolution: add the three categories now; optionally file an issue to move mapping into the manifest (per CLAUDE.md, open the ticket and reference its number inline).
- Picker shape is a shared contract consumed by `github-com`/`ghe` too; a breaking change to `SourceCandidatesResponse` risks those plugins. — Resolution: make the new shape additive (new `shape` literal + optional fields), leaving `multi-list`/`categorized-multi-list` untouched.

### Non-functional
- "Nothing may load a full list" is a hard constraint, but board-to-filter resolution currently fans out one config call per board; doing this at pick time is fine, doing it at list time is not. — Resolution: resolve a board's filter id only when the user selects it, not while browsing.
- Double-filtering: if status exclusion moves into JQL but the client `applyFilters` exclusion stays, behavior is still correct but the Status facet UI (`CutListFilterBar.tsx:202`) folds `excludedStatuses` into its options assuming client-side semantics; watermark math in `listIssues` (`plugin.ts:272-280`) also currently counts closed issues that JQL would now remove. — Resolution: decide one source of truth (JQL) and verify the watermark/pagination still advances correctly once closed issues never appear in a page; covered by existing TC-030 watermark test as a guardrail.

### Data
- Clean break is explicitly approved, so no migration path is required, but old-shape `boards/epics/filters` configs in committed roubo.yaml and per-user overrides will silently produce empty/wrong selections until re-picked. — Resolution: on read, detect old-shape categories and surface a "re-pick your sources" prompt rather than failing silently; product-level decision for PRD.
- JQL string interpolation of user-typed search and project keys widens the injection surface beyond today's numeric/quoted filter ids. — Resolution: reuse and extend `jqlString` escaping (`jql.ts:49-54`) for every interpolated user value; the `~` (contains) operator on `summary` needs its own escaping review.

## Unknowns

- Does the target Jira Server/DC version expose `GET /rest/api/2/project/search` (or only `/project/picker`), `GET /rest/api/2/filter/search`, and `GET /rest/agile/1.0/board?projectKeyOrId=`? These are documented in current DC REST references but some are version-gated; the exact Workday instance version must be confirmed. If `filter/search` is absent, filter discovery degrades to favourites-only and the "search all filters" goal cannot be met without raw JQL (which is out of scope). — Spike: hit all four endpoints against the real instance with a PAT and confirm pagination params and owner/label fields.
- Is "assigned to me" instance-wide or project-scoped? (Open question in context.) Affects whether `mine` is a top-level kind or a per-project refinement.
- Is filter `owner` reliably returned by the DC filter endpoints for the disambiguation label? (Open question in context.)
- At what page size and concurrency does the real instance stay under a sub-second type-ahead budget? Drives debounce interval and `maxResults`.

Sources:
- [Jira Data Center REST API — filter group](https://developer.atlassian.com/server/jira/platform/rest/v10002/api-group-filter/)
- [Jira Data Center REST API — projects group](https://developer.atlassian.com/server/jira/platform/rest/v10002/api-group-projects/)
- [How to filter when using GET /rest/api/2/project/search](https://community.atlassian.com/forums/Jira-questions/How-to-filter-when-using-GET-rest-api-2-project-search/qaq-p/1260429)
- [Jira Software Cloud/DC REST API — board group](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
