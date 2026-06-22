# Verify gate (contract)

**Status:** Adopted by this spec (the Roubo-side `verify-gate` feature in this
folder). This is the cross-tool _contract_ for batched manual verification: the
gate unit, the deterministic rule that decides whether a batch has passed, and the
seam by which that decision blocks downstream work. It builds on
[`work-unit-model.md`](./work-unit-model.md); read that first. The Roubo build is
specced in the sibling [`prd.md`](./prd.md) and [`architecture.md`](./architecture.md);
product-dev `breakdown` (the marketplace side that _emits_ gates) has not adopted
it yet.

This document folds in the decisions the verify-gate spec settled (failed-case
handling, the pass-condition extension, batch granularity, enforcement strength),
so it stays the single cross-tool source of truth both repos build against.

## Problem

Test cases are generated in volume for human verification, then dropped on the
human all at once at the end of a feature. The batch is large, the cases are
mixed-criticality, and verification gets deferred or skipped. We want:

1. verification broken into batches that line up with natural development
   checkpoints, and
2. downstream work that cannot proceed until the batch it depends on has been
   verified to pass.

The work-unit model already carries every field this needs (`kind`, `depends_on`,
`implements.test_case_ids`, the `tracker` projection). This contract specifies the
`kind: "verify"` unit and the results-to-passed rule on top of it.

## The verify unit

A verify gate is a work unit (per `work-unit-model.md`) with:

| Field                                           | Value                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                                          | `"task"` (a technical enabler, like an e2e unit; never a new type)                                                                          |
| `kind`                                          | `"verify"`                                                                                                                                  |
| `labels`                                        | must contain `"verify"` (half the dedup key) plus a priority                                                                                |
| `depends_on`                                    | every slice unit in this batch (the work the gate verifies)                                                                                 |
| `covers`                                        | the same set as `depends_on` (the recorded coverage claim)                                                                                  |
| `implements.test_case_ids`                      | the batch's **gating test set** (see Gating policy)                                                                                         |
| `implements.requirement_ids` / `user_story_ids` | the union of the gated cases' links                                                                                                         |
| `milestone`                                     | the batch's phase                                                                                                                           |
| `description` / `acceptance_criteria`           | "every gating case passes in verification, none fails or is blocked, and no fix issue holds the gate open", projected into the tracker body |

**The downstream edge (the point of the whole thing):** every unit in the _next_
batch lists this gate's `id` in its `depends_on`. That projects (per
`work-unit-model.md` R1) into the next batch's `tracker.blocked_by_refs`, which
Roubo enforces. A batch's slices block the gate; the gate blocks the next batch.

```jsonc
{
  "id": "WU-040",
  "title": "Verify gate: Phase 2 (sources picker) manual verification",
  "type": "task",
  "kind": "verify",
  "labels": ["P0", "verify"],
  "milestone": "Phase 2: sources picker",
  "depends_on": ["WU-031", "WU-032", "WU-033"],
  "covers": ["WU-031", "WU-032", "WU-033"],
  "implements": {
    "requirement_ids": ["FR-002", "FR-005", "US-003"],
    "user_story_ids": ["US-003", "US-004"],
    "test_case_ids": ["TC-019", "TC-020", "TC-024"],
  },
  "tracker": {
    "system": "github",
    "ref": "451",
    "url": "https://github.com/davidpoxon/roubo/issues/451",
    "blocked_by_refs": ["441", "442", "443"],
  },
}
```

## Batch definition

