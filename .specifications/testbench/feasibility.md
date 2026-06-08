# Feasibility: TestBench (in-app manual test-review surface)

> **Recommendation: DE-RISK**: every dimension is feasible-with-conditions, with no infeasible verdict; the build is sound on Roubo's existing primitives, but five high-severity risks (the published-schema contract shape, the review-UI coverage/a11y load, reconcile data-loss, external-repo path safety, and multi-bench result keying) must be resolved by upfront spikes before committing.

**Brief:** ./brief.md

## Per-dimension summary

| Dimension   | Verdict                  | Confidence | Top risk                                                                                                           | Mitigation                                                                                                                              |
| ----------- | ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Technical   | feasible-with-conditions | high       | External-repo `test-results.json` writes trip CodeQL path-injection unless routed through a recognised sanitizer   | Model writes on `resolveWithin(repoPath, '.specifications', slug, file)` + a JIG_ID_RE-style slug allowlist (`server/lib/safe-path.ts`) |
| Effort      | feasible-with-conditions | medium     | Targeting-field schema shape unresolved; publishing then breaking it fails the "stable contract" goal from day one | Lock the targeting-field shape as a blocking pre-implementation spike, not a follow-up                                                  |
| Operational | feasible-with-conditions | medium     | Reconcile silently discards authored marks/notes when a case is removed from the plan                              | Orphan (never delete) result entries for absent cases; surface as archived, exclude from rollup                                         |

## Dimension detail

### Technical (feasible-with-conditions, high)

All major primitives already exist and are directly reusable, so this is careful design over new invention.

- **Bench tab surface is a localised change.** `BenchTabId` is a single union at `client/src/hooks/useBenchViewState.ts:5`; `availableTabIds` is computed dynamically at `client/src/components/BenchDetail.tsx:865-870`, and the conditional `inspection` tab (`BenchDetail.tsx:1066-1110`) is the exact template for a conditional first `testbench` tab. React Aria `Tabs/TabList/Tab/TabPanel` are already in use (`BenchDetail.tsx:11-16`).
- **Settings extension point is well-precedented.** `UserPreferences` (`shared/types.ts:1392-1398`) + `loadSettings`/`saveSettings` (`server/services/state.ts:233-292`); the settings UI maps a typed tab array (`client/src/components/ProjectSettings.tsx:659,681`). A `testBench: { enabled }` section mirrors the existing `benches` key.
- **Create entry point is contained.** `EmptyBenchCard.tsx` already drives a two-option popover; a third "Create a TestBench" option is a local change, though the spec-picker (discovery + manual-path escape hatch + validation) is net-new UI + route + hook.
- **Schema pipeline is native.** zod 4 is the declared and installed runtime source of truth (`shared/package.json`), and `z.toJSONSchema()` is confirmed present (`node_modules/zod/v4/core/to-json-schema.d.ts`). `schema/` holds two hand-maintained JSON Schema files with no generator; the generate script + CI drift guard are genuinely new work.
- **Safe primitives exist.** `atomicWrite` (`server/services/state.ts:52-66`), `resolveWithin` / `assertSafeIdentifier` (`server/lib/safe-path.ts`), and `node:crypto` `createHash('sha256')` are all present; the SHA-256 staleness hash is a zero-dependency addition.
- **Bench variant is backward-compatible.** `PersistedBench` (`shared/types.ts:716-744`) carries no variant discriminator; an optional `variant?: "testbench"` + `focusedSpecPath?` field is additive (absent = normal bench), no migration script needed given the existing load-time migration pattern.

Assumptions: focused project repoPath is always a locally accessible, registered Roubo project; a TestBench still creates a worktree and runs the standard lifecycle; the slug is already a safe filesystem identifier. Open questions: exact `test-results.json` key structure for multiple benches on one spec; whether the focused-spec binding lives in `PersistedBench`; the TestBench-tab behaviour when the spec is missing/invalid; versioned-file vs single-file schema publication; manual-path validation timing and whether it may point outside the project repo.

### Effort (feasible-with-conditions, medium)

