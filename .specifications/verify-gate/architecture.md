# Architecture: Verify gate

## Context

**PRD:** ./prd.md

Roubo must turn a human verification decision in TestBench into a hard,
cross-tool gate: when a batch's gating cases pass, the gate's tracker issue
closes and the next batch unblocks; when `enforceIssueDependencies` is ON and an
upstream gate has not passed, a bench cannot start the blocked work. The choice
is non-trivial because the gate decision must be **deterministic and never
false-pass** (NFR-007), must **fail closed** when blocking or results data is
indeterminate (NFR-003), must add at most **one bounded RPC** to the start path
(NFR-002), and the failed-case fix-issue filing requires a **new, consented,
audit-logged, tracker-agnostic** privileged capability (FR-011, NFR-001,
NFR-005) that Roubo does not have today (it can read blocking and assign, but it
cannot create an issue or register a block-link). This feature **adopts** the
settled `work-unit-model.md` and `verify-gate.md` contracts as fixed
inputs and builds on them; it does not re-open the work-unit model, the gate
unit shape, the results-to-passed rule, the dedup key, or the blocking topology.

## Decision summary

**Lens:** Extract a verify-gate domain module (model-first), with two folded-in
touches from the other candidates.

Introduce a single bounded **VerifyGate module** in the server that owns every
piece of gate logic: a validated work-units loader, a **pure** gate evaluator, a
start-gate, a pass-time lifecycle coordinator, a tracker-action gateway, and the
fix-issue filer. The existing services call **into** narrow entry points
(`assertGateOpen`, `evaluateGate`, `onGatePassed`, `fileFixIssueAndBlock`); the
module never reaches back into them. This wins because the feature's two hardest
guarantees want exactly one home: fail-closed enforcement (NFR-003) lives in one
`StartGate`, and deterministic evaluation (NFR-007) is one pure function that is
trivially truth-table-testable. The riskiest new surface, the unspiked
cross-tracker `createIssue` + `addBlockedBy` + close-gate, is isolated in one
`TrackerActionGateway` with capability-flag degradation (NFR-005) and audit
logging (NFR-001), so it can be spiked and phased GitHub-first without touching
the rest. Two touches are folded in: from extend-in-place, the start-gate accepts
an already-fetched issue so the create-and-assign path does not fetch it twice
(NFR-002); from event-driven, an optional best-effort SSE push of gate state on a
transition, reusing the existing notification stream for live UI (FR-012).

### Considered and rejected

- **Extend-in-place (Lens 1):** scatters gate logic across four to six files and
  creates two start-gate enforcement points that must stay in sync, working
  against the single-source-of-truth that NFR-003 and NFR-007 want. Its
  no-double-fetch optimization is kept.
- **Event-driven (Lens 3):** adds an in-process event bus Roubo does not use and
  introduces cache cold-start and staleness windows; decisively, FR-010 (a fix
  issue blocking the gate) is a tracker state change that fires no results event,
  forcing a non-reactive second write into the cache that undermines the reactive
  model. Its optional SSE gate-state push is kept as a non-load-bearing extra.

## Components

