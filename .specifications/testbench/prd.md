# PRD: TestBench (in-app manual test-review surface)

| | |
|---|---|
| **Slug** | testbench |
| **Status** | draft |
| **Brief** | ./brief.md |
| **Feasibility** | ./feasibility.md |

## Problem statement

Roubo produces and consumes structured test plans (product-dev `test-cases.json`), but there is no in-app surface for a human to execute and review one. Today a reviewer reads raw JSON or hand-edits files to record what passed: error-prone, easy to drift out of any contract, and unable to capture granular, timestamped, authored results. A standalone "Test Case Reviewer" tool was built to solve exactly this (evidence the need is real); the decision now is to bring that product intent into Roubo as a native bench variant rather than ship a second process. A first-class deliverable is standardising and publishing versioned `test-cases.json` and `test-results.json` schemas with validation, forward-compatible with a separate, future guided-navigation Chrome extension.

## Goals & non-goals

- **Goals:** give reviewers a native Roubo surface to walk a focused test plan and record granular, never-mutating, authored results inside a normal bench; publish two versioned, validated schemas as Roubo-owned contracts; keep the door open for a purely-additive future extension.
- **Non-goals:** authoring/editing/deleting test-case definitions; automated test execution; building the Chrome extension; multi-user / concurrent editing / auth / network exposure; standing up any new server or process.

## In scope

- A TestBench bench variant: created from an empty bench slot, focused on one selected spec, adding a first "TestBench" tab while keeping all existing bench tabs.
- Rendering a focused plan for humans; granular per-observation pass/fail marks; a derived-but-overridable per-case status; append-only authored notes; per-level and overall progress.
- Automatic, source-preserving persistence of `test-results.json` beside the focused spec in the focused project's repo, with hash-based staleness detection and a result-preserving reconcile.
- An app-settings toggle that enables/disables the whole feature.
- Published, versioned `test-cases.json` + `test-results.json` schemas (zod source of truth, generated JSON Schema), a runtime validator, and a CI drift guard.

## Out of scope

- Authoring, editing, or deleting test-case definitions; any mutation of the source `test-cases.json`.
- Automated test execution (this is human review/recording).
- Building the guided-navigation Chrome extension (separate spec, likely slug `testbench-guide-extension`); only its schema impact (optional additive targeting fields) lands here.
- Multi-user / concurrent editing, authentication, or network exposure beyond Roubo's existing localhost surface.
- Retrofitting JSON-Schema generation onto the existing `roubo-config` / `roubo-plugin` schemas.

## User stories

- **US-001** As a reviewer, I want to create a TestBench from an empty bench slot and pick a focused spec, so that I can review one test plan in an isolated bench. _(P0)_
- **US-002** As a reviewer, I want a first "TestBench" tab that keeps all the normal bench tabs, so that I can review and still drive or investigate the app under test (terminal, jig, AI prompting) in the same bench. _(P0)_
- **US-003** As a reviewer, I want the focused plan rendered as readable cases grouped by level/priority with full case detail, so that I never have to read raw JSON. _(P0)_
- **US-004** As a reviewer, I want to mark each expected observation pass or fail with a timestamp, so that I record granular results. _(P0)_
- **US-005** As a reviewer, I want a per-case status that auto-derives from the observation marks but can be manually overridden, so that I can reflect real states like "blocked". _(P0)_
- **US-006** As a reviewer, I want to append authored, timestamped, status-stamped notes per case that cannot be edited or deleted, so that there is a trustworthy audit trail. _(P0)_
- **US-007** As a reviewer, I want per-level and overall progress rollups, so that I can see how far through the plan I am. _(P1)_
- **US-008** As a reviewer, I want results to persist automatically without ever editing the source plan, so that my work is saved and the plan stays pristine. _(P0)_
- **US-009** As a reviewer, I want to be warned when the underlying plan has changed and to reconcile without losing my results, so that stale results are obvious and safe. _(P0)_
- **US-010** As a Roubo user, I want an app-settings toggle to enable or disable the whole TestBench feature, so that the surface is hidden when I do not want it. _(P1)_
- **US-011** As a tooling author (including the future extension), I want published, versioned `test-cases.json` and `test-results.json` schemas with validation, so that I can build against a stable contract. _(P0)_
- **US-012** As a reviewer, I want to point a TestBench at a non-discovered plan via a manual file path that is validated first, so that I can review plans that are not auto-discovered. _(P1)_
- **US-013** As a reviewer, I want to re-point an active TestBench to a different focused spec without losing the results I already recorded, so that I can review more than one plan in the same bench. _(P1)_

