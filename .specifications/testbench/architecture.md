# Architecture: TestBench (in-app manual test-review surface)

## Context

**PRD:** ./prd.md

TestBench adds a native Roubo surface (a bench variant) for a human to walk a focused spec's test plan and record granular, never-mutating, authored results, plus two published, versioned schemas (`test-cases.json`, `test-results.json`) consumable by a future Chrome extension. The architectural choice is non-trivial because the two highest-severity risks are data-integrity (NFR-003: no authored mark/note ever lost; atomic same-directory writes; fail-open reads; reconcile orphans-not-deletes; purge only on explicit confirm) and correctness of the derived-but-overridable per-case status (FR-009/FR-010), while writes land in an external project repo under a required CodeQL path-injection gate (NFR-001), the published contract must stay backward-compatible with migrations for any breaking change (NFR-005), and the schema is generated, not hand-written, with a CI drift guard (NFR-006). Performance budgets (NFR-002: render up to 500 cases p95 < 300ms with virtualisation, mark round-trip < 150ms, validate + hash a ~1MB plan < 200ms), WCAG 2.1 AA (NFR-004), and the <= 5 interactions to first mark (NFR-007) are carried verbatim from the PRD.

## Decision summary

**Lens:** Blend, anchored on #3 (model-first domain core) + #1 (minimal-construct, mirror-Inspection integration) + #2 (schema-contract discipline, kept as a compile-time `shared/` module).

The centerpiece is an exhaustively-typed, platform-agnostic **domain core in `@roubo/shared`**: the zod source schemas for both files, plus two pure, side-effect-free modules, a **derived-status state machine** (observation marks to status, with override coexistence) and a **deterministic reconcile algorithm** (diff the source plan against recorded results by stable id, classify added/removed/changed, orphan removed cases, never delete). These pure functions are the single authority for every domain invariant and are unit-testable with zero filesystem or HTTP setup, which is what makes NFR-003 and FR-009/FR-010 provably correct and the 80% coverage gate (NFR-006) natural. Around that core, integration follows the existing **Inspection** surface: TestBench is a thin variant of `Bench` (an additive discriminator + focused-spec binding), served by one new thin file-IO server service plus a route module shaped like `inspection.ts`, surfaced as a conditional first tab in the existing bench detail view, and toggled through the existing `UserPreferences` settings path. The published contract gets B's discipline (versioned `$id` semver, a migration registry, file-per-version generated JSON Schema, CI drift guard) but **not** B's packaging: the contracts stay a compile-time module inside `shared/`, never a separate npm package or process. The tradeoff that tipped the decision: the model-first core eliminates C's own dual-authority risk only if domain invariants live in one place, so the binding rule is that **every server write endpoint enforces invariants by calling the shared state machine**, and the client runs the same shared functions for preview only.

### Considered and rejected

- **A (Extend-in-place, logic in the server service):** simplest, but it leaves the derived-status and reconcile logic embedded in a server service rather than a pure shared module, which is exactly the code that carries the two highest-severity risks and most needs isolated unit tests. Its integration approach is adopted; its logic placement is not.
- **B (Extract a contract subsystem as a package):** strongest for the extension contract, but a separately-packaged, separately-versioned subsystem is premature abstraction for a single in-app consumer today. Its versioning/migration discipline is adopted; its packaging is rejected in favour of a compile-time `shared/` module boundary that is cheap to harden later if the extension ships.

## Components

