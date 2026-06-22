# Work-unit model (canonical, proposed)

**Status:** Proposed. Not yet adopted. Today `product-dev:breakdown` writes
`issues.json` and three Roubo specs still carry a different `work-units.json`.
This document is the single target the two converge on, so the verify-gate work
(batched manual verification with cross-tool dependency enforcement) builds on
one model rather than two.

**Decision in one line:** product-dev remains the owning toolchain, and it
adopts the work-unit-first _structure_ (a stable unit with a nested tracker
reference), because a work unit must outlive any single issue tracker.

This is a contract / decision record. It defines the on-disk artifact only. It
does not define the verify-gate feature, manual-verification batching, or the
`test-results.json` semantics; those are a separate spec that consumes this one.

## Why this exists

Two distinct lifecycle toolchains have written into `.specifications/` in this
repo, and they emit different work-unit artifacts:

|                | product-dev (the marketplace plugin)                      | the other toolchain                                               |
| -------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Work-unit file | `issues.json`                                             | `work-units.json`                                                 |
| State file     | `manifest.json`                                           | `flow-state.json`                                                 |
| Tracker scope  | GitHub only (`gh`)                                        | tracker-agnostic (`issue_target`, `jira_epic_key`)                |
| Maintenance    | live (edited continuously)                                | frozen (untouched for weeks)                                      |
| Specs here     | `testbench`, `component-plugins`, `cut-list-improvements` | `global-bench-limit`, `integration-plugins`, `jira-sources-scale` |

Neither file is read by Roubo's application code: discovery reads
`test-cases.json`, the TestBench writes `test-results.json`, and blocking is read
from the tracker through the active integration plugin. So standardizing the
work-unit artifact breaks no Roubo code; the choice is purely about which
generator convention and which structure win.

The structure question is settled by tracker scope. Work units must be
enforceable on GitHub, GitHub Enterprise, and Jira-tracked projects (Roubo is
tracker-agnostic and ships integration plugins for each). The moment a unit can
be filed into more than one tracker, `issues.json`'s "the entry _is_ the GitHub
issue, keyed on its number" model is wrong, and `work-units.json`'s "stable unit
with a nested tracker reference" structure is right. The reconciled model is
therefore the work-unit-first _shape_ carrying product-dev's _rigor_ (minted
ids, the `kind` extension pattern, dedup contracts, depth-awareness, and the
documented stage skills).

## Scope

Governs the on-disk work-unit artifact for a feature folder
(`.specifications/<slug>/`).

- **Written by:** `product-dev:breakdown`.
- **Read by:** `product-dev:align`, `product-dev:review`, `product-dev:document`,
  and `scripts/e2e_coverage.py`.
- **Validated by:** Roubo (a JSON Schema mirroring the existing
  [`schema/test-cases.schema.json`](../../schema/test-cases.schema.json) /
  [`schema/test-results.schema.json`](../../schema/test-results.schema.json) pair).
- **Enforced by:** Roubo, which reads blocking from the active integration plugin
  (not from this file) and gates work via `enforceIssueDependencies`.

Out of scope (separate spec): the verify-gate unit's full contract, the rule that
maps `test-results.json` to a "batch passed" state, and turning
`enforceIssueDependencies` from informational into a hard start-gate.

## File shape

A versioned envelope wrapping a `units` array, symmetric with `test-cases.json`:

```jsonc
{
  "$schema": "https://roubo.dev/schema/work-units/v1.0.0.json",
  "schemaVersion": "1.0.0",
  "specSlug": "testbench",
  "units": [
    {
      "id": "WU-003",
      "title": "Results store: safe-path write of test-results.json",
      "type": "feature",
      "description": "Persist per-observation marks to test-results.json behind the resolveWithin barrier.",
      "acceptance_criteria": [
        "Writes land at .specifications/<slug>/test-results.json only",
        "A path escaping the repo is rejected before any fs call",
      ],
      "milestone": "Phase 1: results plumbing",
      "labels": ["P0"],
      "estimate": 3,
      "depends_on": [],
      "implements": {
        "requirement_ids": ["NFR-001", "NFR-003"],
        "user_story_ids": ["US-008"],
        "test_case_ids": ["TC-050", "TC-051"],
      },
      "tracker": {
        "system": "github",
        "ref": "406",
        "url": "https://github.com/davidpoxon/roubo/issues/406",
        "node_id": "I_kwDOExample406",
        "blocked_by_refs": [],
      },
    },
    {
      "id": "WU-009",
      "title": "Verify gate: Phase 1 manual verification",
      "type": "task",
      "kind": "verify",
      "description": "Human sign-off that the Phase 1 batch passes in TestBench before Phase 2 starts.",
      "acceptance_criteria": [
        "Every gating test case has a passing derivedStatus in test-results.json",
        "No gating case is failed or blocked",
      ],
      "milestone": "Phase 1: results plumbing",
      "labels": ["P0", "verify"],
      "depends_on": ["WU-003"],
      "implements": {
        "requirement_ids": ["NFR-001"],
        "user_story_ids": ["US-008"],
        "test_case_ids": ["TC-050", "TC-051"],
      },
      "covers": ["WU-003"],
      "tracker": {
        "system": "github",
        "ref": "420",
        "url": "https://github.com/davidpoxon/roubo/issues/420",
        "blocked_by_refs": ["406"],
      },
    },
  ],
}
```

