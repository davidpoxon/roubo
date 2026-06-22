# PRD: Verify gate

| | |
|---|---|
| **Slug** | verify-gate |
| **Status** | draft |
| **Brief** | ./brief.md |
| **Feasibility** | ./feasibility.md |

## Problem statement

Test cases are generated in volume for human verification and then dropped on the
operator all at once at the end of a feature. The batch is large and
mixed-criticality, so verification gets deferred or skipped. Roubo reads issue
blockers only informationally today (`server/routes/benches.ts:188-212`, labelled
"Best-effort and informational"), so nothing actually stops a bench from starting
work that depends on unverified upstream work. The solo operator works a strict
finish-all-units then verify rhythm, so they need verification broken into
phase-sized batches with a real, hard gate that prevents the next milestone from
starting until the current batch has been verified to pass.

## Goals & non-goals

- **Goals:** Deliver the Roubo-side runtime for batched manual verification: a
  validated work-units artifact, deterministic gate evaluation from
  `test-results.json`, a hard start-gate keyed to `enforceIssueDependencies`, the
  pass-time gate close that unblocks the next batch, a TestBench surface for
  signing off a batch (a subset of a spec's cases), and a failed-case capture
  that files a tracker fix issue which blocks the gate.
- **Non-goals:** Authoring `work-units.json` / minting `WU-` ids / filing gates
  (external `product-dev:breakdown` work). `align`'s results-aware drift pass.
  Test-volume reduction / level-tiering. Team separation-of-duties routing
  (notifying or assigning a different person). Re-deciding the settled
  `work-unit-model.md` / `verify-gate.md` contracts.

## In scope

- A `schema/work-units.schema.json` plus a Roubo validator, mirroring the
  `test-cases` / `test-results` schema pair, for the canonical work-unit artifact.
- Deterministic evaluation of the results-to-passed rule (`verify-gate.md`) over a
  gate's gating test set, including staleness (`planHash`) and `orphaned` handling.
- The gate lifecycle: on pass, close the gate's tracker issue so the next batch
  unblocks.
- The hard start-gate driven by the existing `enforceIssueDependencies` setting.
- The TestBench batch surface: present and sign off a subset of one spec's
  `test-cases.json`.
- Failed-case capture (notes + evidence) and tracker fix-issue filing wired to
  block the gate, tracker-agnostically via the active integration plugin.

## Out of scope

- `breakdown` emitting gates: writing `work-units.json`, minting `WU-` ids, filing
  `kind:"verify"` gates with downstream `depends_on` wiring. External dependency,
  tracked as "breakdown emits gates" in the marketplace `product-dev` repo.
- `align`'s results-aware drift pass (gating-set drift, stale gate, orphaned
  results). External `product-dev` work.
- Test-volume reduction (level-tiering / culling). Deferred to its own effort.
- Team separation-of-duties routing. v1 assumes one operator who is both
  implementer and verifier.

## User stories

- **US-001** As a solo operator, I want verification grouped into phase-aligned
  batches so that I verify in human-sized chunks at natural checkpoints instead of
  one large pile at the end. _(P0)_
- **US-002** As an operator, I want the next milestone's benches to be unable to
  start until the current milestone's verify gate has passed (when enforcement is
  on) so that unverified work cannot advance. _(P0)_
- **US-003** As a verifier, I want to verify only the gate's batch (a subset of a
  spec's cases) in TestBench and sign it off, rather than the whole file. _(P0)_
- **US-004** As Roubo, I want to compute a gate's passed / failed / pending /
  stale state deterministically from `test-results.json` so that the gate decision
  is trustworthy and matches the cross-tool contract. _(P0)_
- **US-005** As an operator, when a gate passes I want Roubo to close the gate's
  tracker issue so that the blocking relationship clears and the next batch
  unblocks automatically. _(P0)_
- **US-006** As a verifier, when a gating case fails I want to capture notes and
  evidence and file a tracker fix issue that blocks the gate so that the failure
  becomes a tracked item holding the gate shut until it is resolved. _(P0)_
- **US-007** As an operator, I want to merge or split the default phase-aligned
  batches so that I can right-size a gate when a phase is too coarse or too fine.
  _(P1)_
- **US-008** As a Roubo maintainer, I want a `work-units.json` schema and validator
  so that the canonical work-unit artifact (including `kind:"verify"` gates) is
  validated like `test-cases` / `test-results`. _(P0)_

## Functional requirements

- **FR-001** Roubo presents verification as batches, one per development phase /
  milestone by default, derived from each work unit's `milestone`. _(serves
  US-001; P0)_
- **FR-002** The operator can merge or split batches, overriding the default
  one-gate-per-phase grouping. _(serves US-007; P1)_
- **FR-003** Roubo provides `schema/work-units.schema.json` and a validator that
  validates a `work-units.json` envelope (including `kind:"verify"` units), in the
  pattern of the existing `test-cases` / `test-results` schema pair. _(serves
  US-008; P0)_