| Name | Kind | New / existing / extended | Responsibility |
|------|------|---------------------------|----------------|
| `testbench-contracts` (in `shared/`) | library | new | zod source schemas for `test-cases.json` and `test-results.json`; `z.infer` types; the runtime `safeParse` validators; version constants (`$id` semver); the migration registry keyed by version pair. Single source of truth for both server and client. |
| `testbench-domain` (in `shared/`) | library | new | Pure, platform-agnostic domain logic: the derived-status state machine (marks to status; override coexistence) and the deterministic reconcile algorithm (classify added/removed/changed; orphan-not-delete). No `fs`, no `node:crypto`, no React. |
| `testbench-canonicalize` (in `shared/`) | library | new | Pure function that canonicalises a parsed plan (stable id sort + content normalisation) into a deterministic string for hashing. Returns a string; does not hash (keeps `shared/` platform-agnostic). |
| `testbench-store` | service | new | Thin server file-IO service: validated read of the plan and results, atomic same-directory write of results, server-side plan hashing (consumes `testbench-canonicalize` + `node:crypto`), fail-open load, and orphan reconcile by delegating to `testbench-domain`. Owns every filesystem path through `resolveWithin` + a spec-slug allowlist. |
| `testbench-spec-discovery` | module | new | Server-side enumeration of `.specifications/*/test-cases.json` within a registered project's repo, validating each candidate against the contracts before returning it; also validates a manual-path candidate (FR-003), constrained to a registered project repo. |
| `git-identity` helper | module | new | Resolves `user.name` / `user.email` scoped to the bench workspace; returns a sentinel author plus an `isSentinel` flag when git identity is unset (FR-012), so writes never fail on missing identity. |
| `testbench` routes | service | new | Express 5 route module exposing every TestBench action; validates request bodies with the contracts, enforces domain invariants via `testbench-domain` before any write, delegates IO to `testbench-store`. Never touches the filesystem directly. Shaped like `inspection.ts`. |
| schema generate script + CI drift guard | other | new | Generates the file-per-version JSON Schema into `schema/` from the zod source via `z.toJSONSchema()`; the CI step regenerates and `git diff --exit-code`s to enforce NFR-006/FR-023. |
| `TestBenchTab` | client | new | The review UI: virtualised case list (NFR-002), per-observation marks, status + override, append-only notes, progress rollup, staleness banner, reconcile-confirm dialog. Consumes a client domain layer; holds no domain rules of its own. |
| client domain layer + React Query hooks | module | new | Wires the TestBench endpoints to the UI; runs the shared `testbench-domain` functions for client-side preview (effective status, progress rollup, reconcile preview before confirm). Authority remains server-side. |
| `Bench` / `PersistedBench` | library | extended | Additive optional `variant?: "testbench"` discriminator and `focusedSpecPath?: string` binding (absent = normal bench; no migration needed, per the existing load-time migration pattern). |
| `BenchTabId` + bench detail tabs | module | extended | `BenchTabId` union gains `"testbench"`; the bench detail view conditionally renders it as the FIRST tab when `variant === "testbench"`, mirroring the existing conditional Inspection tab. All existing tabs are retained (FR-005). |
| empty-bench create menu | client | extended | Gains a "Create a TestBench" option gated on the settings toggle (FR-001), launching a spec-picker (discovery list + manual-path escape hatch). |
| `UserPreferences` + settings UI | library | extended | Additive `testBench?: { enabled: boolean }` key (mirrors the existing `benches` key), surfaced as a new app-settings "TestBench" tab toggle (FR-018), persisted via the existing settings load/save path. |
| `safe-path` lib | library | existing | `resolveWithin` + `assertSafeIdentifier` reused as the path-containment barrier for every sidecar write; a spec-slug allowlist (analogous to the existing jig-id pattern) is added. |
| `atomicWrite` pattern | module | existing | The temp + rename pattern is reused, but NOT the settings-scoped helper directly: `testbench-store` writes its temp file inside the target `.specifications/<slug>/` directory (creating it if absent) so cross-device renames cannot raise `EXDEV`. |
| Inspection surface | service | existing | Unchanged and fully separate (no shared data model); it is the structural template (per-bench service + route + conditional tab), not a dependency. |

## Data model

