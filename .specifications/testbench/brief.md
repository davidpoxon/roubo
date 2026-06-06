# Brief: TestBench (in-app manual test-review surface)

> One-line pitch: A bench variant inside Roubo where a human walks a focused spec's test plan, records granular pass/fail results and authored notes, and tracks progress, without ever hand-editing a source file.

## Problem

Roubo produces and consumes structured test plans (product-dev `test-cases.json`), but there is no in-app surface for a human to actually execute and review one. Today a reviewer either reads raw JSON or hand-edits files to record what passed, which is error-prone, easy to get out of contract, and never captures granular, timestamped, authored results. The pain is felt every time someone needs to walk a test plan by hand and prove what was checked. The evidence it is real: a standalone "Test Case Reviewer" tool (separate Node server + SPA) was already built to solve exactly this, with brief.md, prd.md, architecture.md, and a clickable prototype. The decision now is to bring that product intent into Roubo as a native feature rather than ship a second process.

## Target users

- **Primary:** the Roubo developer/reviewer who needs to manually walk a test plan against a working bench: mark each expected observation pass or fail, leave notes, and track progress, all inside the environment where they are also running and investigating the app under test.
- **Not the user:** end-users of the applications under test; CI / automated test runners (this is human review, not automated execution); multi-user / concurrent reviewers (single localhost user only).

## Jobs to be done

- "Let me execute a known test plan by hand and record exactly what I observed, case by case and step by step, without touching the source plan or fighting raw JSON."
- "Keep an authored, timestamped trail (granular marks + append-only notes) of what was checked and by whom."
- "Show me where I am: per-level and overall progress, and warn me when the underlying plan has changed under my results."
- "Do all this in the same bench where I can still prompt an AI agent, drive the app, and investigate a failing case."

## Current alternatives & their gaps

- **Reading raw `test-cases.json` and hand-editing a results file:** error-prone, no granular per-observation marks, no derived status, no append-only audit trail, easy to drift out of any contract.
- **The prior standalone "Test Case Reviewer" (separate server + SPA):** solved the product need but stands up a second process and a parallel construct; duplicates Roubo's bench/port/identity/state machinery instead of reusing it. Reference / prior-art only: `/Users/davidpoxon/Developer/intent/ai-agent-marketplace/.specifications/test-case-reviewer/`. Its product intent carries over; its standalone-server architecture does not.
- **General-purpose spreadsheets / docs:** no link to the actual spec, no schema, no staleness detection, no reuse of identity or progress rollups.

## Core capabilities