- **FR-004** Roubo evaluates a gate's state by reading `test-results.json` and
  applying the deterministic results-to-passed rule over the gate's
  `implements.test_case_ids`: passed only if every gating case is passed; failed
  if any is failed or blocked; pending if any is not_started / in_progress or
  absent / orphaned; stale if the results `planHash` does not match the current
  `test-cases.json` plan hash. _(serves US-004; P0)_
- **FR-005** The gating test set defaults to the batch's L1 / L2 plus `e2e_flow`
  cases (per `verify-gate.md`), and the evaluation uses each case's effective
  status (`statusOverride` if present, else `derivedStatus`). _(serves US-004; P0)_
- **FR-006** When `enforceIssueDependencies` is ON, Roubo refuses to start or
  assign a bench on a unit whose upstream verify gate has not passed, upgrading
  today's informational blocking read into a hard start-gate; when OFF, no
  gate-blocking occurs. _(serves US-002; P0)_
- **FR-007** When a gate's state becomes passed, Roubo closes (transitions to
  done) the gate's tracker issue via the active integration plugin, clearing the
  blocking relationship so the next batch's units unblock. _(serves US-005; P0)_
- **FR-008** TestBench can present and sign off a batch, the subset of one spec's
  `test-cases.json` identified by the gate's `implements.test_case_ids`, not only
  the whole file. _(serves US-003; P0)_
- **FR-009** On marking a gating case failed or blocked, the verifier can attach
  notes and evidence and trigger filing a fix issue into the project's tracker via
  the active integration plugin. _(serves US-006; P0)_
- **FR-010** A filed fix issue is automatically wired to block the gate (registered
  as a blocker on the gate issue) so the gate cannot pass until the fix issue is
  resolved and the case re-verified. _(serves US-006; P0)_
- **FR-011** Issue creation and blocking-link registration are tracker-agnostic,
  routed through the active integration plugin (GitHub / GHE / Jira) behind a
  declared, consented plugin capability; a tracker lacking the capability degrades
  with a clear message rather than a silent no-op. _(serves US-006; P0)_
- **FR-012** For any gate, the operator can see its current state (passed / failed
  / pending / stale) and, for a non-passed gate, the unresolved gating cases and
  the slice unit(s) they trace to (via the gate's `covers`). _(serves US-004,
  US-002; P0)_

## Non-functional requirements

Each NFR has a measurable target and a verification method.

- **NFR-001** _(Security & data integrity)_ Privileged tracker actions
  (create-issue, add-blocking-link, close-gate) run only through a declared,
  user-consented integration-plugin capability and are recorded in Roubo's
  privileged-broker audit log; evidence and `test-results.json` are written only
  inside the bench workspace via the existing safe-path (`resolveWithin`) barrier;
  no tracker tokens or secrets are logged. **Target:** 100% of these actions are
  consent-gated and audit-logged; 0 writes land outside the workspace; 0 secret
  values in logs. **Verify:** a `security` test asserting the undeclared-actions
  guard blocks an unconsented call, an audit-log entry is recorded per action, and
  a path-escaping write is rejected.
- **NFR-002** _(Performance)_ The hard start-gate adds at most one bounded plugin
  RPC (the blocking read) to the bench start / assign path with a 3s timeout;
  deterministic gate evaluation over a batch's results is in-memory.
  **Target:** start-gate adds <= 1 RPC, 3s timeout; gate evaluation p95 < 200ms
  for a spec of up to a few hundred cases. **Verify:** a `performance` test timing
  evaluation over a representative `test-results.json` and asserting a single,
  timeout-bounded RPC on the start path.
- **NFR-003** _(Reliability & safety)_ When enforcement is ON and the gate's
  blocking / results state cannot be determined (no active plugin, RPC error, or
  timeout), the start-gate fails **closed** (refuses, with a clear reason).
  Fix-issue filing is recoverable: if the block-link step fails after the issue is
  created, the partial state is surfaced and a retry of only the link step is
  offered, never leaving a gate that looks passable while a fix is outstanding.
  **Target:** 0 starts permitted on indeterminate blocking state when ON; 0
  silently-half-wired fix issues. **Verify:** a `reliability` test simulating
  plugin-unavailable (start refused) and a create-succeeds / link-fails sequence
  (partial state surfaced, link-only retry succeeds).
- **NFR-004** _(Observability)_ A gate's state and its unresolved gating cases plus
  their slice units are always derivable and surfaced to the operator from data
  Roubo already exposes. **Target:** for every non-passed gate, the API/UI returns
  state + the unresolved `TC-` ids + their covering unit ids. **Verify:** an
  integration test asserting the gate-state payload for pending / failed / stale
  gates includes the unresolved cases and covering units.
- **NFR-005** _(Compatibility)_ Create + blocking-link + close are tracker-agnostic
  across GitHub, GHE, and Jira via the plugin abstraction, with a per-capability
  flag so an unsupported tracker degrades with a clear message. **Target:** the
  three operations are defined in the plugin contract with capability flags; an
  absent capability yields a legible degrade, never a silent no-op. **Verify:** a
  `compatibility` test exercising the capability-flag path (supported vs degraded).