| Name                        | Kind            | New / existing / extended | Responsibility                                                                                                                                                                                          |
| --------------------------- | --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VerifyGate module           | module          | new                       | The bounded server domain that owns all gate logic; existing services call into its narrow entry points.                                                                                                |
| WorkUnitsSchema (source)    | library         | new                       | The schema source for the `work-units.json` envelope + `WorkUnit` (incl. `kind:"verify"`), feeding generated `schema/work-units.schema.json` with a CI drift guard (FR-003, NFR-006).                   |
| WorkUnitLoader              | module          | new                       | Validates and loads `work-units.json` for a slug via the validator; resolves a unit's upstream verify gate; fail-open to a fixture when absent (FR-003).                                                |
| GateEvaluator               | module          | new                       | **Pure** function over (gate, results, planHash) applying the deterministic results-to-passed rule using effective case status (FR-004, FR-005, NFR-007).                                               |
| StartGate                   | module          | new                       | The hard start-gate: one bounded blocking read, refuses (409) when blocked, fails closed when indeterminate and enforcement is ON (FR-006, NFR-002, NFR-003).                                           |
| GateLifecycleCoordinator    | module          | new                       | On a transition to passed, closes the gate's tracker issue and audit-logs it; no-ops if already closed (FR-007, NFR-001).                                                                               |
| TrackerActionGateway        | module          | new                       | The sole wrapper for the three new privileged tracker ops (create-issue, add-block-link, close-gate); enforces capability flags + consent and records each in the audit log (FR-011, NFR-001, NFR-005). |
| FixIssueFiler               | module          | new                       | Files a fix issue then registers the block-link; surfaces partial state and offers a link-only retry on a post-create failure (FR-009, FR-010, NFR-003).                                                |
| Gate API routes             | module          | new                       | `GET /gates`, `GET /gates/:gateId` (state + unresolved cases + covering units), `POST /gates/:gateId/fix-issues` (FR-008, FR-012, NFR-004).                                                             |
| TestBench surface           | client + module | extended                  | A batch-subset view (the gate's `implements.test_case_ids`), a gate-state panel, and a failed-case notes + file-fix-issue form (FR-008, FR-012, FR-009).                                                |
| benches route               | module          | extended                  | Calls `StartGate.assertGateOpen` before bench creation; replaces today's informational blocking read with the hard gate when ON (FR-006).                                                               |
| issue-assignment service    | module          | extended                  | The assign flow delegates the same `assertGateOpen` check before checkout, so direct-assign paths are gated too (FR-006).                                                                               |
| TestBench sign-off path     | module          | extended                  | After a mark write, invokes `evaluateGate` and, on passed, `onGatePassed` (FR-004, FR-007).                                                                                                             |
| pluginManager               | service         | existing                  | Sandboxed plugin RPC bus; `TrackerActionGateway` routes all privileged tracker ops through its consent-gated `invoke`.                                                                                  |
| project-registry            | module          | existing                  | `resolveEnforceIssueDependencies(projectId)` decides hard vs no-gate mode (FR-006).                                                                                                                     |
| privileged-broker audit log | data-store      | existing                  | Records every create-issue / add-block-link / close-gate call (NFR-001).                                                                                                                                |
| notification SSE stream     | module          | existing                  | Optional best-effort push of gate-state-changed for live UI (FR-012).                                                                                                                                   |

## Data model

Shapes adopted verbatim from `work-unit-model.md`; Roubo only validates and
reads `work-units.json` (it is written by the external `breakdown`).

| Entity            | Owner           | Shape                                                                                                                       |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WorkUnitsEnvelope | WorkUnitLoader  | `$schema: string, schemaVersion: string, specSlug: string, units: WorkUnit[]`                                               |
| WorkUnit          | WorkUnitsSchema | `id: string, title: string, type: 'feature'                                                                                 | 'task'                                                                                      | 'spike'                                                                                        | 'bug', kind?: 'e2e'                                                                                                          | 'doc' | 'verify', milestone?: string, depends_on: string[], covers?: string[], implements: { requirement_ids: string[], user_story_ids: string[], test_case_ids: string[] }, tracker?: TrackerRef` |
| VerifyUnit        | WorkUnitsSchema | `WorkUnit & { kind: 'verify', covers: string[], implements.test_case_ids: string[] (the gating set), tracker: TrackerRef }` |
| TrackerRef        | WorkUnitsSchema | `system: 'github'                                                                                                           | 'ghe'                                                                                       | 'jira', ref: string, url: string, node_id?: string, db_id?: number, blocked_by_refs: string[]` |
| GateState         | GateEvaluator   | `gateId: string, status: 'passed'                                                                                           | 'failed'                                                                                    | 'pending'                                                                                      | 'stale', unresolvedCaseIds: string[], coveringUnitIds: string[], evaluatedAt: string` (computed projection, never persisted) |
| FixIssueRecord    | FixIssueFiler   | `fixIssueRef: string, gateRef: string, failedCaseId: string, linkStatus: 'complete'                                         | 'link_pending', createdAt: string` (per-request; partial state surfaced for retry, NFR-003) |

Invariants carried from the PRD / contracts: the gating set defaults to L1/L2 +
`e2e_flow` (FR-005); evaluation uses effective status `statusOverride.status ??
derivedStatus` (FR-005, NFR-007); a gating case that is absent, `orphaned`, or
behind a `planHash` mismatch reads as pending/stale, never passed (FR-004,
NFR-007); `depends_on` is the dependency authority and `tracker.blocked_by_refs`
is its derived projection (work-unit-model R1), so Roubo reads blocking from the
tracker, never from the file.

## Interfaces / contracts

### Module entry points (function-call)

- **StartGate → callers:** `assertGateOpen(projectId, externalId, pluginId,
opts?: { enforce?: boolean, timeoutMs?: 3000, prefetchedIssue?: NormalizedIssue
}): Promise<void>`. Resolves enforcement via `resolveEnforceIssueDependencies`
  when `enforce` is not passed. When ON: reads the issue's `blockedBy` with one
  3s-bounded `getIssue` RPC (or reuses `prefetchedIssue` to avoid a second fetch,
  NFR-002); throws `409 GATE_BLOCKED` if any blocker is unresolved; throws
  `409 GATE_INDETERMINATE` on no active plugin / RPC error / timeout (fail-closed,
  NFR-003). When OFF: returns immediately (FR-006).
- **GateEvaluator:** `evaluateGate(gate: VerifyUnit, results: BenchResults,
currentPlanHash: string): GateState`. Pure, synchronous, in-memory (NFR-002,
  NFR-007).
- **GateLifecycleCoordinator:** `onGatePassed(projectId, gate: VerifyUnit,
pluginId): Promise<void>`. No-ops if the gate's tracker issue is already in a
  done state; else calls `TrackerActionGateway.closeGate` and audit-logs (FR-007,
  NFR-001).
- **FixIssueFiler:** `fileFixIssueAndBlock(projectId, pluginId, gateRef,
failedCaseId, notes, evidence?): Promise<FixIssueRecord>`. Calls
  `createFixIssue` then `addBlockingLink`; on link failure returns
  `linkStatus: 'link_pending'` with the created ref for a link-only retry
  (NFR-003).

### New plugin RPC contract (function-call via pluginManager.invoke)

All capability-gated (NFR-005) and audit-logged (NFR-001); an absent capability
returns a legible degrade, never a silent no-op.

- `createIssue({ title, body, labels }) -> { ref, url, node_id? }`
- `addBlockedBy({ blockedRef, blockerRef }) -> void` (GitHub `addBlockedBy`
  mutation; Jira "is blocked by" link; GHE equivalent)
- `closeGate({ ref }) -> void` (or reuse existing `applyTransition` to the done
  state when `allowedTransitions` exposes one)
- Capability flags on the plugin manifest: `supportsCreateIssue`,
  `supportsBlockingLinks` (NFR-005).

### New HTTP routes (mounted under the existing `/api/projects/:projectId`)

- `GET /api/projects/:projectId/gates -> 200 GateState[]`
- `GET /api/projects/:projectId/gates/:gateId -> 200 GateState` (incl.
  `unresolvedCaseIds`, `coveringUnitIds`) / `404` (FR-012, NFR-004)
- `POST /api/projects/:projectId/gates/:gateId/fix-issues`
  Request: `{ failedCaseId: string, notes: string, evidence?: string,
existingFixRef?: string }` (the optional `existingFixRef` drives the link-only
  retry). Response: `201 FixIssueRecord` (full) / `207 FixIssueRecord`
  (`link_pending`, partial) / `422` (capability absent, NFR-005) / `409`.
- TestBench batch subset: the existing plan endpoint gains an optional
  `?gateIds=TC-019,TC-020` filter returning the gating-case subset, with a
  `filteredToGateIds` marker so existing no-param callers get the unchanged full
  response (FR-008).

## Sequence flows

### Happy path: verify a batch, pass, unblock the next batch

1. The operator opens TestBench in batch mode for a gate (subset = gate's
   `implements.test_case_ids`) and marks each gating case.
2. On each mark write, the sign-off path calls `evaluateGate`. While any gating
   case is not passed, `GateState.status` is `pending`/`failed`/`stale`.
3. When the last gating case is marked passed, `evaluateGate` returns `passed`;
   the sign-off path calls `onGatePassed`, which closes the gate's tracker issue
   via `TrackerActionGateway.closeGate` (audit-logged) and optionally SSE-pushes
   the new state.
4. The tracker's blocking relationship clears; the next batch's units are no
   longer blocked, so `assertGateOpen` permits their benches to start.

### Failed case: file a gate-blocking fix issue

1. The operator marks a gating case failed/blocked and enters notes (and evidence,
   if enabled), then triggers `POST /gates/:gateId/fix-issues`.
2. `FixIssueFiler.createFixIssue` files the issue via the consented plugin
   capability (audit-logged); `addBlockingLink` registers it as a blocker on the
   gate.
3. If `addBlockingLink` fails after the issue is created, the response is `207`
   with `linkStatus: 'link_pending'` and the created ref; the operator retries
   with `existingFixRef` set, which runs only the link step (NFR-003). The gate
   never reads as passable while a fix is outstanding.

### Hard start-gate (fail-closed)

1. A bench-start or assign request arrives for a unit with an upstream verify
   gate; the handler calls `assertGateOpen`.
2. Enforcement OFF: returns immediately. Enforcement ON: one 3s-bounded blocking
   read (or the prefetched issue). Blocked, no plugin, error, or timeout all
   refuse with a 409 and a clear reason (fail-closed). Unblocked: proceed.

## Operational concerns

- **Deployment:** in-process within the existing Roubo server; no new service,
  queue, or datastore. The new schema is a checked-in generated file with a CI
  drift guard (NFR-006).
- **Observability:** every privileged tracker op is in the audit log (NFR-001);
  gate state plus unresolved cases and their covering units are always derivable
  and exposed via `GET /gates/:gateId` (FR-012, NFR-004); an optional SSE push
  gives live UI without being load-bearing.
- **Scaling:** solo operator, low concurrency, sequential finish-then-verify. The
  start path adds at most one bounded RPC; evaluation is in-memory p95 < 200ms
  (NFR-002). `test-results.json` is per-worktree, so there is no concurrent
  writer in the target workflow.
- **Failure modes:** indeterminate blocking/results state with enforcement ON
  fails closed (NFR-003); a corrupt/missing `test-results.json` reads as pending,
  never passed (NFR-007); fix-issue filing is create-then-link with a link-only
  retry; the external "breakdown emits gates" gap is covered by a committed
  fixture `work-units.json` so the runtime is testable now.

## Security & compliance

Carried from the PRD (NFR-001): the create-issue, add-block-link, and close-gate
ops run only through a declared, user-consented integration-plugin capability
(enforced by the existing undeclared-actions guard) and are recorded in the
privileged-broker audit log. Evidence and `test-results.json` are written only
inside the bench workspace via the existing safe-path (`resolveWithin`) barrier;
no tracker tokens or secrets are logged. The enforcement is opt-in: with
`enforceIssueDependencies` OFF there is no gate-blocking (FR-006).

## Supersedes / PRD deltas

None. The chosen architecture honours every PRD `FR-`/`NFR-` as written.

## Open questions

- [x] Spike: does GitHub/GHE support the `addBlockedBy` write path, and Jira an
      "is blocked by" link type? Resolves FR-010, FR-011, NFR-005 and gates the
      `TrackerActionGateway` build. **Resolved by Spike 704 (#704 closed, adopt):**
      feasible on all three trackers GitHub-first, with two capability flags
      `supportsCreateIssue` / `supportsBlockingLinks` and a loud degrade. See
      spikes/spike-704-cross-tracker-issue-create-and-blocking-link.md.
- [ ] Evidence storage for FR-009: tracker attachment upload vs a workspace
      sidecar vs both (default notes-only v1).
- [ ] Batch-subset filter location: the `?gateIds=` plan param vs a dedicated
      gate-plan slice (FR-008).
- [ ] Should `GateEvaluator` live in shared (client can re-evaluate without a
      round-trip) or server-only (smaller browser bundle)? Pure either way
      (NFR-007).
- [ ] Root-path resolution for `work-units.json` (repo `.specifications/<slug>/`
      vs bench worktree) and the gate-state key (per-project vs per-worktree).
- [ ] Exact timeout / retry UX at each start callsite for the fail-closed gate
      (refines NFR-002, NFR-003).

## Out of scope

- `breakdown` writing `work-units.json` / minting `WU-` ids / filing gates
  (external "breakdown emits gates").
- `align`'s results-aware drift pass.
- Test-volume reduction / level-tiering.
- Team separation-of-duties routing.

## Phase mapping

Mirrors the PRD's DE-RISK delivery phasing (pieces 1-5 first, fix-issue filing
last, GitHub-first).

| Phase                                                                     | Components delivered                                                                                                | Interfaces live                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1: model + evaluation                                               | WorkUnitsSchema + validator, WorkUnitLoader, GateEvaluator                                                          | `evaluateGate`; schema CI drift guard (FR-003, FR-004, FR-005, NFR-006, NFR-007)                                                                 |
| Phase 2: enforcement + lifecycle                                          | StartGate, GateLifecycleCoordinator (+ benches / issue-assignment extensions)                                       | `assertGateOpen`; `onGatePassed` → `closeGate` (FR-006, FR-007, NFR-002, NFR-003)                                                                |
| Phase 3: TestBench batch surface                                          | Gate API routes, TestBench batch + gate-state view, operator batch merge/split (FR-002 / US-007, delivered as #703) | `GET /gates`, `GET /gates/:gateId`, `?gateIds=` filter, `POST /gates/merge`, `POST /gates/split` (FR-008, FR-012, FR-002, NFR-004); optional SSE |
| Phase 4: failed-case filing (after the cross-tracker spike, GitHub-first) | TrackerActionGateway, FixIssueFiler, new plugin RPC + capability flags                                              | `createIssue`, `addBlockedBy`, `POST /gates/:gateId/fix-issues` (FR-009, FR-010, FR-011, NFR-001, NFR-005)                                       |
