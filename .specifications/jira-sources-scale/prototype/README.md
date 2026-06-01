# Prototype: Scalable Jira Source Configuration

A **single, self-contained `index.html`** prototype of the redesigned `jira-self-hosted`
source picker for the `jira-sources-scale` slug. No build, no install, no config.

## Run

Open `index.html` in any browser. On macOS:

```bash
open .specifications/jira-sources-scale/prototype/index.html
```

That is the whole setup. The page has no dependencies to install. (It pulls Inter and
JetBrains Mono from Google Fonts for fidelity; if you are offline it falls back to system
fonts and still works.)

## What it demonstrates

The page renders the Configure-modal body for Jira sources plus a live cut-list preview,
against a **mock instance of 200 Jira projects with ~700 boards, ~1,200 filters, and
~4,000 epics**. None of those arrays is ever rendered directly: every picker issues a
scoped, debounced, paginated search.

| User story | How it shows up |
|---|---|
| US-001 Pick a Jira project first | "1 · Jira project scope" gates everything; board/filter/epic pickers are disabled until a project is chosen. |
| US-002 Add a scrum board | "Board" picker; each board source has an "Active sprint only" toggle (on by default). |
| US-003 Add a saved filter | "Filter" picker, searched server-side within scope. |
| US-004 Search instead of scroll | Every picker is a debounced (250ms) type-ahead with "Load more" cursor paging and a per-query latency readout. |
| US-005 Combine multiple sources | Add several mixed-type sources; the cut list is their union. |
| US-006 Keep closed issues out | "Done" category excluded by default; the preview shows how many were filtered in-query. |
| US-007 Tune excluded statuses | Step 3 category checkboxes; the cut list updates live. |
| US-008 Assigned to me | "Assigned to me" source with In-scoped-projects / Anywhere modes. |
| US-009 Project-scoped epics | "Epic" picker only searches within the selected project(s); no instance-wide dump or 50-cap. |
| US-010 Team default + override | Note under the configurator explaining the personal-override model. |
| US-011 Tell similar sources apart | Every result and source row shows the Jira project key + underlying id in monospace. |
| FR-013 Dropdown not clipped | The search popover is appended to `<body>` and positioned over the trigger, so it is never clipped by a container. |

## How it is built

- **One file, vanilla JS + hand-written CSS.** The CSS replicates Roubo's warm-stone +
  amber-500 palette, Inter for UI text, and JetBrains Mono for ids/keys, matching the host
  shell without importing any Roubo or framework packages.
- **`searchSources(category, scopeKeys, search, cursor)`** simulates a server-side endpoint
  with ~120–300ms latency, project scoping, text match, and cursor pagination.
- **`resolveCutList()`** computes the union of selected sources and applies status-category
  exclusion before render, so excluded issues never occupy a page.

## What is intentionally not built

- Persistence to `roubo.yaml` / the per-user override (shown only as an explanatory note).
- The actual host picker-contract types (the page models the shape they imply).
- Real Jira REST/Agile endpoints (the spike validates these against Workday's instance).