## Field reference

### Envelope

| Field           | Type   | Required | Meaning                                                                   |
| --------------- | ------ | -------- | ------------------------------------------------------------------------- |
| `$schema`       | string | yes      | Versioned schema URI (`https://roubo.dev/schema/work-units/v1.0.0.json`). |
| `schemaVersion` | string | yes      | Semver, kept consistent with `$schema`.                                   |
| `specSlug`      | string | yes      | The `.specifications/<slug>/` folder name this file lives in.             |
| `units`         | array  | yes      | The work-unit objects below.                                              |

### Unit

| Field                 | Type     | Required           | Tracker-agnostic | Meaning                                                                                                             |
| --------------------- | -------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                  | string   | yes                | yes              | Minted `WU-NNN` (bare) or `<id_code>-WU-NNN` (coded). Permanent, tracker-independent identity.                      |
| `title`               | string   | yes                | yes              | One-line imperative summary.                                                                                        |
| `type`                | enum     | yes                | yes              | `feature` \| `task` \| `spike` \| `bug`. Our category; the integration plugin maps it to the tracker's native type. |
| `kind`                | enum     | no                 | yes              | `e2e` \| `doc` \| `verify`. Durable semantic role. Absent means a plain delivery slice.                             |
| `description`         | string   | yes                | yes              | Short objective / context. On-disk source of truth, projected into the tracker body.                                |
| `acceptance_criteria` | string[] | yes                | yes              | On-disk source of truth, projected into the tracker body.                                                           |
| `milestone`           | string   | no                 | yes              | Phase label.                                                                                                        |
| `labels`              | string[] | no                 | yes              | Priority (`P0`/`P1`/`P2`) plus semantic labels (`e2e`, `verify`).                                                   |
| `estimate`            | number   | no                 | yes              | Optional effort points.                                                                                             |
| `depends_on`          | string[] | yes (may be empty) | yes              | `WU-` ids. The dependency authority (see R1).                                                                       |
| `implements`          | object   | yes                | yes              | `{ requirement_ids[], user_story_ids[], test_case_ids[] }`. Test linkage is first-class on every unit (see R4).     |
| `covers`              | string[] | no                 | yes              | `WU-` ids this unit spans (used by `e2e` / `verify` units).                                                         |
| `target_path`         | string   | no                 | yes              | Doc-unit only: the documentation artifact it updates.                                                               |
| `trigger_reason`      | string   | no                 | yes              | Doc-unit only: which doc-standard rule fired.                                                                       |
| `tracker`             | object   | no until filed     | no               | The tracker manifestation (below). Absent before the unit is filed.                                                 |

### tracker

| Field             | Type     | Required           | Meaning                                                                      |
| ----------------- | -------- | ------------------ | ---------------------------------------------------------------------------- |
| `system`          | enum     | yes                | `github` \| `ghe` \| `jira`.                                                 |
| `ref`             | string   | yes                | The tracker's external id: an issue number (GitHub) or issue key (Jira).     |
| `url`             | string   | yes                | Canonical issue URL.                                                         |
| `node_id`         | string   | no                 | GitHub GraphQL node id.                                                      |
| `db_id`           | number   | no                 | GitHub REST id.                                                              |
| `blocked_by_refs` | string[] | yes (may be empty) | Derived projection of `depends_on` into this tracker's `ref` space (see R1). |

## Normative rules

