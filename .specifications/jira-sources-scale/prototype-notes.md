# Prototype notes: jira-sources-scale

## Intent and scope

A self-contained, single-file (`index.html`) prototype of the redesigned `jira-self-hosted`
source picker. It demonstrates the project-first mental model, server-side type-ahead search
over a large mock instance, multi-source (mixed-type) union, per-source options (board
active-sprint, "assigned to me" scope), in-query status-category exclusion, and
disambiguating labels (project key + item id). It replicates Roubo's host look and feel
(warm stone + amber-500, Inter, JetBrains Mono) with hand-written CSS, but imports no Roubo
or framework packages and makes no network calls.

## Design decisions made during generation

- **Redone as a single static `index.html`, no build/install.** The first pass was a
  Vite + React + Tailwind app, but it required `npm install` against a private registry and
  was too much setup just to look at the design. The static file opens directly in a browser
  with zero configuration. (This was an explicit revision request.)
- **Replicated the host design tokens rather than importing them.** Warm stone foundation,
  amber-500 accent, Inter for UI, JetBrains Mono for ids/keys, mirroring the idioms in
  `MultiSelect.tsx`, `SourcePicker.tsx`, `PluginConfigureDialog.tsx`, and `ConfigSchemaForm.tsx`.
- **Built a new async type-ahead control instead of reusing `MultiSelect`.** The host
  `MultiSelect` is synchronous over a fully-loaded item array, which is exactly what does
  not scale. The prototype's picker is a debounced (250ms) type-ahead with cursor "Load
  more" paging and a per-query latency readout, modeled on the existing
  `getFacetOptions(facetId, search?)` async pattern the plugin already has.
- **Dropdown rendered in a body-level popover.** Appended to `<body>` and positioned over
  the trigger, so the results list is never clipped by a container's `overflow-hidden`. This
  directly demonstrates the FR-013 fix.
- **Project scope is a hard gate.** Board / filter / epic pickers are disabled with a hint
  until at least one Jira project is selected, making the project-first model literal.
- **Status exclusion is category-based and applied in `resolveCutList` before render**, so
  the preview's "N closed/done filtered out in the query" message reflects the real intent
  (FR-009/FR-010): excluded issues never occupy a page.
- **Mock instance is deliberately large** (200 projects, ~700 boards, ~1,200 filters,
  ~4,000 epics) with intentionally similar names, so search and disambiguation are exercised
  the way they would be at Workday scale.

## Screens (add screenshots after opening)

Open `index.html` in a browser (no install needed) and add screenshots here. The embedded
JavaScript was syntax-validated with `node --check`; the interaction itself should be
eyeballed in the browser.

1. **Initial state** — header with instance stats, empty "Jira project scope" with a
   "Choose project" type-ahead, disabled source pickers, empty cut-list preview.
2. **Project search open** — type-ahead popover with paged results, each showing name +
   `PRJxxx · key` mono subline and a live `NNNms ✓` latency readout.
3. **Scoped sources** — one or more project chips, enabled Board/Filter/Epic/"Assigned to
   me" pickers, a mixed list of configured sources with per-source options.
4. **Cut list preview** — union of issues with the "N closed/done filtered out in the
   query" banner; toggling Step 3 status categories updates it live.

## Open questions for the architecture stage

- **Picker-contract shape.** The prototype implies a `getSourceOptions(category, scope,
search, cursor)` RPC and a host-rendered "searchable list" picker shape. Architecture
  should define the exact contract: how scope (parent project selection) is passed, the
  cursor format, and how the existing `categorized-multi-list` shape is deprecated or
  coexists. (Ties to the feasibility spike.)
- **Cascade state ownership.** Where does the project→board dependency live: host picker
  state, plugin, or both? The prototype keeps it in client state; the real contract must
  decide.
- **"Assigned to me" representation in roubo.yaml.** It is a synthetic source, not a Jira
  object id. Architecture should pin how it (and its project/anywhere scope) serializes in
  `integration.sources`.
- **Active-sprint resolution.** The prototype fakes an `inActiveSprint` flag; the plugin
  must resolve a board's active sprint via the Agile API and fold it into the JQL.
- **Status-category exclusion in JQL.** Confirm Jira Server/DC supports
  `statusCategory not in (Done)` in JQL (vs. enumerating status names) on Workday's version.
- **Multi-source watermark.** With a union of sources, confirm the per-source `updated >=`
  watermark model from the existing design still holds (FR-014).