A **Large (L)** feature: roughly 8-12 work-streams across every layer, buildable by one experienced full-stack developer, but the coverage gate + a11y + the append-only/staleness data model add non-trivial test overhead on top of feature code. Sequencing is manageable if the zod schemas and the server results-store service are built first, since every downstream layer depends on them.

- `BenchTabId` is a one-line change but ripples to every switch consumer and its tests.
- The `Bench` interface (`shared/types.ts:488`) needs a variant discriminator: a shared-type change touching `bench-manager.ts`, `state.ts` serialisation, and all bench-listing clients. Land it as the first commit to avoid late rework.
- The results-store service is substantially heavier than its analogue `inspection-runner.ts` (~100 lines, in-memory Map): it adds filesystem read/write of the external-repo sidecar, content-hash staleness, and append-only note mutation, perhaps 3-4x the volume.
- No git-identity helper exists in `server/services/git-helpers.ts` (it covers remote/branch/dirty, not `git config user.name/email`): a new helper + tests are net-new.
- The review UI (observation marks, derived+overridable status, append-only notes, progress rollup, staleness banner, reconcile flow) is the largest single component and must hit 80% coverage with vitest-axe a11y; underestimating this test-writing time is the most likely 2-3x slip.

Assumptions: one experienced full-stack dev familiar with the codebase; targeting-field shape decided before implementation; `z.toJSONSchema()` output is publication-quality without a third-party lib; no coverage exemption; English-only. Open questions: targeting-field shape; whether status override needs a reason field; fixed vs re-pointable binding; reconcile semantics for removed cases; where the drift guard runs (CI vs pre-commit); whether very large plans need UI virtualisation.

### Operational (feasible-with-conditions, medium)

Reframed as execution-robustness/reliability for a local, single-user tool. Buildable within Roubo's reliability model, but four robustness hazards must be designed deliberately or they cause silent data loss or schema drift.

- **External-repo atomic writes** must use a same-directory temp-then-rename (temp inside `.specifications/<slug>/`), because the OS default tmp dir can be on a different volume and `fs.renameSync` throws `EXDEV` (the existing `atomicWrite` at `state.ts:52-66` assumes same-filesystem rename).
- **Fail-open reads.** A corrupt/missing/future-version `test-results.json` must degrade gracefully with the same pattern as `loadSettings` (`state.ts:233-288`), never hard-error the tab.
- **Path containment.** The sidecar path is derived from a spec-discovered or user-supplied base, not a Roubo-controlled root, so every write must go through `resolveWithin(project.repoPath, ...)` (`server/lib/safe-path.ts:14-29`; note `resolveWithinRoots` at `:40-55` currently has zero consumers and needs in-context validation).
- **Schema-drift CI.** `schema/` has no regenerate+diff step today, so drift between the zod source and the published JSON Schema is currently undetected; the new contract needs `generate:schema` + a `git diff --exit-code schema/` CI check.

Assumptions: focused project is always a registered project with a known repoPath; `atomicWrite`'s pattern is reused; `z.toJSONSchema()` output is stable/spec-compliant (untested in this repo); single-user/single-process means no advisory locking is needed; mostly-local filesystems. Open questions: physical multi-bench file layout; what content is hashed; orphaned-result UX and purge policy; whether the sidecar is committed to the focused project's VCS or gitignored; sidecar root for the manual-path escape hatch; behaviour during a mid-rebase/locked `.git`; large-file performance.

## Top risks (ranked, cross-dimension)

1. **Published-schema contract shape is load-bearing and irreversible once external consumers exist** (high): the optional guided-execution targeting fields, the `$id`/semver versioning strategy, AND the multi-bench physical file layout (single bench-keyed map vs `test-results-<benchId>.json`) must all be fixed before the schema is published, or the Chrome extension builds against a contract that later needs a breaking change. Owner: schema-contract spike (below).
2. **Reconcile data loss** (high): removing a case from the source plan must not delete its authored marks/notes. Owner: reconcile-semantics spike (orphan-not-delete).
3. **External-repo path traversal** (high): a malformed slug or manual path containing `../` could write outside the project repo and will be flagged by CodeQL (a required check). Owner: results-store + safe-path spike.
4. **Review-UI coverage + a11y load** (high): the largest component must hit the 80% gate with vitest-axe; plan test-writing as a first-class parallel track, not trailing cleanup. Owner: implementation sequencing.
5. **Schema drift undetected** (medium): no CI regenerate+diff exists for `schema/`. Owner: generate-script + drift-guard spike.