**R1. `depends_on` is the dependency authority; `tracker.blocked_by_refs` is a
derived projection.** The dependency graph is expressed once, in unit space, over
stable `WU-` ids, so it exists and is reviewable before any issue is filed and is
identical across trackers. When units are filed (or refiled) into a tracker, each
`depends_on` target is resolved to that unit's `tracker.ref` in the _same_
tracker, producing `blocked_by_refs`. Units are filed in topological order so the
referenced ids already exist. `blocked_by_refs` is regenerated on every file and
never hand-edited. Roubo enforces dependencies by reading the tracker's blocking
relationship through the active integration plugin (whose `NormalizedIssue`
already carries `blockedBy` as tracker-agnostic external ids), never by parsing
this file.

**R2. Ids are minted, stable, and tracker-independent.** `id` is minted by
`id_mint.py` with prefix `WU`; the minter stays the single writer of
`manifest.json.id_counters`. Migrated folders use the coded form
`<id_code>-WU-NNN`; un-migrated folders use bare `WU-NNN`. Never hand-assign an
id or hand-edit the counter. A unit's `id` is permanent; its `tracker.ref` may
change (a refile, or a move to a different tracker) but the `id` does not. This
closes product-dev's one identity gap: work units were previously the only
artifact keyed on a tracker number instead of a minted id.

**R3. `type` and `kind` are separate axes.** `type` is our tracker-agnostic work
category (`feature` / `task` / `spike` / `bug`); each integration plugin maps it
to the tracker's native type. `kind` is an optional durable semantic role
(`e2e` / `doc` / `verify`) that `align`, `review`, and the dedup keys rely on,
identical across trackers. Because `type` is now tracker-agnostic, `spike` is
carried directly by `type: "spike"`, and the legacy `kind: "spike"` marker is
retired: it existed only because GitHub has no native Spike type, so the native
value could not distinguish a spike from a task. Consumers that keyed on
`kind == "spike"` switch to `type == "spike"`.

**R4. Test linkage is first-class on every unit.**
`implements.test_case_ids` lists the `TC-` ids a unit is verified by, on every
unit, not only on e2e units. For a `kind: "verify"` unit it is the gating test
set the human (or automation) must pass. The old e2e shape's `verified_by` folds
into `implements.test_case_ids`, and its issue-number `covers` becomes `WU-` ids.

**R5. The body is on-disk source of truth.** `description` and
`acceptance_criteria` live in this file and are projected into the tracker issue
body at file time. The tracker body is a rendering, not the source. This keeps
units previewable and diffable without hitting a tracker, and portable when a
unit is filed into a different tracker. The mild duplication is accepted
deliberately.

**R6. Envelope plus published schema.** The file is an envelope
(`$schema`, `schemaVersion`, `specSlug`, `units`) with a published `$id`,
validatable by Roubo exactly like `test-cases.json` and `test-results.json`. The
canonical filename is `work-units.json`.

## Tracker projection and enforcement

The model is built so Roubo can enforce "downstream work cannot start until its
blockers are done" across any tracker:

1. `breakdown` files each unit into the project's tracker (via the integration
   plugin), in `depends_on` topological order.
2. For each filed unit, it resolves `depends_on` to the blockers' `tracker.ref`
   values and records them as `blocked_by_refs`, and registers the blocking
   relationship in the tracker (GitHub `addBlockedBy`, the Jira equivalent link).
3. Roubo reads that relationship back through the integration plugin
   (`NormalizedIssue.blockedBy`, already external-id based) and, when
   `enforceIssueDependencies` is on, factors it into whether a bench may work the
   issue.

Today Roubo's blocking read is informational (it surfaces blockers in the bench
view). Turning it into a hard start-gate, and computing a `verify` unit's
"passed" state from `test-results.json`, is the verify-gate feature, out of scope
here. This document only guarantees the model carries the data that feature
needs.

## Reconciliation from current artifacts