- **NFR-006** _(Maintainability)_ The work-units artifact is a versioned envelope
  (`$schema` + `schemaVersion`) validated in CI with a drift guard mirroring the
  `test-cases` / `test-results` pair (generated-from-source, with the existing
  `scripts/generate-schema.ts` + pr-check pattern). **Target:** schema validated in
  CI; a source/schema drift fails CI. **Verify:** a CI job (and unit test)
  asserting the generated schema matches the source and rejects an invalid
  `work-units.json`.
- **NFR-007** _(Correctness / determinism)_ Gate evaluation is deterministic and a
  pure function of `test-results.json` + the gating set: it uses effective case
  status, and absent / orphaned / stale never read as passed. **Target:** the same
  inputs always yield the same gate state; 0 false-pass outcomes from
  orphaned / absent / stale cases. **Verify:** a table-driven unit test over the
  rule's truth table (passed / failed / pending / stale, incl. `statusOverride`
  and `planHash` mismatch).

## Success indicators

### Leading

| Indicator | Baseline | Target | Source | Validates |
|-----------|----------|--------|--------|-----------|
| Per-phase verification completion (% of milestones whose gate is signed off before the next milestone's first bench starts) | 0 (no gates today) | > 90% | gate state + bench start timestamps | US-001, US-002 |
| Hard-gate refusals (count of bench-start/assign attempts correctly refused by an unpassed gate when ON) | n/a (informational only today) | > 0 and matching unpassed gates | start-gate refusal records / audit log | US-002, FR-006 |
| Failed-case to fix-issue conversion (% of failed gating cases that become a filed, gate-blocking fix issue) | 0 | > 80% | failed-case + fix-issue records | US-006 |

### Lagging

| Indicator | Baseline | Target | Source | Validates |
|-----------|----------|--------|--------|-----------|
| Deferred / skipped verification batches | high (current pain) | trends to ~0 | gates left pending past their milestone | the feature |
| Milestones advancing on unverified work when ON | unknown / unguarded today | 0 instances | gate state vs next-batch bench start | US-002 |

## Dependencies & assumptions

- **External dependency (runtime prerequisite):** `breakdown` emitting
  `work-units.json` with `kind:"verify"` units carrying `tracker.ref`. Roubo's
  runtime consumes this; a hand-authored fixture stands in for local
  development / testing until the external "breakdown emits gates" effort lands.
- **Settled contracts adopted as-is:** `docs/work-unit-model.md` and
  `docs/verify-gate.md` (gate unit, gating policy, deterministic results-to-passed
  rule, dedup key, blocking topology).
- **Gate pass-condition extension (confirmed allowed):** "results-to-passed rule
  over gating cases AND all gate blockers done (including spawned fix issues)" is a
  clean extension of `work-unit-model.md` R1, since Roubo reads blocking from the
  tracker, not from `work-units.json`. It augments, not contradicts, the contract.
- **Existing primitives reused:** `ajv 8.20.0`; the TestBench surface
  (`client/src/components/testbench/`, `useTestbench*`, `server/lib/testbench-*`,
  `server/routes/testbench.ts`); `enforceIssueDependencies` resolution
  (`projectRegistry.resolveEnforceIssueDependencies`); tracker-agnostic blocking
  read (`NormalizedIssue.blockedBy`); the privileged-broker audit log; the
  notification stream (available, not required for v1's failed-gate UX).
- **Delivery sequencing (from feasibility, DE-RISK):** implement create + link
  GitHub-first, then GHE / Jira behind capability flags; ship pieces 1-5 (schema,
  evaluation, gate lifecycle, hard start-gate, batch surface) as a milestone that
  delivers US-001..US-005; phase piece 6 (US-006 fix-issue filing) starting
  notes-first if evidence storage is deferred.

## Open questions

- [ ] **Spike:** does the GitHub/GHE plugin support the `addBlockedBy` write path,
      and does Jira support an equivalent "is blocked by" link type? (resolves
      FR-010, FR-011, NFR-005)
- [ ] **Decision:** screenshot / evidence storage, tracker attachment upload vs a
      sidecar alongside `test-results.json` vs both (default: notes-only for v1).
      (affects FR-009)
- [ ] **Decision:** batch-subset filter server-side (a plan query param) vs
      client-side (filter by the gate's `test_case_ids`). (affects FR-008)
- [ ] **Decision:** exact timeout / retry UX at each start callsite for the
      fail-closed gate. (refines NFR-002, NFR-003)
- [ ] **Open:** re-verification after a fix that also edits `test-cases.json` and
      its interaction with spec-level `planHash` staleness granularity. (affects
      FR-004)
- [ ] **Open:** is the operator batch merge/split (US-007 / FR-002) in v1 scope or
      deferred behind read-only batch presentation, and how it reconciles with
      gates already filed by the external `breakdown`.