## Functional requirements

- **FR-001** From an empty bench slot's option menu, offer a "Create a TestBench" action alongside the normal set-up-bench path; the option is present only when the feature is enabled (FR-018). _(serves US-001; P0)_
- **FR-002** On TestBench creation, discover candidate plans by enumerating `.specifications/*/test-cases.json` in the focused project's repo and present them for selection. _(serves US-001; P0)_
- **FR-003** Provide a manual file-path escape hatch: accept a path to a `test-cases.json`, validate it against the published schema before binding, and reject binding on failure. The path is constrained to a registered project repo. _(serves US-012; P1)_
- **FR-004** A TestBench binds exactly one focused spec at a time to one bench/worktree; the binding is established at creation and may later be re-pointed (FR-024). _(serves US-001; P0)_
- **FR-005** A TestBench adds a first tab named "TestBench" and retains all existing bench tabs (components, terminal, inspection when present, info). _(serves US-002; P0)_
- **FR-006** Render the focused plan's cases grouped by level/priority, without exposing raw JSON to the reviewer. _(serves US-003; P0)_
- **FR-007** Show each case in full: metadata, preconditions, ordered steps, and the expected observation(s) for each step. _(serves US-003; P0)_
- **FR-008** Let the reviewer mark each individual expected observation pass or fail; each mark is timestamped. _(serves US-004; P0)_
- **FR-009** Derive a per-case status from a fixed set (`not_started`, `in_progress`, `passed`, `failed`, `blocked`) from the observation marks. _(serves US-005; P0)_
- **FR-010** Allow the reviewer to manually override the per-case status; the override is recorded distinctly from the derived value. _(serves US-005; P0)_
- **FR-011** Capture append-only authored notes per case: no edit, no delete; each note stamped with author, timestamp, and the case status at write time. _(serves US-006; P0)_
- **FR-012** Resolve the note/mark author from the bench's git identity (`user.name` / `user.email`), with a graceful fallback (a sentinel author plus a UI warning) when git identity is unset, so writes never fail on missing identity. _(serves US-006; P0)_
- **FR-013** Show a progress rollup per level and overall, excluding orphaned results (FR-017). _(serves US-007; P1)_
- **FR-014** Persist results automatically and never modify the source `test-cases.json`. _(serves US-008; P0)_
- **FR-015** Store results as a `test-results.json` sidecar beside the focused spec in the focused project's repo, keyed per project + spec + bench (physical layout fixed by the schema-contract spike). _(serves US-008; P0)_
- **FR-016** Detect staleness by storing a canonicalised content hash of the source plan and flagging results stale when that hash changes. _(serves US-009; P0)_
- **FR-017** Provide a reconcile flow that preserves authored results: cases removed from the plan are orphaned (not deleted), surfaced as archived, and excluded from the rollup; orphaned results are purged only on explicit user confirmation. _(serves US-009; P0)_
- **FR-018** Add a "TestBench" tab to app settings with an enable/disable toggle; disabling hides the create-TestBench option (FR-001) and the feature surface. _(serves US-010; P1)_
- **FR-019** Publish a versioned `test-cases.json` schema (authored as zod in `shared/`, generated to JSON Schema in `schema/`) that reserves OPTIONAL, additive guided-execution targeting fields: a per-step "target" and a per-observation "observe" target, each expressible as some combination of CSS selector, ARIA role + accessible name, visible-text anchor, route/URL context, or region. _(serves US-011; P0)_
- **FR-020** Publish a versioned `test-results.json` schema (authored as zod in `shared/`, generated to JSON Schema in `schema/`); results reference cases by stable id and never require editing `test-cases.json`. _(serves US-011; P0)_
- **FR-021** Validate `test-cases.json` on load and `test-results.json` on read and write, surfacing clear, actionable errors on malformed or out-of-contract files rather than failing opaquely. _(serves US-011; P0)_
- **FR-022** Expose every TestBench action as a REST endpoint (create TestBench, discover specs, fetch plan + results, mark observation, set status override, append note, reconcile), using PUT for updates per Roubo's API-first convention. _(serves US-002, US-004, US-006, US-008; P0)_
- **FR-023** Provide a zod-to-JSON-Schema generate script and a CI drift guard that regenerates the published schemas and fails the build if the checked-in JSON Schema differs from the zod source. _(serves US-011; P0)_
- **FR-024** Provide an explicit "change focused spec" action in the TestBench surface that re-points the bench to another discovered or manual spec. Re-pointing is explicit (never silent), preserves each spec's results independently (per project + spec + bench, FR-015), and re-evaluates staleness (FR-016) against the newly focused plan. _(serves US-013; P1)_