## De-risking plan (resolve before/early in the build)

- [x] **Schema-contract spike:** _(completed: #405, closed)_ lock the `test-cases.json` optional targeting-field shapes (which of CSS selector / ARIA role+name / visible-text anchor / route-URL context / region, and their exact zod shape, all `.optional()`), the published-schema versioning strategy (`$id` semver, file-per-version vs single overwritten file), and the multi-bench physical layout for `test-results.json`. Resolves risks 1 and the multi-bench keying open question, before any schema is committed.
- [x] **Results-store + safe-path spike:** _(completed: #406, closed)_ prototype writing `test-results.json` into an external registered project repo via `resolveWithin(repoPath, '.specifications', slug, file)` + a strict slug allowlist, with same-directory temp-then-rename to dodge `EXDEV`; confirm it passes CodeQL. Resolves risk 3 and the EXDEV hazard.
- [x] **Hash-staleness + reconcile spike:** _(completed: #407, closed)_ decide the canonicalised hash input (normalised case-set content, not raw bytes) and the orphan-not-delete reconcile semantics; prove no authored result is ever silently lost when cases are added/removed/changed. Resolves risk 2 and the false-positive-staleness risk.
- [x] **Schema-generate + CI drift-guard spike:** _(completed: #408, closed)_ wire `z.toJSONSchema()` into a `generate:schema` script writing into `schema/`, plus a CI step that regenerates and `git diff --exit-code`s the output (model on the existing `format:check` step). Resolves risk 5.
- [x] **Git-identity helper (small):** _(completed: #409, closed)_ `git config user.name` / `user.email` scoped to the bench workspace, with a graceful fallback (sentinel author + UI warning) when unset, so note-append never throws. Resolves the author-stamping reliability risk.

_(These become `spike` issues when `breakdown` runs.)_

## Recommendation

**DE-RISK**: proceed to `/product-dev:prd`, but treat the five de-risking items above as gating design work; the schema-contract and results-store spikes in particular must land before the published schemas are committed, because a published contract is expensive to change once the external Chrome extension depends on it. No dimension is infeasible, so there is no NO-GO condition; the conditions are about getting irreversible contract and data-safety decisions right up front.

## Assumptions to validate

- The focused project is always a locally accessible, registered Roubo project (repoPath available server-side; localhost-only, no network/cloud storage).
- A TestBench participates in the standard bench lifecycle and worktree provisioning; it is a variant, not a parallel construct.
- `z.toJSONSchema()` output (zod 4) is publication-quality for a versioned contract without a third-party library (currently unverified in this repo).
- The targeting-field shape will be decided before implementation; if it stays open, the schema deliverable cannot complete.

## Open questions

- [x] Physical layout for multi-bench results on one spec: single `test-results.json` with a bench-keyed map, or per-bench filenames? (Load-bearing for the published schema.) RESOLVED, single `test-results.json` per spec with a bench-keyed map (spike #405).
- [x] What is hashed for staleness: raw bytes or a normalised case-set serialisation? RESOLVED, a canonicalised normalised case-set serialisation (spike #407).
- [x] Reconcile UX when a case with authored results is removed: orphan/archive vs warn vs purge, and whether a permanent purge is ever allowed. RESOLVED, orphan-not-delete (archived, excluded from rollup); a permanent purge is allowed only on explicit user confirmation (spike #407).
- [ ] Is the `test-results.json` sidecar committed to the focused project's VCS or gitignored? (Determines whether the audit trail is shared or ephemeral.)
- [x] For the manual file-path escape hatch, what directory is the sidecar root and how is it constrained? RESOLVED, the sidecar resolves through `resolveWithin(repoPath, ...)` plus a strict spec-slug allowlist, constrained to a registered project repo (spike #406).
- [ ] TestBench-tab behaviour when the focused spec is missing, schema-invalid, or its repo is mid-rebase / `.git`-locked.
- [ ] Whether per-case status override needs a captured reason, and whether the focused-spec binding is fixed at creation or re-pointable.
