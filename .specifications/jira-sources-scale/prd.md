# PRD: Scalable Jira Source Configuration

> Slug: `jira-sources-scale` · Last updated: 2026-06-01

## Problem

Configuring where a Bench's cut list pulls issues from is not usable on a large,
Workday-sized Jira instance. The current `jira-self-hosted` source picker presents three
flat, instance-wide tabs (Boards, Epics, Filters) that each try to enumerate the whole
instance: board names are truncated and indistinguishable, epics are capped at the first
50 with no pagination or scoping, and favourite filters load in a single unpaginated call
whose dropdown is clipped by the modal. On top of that, closed and done issues leak into
the cut list because status exclusion runs client-side after the fetch rather than in the
query. Developers cannot reliably find the right source, and when they do, the cut list is
polluted. This redesign reframes source selection around the Jira project a developer
actually works in, makes every source type searchable server-side, and pushes status
exclusion into the query so the cut list is correct.

## In scope

- Project-first source selection for the `jira-self-hosted` plugin: pick one or more Jira
  projects, then refine to a board, saved filter, epic, or an "assigned to me" preset
  scoped within them.
- Server-side, paginated, type-ahead search for every source type (Jira projects, boards,
  saved filters, epics). No instance-wide full-list loads.
- Multi-source selection across mixed types; the cut list is the union of all selected
  sources.
- Moving closed/done status exclusion into the JQL query, defaulting to Jira's "Done"
  status category, with a user-editable excluded-status set.
- Evolution of the shared host picker contract to support a searchable, cascading
  (scope-aware) source shape, modeled on the existing `getFacetOptions` async pattern.
- Rich, untruncated result labels (full name + Jira project key + underlying item id).
- Team-default-plus-personal-override config model in `roubo.yaml` and the per-user
  `~/.roubo` override (array fields replace).
- Host-side fix for the picker dropdown being clipped by the configure modal.

## Out of scope

- Jira Cloud support (this work targets self-hosted Server/Data Center only).
- Raw free-text JQL entry as a source type.
- Automated migration or backward-compatible reads of old-shape (`boards`/`epics`/
  `filters`) source configs. Clean break: existing configs are dropped and re-picked once.
- Generalizing source configuration across non-Jira plugins beyond the picker-contract
  changes this redesign requires.

## Sizing

- **T-shirt size:** Small
- **Effort:** 4 sprints / 8 person-weeks
- **Rationale:** Bounded to the Jira plugin plus the shared picker contract, and reuses
  the existing async-search pattern and override model. The net-new project-to-board
  cascade design and a confirmation spike against Workday's Jira keep it above X-Small.

## User stories

### US-001 — Pick a Jira project first
As a developer, I want to select the Jira project I work in before anything else, so that
I only deal with the few projects relevant to me instead of the whole instance.

### US-002 — Add my scrum board as a source
As a developer who works from a project's scrum board, I want to add that board (its
active sprint) as a source, so that my cut list mirrors my current sprint.

### US-003 — Add a saved filter as a source
As a developer with a custom workflow, I want to pick one or more saved Jira filters as
sources, so that my cut list matches a query I already maintain in Jira.

### US-004 — Search instead of scroll
As a developer on a very large Jira instance, I want to type to search for projects,
boards, filters, and epics, so that I can find the right one in seconds without scrolling
thousands of entries or hitting a silent cap.

### US-005 — Combine multiple sources
As a developer who spans multiple projects or boards, I want to combine several sources of
different types in one Bench, so that the cut list shows the union of all my work.

### US-006 — Keep closed issues out of the cut list
As a developer, I want closed and done issues excluded from my cut list automatically, so
that I only see actionable work.

### US-007 — Tune which statuses are excluded
As a developer, I want to edit the set of excluded statuses, so that exclusion matches my
team's actual workflow rather than a fixed list.

### US-008 — Quick "assigned to me" source
As a developer, I want an "assigned to me" preset (within my selected project, or anywhere),
so that I can pull my own work without building a filter.

### US-009 — Project-scoped epics
As a developer, I want to add an epic as a source by searching within my project, so that
I can focus a Bench on one epic's issues without the picker trying to list every epic in
the instance.

### US-010 — Team default with personal override
As a team lead, I want to commit a default source set in `roubo.yaml` that teammates can
override locally, so that onboarding is fast while individuals stay flexible.

### US-011 — Tell similar sources apart
As a developer, I want each picker result to show its Jira project key and underlying id,
so that I can distinguish similarly named boards and filters and configure sources without
asking a teammate.

## Functional requirements

### FR-001 — Project-first source selection
The picker MUST lead with Jira project selection. Board, saved-filter, and epic source
types MUST be scoped to the selected Jira project(s); a developer cannot pick a board or
epic without first establishing the project scope it belongs to.

### FR-002 — Server-side searchable source options
The plugin MUST expose a scoped, paginated, type-ahead source-options operation (e.g.
`getSourceOptions(category, scope, search, cursor)`) that returns results for projects,
boards, filters, and epics. No source category may rely on loading a full instance-wide
list.

### FR-003 — Searchable, cascading host picker shape
The shared host picker contract MUST gain a searchable source shape that carries a search
term, a scope (the parent selection, e.g. the chosen Jira project), and cursor-based
pagination. Plugins MUST continue to declare picker shape only and MUST NOT ship React
components. The shape SHOULD reuse the existing async-option pattern used by
`getFacetOptions`.

