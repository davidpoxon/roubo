# Brief: Verify gate

> One-line pitch: Batched manual verification with a hard cross-tool dependency gate, so a milestone's work cannot advance until a human has verified its critical tests pass in TestBench.

## Problem

Test cases are generated in volume for human verification, then dropped on the
human all at once at the end of a feature. The batch is large, the cases are
mixed-criticality, and verification gets deferred or skipped. Two things are
missing: verification broken into batches that line up with natural development
checkpoints, and downstream work that genuinely cannot proceed until the batch
it depends on has been verified to pass. Today Roubo reads issue blockers only
informationally, so nothing actually stops unverified work from advancing.

## Target users

- **Primary:** the solo Roubo operator who is both implementer and verifier. They
  work a strict rhythm: execute every substantive work unit for a milestone /
  phase via an AI coding agent, and only once all of those are complete switch
  into verification in TestBench. At verification time there is no open
  implementation bench, the same person now wears the verifier hat.
- **Not the user (v1):** teams that need separation of duties between a reviewer
  and an implementer, with notifications and fix work routed to a different
  person. v1 assumes one actor; team routing is out of scope.

## Jobs to be done

- Verify a milestone's work in human-sized batches at natural checkpoints,
  instead of facing one large mixed-criticality pile at the very end.
- Be unable to start the next milestone's work until the current milestone's
  verification batch has actually passed (a real gate, not a reminder).
- When a case fails, capture the evidence and turn it into a tracked fix that
  itself holds the gate shut until resolved.

## Current alternatives & their gaps

- **Verify everything at the end, all at once:** the batch is too big and
  mixed-criticality, so verification is deferred or skipped entirely.
- **Roubo's current informational blocker read:** it surfaces blockers in the
  bench view but does not stop a bench from starting blocked work, so there is no
  enforcement.
- **Manual discipline:** relying on the operator to remember to verify each phase
  before moving on does not survive a busy run.

## Core capabilities

1. **Work-units schema + validator.** A `work-units.schema.json` plus a Roubo
   validator, mirroring the existing `test-cases` / `test-results` schema pair,
   for the canonical work-unit artifact defined in `work-unit-model.md`.
2. **Results-to-passed evaluation.** Evaluate the deterministic results-to-passed
   rule from `verify-gate.md` over a gate's gating test set (default: the batch's
   L1 / L2 + `e2e_flow` cases), reading `test-results.json`, including the
   staleness (`planHash` mismatch) and `orphaned` handling.
3. **Gate lifecycle.** On pass, close the gate's tracker issue so the blocking
   relationship clears and the next batch unblocks. On fail, the gate stays open.
4. **Hard start-gate.** Upgrade today's informational blocking read into a hard
   start-gate driven entirely by the existing `enforceIssueDependencies` setting:
   ON means a bench cannot start or be assigned a unit whose verify gate has not
   passed; OFF means no gate-blocking. No separate override.
5. **TestBench batch surface.** Present and sign off a subset of one spec's
   `test-cases.json` (the batch), given TestBench focuses on the whole file today.
   Batches default to one per phase / milestone, with the operator able to merge
   or split a batch.
6. **Failed-case capture and fix-issue filing.** On marking a gating case
   failed / blocked, the verifier can attach notes and screenshots / evidence,
   then file a fix issue into the project's tracker via the active integration
   plugin (GitHub, GitHub Enterprise, or Jira). Roubo automatically wires the new
   fix issue to **block the gate** (the gate depends on it), so the gate cannot
   pass until the fix is resolved and the case re-verified.

## Out of scope (v1)

- **`breakdown` emitting gates** (writing `work-units.json`, minting `WU-` ids,
  filing `kind:"verify"` gates with downstream `depends_on` wiring). Treated as an
  external dependency in the marketplace `product-dev` repo, named "breakdown
  emits gates".
- **`align`'s results-aware drift pass** (gating-set drift, stale gate, orphaned
  results findings). Also external `product-dev` work.
- **Test-volume reduction** (the level-tiering / culling idea). Deferred to its
  own effort; verify-gate ships using the existing level axis as the gating lever
  and adds no culling UI.