| Entity | Owner | Shape |
|--------|-------|-------|
| `TestCasesPlan` (file envelope) | `testbench-contracts` | `{ $schema: string, schemaVersion: string, specSlug: string, cases: Case[] }` |
| `Case` | `testbench-contracts` | `{ id: string, title: string, level: string, priority: string, preconditions?: string[], steps: Step[] }` |
| `Step` | `testbench-contracts` | `{ id: string, instruction: string, observations: Observation[], target?: TargetingField }` |
| `Observation` | `testbench-contracts` | `{ id: string, expected: string, observe?: TargetingField }` |
| `TargetingField` (reserved, optional) | `testbench-contracts` | All-optional: `{ cssSelector?: string, ariaRole?: string, ariaName?: string, textAnchor?: string, routeContext?: string, region?: string }`. Additive and ignored by the in-app UI; reserved for the future extension (FR-019, NFR-005). |
| `TestResultsFile` (file envelope) | `testbench-store` / `testbench-contracts` | `{ $schema: string, schemaVersion: string, planHash: string, benches: Record<benchId, BenchResults> }`. One sidecar file per spec; the bench-keyed map is the chosen multi-bench layout (resolves the PRD open question). |
| `BenchResults` | `testbench-contracts` | `{ caseResults: Record<caseId, CaseResult>, updatedAt: string }` |
| `CaseResult` | `testbench-contracts` | `{ observationMarks: Record<observationId, ObservationMark>, derivedStatus: CaseStatus, statusOverride?: StatusOverride, notes: Note[], orphaned?: true }` |
| `ObservationMark` | `testbench-contracts` | `{ result: "pass" \| "fail", author: Author, timestamp: string }` |
| `CaseStatus` | `testbench-domain` | `"not_started" \| "in_progress" \| "passed" \| "failed" \| "blocked"` (the fixed set, FR-009) |
| `StatusOverride` | `testbench-contracts` | `{ status: CaseStatus, author: Author, timestamp: string }` (recorded distinctly from `derivedStatus`, FR-010) |
| `Note` | `testbench-contracts` | `{ id: string, text: string, author: Author, timestamp: string, statusAtWrite: CaseStatus }` (append-only; no edit/delete, FR-011) |
| `Author` | `testbench-contracts` | `{ name: string, email: string, isSentinel?: true }` (FR-012) |
| `SchemaVersion` / `MigrationRegistry` | `testbench-contracts` | `$id` URI embedding semver; `Map<"fromMajor.minor->toMajor.minor", (raw) => raw>`, populated only when a breaking change ships (NFR-005). |
| `Bench` / `PersistedBench` (extended) | bench state | existing fields + `variant?: "testbench"`, `focusedSpecPath?: string` (absolute, re-validated with `resolveWithin` on load, never trusted blindly). `focusedSpecPath` is **mutable**: an explicit re-point (FR-024) updates it; results stay keyed per spec so re-pointing loses nothing. |
| `UserPreferences` (extended) | settings state | existing fields + `testBench?: { enabled: boolean }`. |

**PRD-supplied invariants.** Results reference cases by stable id and never require editing `test-cases.json` (FR-014, FR-020); the source plan is never mutated (FR-014, NFR-001). Notes are append-only: no update or delete path exists (FR-011). A removed case's `CaseResult` is marked `orphaned` and retained, never deleted, and excluded from the rollup (FR-013, FR-017, NFR-003). All result writes resolve inside a registered project's `repoPath` (NFR-001).

## Interfaces / contracts

All endpoints are localhost-only, no auth (single-user, per PRD non-goals), under the existing bench namespace. Updates use PUT (project convention). Request/response bodies are typed by `testbench-contracts`.

### empty-bench create menu / spec-picker → `testbench` routes (HTTP)