## Non-functional requirements

Each NFR has a measurable target and a verification method.

- **NFR-001** _(Security / data-safety)_ All TestBench file writes are confined to a registered project's `repoPath` through `resolveWithin` plus a strict spec-slug allowlist; the manual-path escape hatch (FR-003) is likewise constrained to a registered project repo; the feature never mutates the source `test-cases.json`; there is no network exposure beyond Roubo's existing localhost surface. **Target:** 0 writes resolving outside a registered `repoPath`; 0 CodeQL high/critical path-injection findings. **Verify:** path-traversal-attempt unit tests (malformed slug, `../` manual path) plus the required CodeQL check.
- **NFR-002** _(Performance)_ The TestBench tab renders a plan of up to 500 cases (using list virtualisation/windowing) at p95 < 300ms after data load; an observation-mark persist round-trip completes < 150ms; schema validation plus the staleness hash of a ~1MB plan completes < 200ms. **Target:** as stated, at the single-user local load. **Verify:** component render-timing tests with a 500-case fixture; a validate+hash benchmark.
- **NFR-003** _(Reliability / data-integrity)_ No authored mark or note is ever lost: writes are atomic (same-directory temp + rename, EXDEV-safe); reads fail open (a corrupt, missing, or future-version results file surfaces a recovery prompt and never crashes the tab); reconcile orphans (never silently deletes) results for removed cases, and any purge requires explicit user confirmation. **Target:** 0 data loss across add/remove/change reconcile scenarios; 100% fail-open on malformed results. **Verify:** reconcile unit tests (case added/removed/changed under existing marks) and fail-open tests (truncated, invalid, newer-schema files).
- **NFR-004** _(Accessibility)_ The TestBench UI meets WCAG 2.1 AA: full keyboard operability for marking observations, overriding status, appending notes, and navigation; visible focus per the design system. **Target:** 0 vitest-axe violations; AA. **Verify:** vitest-axe assertions in component tests plus keyboard-operability tests.
- **NFR-005** _(Compatibility / contract stability)_ The published schemas are versioned (semver in `$id`); the optional guided-execution targeting fields are additive and the in-app UI ignores unknown optional fields; no release within a major version rejects a file a prior minor accepted. A genuinely breaking change requires a major-version bump AND a documented migration path for existing `test-results.json` files. **Target:** 0 within-major breaking changes; a backward-compat fixture corpus stays valid; every breaking change ships a migration. **Verify:** schema-compat fixture corpus + a version-bump/migration rule check.
- **NFR-006** _(Maintainability)_ The checked-in JSON Schema in `schema/` is generated from the zod source, and a CI step regenerates and git-diffs it, failing the build on any drift; new code meets the 80% coverage gate (lines/functions/branches/statements) and the zero-stdout/stderr test rule. **Target:** CI fails on schema drift; coverage >= 80% across all four metrics. **Verify:** the CI generate-and-diff step (FR-023); the existing coverage gate.
- **NFR-007** _(Usability)_ A reviewer reaches their first recorded observation mark within <= 5 interactions from choosing "Create a TestBench" (the spec is selected from a discovered list, not typed), and every key flow (spec missing, spec invalid, results stale) has an explicit, actionable UI state. **Target:** <= 5 interactions to first mark; named error/empty states for the key flows. **Verify:** an interaction-count walkthrough test plus state-coverage assertions.