A **batch** is a phase / milestone, derived from each unit's `milestone`; one
verify gate per phase by default. `breakdown` already groups slices into phases
(from the architecture's phase mapping, else the PRD), so the checkpoint rhythm
already exists.

**Resolved by the spec:** the operator can **merge or split** the default
phase-aligned batches to right-size a gate when a phase is too coarse or too fine
(US-007 / FR-002). Phase-aligned is the default, not a law.

## Gating policy (which cases gate)

By default the gating test set is the batch's **L1 and L2 cases plus its
`e2e_flow` cases**. L3 and L4 cases are tracked but **not** in the gating set:
they do not block downstream work and belong in an automation / regression
backlog, not in a human's blocking queue. This keeps human verification time spent
on what matters, and it is the join point with the test-volume reduction idea (a
separate, deferred concern): level already encodes criticality, so the gate reuses
it rather than inventing a value score.

Evaluation uses each case's **effective status**: `statusOverride` when present,
otherwise `derivedStatus` (FR-005).

## The results-to-passed rule (deterministic)

Roubo's TestBench writes
[`test-results.json`](../../schema/test-results.schema.json) (v2.0.0): per case a
`derivedStatus` in `{ not_started, in_progress, passed, failed, blocked }`, an
optional `statusOverride`, a `planHash` over the test plan, and `orphaned`
markers.

A verify gate is **passed** if and only if:

- for every `TC-` id in `implements.test_case_ids`, the case's **effective status**
  (`statusOverride` else `derivedStatus`) is `"passed"`, and none is `"failed"` or
  `"blocked"`; **and**
- every one of the gate's tracker-level blockers is done, including any spawned
  **fix issues** (see Failed-case handling).

Otherwise the gate is **not passed**:

- any gating case failed/blocked, or any open blocker (fix issue) -> gate **failed**;
- any gating case `not_started` or `in_progress` (and none failed/blocked) -> gate
  **pending**;
- a gating `TC-` id absent from `caseResults`, or marked `orphaned` -> gate
  **pending** (treated as unverified, never as passed).

**Staleness:** if `test-results.json.planHash` does not match the current
`test-cases.json` plan hash, the gate is **stale** and cannot be passed until the
batch is re-verified. Stale never reads as passed.

The blocker clause is the **pass-condition extension** the spec confirmed against
`work-unit-model.md` R1: Roubo reads blocking from the tracker (not from
`work-units.json`), so adding a fix issue to the gate's blockers augments the model
rather than contradicting it.

## Failed-case handling and fix issues

**Resolved by the spec (the failed-gate UX):** when a gating case is marked failed
or blocked, the verifier captures notes and evidence and files a **fix issue** into
the project's tracker, which is automatically wired to **block the gate** (FR-009 /
FR-010). The gate cannot pass until the fix issue is resolved and the case
re-verified.

Tracker actions (create-issue, add-blocking-link, close-gate) are tracker-agnostic,
routed through the active integration plugin (GitHub / GHE / Jira) behind a
**declared, consented** capability and recorded in the privileged-broker audit log;
a tracker lacking the capability degrades with a clear message, never a silent
no-op (FR-011, NFR-001, NFR-005). Filing is **recoverable**: if the block-link step
fails after the issue is created, the partial state is surfaced and a link-only
retry is offered, so a gate never looks passable while a fix is outstanding
(NFR-003).

## Lifecycle and ownership

Roubo owns the transition, because it writes the results and talks to the tracker:

1. A human verifies the batch in TestBench; marks accumulate in `test-results.json`.
2. Roubo evaluates the results-to-passed rule (including the blocker clause) over
   the gate's gating set.
3. On **passed**, Roubo closes (or marks done) the gate's tracker issue. The
   tracker's blocking relationship clears, and the next batch's units unblock.
4. On **failed**, the verifier captures notes/evidence and a gate-blocking fix
   issue is filed; the gate stays shut until the fix is resolved and the case
   re-verified.

`breakdown` files the gate and wires the topology; Roubo drives the runtime state.
Neither parses the other's runtime store: `breakdown` does not read
`test-results.json`, Roubo does not parse `work-units.json` to enforce (it reads
blocking from the tracker, per `work-unit-model.md` R1).

## Enforcement

**Resolved by the spec (enforcement strength):** when `enforceIssueDependencies` is
ON, a bench may not start or be assigned work on a unit whose upstream verify gate
has not passed (a hard start-gate, upgrading Roubo's current informational read).
When OFF, no gate-blocking occurs. When ON and the gate's blocking / results state
cannot be determined (no active plugin, RPC error, or timeout), the start-gate
fails **closed** (refuses, with a clear reason) (NFR-003).

## Dedup key (idempotency)

Mirrors the e2e-unit discipline. A verify gate is **already present** when some
unit has:

> `kind == "verify"` **and** `labels` contains `"verify"` **and**
> `implements.test_case_ids` set **equals** the batch's gating test set
> (exact set equality, order-independent).

Checked against `work-units.json` only, never a live tracker query. A re-run of
`breakdown` files zero duplicate gates. Like e2e/doc units, gate creation is
depth-aware: under reduced/minimal depth only the batches the change touches get a
new or refreshed gate.

## Drift (align)

`align` gains a results-aware pass that reports, without auto-fixing:

- a gate whose `implements.test_case_ids` has drifted from the batch's actual
  L1/L2 + `e2e_flow` cases (a gating-set mismatch),
- a **stale** gate (results `planHash` mismatch),
- `orphaned` results (a marked case no longer in `test-cases.json`).

These are new finding types in the drift taxonomy, consuming `test-results.json`,
which `align` does not read today. This is marketplace `product-dev` work.

## What the spec left as implementation detail

The contract-level decisions above are settled. Remaining implementation-level
questions (evidence storage default, batch-subset filter server- vs client-side,
exact timeout/retry UX at each start callsite, re-verification `planHash`
granularity) live in [`prd.md`](./prd.md) "Open questions" and are the build's to
decide, not the contract's.

## What this contract guarantees

The gate unit, the gating policy, the deterministic pass rule (including the
blocker clause), the dedup key, and the blocking topology are fixed cross-tool
decisions. Both repos build to them so the two tools agree byte-for-byte on what
"the batch passed" means.