- **Discovery:** `GET /api/projects/:projectId/testbench/specs` -> `200 { specs: Array<{ slug, path, caseCount }> }` (enumerate + validate `.specifications/*/test-cases.json` within `repoPath`).
- **Manual-path validation:** `POST /api/projects/:projectId/testbench/specs/validate` `{ path: string }` -> `200 { ok: true, slug, caseCount }` / `400 { ok: false, errors }` (FR-003; path constrained to a registered project repo, NFR-001).
- **Create:** `POST /api/projects/:projectId/benches` `{ variant: "testbench", focusedSpecPath: string }` -> `201 Bench` (normal bench-manager create path; variant fields stored in `PersistedBench`). `400` if the path fails validation/containment.
- **Re-point (FR-024):** `PUT /api/projects/:projectId/benches/:id/testbench/focus` `{ focusedSpecPath: string }` -> `200 Bench` (validates + contains the new path like create, updates `PersistedBench.focusedSpecPath`, then a subsequent plan load returns the new spec's results and re-evaluated staleness). The prior spec's `test-results.json` is untouched. `400` on validation/containment failure.

### `TestBenchTab` (via React Query hooks) → `testbench` routes (HTTP)

- **Load:** `GET /api/projects/:projectId/benches/:id/testbench/plan` -> `200 { plan: TestCasesPlan, results: BenchResults \| null, stale: boolean, planHash: string }`. Fail-open: a malformed/missing/newer results file returns a typed recovery payload, never a 500 (NFR-003).
- **Mark observation:** `PUT /api/projects/:projectId/benches/:id/testbench/cases/:caseId/observations/:observationId` `{ result: "pass" \| "fail" }` -> `200 CaseResult` (recomputes `derivedStatus` via `testbench-domain`; persists atomically). Target < 150ms (NFR-002).
- **Set status override:** `PUT /api/projects/:projectId/benches/:id/testbench/cases/:caseId/status` `{ override: CaseStatus \| null }` -> `200 CaseResult` (`null` clears the override).
- **Append note:** `POST /api/projects/:projectId/benches/:id/testbench/cases/:caseId/notes` `{ text: string }` -> `201 Note` (server stamps author + timestamp + `statusAtWrite`; append-only). `400` on empty text.
- **Reconcile:** `POST /api/projects/:projectId/benches/:id/testbench/reconcile` `{ confirm?: boolean, purgeOrphans?: boolean }` -> `200 { classification: ReconcileClassification, applied: boolean }`. Without `confirm`, returns the classification preview only; orphan purge happens only when `purgeOrphans` is explicitly set (NFR-003).

### `testbench` routes → `testbench-store` / `testbench-domain` (function-call)

- `readPlanAndResults(project, bench) -> { plan, results, stale, planHash }`
- `markObservation(project, bench, caseId, observationId, result) -> CaseResult` (route enforces invariants via `testbench-domain.deriveStatus` before `testbench-store` writes)
- `appendNote(project, bench, caseId, text, author) -> Note`
- `setStatusOverride(project, bench, caseId, override) -> CaseResult`
- `reconcile(project, bench, { confirm, purgeOrphans }) -> ReconcileResult` (`testbench-domain.reconcile` classifies; `testbench-store` persists)
- `testbench-store` -> `safe-path`: `resolveWithin(project.repoPath, ".specifications", slug, "test-results.json")` + slug allowlist on every path before any `fs` call.

### schema generate script → `testbench-contracts` (function-call)

- `z.toJSONSchema(TestCasesPlanSchema, { $id })` and `z.toJSONSchema(TestResultsFileSchema, { $id })` -> writes file-per-version JSON Schema into `schema/`. CI regenerates and diffs.

## Sequence flows

### Happy path: record an observation result

1. Reviewer opens the TestBench tab; `GET .../testbench/plan` returns the validated plan, current `BenchResults` (or null), `stale`, and `planHash`.
2. Reviewer marks an observation pass/fail; the hook issues `PUT .../cases/:caseId/observations/:observationId`.
3. The route resolves the author (`git-identity`), records the timestamped mark, recomputes `derivedStatus` via `testbench-domain`, and `testbench-store` writes the whole results file atomically (same-directory temp + rename inside `.specifications/<slug>/`).
4. The response returns the updated `CaseResult`; the client domain layer recomputes effective status and the progress rollup; the UI reflects the new mark and status.

### Staleness + reconcile (no data loss)

1. On load, `testbench-store` canonicalises the plan (`testbench-canonicalize`), hashes it server-side, and compares to the stored `planHash`; a mismatch sets `stale: true`.
2. The UI shows a staleness banner; the reviewer opens reconcile. `POST .../reconcile` (no `confirm`) returns a `ReconcileClassification` (added / removed / changed / unchanged) computed by `testbench-domain`.
3. Removed cases with recorded results are classified as orphan candidates; nothing is deleted. The reviewer confirms; results for surviving cases are retained, removed-case results are marked `orphaned` (excluded from the rollup), and `planHash` is updated.
4. Orphaned results are purged only if the reviewer later sends `purgeOrphans: true` (explicit confirmation).

## Operational concerns

(Local single-user dev tool: read these as execution-robustness, not hosting/scaling.)

- **Deployment:** no new process or port (PRD non-goal honoured); ships inside the existing Roubo server + client + Electron shell. A new build/CI step is added: `generate:schema` + a drift-diff check (FR-023, NFR-006).
- **Observability:** validation failures surface as actionable, typed errors to the UI (FR-021); a git-identity sentinel surfaces a UI warning (FR-012). No telemetry beyond Roubo's existing surface.
- **Scaling / hotspots:** every mark write rewrites the whole `test-results.json`; the bench-keyed map is kept small by purging cleared-bench entries on reconcile, and the 500-case render is virtualised (NFR-002). A validate + hash benchmark on a ~1MB plan guards the < 200ms budget.
- **Failure modes:** fail-open reads (corrupt / missing / newer-schema results surface a recovery prompt, never crash the tab, NFR-003); `EXDEV` avoided by same-directory temp + rename; missing `.specifications/<slug>/` directory is created before write; a focused project mid-rebase / `.git`-locked is surfaced as a degraded read-only state rather than a hard error (open question below).

## Security & compliance

- **NFR-001 (path-safety):** every result write and the manual-path escape hatch resolve through `resolveWithin(project.repoPath, ...)` plus a strict spec-slug allowlist; writes that resolve outside a registered `repoPath` are rejected. The source plan is never written. Target: 0 out-of-repo writes, 0 CodeQL high/critical path-injection findings. The `resolveWithinRoots`/`resolveWithin` path is exercised by the results-store + safe-path spike with a CodeQL-confirming test before other work proceeds.
- **NFR-003 (data-integrity):** atomic same-directory writes, fail-open reads, orphan-not-delete reconcile, explicit-confirm purge, all enforced in `testbench-store` + `testbench-domain` and covered by pure unit tests.
- **NFR-005 (contract stability):** versioned `$id` semver, additive optional targeting fields, a migration registry, and a backward-compat fixture corpus; no within-major breaking change, and any breaking change ships a major bump plus a migration.
- No auth, PII, or network exposure beyond localhost (PRD non-goals); compliance is N/A for this internal tool.

## Supersedes / PRD deltas

None. The architecture honours every PRD `FR-`/`NFR-`. It also resolves two PRD open questions as design decisions (not supersedes): the multi-bench physical layout is a single `test-results.json` per spec with a bench-keyed map, and the staleness hash input is a canonicalised case-set serialisation (stable-id sorted, content-normalised) computed server-side, not raw file bytes. Both remain subject to confirmation by the schema-contract and hash-staleness spikes before the schemas are published.

## Open questions

- [ ] Does clearing/deleting a TestBench purge its entry from the spec's bench-keyed `test-results.json`, or are cleared-bench entries retained? (Bench-dimension reconcile, distinct from case-dimension reconcile.)
- [ ] Is the `test-results.json` sidecar committed to the focused project's VCS or gitignored? (Determines whether the audit trail is shared or ephemeral; affects whether the generator/CI guidance should recommend a `.gitignore` entry.)
- [ ] Behaviour when `focusedSpecPath` points to a spec in a different registered project than the bench's own project (cross-project specs): support or reject at creation?
- [ ] TestBench-tab behaviour when the focused project's repo is mid-rebase or `.git`-locked (degraded read-only vs deferred write).
- [ ] Does the per-case status override (FR-010) need a captured reason string? (Schema-additive if yes.)
- [ ] Re-point (FR-024) surfacing: the prototype's header should expose a "change focused spec" affordance (reuses the spec-picker modal); not yet rendered in the prototype, captured as a build detail.

## Out of scope

- Building the guided-navigation Chrome extension (separate spec); only the reserved optional `TargetingField` shape lands here.
- Authoring/editing/deleting test-case definitions; any mutation of the source plan.
- Multi-user concurrency / advisory file locking (single-user, single-process per PRD non-goals).
- Retrofitting JSON-Schema generation onto the existing `roubo-config` / `roubo-plugin` schemas.

## Phase mapping

The PRD does not define formal delivery phases, but the feasibility de-risking plan implies a build order the issue breakdown should respect: the schema-contract spike and the results-store + safe-path spike gate everything downstream (the published schemas and the store cannot be authored until the targeting-field shape, the `$id`/versioning, the multi-bench layout, the canonical hash, and the CodeQL-clean write path are fixed). Suggested order for `breakdown`: (1) the spikes, (2) `testbench-contracts` + the generate script + CI drift guard, (3) `testbench-domain` + `testbench-canonicalize` (pure, fully tested), (4) `testbench-store` + `git-identity` + routes, (5) `Bench`/`PersistedBench`/`BenchTabId`/`UserPreferences` extensions + the create flow + settings toggle, (6) `TestBenchTab` + client domain layer + hooks (virtualisation, a11y).
