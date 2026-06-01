# Context: jira-sources-scale

Redesign how the Jira (self-hosted) integration plugin discovers and configures
"sources" (where a bench's cut list pulls issues from) so it scales to a very large,
Workday-sized Jira instance.

## Problem

The current Jira source picker does not work at enterprise scale. It presents three
flat, instance-wide tabs (Boards, Epics, Filters) that each try to enumerate the whole
instance:

- **Boards** show truncated names with no way to tell which is which or where they came
  from. Each board also fans out a separate `/board/{id}/configuration` call to resolve
  its backing filter (bounded to 5 concurrent), adding latency.
- **Epics** are fetched instance-wide with a hardcoded `maxResults: 50` and no pagination,
  no project scoping, and no search. Beyond the first ~50 epics, the rest silently vanish.
  Unusable on an instance with tens of thousands of epics.
- **Filters** load all favourite filters in one unpaginated call, surface nothing useful,
  and the dropdown is visually clipped by the bottom of the modal.
- **Closed/Done tickets leak into the cut list** because `excludedStatuses` is applied
  client-side after fetch, not in the JQL query.

At Workday scale (thousands of projects and boards, tens of thousands of epics, hundreds
or thousands of saved filters) any approach that loads a full list is a non-starter.

## Users

- **Primary:** Workday developers configuring a Roubo project against the company's
  self-hosted Jira instance, then picking which issues land in their bench cut list.
- Most work within a single project, usually from that project's scrum board. Some span
  multiple projects/boards. Some don't use a board at all and work from saved filters.

## Goals

1. Make source configuration usable and fast on a very large Jira instance.
2. Reframe selection around a **Project-first** mental model: pick a project (or a few),
   then refine to a board / filter / epic / "assigned to me" within that scope.
3. Stop closed/done issues from reaching the cut list by filtering server-side in JQL.
4. Make every selectable thing reachable via server-side search, with unambiguous,
   self-serve labels (no truncation, no id-guessing).

## Key decisions (from interview)

- **Mental model:** Project-first, then refine. Project is the primary scoping unit.
- **Source types kept:** Project, Board (scrum/kanban), Saved filter (JQL), Epics
  (now project-scoped + searchable), and an "assigned to me" preset.
  **Raw JQL input is out of scope.**
- **Multi-source:** A single Roubo project may combine **multiple sources of mixed
  types** at once (e.g. two boards + one saved filter); the cut list is their union.
- **Closed/done exclusion:** Move status exclusion into the **JQL query** (server-side),
  and make the excluded-status list **fully user-editable** (first-class setting).
- **Config sharing:** **Team default + personal override.** `roubo.yaml` seeds a shared
  baseline; each developer can override their own sources via their `~/.roubo` per-user
  override (array fields replace, consistent with the existing override model).
- **Discovery UX:** **Server-side type-ahead + rich labels.** Searching queries Jira
  live (no full-list dumps). Each result shows disambiguating detail (project key,
  board type, owner). Full names are never truncated.
- **Epics:** Kept, but only **within a selected project** and via server-side search.
  No more instance-wide dump or 50-item cap.
- **Migration:** **Clean break.** Old `boards/epics/filters`-shaped configs are dropped;
  users re-pick once in the new picker. Justified because the feature is early and the
  old UX was broken. (No auto-migration, no backward-compat read path required.)
- **Scope:** The `jira-self-hosted` plugin, the **shared host picker contract** (picker
  shapes + search/pagination contract may evolve as needed), and the **modal-clipping
  bug fix** for the filter dropdown.
- **Cloud Jira:** **Self-hosted (Server/Data Center) only.** Cloud is a separate future
  plugin; design need not actively accommodate it.

## Scale constraints

- Target: **Very large (Workday-scale)** — thousands of projects/boards, tens of
  thousands of epics, hundreds/thousands of saved filters.
- Nothing in the picker may depend on loading a full list. All discovery is search- and
  pagination-driven.

## Success criteria

- **Time-to-configure:** From opening the picker to a correctly-scoped, working cut list
  in well under a minute, even on the huge instance.
- **No wrong/closed issues:** Cut list shows only relevant, open issues; zero closed/done
  leakage.
- **Picker never stalls or truncates:** No silent truncation (no 50-epic cap), no UI
  freeze/timeout on large result sets; every selectable item is reachable via search.
- **Self-serve:** Developers configure sources without asking a teammate which board or
  filter id to use; labels are unambiguous enough to self-serve.

## In scope

- Project-first source discovery and selection for `jira-self-hosted`.
- Server-side, paginated/type-ahead search for projects, boards, filters, and epics.
- Server-side JQL status exclusion with a user-editable excluded-status list.
- Multi-source (mixed-type) selection with union semantics.
- Necessary evolution of the shared host picker contract (search/pagination, richer
  result labels) to support the above.
- Host-side fix for the filter dropdown being clipped by the modal.

## Out of scope

- Jira Cloud support.
- Raw free-text JQL entry as a source.
- Automated migration / backward-compat reads of old-shape source configs (clean break).

## Open questions (flag for refinement in PRD)

- Exact disambiguating fields to show per result type (project key + board type + owner
  proposed; confirm owner is available/useful for filters).
- Whether the "assigned to me" preset is per-project-scoped or instance-wide.
- Default excluded-status set to seed the now-editable list (carry today's
  `["Closed","Done","Resolved","In Review"]`?).
- Whether "active sprint only" should be a default for board sources or an explicit toggle.