| Concept                | `issues.json` (today)                         | `work-units.json` (today)                                    | Canonical                                                              |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Identity               | `number` (GitHub #)                           | `id` (`WU-`) + nested `issue`                                | `id` (minted `WU-`) + `tracker`                                        |
| Category               | `type` + `kind`                               | `category`                                                   | `type` + `kind` (R3)                                                   |
| Requirements / stories | `implements.{requirement_ids,user_story_ids}` | `linked_requirement_ids` / `linked_user_story_ids`           | `implements.{requirement_ids,user_story_ids}`                          |
| Tests                  | `implements.test_case_ids`, e2e `verified_by` | `linked_test_ids`                                            | `implements.test_case_ids` (R4)                                        |
| Dependency             | `blocked_by` (GitHub #)                       | `depends_on` (`WU-`) + `issue.blocked_by`                    | `depends_on` (authority) + `tracker.blocked_by_refs` (projection) (R1) |
| Phase                  | `milestone`                                   | `github_milestone_number` (in flow-state)                    | `milestone` (per unit)                                                 |
| Effort                 | (none)                                        | `estimate`                                                   | `estimate` (optional)                                                  |
| Body                   | in the tracker issue                          | inline `description` + `acceptance_criteria`                 | inline, projected (R5)                                                 |
| e2e unit               | `kind:"e2e"`, `verified_by`, `covers`(#)      | `category:"e2e_automation"`, `depends_on`, `linked_test_ids` | `kind:"e2e"`, `implements.test_case_ids`, `covers`(`WU-`)              |
| spike                  | `type` + `kind:"spike"`                       | `category`                                                   | `type:"spike"` (R3)                                                    |
| Tracker                | implied GitHub                                | `issue.system`                                               | `tracker.system`                                                       |

## Gate-readiness (informative)

A verify gate is just `kind: "verify"`: it `depends_on` its batch's slice units,
its `implements.test_case_ids` is the gating test set, its `covers` lists the
same slices, and the next batch's units list this gate in _their_ `depends_on`.
The full contract (dedup key, the `test-results.json` to "passed" rule, the hard
start-gate) is deferred to the verify-gate spec. The point here is only that this
model holds every field that contract needs without further additions.

## Migration and blast radius

**product-dev (the marketplace plugin):**

- `breakdown`: write the envelope; mint `WU-` ids; build `depends_on`; project to
  `tracker.blocked_by_refs`; route `type` to a tracker-native type through the
  integration abstraction rather than GitHub Issue Types directly.
- `align` / `review` / `document`: read `units` / `depends_on` / `kind`, and key
  spikes on `type == "spike"` (retire `kind == "spike"`).
- `scripts/e2e_coverage.py`: read `units` + `depends_on` instead of `issues.json`
  - integer `blocked_by`.
- `references/`: rewrite `feature-folder-contract.md` (rename `issues.json` to
  `work-units.json`, define the new shape), `e2e-work-unit.md` (unit-space,
  `covers` as `WU-` ids), and `id-scheme.md` (add the `WU` prefix).
- Transition: a dual-read shim that accepts either file, plus a one-shot
  `migrate_issues_to_work_units.py` modeled on the existing
  `migrate_test_cases_to_v1_1.py`.

**Roubo:**

- Add `schema/work-units.schema.json` and a validator, mirroring the test-cases /
  test-results pair.
- The three frozen `work-units.json` specs are already close to this shape (they
  carry `id`, `depends_on`, and a nested issue). Conform their field names
  (`issue` to `tracker`, `category` to `type` + `kind`, `linked_*` to
  `implements`) or freeze them as historical.
- Hard dependency enforcement and the `test-results.json` to "passed" rule are
  the verify-gate feature, not this change.

**Suggested sequence:**

1. Adopt this doc and publish `schema/work-units.schema.json` (no behavior
   change yet).
2. `breakdown` writes `work-units.json`; the dual-read shim keeps existing
   readers working; run the migration script over current `issues.json` files.
3. Switch `align` / `review` / `document` / `e2e_coverage.py` to the new shape,
   then drop the shim.
4. Conform or freeze the cold Roubo specs.
5. Build the verify-gate feature on top.

## Open sub-decisions

| Decision            | Recommendation                     | Note                                                                                      |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Canonical filename  | `work-units.json`                  | The entries are no longer GitHub issues; the name should say so. Migration is mechanical. |
| Nested object name  | `tracker`                          | Clearer than `issue` once `system` can be Jira.                                           |
| Inline body on disk | yes                                | Needed for tracker portability and previewability (R5).                                   |
| `WU` counter home   | shared `manifest.json.id_counters` | Keeps `id_mint.py` the single id writer (R2).                                             |

## On adoption

This document is the rationale and decision record. On adoption it splits into the
same two-artifact pairing `test-cases` already uses: a prose contract in
product-dev (`references/work-unit-schema.md`) and a JSON Schema in Roubo
(`schema/work-units.schema.json`). Both repos' contributor docs are updated to
point at the canonical pair, and this file remains as the "why".