## Success indicators

### Leading

| Indicator | Baseline | Target | Source | Validates |
|-----------|----------|--------|--------|-----------|
| TestBenches created (per active project) | 0 (new) | >= 1 within first week of enabling | Roubo state / TestBench create events | US-001, FR-001 |
| Plans completed in-app without editing source | 0 | >= 1 full plan marked end-to-end via the UI | `test-results.json` completion state | US-004, US-008, FR-008, FR-014 |
| Time-to-first-mark | n/a | <= 5 interactions from create | UI walkthrough instrumentation | US-001, NFR-007 |
| Schema validation pass rate on load | n/a | 100% of bound plans load without opaque failure | validator surfaced errors | US-011, FR-021 |

### Lagging

| Indicator | Baseline | Target | Source | Validates |
|-----------|----------|--------|--------|-----------|
| Sustained adoption over hand-editing JSON | hand-editing today | reviewers use TestBench as the default recording surface | recurring `test-results.json` writes vs manual edits | the feature |
| Published-schema stability across the extension launch | n/a | 0 breaking changes when `testbench-guide-extension` ships | schema version history + compat corpus | US-011, NFR-005 |

## Dependencies & assumptions

- Carried from feasibility (DE-RISK): five gating spikes must inform the build, several before the schemas are published.
  - **Schema-contract spike:** fix the optional targeting-field shapes (FR-019), the `$id`/semver versioning (NFR-005), and the multi-bench physical layout for `test-results.json` (FR-015) before any schema is committed.
  - **Results-store + safe-path spike:** prove external-repo writes via `resolveWithin` + slug allowlist + same-dir temp/rename, CodeQL-clean (NFR-001, NFR-003).
  - **Hash-staleness + reconcile spike:** fix canonicalised hashing (FR-016) and orphan-not-delete reconcile (FR-017) with no result loss (NFR-003).
  - **Schema-generate + CI drift-guard spike:** wire `z.toJSONSchema()` + a regenerate/diff CI step (FR-023, NFR-006).
  - **Git-identity helper (small):** `git config user.name/email` with graceful fallback (FR-012).
- The focused project is always a registered, locally accessible Roubo project (its `repoPath` is available server-side; localhost-only).
- A TestBench participates in the standard bench lifecycle and worktree provisioning; it is a variant, not a parallel construct.
- zod 4's `z.toJSONSchema()` produces publication-quality JSON Schema without a third-party library (to be confirmed in the generate-script spike).
- Inspection stays fully separate; TestBench shares no data model with it.

## Open questions

- [ ] Physical layout for multi-bench results on one spec: single `test-results.json` with a bench-keyed map, or per-bench filenames? (Resolved by the schema-contract spike; load-bearing for FR-015/FR-020.)
- [ ] Exactly what is canonicalised and hashed for staleness (FR-016): normalised case-set content vs raw bytes.
- [ ] Is the `test-results.json` sidecar committed to the focused project's VCS or gitignored? (Determines whether the audit trail is shared or ephemeral.)
- [ ] Whether the per-case status override (FR-010) needs a captured reason.
- [x] Whether the focused-spec binding (FR-004) is fixed at creation or re-pointable later: RESOLVED, explicit re-point is supported (FR-024, US-013), with per-spec results preserved.
- [ ] TestBench-tab behaviour when the focused project's repo is mid-rebase or `.git`-locked (NFR-003 degradation case).
