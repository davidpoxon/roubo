# Spike 405: Lock the published-schema contract (targeting fields, $id/semver, multi-bench layout)

**Status:** Resolved · **Issue:** #405 · **Class:** decision · **Resolves:** PRD open question (multi-bench physical layout); architecture decision summary (versioned `$id` semver, migration registry, file-per-version JSON Schema) · **Implements:** FR-019, FR-020, NFR-005, US-011 · **Verified by:** TC-059, TC-060, TC-062, TC-063 · **Gates:** #6 (author the zod schemas), #7 (build the generate script) · **Recommendation:** adopt (confirm the architecture's proposals)

## Objective and method

The two published schemas (`test-cases.json` and `test-results.json`) are a first-class, forward-compatible deliverable, consumed in the future by a guided-navigation Chrome extension. Three decisions baked into those schemas are expensive to reverse once external consumers depend on them: the optional guided-execution targeting field shapes, the `$id`/semver versioning strategy, and the physical multi-bench layout of `test-results.json`. This spike fixes those three decisions before any schema is committed. It produces no production schema, no zod, and no generate script: that work is downstream (#6 and #7).

Method: ground every decision in the spec sources already in the repo, then either confirm or revise the architecture's proposals.

- `.specifications/testbench/architecture.md`: the data-model rows for `TargetingField`, `TestResultsFile`, `SchemaVersion`/`MigrationRegistry`, and the decision summary.
- `.specifications/testbench/prd.md`: FR-019, FR-020, NFR-005, US-011, and the open-questions section.
- `.specifications/testbench/test-cases.json`: TC-059, TC-060, TC-062, TC-063.

The existing `schema/roubo-config.schema.json` and `schema/roubo-plugin.schema.json` files are hand-written JSON Schema draft-07 with no `$id`, so the `$id`/semver convention introduced here is genuinely new in this repo; there is no prior in-repo convention to inherit.

The decision posture across all three is **adopt the architecture's proposals**: each was investigated against the sources and found correct, so this spike confirms rather than revises. Each section states the confirmed decision, why it holds, and the test cases that pin it.

## AC1: targeting field shapes (FR-019)

**Decision (confirm).** A single reserved, all-optional shape is shared by both placements:

```
TargetingField = {
  cssSelector?: string,
  ariaRole?:    string,
  ariaName?:    string,
  textAnchor?:  string,
  routeContext?: string,
  region?:      string,
}
```

Every member is a plain `string` and every member is `.optional()`. The shape appears in exactly two places, both themselves optional:

- per-step `target?: TargetingField` on `Step`,
- per-observation `observe?: TargetingField` on `Observation`.

This matches the architecture's `TargetingField` data-model row verbatim (all-optional `{ cssSelector?, ariaRole?, ariaName?, textAnchor?, routeContext?, region? }`) and the FR-019 wording "each expressible as some combination of CSS selector, ARIA role + accessible name, visible-text anchor, route/URL context, or region, all `.optional()`".

**Why every member is a plain optional string, with no enums or cross-field requirements.**

- FR-019 says "some combination", so any subset (including the empty set) must validate. Enforcing "at least one populated" or any mutual requirement (for example "if `ariaRole` then `ariaName`") would reject a legitimate empty or partial target and would itself become a breaking-change risk the moment the extension wanted a looser combination. Keeping each member an independent optional string keeps the field purely additive.
- `ariaRole` is left as a free `string`, not a closed enum of ARIA roles. The ARIA role set evolves, and pinning it as an enum would make adding a future role a schema change; a `string` lets the extension carry any role without a contract bump. The same reasoning applies to `region`.
- The fields are reserved for the future extension and ignored by the in-app TestBench UI. The in-app reviewer surface (FR-006/FR-007) renders cases for human review and does not consume targeting hints. NFR-005 already requires the in-app UI to ignore unknown optional fields, so reserving these now costs the UI nothing and avoids a breaking change when the extension ships.

**Verified by.**

- **TC-059** (a `test-cases.json` that omits all optional targeting fields still validates): satisfied because both `target` and `observe`, and every member inside `TargetingField`, are `.optional()`. A fixture with no targeting fields validates, and their absence is not an error.
- **TC-060** (a `test-cases.json` with per-step `target` and per-observation `observe` validates): satisfied because all six members are accepted independently. Any combination of `cssSelector`, `ariaRole` + `ariaName`, `textAnchor`, `routeContext`, or `region` validates, and no combination raises an error.

These two cases together pin both the all-omitted and the populated ends of the range, which is exactly the additive guarantee FR-019 needs.

## AC2: versioning strategy (NFR-005)

**Decision (confirm, with a concrete `$id` base-URI convention proposed).**

- **Semver lives in two coordinated places, fed by one literal.** A single version constant in `testbench-contracts` is the sole source of the version string. It feeds both:
  - the schema `$id` URI, which embeds the semver, and
  - a `schemaVersion` string field carried in each file envelope (`TestCasesPlan` and `TestResultsFile` both already declare `schemaVersion: string` in the architecture data model).

  Having one literal feed both prevents `$id` and `schemaVersion` from drifting apart. The `$id` is the authoritative published identity for external consumers (the extension resolves the schema by `$id`); the in-file `schemaVersion` lets a reader detect the file's version without fetching or parsing the `$id`, and is what the fail-open read path (NFR-003) inspects to recognise a newer-than-known file.

- **File-per-version generated JSON Schema in `schema/`.** Each published version generates its own JSON Schema file rather than overwriting a single file in place. File-per-version means an external consumer can pin and resolve an exact historical version by `$id`, and the backward-compat fixture corpus (NFR-005) can validate old fixtures against the exact schema they were authored under. Single-overwrite would erase the ability to resolve a prior `$id` and is rejected for that reason.

- **Change classification.**
  - An **additive** change (a new optional field, a relaxed constraint that accepts a strict superset of prior-valid files) is a **minor** bump with **no within-major breaking change**. Every file a prior minor accepted stays valid (NFR-005 target: 0 within-major breaking changes).
  - A **breaking** change (a required field renamed or removed, a tightened constraint that rejects a previously-valid file) requires a **major** bump, **plus** a new entry in the migration registry (`MigrationRegistry`, keyed by version pair per the architecture data model), **plus** a documented migration guide covering existing `test-results.json` files, referenced from the changelog or release notes.

- **Proposed `$id` base-URI convention (new, for the schema author in #6 to adopt).** The architecture does not pin a literal base URI, so this spike proposes one concrete convention:

  ```
  $id = https://schemas.roubo.dev/testbench/<file>/v<major>.<minor>.<patch>.json
  ```

  with `<file>` being `test-cases` or `test-results`. Worked examples:

  ```
  https://schemas.roubo.dev/testbench/test-cases/v1.0.0.json
  https://schemas.roubo.dev/testbench/test-results/v1.0.0.json
  ```

  Rationale for this shape:
  - An `https://` URI (not a bare path) is the JSON Schema idiom for `$id` and gives external consumers a stable, dereferenceable-looking identity even before any document is actually hosted there. The URI is an identity, not a fetch requirement; it does not commit Roubo to serving the document at that address.
  - `schemas.roubo.dev` is a project-owned namespace placeholder. If Roubo does not control `roubo.dev`, the schema author should substitute the canonical project domain at authoring time; the spike fixes the *shape* (host + `/testbench/<file>/v<semver>.json`), not the literal hostname.
  - The full `v<major>.<minor>.<patch>` segment embeds the complete semver so the `$id` is unique per published version (the file-per-version requirement) and the major segment is mechanically inspectable (TC-063 step 1 inspects the major segment of the semver in `$id`).
  - The `testbench/<file>/` path segments scope the schema to this feature and distinguish the two files, leaving room for sibling schemas under the same host without collision.

**Verified by.**

- **TC-062** (a v1.0 fixture still validates after a minor bump): satisfied because minor bumps are additive-only by the classification rule, so the v1.0 corpus validates unchanged against any v1.x validator; zero previously-valid files are rejected.
- **TC-063** (a breaking change requires a major bump and a documented migration): satisfied across its three steps. Step 1 (inspect `$id`): the major segment of the semver in the proposed `$id` increments on a breaking change. Step 2 (migration document): the rule requires a migration-registry entry plus a documented migration guide referenced from the changelog/release notes. Step 3 (validate a prior-major file against the new schema): because `$id` and `schemaVersion` both carry the major version, a prior-major file fails validation with a clear version-mismatch error, and the surfaced error references the migration guide.

## AC3: multi-bench physical layout (FR-015, FR-020)

**Decision (confirm, resolving the PRD open question).** One `test-results.json` sidecar **per spec**, with a bench-keyed map:

```
TestResultsFile = {
  $schema:       string,
  schemaVersion: string,
  planHash:      string,
  benches:       Record<benchId, BenchResults>,
}
```

This matches the architecture's `TestResultsFile` data-model row exactly and resolves the PRD open question "single `test-results.json` with a bench-keyed map, or per-bench filenames?" in favour of the single-file, bench-keyed map.

**Why single-file-per-spec over per-bench filenames.**

- The sidecar lives beside the focused spec at `.specifications/<slug>/test-results.json` (FR-015), one stable path per spec. Multiple benches reviewing the same spec write into distinct keys of the one `benches` map rather than spawning a fan of `test-results.<benchId>.json` files. The audit trail for a spec is one file, which is simpler for a human and for the future extension to locate and reason about.
- It keeps `planHash` (the staleness anchor, FR-016) and `schemaVersion` in one place for the whole spec rather than duplicated across per-bench files that could drift.
- Per-bench results are isolated by key, so re-pointing a bench (FR-024) and per-spec result preservation both fall out naturally: each `benchId` key is independent.

**Scope note (out of scope here).** The bench-dimension reconcile/purge is a separate concern and is **not** decided by this spike. The architecture open question "Does clearing/deleting a TestBench purge its entry from the spec's bench-keyed `test-results.json`, or are cleared-bench entries retained?" is the bench-dimension reconcile, distinct from the case-dimension reconcile (FR-017). It does not affect the physical layout fixed here (a `Record<benchId, BenchResults>` supports either retain or purge), so it is left open for the relevant downstream issue and does not block #6 or #7.

## AC4: doc location

This findings doc lives at `.specifications/testbench/spikes/schema-contract.md` (this file), under the feature's `spikes/` directory as required.

## Adjacent open questions: resolve-or-defer

The architecture and PRD carry two adjacent open questions that touch the published contract. Neither is one of this spike's four acceptance criteria, so neither is expanded here, but each is given a clear resolve-or-defer disposition so the downstream schema issues (#6 author the zod schemas, #7 build the generate script) are not blocked waiting on an unstated decision.

1. **Is the `test-results.json` sidecar committed to the focused project's VCS or gitignored?** (PRD open question; architecture open question.)
   - **Disposition: defer, does not block #6/#7.** This is an operational/policy choice (shared vs ephemeral audit trail) that does not change the schema shape: the same `TestResultsFile` schema is generated and validated whether the file is committed or gitignored. The architecture notes it "affects whether the generator/CI guidance should recommend a `.gitignore` entry", which is a #7 documentation detail, not a schema-shape decision. Recommendation for whoever resolves it: lean toward committing the sidecar so the authored audit trail is shared and reviewable, and let #7's generate/CI guidance optionally document a gitignore opt-out; but this spike does not bind it. Track it on its own issue rather than inside the contract work.

2. **Does the per-case status override (FR-010) need a captured reason string?** (PRD open question; architecture open question, flagged "schema-additive if yes".)
   - **Disposition: defer, safe to defer precisely because it is additive.** A future `reason?: string` on `StatusOverride` is a purely additive optional field. By the AC2 classification it would be a minor bump with no within-major breaking change, so adding it later costs nothing in contract terms and does not need to be decided before #6 ships v1.0.0. Authoring the schema without a reason field now is fully reversible upward via a minor bump. #6 should ship `StatusOverride` as `{ status, author, timestamp }` (the architecture row) and treat `reason?` as a candidate additive minor.

Neither disposition expands the four acceptance criteria; both exist only to unblock the downstream issues.

## Recommendation

**Adopt all three architecture proposals as confirmed:** the all-optional `TargetingField` shape, the single-literal-fed `$id`-semver + `schemaVersion` + file-per-version + migration-registry versioning strategy (with the proposed `https://schemas.roubo.dev/testbench/<file>/v<semver>.json` `$id` base-URI convention), and the one-`test-results.json`-per-spec bench-keyed-map layout. The two adjacent open questions are dispositioned (both deferred, both shown not to block) so #6 and #7 can proceed.

## Next steps not taken here

- Authoring the actual zod schemas in `shared/testbench-contracts` (#6): out of scope for this spike.
- Building the `z.toJSONSchema()` generate script and CI drift guard (#7): out of scope for this spike.
- Filing the two deferred open questions as their own tracked issues (sidecar VCS policy; override-reason field): a follow-up for whoever owns the testbench backlog, so they are tracked by number rather than only described here.
