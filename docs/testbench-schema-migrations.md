# TestBench Schema Migrations

The two published TestBench files, `test-cases.json` and `test-results.json`, are versioned schemas (NFR-005). Each carries a `$schema` URI whose path embeds a semver, plus a matching `schemaVersion` string. This document is the migration path NFR-005 requires: it records every breaking change, how an existing file moves to the new shape, and the rule the versions follow going forward.

The schemas are authored in `shared/testbench-contracts.ts`, and the generated JSON Schema lives under `schema/` (`test-cases.schema.json`, `test-results.schema.json`).

## Versioning rule

- A within-major release never rejects a file a prior minor accepted. Minor and patch bumps stay additive, and any new field is optional.
- A genuinely breaking change (a field that changes type, or becomes required, or a structural reshape) takes a MAJOR bump AND a migration entry in this document.
- The `test-results.json` loader is fail-open: a prior-major file is never a hard error. It recovers to a clean slate and reports a `version-migration-required` signal that points here, rather than a generic shape error.

## test-cases.json

### 1.0.0 to 1.1.0 (accepted retroactive break)

The 1.0.0 to 1.1.0 change merged the TestBench case shape onto the canonical product-dev shape. It was tagged as a MINOR bump but was in fact breaking:

- `level` changed from a string to an integer (1 to 4).
- `area`, `type`, `tags`, `linked_requirement_ids`, and `linked_user_story_ids` became required.

A `test-cases.json` authored under 1.0.0 is therefore rejected by the 1.1.0 validator (for example: `cases.0.level: expected number, received string`).

Decision: this break is ACCEPTED retroactively rather than re-tagged as 2.0.0. Re-tagging would rewrite an already-published `$id` and regenerate `schema/` for no practical gain, since 1.1.0 is the shape in use. The break is recorded here as the migration path NFR-005 calls for.

Migration for a 1.0.0 file:

- Set `level` to the integer 1 to 4 that matches the old string level.
- Add `area` (the kebab-case feature area), `type` (the test flavor), `tags` (an array, may be empty), `linked_requirement_ids` (at least one), and `linked_user_story_ids` (an array, may be empty).

Going forward, `test-cases.json` minor bumps stay additive and optional; a real break takes a major bump and an entry here.

## test-results.json

### 1.0.0 to 2.0.0 (benches-map flatten)

Before 2.0.0, a single `test-results.json` held results for many benches nested under a per-bench `benches` map. As of 2.0.0 (the #493 flatten), one results file lives per worktree (a sibling of `test-cases.json`), so a file holds exactly one bench's results and `caseResults` sits at the TOP LEVEL instead of nested under `benches`.

A prior-major (v1) `test-results.json` does not match the strict v2 contract. The loader (`server/lib/testbench-store.ts`) detects the prior major BEFORE strict validation and fails open with a `version-migration-required` recovery reason, so the caller sees a legible version-mismatch signal (not a generic shape error) and treats the worktree as a clean slate.

Migration for a v1 file:

- Take the entry under `benches` that corresponds to this worktree's bench.
- Lift its `caseResults` and `updatedAt` to the top level of the file.
- Drop the `benches` map.
- Set `$schema` and `schemaVersion` to the v2 values in the table below.

Recorded results that are not migrated are not lost destructively: the fail-open loader leaves the old file in place and starts fresh; re-recording a mark rewrites the file in the v2 shape.

## Version history

| File              | schemaVersion | `$id`                                                         | Change                                           |
| ----------------- | ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| test-cases.json   | 1.0.0         | `https://roubo.dev/schema/testbench/test-cases/v1.0.0.json`   | Initial published shape.                         |
| test-cases.json   | 1.1.0         | `https://roubo.dev/schema/testbench/test-cases/v1.1.0.json`   | Canonical merge (accepted retroactive break).    |
| test-results.json | 1.0.0         | `https://roubo.dev/schema/testbench/test-results/v1.0.0.json` | Initial shape (per-bench `benches` map).         |
| test-results.json | 2.0.0         | `https://roubo.dev/schema/testbench/test-results/v2.0.0.json` | Flatten to top-level `caseResults` per worktree. |