- **Team separation-of-duties routing** (notifying / assigning a fix to a person
  other than the operator).

## Constraints

- **Platform/tech:** Roubo monorepo (npm workspaces `shared` / `server` /
  `client`), Node >= 24.14.0, Express 5 + TypeScript server, React 19 + Vite +
  Tailwind client. New schema follows the `schema/test-cases.schema.json` /
  `schema/test-results.schema.json` pattern with a Roubo-side validator.
- **Settled cross-tool contracts (adopt, do not re-derive):**
  [`work-unit-model.md`](./work-unit-model.md) (the canonical work-unit
  artifact) and [`verify-gate.md`](./verify-gate.md) (the gate unit, the
  gating policy, the deterministic results-to-passed rule, the dedup key, the
  blocking topology). The architecture stage must adopt and record these, not
  re-open them.
- **Tracker-agnostic:** fix-issue creation and blocking-relationship wiring go
  through the active integration plugin (GitHub / GHE / Jira), never GitHub-only
  calls, consistent with `work-unit-model.md`'s tracker-agnostic model.
- **Builds on a mature TestBench:** the in-app manual test-review surface already
  exists (`client/src/components/testbench/`, `useTestbench*` hooks,
  `server/lib/testbench-*`, `server/routes/testbench.ts`, `test-results.json`
  writes). This feature extends it; it does not build TestBench from scratch. See
  the existing `testbench` spec, which this feature depends on.

## Differentiation

Internal Roubo capability, not a competitive product. The distinguishing choice
is making the dependency gate **hard and cross-tool**: the verification decision a
human makes in TestBench deterministically gates whether Roubo will let the next
batch's benches start, with the two tools agreeing byte-for-byte on what "the
batch passed" means.

## Success definition

- **Leading:** verification happens incrementally, per milestone, rather than being
  dumped at the end; each phase's L1 / L2 + `e2e_flow` cases are signed off before
  the next phase's benches start.
- **Lagging:** no milestone advances on unverified work when enforcement is on; the
  count of deferred / skipped verification batches trends to zero; failed cases
  reliably become tracked fix issues that hold the gate shut until resolved.

## Open questions & risks

- [ ] **Gate-blocking fix issue extends the settled contract.** `verify-gate.md`
      says only that failing TC ids and notes are the signal back to the
      implementer. The chosen UX adds a verification-spawned fix issue that blocks
      the gate. Architecture must reconcile the gate's pass condition as: the
      results-to-passed rule over gating cases AND all gate blockers (including
      spawned fix issues) done. Confirm this is an allowed extension, not a
      contradiction, of the contract.
- [ ] **Screenshot / evidence storage.** Where do attached screenshots live:
      uploaded to the tracker issue, stored alongside `test-results.json`, or both?
      Affects the TestBench capture surface and the fix-issue body.
- [ ] **Tracker-agnostic blocking wiring.** Creating an issue and registering a
      blocking relationship must work across GitHub, GHE, and Jira via the
      integration plugin abstraction; confirm each plugin supports the blocking
      link Roubo needs.
- [ ] **Batch merge/split mechanics.** How the operator overrides the default
      one-gate-per-phase grouping, and how that interacts with `breakdown` (the
      external tool) having already filed the gates.
- [ ] **Re-verification and staleness.** After a fix lands, the batch is
      re-verified; confirm the `planHash` staleness rule plays correctly with a
      mid-batch fix that changes `test-cases.json`.

## Source notes

- Fixed architecture inputs: the settled contracts `work-unit-model.md` and
  `verify-gate.md` (now in this spec folder).
- Interview changelog (2026-06-22):
  - Batch granularity: phase-aligned default, operator can merge / split a batch.
  - Enforcement: hard block, no override, keyed to the existing
    `enforceIssueDependencies` setting (ON = hard block, OFF = no gate-blocking).
  - Failed-gate UX: capture notes + screenshots on a failed case, then auto-file a
    tracker fix issue (GitHub / Jira / etc.) wired to block the gate.
  - Test-volume reduction: deferred to its own effort.
  - Persona: solo operator, both implementer and verifier, sequential
    finish-then-verify-then-next rhythm; team routing out of scope for v1.