### FR-004 — Board source defaults to active sprint
A board source MUST resolve to the board's active sprint by default, with an explicit
option to widen the source to the whole board.

### FR-005 — Saved-filter source
A developer MUST be able to select one or more saved Jira filters as sources, discovered
via server-side filter search rather than the favourites-only unpaginated list.

### FR-006 — Project-scoped epic source
Epics MUST be selectable only within a selected Jira project, via paginated server-side
search. The fixed 50-item cap and the instance-wide epic enumeration MUST be removed.

### FR-007 — "Assigned to me" preset with two scopes
The picker MUST offer an "assigned to me" preset as a per-source option with two modes:
assigned to me within the selected Jira project, and assigned to me anywhere. The current
user identity MUST come from `getCurrentUser`.

### FR-008 — Multi-source union
A Roubo project MUST be able to combine multiple sources of mixed types; the resulting cut
list MUST be the union of all selected sources (an OR across the per-source JQL clauses).

### FR-009 — Server-side status exclusion in JQL
Status exclusion MUST be applied in the JQL query, not client-side after fetch, so that
excluded issues never occupy a result page or reach the cut list.

### FR-010 — Category-based default exclusion, user-editable
The default excluded set MUST exclude Jira's "Done" status category (category-based, robust
to custom status names) rather than a hardcoded status-name list. The excluded set MUST be
user-editable through the config model.

### FR-011 — Rich, untruncated result labels
Each picker result MUST show its full name, its Jira project key, and the underlying item
id (board id, filter id, or epic key) as a monospace secondary line. Result names MUST NOT
be truncated to the point of ambiguity.

### FR-012 — Project-scoped, mixed-type sources schema
The `roubo.yaml` `integration.sources` schema MUST encode the Jira project scope for each
source and support a mixed-type list. The team-default-plus-personal-override model MUST
apply, with array-typed fields replaced (not merged) by the per-user override. Old-shape
configs MAY be ignored (clean break); no migration path is required.

### FR-013 — Picker dropdown not clipped by the modal
The picker's search dropdown MUST render so that it is not clipped by the configure modal's
overflow (e.g. via a portal or popover), regardless of result-list length.

### FR-014 — Incremental polling preserved across new source kinds
The JQL builder MUST extend its source-clause handling to the new source kinds (project,
board, "assigned to me") while preserving the per-source incremental `updated >=` watermark
behaviour, so polling does not regress to full re-fetches.

## Non-functional requirements

### NFR-001 — Picker search performance
Category: performance
Each type-ahead source query MUST return with a p95 under 500ms. Input MUST be debounced
(~250ms) and all source queries MUST be scoped and paginated; no query may load a full
instance-wide list.

### NFR-002 — Picker accessibility
Category: accessibility
The redesigned picker (search field, results list, multi-select, dependent project scope)
MUST meet WCAG 2.1 AA and be fully keyboard-navigable (type, arrow, select, remove), with
screen-reader labels on results and visible focus, built with the repo's React Aria
Components convention.

### NFR-003 — Credential and query safety
Category: security
The plugin MUST reuse the existing PAT credential slot and per-instance network host
constraint; new search endpoints MUST NOT log JQL, the PAT, or issue contents. User-supplied
search terms MUST be escaped or parameterized before entering JQL to prevent JQL injection.

### NFR-004 — Scale reliability
Category: reliability
The picker MUST NOT silently truncate results. It MUST handle slow or oversized Jira
responses gracefully, paginate correctly without duplicating or dropping items, and keep
the per-source watermark correct when multiple sources are combined.

## Traceability

| User story | Functional requirements | Non-functional requirements |
|---|---|---|
| US-001 — Pick a Jira project first | FR-001, FR-002, FR-003 | NFR-002 |
| US-002 — Add my scrum board as a source | FR-002, FR-004 | NFR-001, NFR-002 |
| US-003 — Add a saved filter as a source | FR-002, FR-005 | NFR-001, NFR-002 |
| US-004 — Search instead of scroll | FR-002, FR-003, FR-006 | NFR-001, NFR-002, NFR-004 |
| US-005 — Combine multiple sources | FR-008, FR-014 | NFR-004 |
| US-006 — Keep closed issues out of the cut list | FR-009, FR-010 | _none_ |
| US-007 — Tune which statuses are excluded | FR-010, FR-012 | NFR-002 |
| US-008 — Quick "assigned to me" source | FR-007 | NFR-001, NFR-002, NFR-003 |
| US-009 — Project-scoped epics | FR-006 | NFR-001, NFR-004 |
| US-010 — Team default with personal override | FR-012 | _none_ |
| US-011 — Tell similar sources apart | FR-011 | NFR-002 |

## Leading indicators of success

- Median time from opening the picker to a saved, working source set is well under one
  minute on the large instance.
- Zero picker queries that silently truncate or time out; every search returns within the
  p95 < 500ms target.

## Lagging indicators of success

- Closed and done issues appearing in cut lists drops to zero (verified by sampling cut
  lists across configured Benches).
- Drop in "which board or filter id do I use?" support questions; developers self-serve
  source configuration.