- **TestBench as a bench variant.** From an empty bench slot's option menu, offer "create a TestBench" alongside the normal set-up-bench path. A TestBench is a normal bench plus one extra FIRST tab named "TestBench"; all existing bench tabs are kept so the reviewer can still prompt an AI agent, run a terminal/jig, and drive the app under test in the same bench.
- **Focused-spec selection on creation.** Creating a TestBench prompts for which spec to review; that selection scopes the TestBench to one test plan. Primary source is a product-dev `.specifications/<slug>/test-cases.json` discovered in the focused project's repo (the prompt lists discoverable specs); a manual file-path entry to any schema-conformant `test-cases.json` is the escape hatch.
- **Render the plan for humans.** Load the focused plan and render its cases grouped by level/priority; show each case in full (metadata, preconditions, ordered steps, and the expected observations per step) without making the reviewer read raw JSON.
- **Granular pass/fail recording.** Mark each individual expected observation pass or fail, each mark timestamped.
- **Derived, overridable per-case status.** Carry a per-case status from a fixed set (not started / in progress / passed / failed / blocked) that auto-derives from the observation marks but can be manually overridden (e.g. to "blocked").
- **Append-only authored notes.** Capture append-only notes per case (no edit, no delete), each stamped with author, timestamp, and the case status at write time. Author is the bench's resolved git identity (`user.name` / `user.email`), reusing Roubo's existing identity handling rather than a separate author prompt.
- **Progress rollup.** Show per-level and overall progress.
- **Safe, automatic persistence.** Persist results automatically and never mutate the source test-plan definitions; results reference cases by stable id.
- **Staleness detection + reconcile.** Flag results as stale and support reconciliation when the underlying `test-cases.json` changes, detected by storing a content hash of the source plan and comparing on load.
- **App-settings toggle.** Add a "TestBench" tab to app settings with a toggle to enable/disable the whole feature; when disabled, the create-TestBench option and the feature surface are hidden. Fit it to Roubo's existing settings storage (roubo.yaml / Roubo state, never settings.json).
- **Published, versioned schemas + validator (first-class deliverable).** Standardise, document, and publish a `test-cases.json` schema and a `test-results.json` schema as Roubo-owned, versioned contracts. Author both as zod in `shared/` (the source of truth, matching `config-schema.ts`), validate `test-cases.json` on load and `test-results.json` on read/write with clear, actionable errors, and generate + check in versioned JSON Schema into `schema/` (via zod 4's `z.toJSONSchema()`) alongside the existing `roubo-config.schema.json` / `roubo-plugin.schema.json`, as the language-agnostic contract external tools consume.

## Out of scope (v1)

- Authoring, editing, or deleting test-case definitions: this executes a plan, it does not write one. Never mutate the source test plan.
- Automated test execution (this is human review/recording).
- Building the guided-navigation Chrome extension (its own separate spec; likely slug `testbench-guide-extension`). Only its schema impact lands here: the published `test-cases.json` schema reserves OPTIONAL, additive targeting fields (a per-step "target" and a per-observation "observe" target, each expressible as some combination of CSS selector, ARIA role + accessible name, visible-text anchor, route/URL context, or region) so the extension is purely additive later, never a breaking schema change. The in-app TestBench UI may ignore these fields.
- Multi-user / concurrent editing, auth, or network exposure beyond Roubo's existing localhost surface.
- Standing up any new server or process: TestBench lives entirely inside the existing Roubo app and its API.
- Retrofitting JSON-Schema generation onto the existing `roubo-config` / `roubo-plugin` schemas (candidate follow-up, not this spec).

## Constraints

- **Platform/tech:** Build inside Roubo's existing monorepo. `shared/` (`@roubo/shared` types, zod schemas), `server/` (Express 5 + TypeScript, `services/` + `routes/`), `client/` (React 19 + Vite + Tailwind CSS 4). Node >= 24.14. Every user action is also a REST endpoint (API-first); PUT (not PATCH) for updates; Express 5 wildcard is `/{*path}`. Client uses React Aria Components for all interactive elements over native HTML, React Query hooks for fetching, the typed client in `client/src/lib/api.ts`, and shared interfaces in `shared/types.ts`.
- **Persistence model:** results are a sidecar (`test-results.json`) stored beside the focused spec in the focused project's repo (`.specifications/<slug>/`), keyed per project + spec + bench, never editing the source plan. The enable/disable toggle fits Roubo's existing settings storage. Config is roubo.yaml only; no `settings.json` or other JSON config alternatives.
- **Bench model:** a TestBench is a bench variant. Reuse the existing bench lifecycle, tabs, detail view, ports, and isolation rather than inventing a parallel construct.
- **Design system:** warm stone foundation, amber-500 accent, Inter + JetBrains Mono, minimalist, motion 150 to 300ms, no bouncing. Match `docs/brand.md`.
- **Quality gates:** 80% coverage (lines/functions/branches/statements), tests next to code as `foo.test.ts`, tests must produce zero stdout/stderr, axe-core / vitest-axe available for a11y; aim WCAG 2.1 AA.
- **Brand vocabulary is load-bearing:** Bench, Project, Component, Inspection, Tool, Jig, Workspace. "TestBench" extends "Bench" and must read as native vocabulary.
- **Writing:** never use em dashes anywhere.
- **Integrations / touchpoints:** product-dev `.specifications/<slug>/test-cases.json` (source plans); Roubo bench lifecycle + tabbed bench detail view; Roubo git/identity handling (author stamping); Roubo app settings; the existing `schema/` directory and `shared/` zod schemas; intentionally NOT the automated Inspection surface (kept fully separate, no shared data model).

## Differentiation

Internal tooling, not a commercial product, so differentiation is against the alternatives rather than competitors: unlike the standalone tool, TestBench reuses Roubo's bench isolation, identity, settings, and state instead of duplicating them, and keeps the reviewer in one environment where they can simultaneously drive and investigate the app under test. Unlike hand-editing JSON, it gives granular timestamped marks, a derived-but-overridable status, an append-only authored trail, progress rollups, and contract-validated, staleness-aware persistence.

## Success definition

Two signals together:

- **Reviewer adoption + coverage:** reviewers run test plans through TestBench instead of hand-editing JSON, and reach full per-observation coverage on focused specs (cases marked, plans completed in-app).
- **Stable published schemas:** the published `test-cases.json` / `test-results.json` schemas stand as stable, versioned contracts: other tooling (including the future guided-navigation extension) builds against them with zero breaking changes.

These seed the PRD's leading indicators (in-app marks recorded, plans completed without editing source) and lagging indicators (sustained adoption over hand-editing, schema stability across the extension launch).

## Open questions & risks

- [ ] Storing `test-results.json` in the focused project's repo means results land in whatever repo the focused spec lives in; confirm the exact path/key convention (per project + spec + bench) and how it behaves when the focused project repo differs from Roubo's own repo. (Hand-off to feasibility / architecture.)
- [ ] Hash-based staleness: decide what is hashed (whole file vs normalised case set) and the reconcile UX when a case is added, removed, or changed under existing results.
- [ ] Discovery of product-dev specs in the focused project's repo: how the create-TestBench prompt enumerates `.specifications/*/test-cases.json`, and how the manual-path escape hatch validates before binding.
- [ ] Exact set of OPTIONAL guided-execution targeting fields to reserve in the published `test-cases.json` schema (which of CSS selector / ARIA role+name / visible-text anchor / route context / region, and their shape), so the future extension consumes them without a breaking change. (User's own worry: getting this reservation right NOW.)
- [ ] Whether per-case status override needs a reason/justification capture, and how an override interacts with later observation-mark changes.
- [ ] Whether a TestBench's focused-spec binding is fixed at creation or can be re-pointed later (per bench + spec scoping suggests fixed; confirm).

## Source notes

- Raw input: `notes.md` ("TestBench, a manual test-review surface inside Roubo"). Decided product shape: a new TestBench bench type created from an empty bench slot's menu, prompting for a focused spec; a normal bench plus a new first "TestBench" tab keeping all existing tabs; an app-settings "TestBench" tab with an enable/disable toggle. Review UI jobs: render the focused plan grouped by level/priority, show each case in full, mark each expected observation pass/fail (timestamped), carry a fixed-set per-case status that auto-derives but is overridable, capture append-only authored notes (author + timestamp + status-at-write), show per-level/overall progress, persist automatically without mutating the source, and flag/reconcile staleness. Schema standardisation is a first-class deliverable. The guided-navigation Chrome extension is a separate spec; only its schema impact (optional additive targeting fields) lands here. Prior-art reference (intent carries over, standalone-server architecture does not): `/Users/davidpoxon/Developer/intent/ai-agent-marketplace/.specifications/test-case-reviewer/`.
- Interview changelog (2026-06-06):
  - Spec source: product-dev `.specifications/<slug>/test-cases.json` discovery in the focused project's repo, PLUS a manual file-path escape hatch to any schema-conformant file.
  - Binding & result scoping: a TestBench binds one focused spec to one bench/worktree; results scoped per bench + spec.
  - Relationship to Inspection: fully separate surface, no shared data model.
  - Validator: zod is the runtime source of truth in `shared/` (grounded in the actual codebase: `config-schema.ts`, `plugin-manifest-schema.ts`, `plugin-enable-state-schema.ts` are all zod; ajv is not used for runtime validation, only a tsup external). Generate + publish versioned JSON Schema into `schema/` via `z.toJSONSchema()` for the external extension. Existing config/plugin schemas untouched.
  - Author capture: reuse Roubo's resolved git identity (`user.name` / `user.email`), no separate author prompt.
  - Results persistence + staleness: `test-results.json` sidecar beside the focused spec in the focused project's repo; staleness via stored content hash of the source plan.
  - Success definition: both reviewer adoption + per-observation coverage AND stable, versioned published schemas (zero breaking changes when the extension lands).
