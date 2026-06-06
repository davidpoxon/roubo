# Spike 407: What does the staleness hash canonicalise over, and how does reconcile preserve every authored result?

**Status:** Resolved · **Issue:** #407 · **Class:** decision · **Resolves:** prd.md FR-016/FR-017/NFR-003, US-009; architecture.md:131 (canonicalised hash input), architecture.md:25 (orphan-not-delete reconcile) · **Implements:** FR-016, FR-017, NFR-003, US-009 · **Verified by:** TC-045, TC-049 · **Gates:** #8, #9 · **Recommendation:** adopt

## Objective and method

The single highest-severity risk in TestBench is silent loss of an authored mark or note (NFR-003). Two mechanisms touch that risk before the domain module (#8, #9) is built:

1. **Staleness detection (FR-016).** If staleness is decided by hashing the raw bytes of `test-cases.json`, then a reformat (pretty-print, trailing-newline change, key reorder by a formatter) flags every untouched result as stale and pushes the reviewer into an unnecessary reconcile. The decision is to hash a canonicalised, content-normalised, stable-id-sorted serialisation of the case set, so the hash changes only when the case set's meaning changes.

2. **Reconcile (FR-017).** If reconcile diffs the plan against recorded results and deletes results for cases no longer in the plan, an authored pass/fail mark or a written note is destroyed the instant a case is renumbered or removed. The decision is orphan-not-delete: a removed case's `CaseResult` is marked `orphaned: true`, excluded from the rollup, and retained on disk; physical purge happens only on an explicit, separate confirmation.

Both decisions are pre-committed by the architecture (architecture.md:25 "classify added/removed/changed; orphan-not-delete"; architecture.md:131 "the staleness hash input is a canonicalised case-set serialisation, stable-id sorted, content-normalised, computed server-side"). This spike's job is not to re-open them; it is to make them precise enough to implement and to prove, with a worked example, that no mark or note is lost. The method is a paper specification plus a hand-traced worked example; no source code is written (the domain module #8/#9 and the reconcile UI #18 are explicitly out of scope per issue #407).

The field shapes below are taken verbatim from the architecture.md data model (architecture.md:46-60): `Case`, `Step`, `Observation`, `CaseResult`, `ObservationMark`, `Note`, `StatusOverride`. A divergence between that target contract shape and the current `test-cases.json` fixture on disk is recorded under [Open questions](#open-questions-and-follow-ups); the contract shape is authoritative for canonicalisation because that is the shape `testbench-canonicalize` and `testbench-domain` will consume once #8/#9 land.

## AC1: Decision, what the hash canonicalises over

**Decision.** The staleness hash is computed over a deterministic string produced by `testbench-canonicalize`, not over the raw file bytes. The pipeline is:

```
raw test-cases.json bytes
  -> testbench-contracts.safeParse        (validate + parse to a typed TestCasesPlan)
  -> testbench-canonicalize(plan)         (pure: produce a canonical string; NO hashing)
  -> node:crypto sha256(canonicalString)  (server-side only; testbench-store)
  -> hex digest = planHash
```

`testbench-canonicalize` returns the canonical **string** and nothing else. It does not call `node:crypto`, so it stays platform-agnostic and lives in `shared/` (architecture.md:26). The server (`testbench-store`) is the only place that hashes, using `node:crypto` (architecture.md:27, architecture.md:108). The client may run `testbench-canonicalize` for preview, but the authoritative `planHash` is always the server's (architecture.md:13 "authority remains server-side").

**What the hash is over: the semantic case set, not its presentation.** The canonical string includes every field that defines what a case asks the reviewer to verify, and excludes every field that is purely presentational, advisory, or derivable. Concretely, walking the architecture.md `Case` shape:

| Field                                                    | In the hash?                                          | Why                                                                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Case.id`                                                | yes (and it is the sort key)                          | the stable identity that binds a result to a case (FR-014); changing an id is a remove + add                                                                                    |
| `Case.title`                                             | yes                                                   | defines what the case is; a retitle is a meaningful change a reviewer should see                                                                                                |
| `Case.level`                                             | yes                                                   | drives the rollup grouping (FR-013); a level change changes the plan's meaning                                                                                                  |
| `Case.priority`                                          | yes                                                   | part of the authored case definition                                                                                                                                            |
| `Case.preconditions[]`                                   | yes (order preserved)                                 | changes what the reviewer must set up; order is semantic                                                                                                                        |
| `Step.id`                                                | yes (sort key within steps)                           | stable identity of the step                                                                                                                                                     |
| `Step.instruction`                                       | yes                                                   | the actual instruction to follow; a wording change is a real change                                                                                                             |
| `Observation.id`                                         | yes (sort key within observations)                    | the stable id a mark is keyed to (`observationMarks[observationId]`)                                                                                                            |
| `Observation.expected`                                   | yes                                                   | the expected outcome the reviewer judges against; the core of the case                                                                                                          |
| `Step.target` / `Observation.observe` (`TargetingField`) | **no**                                                | reserved, all-optional, ignored by the in-app UI (architecture.md:50); used only by the future extension; including it would flag the in-app plan stale on extension-only edits |
| `$schema`, `schemaVersion`                               | **no**                                                | envelope/versioning metadata, not case content; handled by the migration registry (NFR-005), not by staleness                                                                   |
| `specSlug`                                               | **no**                                                | identity of the file, not of the case set; the same cases under a renamed slug are not stale                                                                                    |
| any unknown / additive future field                      | **no** (canonicalize ignores fields it does not know) | additive optional fields must not retroactively stale every existing result (NFR-005 backward-compat)                                                                           |

The rule of thumb: **a field is in the hash if and only if a change to it should make a reviewer re-examine their authored result.** Targeting fields, envelope metadata, and slugs fail that test; the case body fields pass it.

## AC1 continued: Canonicalisation rules

`testbench-canonicalize(plan)` produces the canonical string by these rules, applied in order:

1. **Project to the included fields only.** Drop `$schema`, `schemaVersion`, `specSlug`, every `TargetingField` (`Step.target`, `Observation.observe`), and any field not in the included-fields table above. Canonicalize over a reduced view of each case.

2. **Stable-id sort, at every level.** Sort `cases[]` ascending by `Case.id` using a fixed byte-wise (code-point) comparison, not a locale-aware collator (a locale collator is environment-dependent and would make the hash non-deterministic across machines). Within each case, sort `steps[]` by `Step.id`; within each step, sort `observations[]` by `Observation.id`. Ids are unique within their scope (FR-014), so the sort is total and deterministic. `preconditions[]` is an ordered list with no ids, so its order is preserved, not sorted (reordering preconditions is a meaningful edit).

3. **String content-normalisation**, applied to every included string value (`title`, `instruction`, `expected`, each `preconditions[]` entry, `level`, `priority`):
   - Unicode-normalise to NFC (so two byte-different encodings of the same grapheme collapse).
   - Normalise line endings: CRLF and lone CR both become LF.
   - Trim leading and trailing whitespace.
   - Collapse each run of internal whitespace (spaces, tabs, newlines) to a single space.

   This is the rule that delivers AC2: whitespace-only and formatting-only differences vanish before hashing. Note this normalisation is for the **hash input only**; the stored plan bytes are never rewritten (the source plan is immutable, FR-014, NFR-001).

4. **Deterministic serialisation with fixed key order.** Emit the projected, sorted, normalised structure as JSON with object keys in a fixed canonical order (the field order in the architecture.md `Case`/`Step`/`Observation` shape, e.g. `id, title, level, priority, preconditions, steps` for a case), no insignificant whitespace (no pretty-print indentation), and a stable representation of every scalar. Because keys are emitted in a fixed order rather than source order, a formatter that reorders object keys cannot change the hash.

5. **Return the string.** `testbench-canonicalize` returns this string. It performs no hashing and has no `node:crypto`, no `fs`, no React dependency (architecture.md:26).

Edge rules: an absent optional field (e.g. no `preconditions`) and an explicitly empty one (`preconditions: []`) canonicalise identically (both emit no preconditions entries), so adding then clearing an optional list is hash-neutral. An empty case set canonicalises to a fixed empty-set string with a stable, non-empty hash.

## AC2: Whitespace / formatting invariance, worked

Two byte-different `test-cases.json` inputs that are semantically identical must collapse to the same canonical string and therefore the same `planHash`.

**Input A (compact, one case):**

```json
{
  "$schema": "...",
  "schemaVersion": "1.0.0",
  "specSlug": "testbench",
  "cases": [
    {
      "id": "TC-002",
      "title": "Create TestBench option is absent when disabled",
      "level": "1",
      "priority": "P0",
      "steps": [
        {
          "id": "S1",
          "instruction": "Open the option menu on an empty bench slot",
          "observations": [{ "id": "O1", "expected": "'Create a TestBench' option is NOT present" }]
        }
      ]
    }
  ]
}
```

**Input B (pretty-printed, CRLF line endings, reordered top-level keys, padded whitespace, trailing newline):**

```json
{
  "schemaVersion": "1.0.0",
  "specSlug": "testbench",
  "$schema": "...",
  "cases": [
    {
      "title": "Create   TestBench option   is absent when disabled",
      "id": "TC-002",
      "priority": "P0",
      "level": "1",
      "steps": [
        {
          "id": "S1",
          "observations": [
            { "expected": "'Create a TestBench' option is NOT present", "id": "O1" }
          ],
          "instruction": "Open the option menu on an empty bench slot"
        }
      ]
    }
  ]
}
```

The byte streams differ (indentation, CRLF vs LF, top-level and per-object key order, the doubled internal spaces in B's `title`, B's trailing newline). Applying the canonicalisation rules:

- Rule 1 drops `$schema`, `schemaVersion`, `specSlug` from both, so their reordering is irrelevant.
- Rule 2 leaves the single case, single step, single observation in place (nothing to sort with one element each).
- Rule 3 collapses B's `"Create   TestBench option   is absent"` (multiple internal spaces) to `"Create TestBench option is absent"`, matching A; CRLF -> LF and the trailing newline are stripped/normalised.
- Rule 4 emits both with the same fixed key order (`id, title, level, priority, steps` for the case; `id, instruction, observations` for the step; `id, expected` for the observation).

Both produce the identical canonical string:

```
{"cases":[{"id":"TC-002","title":"Create TestBench option is absent when disabled","level":"1","priority":"P0","steps":[{"id":"S1","instruction":"Open the option menu on an empty bench slot","observations":[{"id":"O1","expected":"'Create a TestBench' option is NOT present"}]}]}]}
```

`sha256` of that one string is the `planHash`. Input A and Input B yield the same digest, so no result is flagged stale by a pure reformat. AC2 holds.

By contrast, changing `O1.expected` to `"'Create a TestBench' option IS present"` alters the canonical string and therefore the hash: a genuine content change correctly flags staleness. The hash is sensitive to meaning and blind to formatting, which is exactly FR-016's intent.

## AC3: The reconcile algorithm (orphan-not-delete)

Reconcile diffs the **source plan** (the new `test-cases.json` case set) against the **recorded results** (`BenchResults.caseResults`, keyed by case id) and classifies each case by stable id. It never deletes a result. Pseudocode (the shape `testbench-domain.reconcile` will implement, #8/#9):

```
type ReconcileClassification = {
  added:     CaseId[]   // in plan, no recorded result            -> new, nothing to preserve
  unchanged: CaseId[]   // in plan + result, canonical case body unchanged
  changed:   CaseId[]   // in plan + result, canonical case body differs (marks kept; reviewer re-reviews)
  removed:   CaseId[]   // recorded result with NO matching plan case -> orphan candidate
}

type ReconcileResult = {
  classification: ReconcileClassification
  applied:        boolean        // false for a preview (no confirm), true when persisted
  nextResults?:   BenchResults   // present only when applied
}

function reconcile(plan, results, { confirm = false, purgeOrphans = false }): ReconcileResult {
  planIds   = set(plan.cases.map(c => c.id))
  resultIds = set(keys(results.caseResults))

  classification = { added: [], unchanged: [], changed: [], removed: [] }

  // canonicalise each plan case in isolation so we can compare bodies per-case
  planCanonById = map(plan.cases, c => [c.id, canonicalizeCase(c)])  // per-case projection of AC1 rules

  for caseId in planIds:
    if caseId not in resultIds:
      classification.added.push(caseId)                 // authored nothing yet -> safe
    else:
      // a result exists; did the case body change?
      storedCanon = results.caseResults[caseId].caseCanon   // canonical body snapshot stored alongside the result
      if storedCanon == planCanonById[caseId]:
        classification.unchanged.push(caseId)
      else:
        classification.changed.push(caseId)             // marks/notes RETAINED; reviewer should re-review

  for caseId in resultIds:
    if caseId not in planIds:
      classification.removed.push(caseId)               // orphan candidate; results NOT touched here

  // ---- preview path: no confirm => return classification only, change nothing ----
  if not confirm:
    return { classification, applied: false }

  // ---- apply path: confirmed; STILL non-destructive to authored data ----
  next = deepCopy(results)

  // 'changed' cases: keep every observationMark, every note, every override.
  //   Only the per-case canonical snapshot is refreshed and derivedStatus recomputed
  //   from the (unchanged) marks. No mark/note is read-modified-away.
  for caseId in classification.changed:
    next.caseResults[caseId].caseCanon    = planCanonById[caseId]
    next.caseResults[caseId].derivedStatus = deriveStatus(next.caseResults[caseId])  // from kept marks

  // 'removed' cases: mark orphaned, EXCLUDE from rollup, RETAIN on disk.
  for caseId in classification.removed:
    next.caseResults[caseId].orphaned = true            // FR-017: orphan, never delete

  // purge is a SEPARATE, explicit gate (see AC5). Default apply does NOT purge.
  if purgeOrphans:
    for caseId in classification.removed:
      delete next.caseResults[caseId]                   // only here, only on explicit purgeOrphans

  next.planHash = sha256(canonicalize(plan))            // adopt the new plan's hash; clears stale
  return { classification, applied: true, nextResults: next }
}
```

Key invariants the algorithm guarantees:

- A case in `added` has no recorded result, so there is nothing to lose.
- A case in `changed` keeps its full `CaseResult` (every `ObservationMark`, every `Note`, any `StatusOverride`); only the stored canonical snapshot and the recomputed `derivedStatus` change. The reviewer is signalled to re-review because the case body moved, but the authored history is intact.
- A case in `removed` is flipped to `orphaned: true` and excluded from the rollup (FR-013, FR-017), never deleted on the default apply.
- Purge (`delete`) is reachable only through the explicit `purgeOrphans` flag (AC5).

(Implementation note for #8/#9: the per-case `caseCanon` snapshot stored alongside each `CaseResult` is the simplest way to classify `changed` vs `unchanged` deterministically. If the contract instead chooses to recompute change-detection purely from the live plan hash, the algorithm collapses `changed`/`unchanged` into a single "present" bucket and the staleness banner alone drives re-review. Either is data-loss-safe; the snapshot variant is shown because it gives the reviewer a precise per-case "this one changed" signal. This is a contract-shape choice for #8/#9, not a reconsideration of the orphan-not-delete decision.)

## AC4: Worked example, no authored mark or note is lost across add + remove + change

**Starting state.** A focused plan with three cases (TC-001, TC-002, TC-003) and a `BenchResults` with authored work on all three (architecture.md `CaseResult` shape):

```
results.caseResults = {
  "TC-001": {
    observationMarks: { "O1": { result: "pass", author: {name:"Dev", email:"dev@x"}, timestamp: "T1" } },
    derivedStatus: "passed",
    notes: [ { id:"N1", text:"verified on chrome", author:{...}, timestamp:"T1", statusAtWrite:"passed" } ]
  },
  "TC-002": {
    observationMarks: { "O1": { result: "fail", author:{...}, timestamp:"T2" } },
    derivedStatus: "failed",
    statusOverride: { status:"blocked", author:{...}, timestamp:"T2" },
    notes: [ { id:"N2", text:"blocked by missing fixture", author:{...}, timestamp:"T2", statusAtWrite:"failed" } ]
  },
  "TC-003": {
    observationMarks: { "O1": { result: "pass", author:{...}, timestamp:"T3" } },
    derivedStatus: "passed",
    notes: []
  }
}
planHash = H_old
```

**The plan edit (all three diff classes at once):**

- **Add:** a new case `TC-004` is appended to the plan.
- **Remove:** `TC-003` is deleted from the plan.
- **Change:** `TC-002`'s `O1.expected` wording is reworded (a real content change, not whitespace).
- `TC-001` is untouched.

On load, the server canonicalises and hashes the new plan, gets `H_new != H_old`, and sets `stale: true`. The reviewer opens reconcile.

**Preview (`POST .../reconcile`, no `confirm`):**

```
classification = {
  added:     ["TC-004"],
  unchanged: ["TC-001"],
  changed:   ["TC-002"],
  removed:   ["TC-003"]
}
applied: false        // nothing on disk has changed yet
```

**Apply (`confirm: true`, `purgeOrphans` NOT set):** trace `nextResults` field by field:

| Case   | Class     | observationMarks      | notes         | statusOverride       | orphaned | In rollup?        |
| ------ | --------- | --------------------- | ------------- | -------------------- | -------- | ----------------- |
| TC-001 | unchanged | `O1: pass @T1` (kept) | `[N1]` (kept) | none                 | absent   | yes               |
| TC-002 | changed   | `O1: fail @T2` (kept) | `[N2]` (kept) | `blocked @T2` (kept) | absent   | yes               |
| TC-003 | removed   | `O1: pass @T3` (kept) | `[]` (kept)   | none                 | **true** | **no (excluded)** |
| TC-004 | added     | (none yet)            | (none)        | none                 | absent   | yes               |

`next.planHash = H_new`, so `stale` clears.

**Proof of zero data loss.** Enumerate every authored datum present before reconcile and confirm it survives:

- TC-001's mark `O1: pass @T1` -> present (unchanged path copies the result verbatim).
- TC-001's note `N1` -> present.
- TC-002's mark `O1: fail @T2` -> present (changed path keeps all marks; only `caseCanon` + recomputed `derivedStatus` change).
- TC-002's override `blocked @T2` -> present (changed path does not touch overrides).
- TC-002's note `N2` -> present.
- TC-003's mark `O1: pass @T3` -> present, now under `orphaned: true` (removed path orphans, does not delete).
- TC-003's note set `[]` -> present (empty, but the `CaseResult` is retained, not dropped).

Every pre-existing `ObservationMark`, `Note`, and `StatusOverride` is still on disk after reconcile. The only mutations are additive/metadata: `TC-003.orphaned = true`, `TC-002.caseCanon` refreshed and its `derivedStatus` recomputed from its (unchanged) marks, and `planHash` advanced. TC-004 starts empty because it is genuinely new. AC4 holds: no authored mark or note is lost across add, remove, and change.

## AC5: Purge is gated behind explicit confirmation

There are two distinct gates, and they are separate on purpose (architecture.md:82, architecture.md:111):

1. **`confirm`** gate. Without `confirm`, reconcile is a pure preview: it returns the `ReconcileClassification` and `applied: false` and writes nothing. This lets the UI show "1 added, 1 changed, 1 removed (will be archived)" before the reviewer commits.

2. **`purgeOrphans`** gate. The default confirmed apply (`confirm: true`, `purgeOrphans` unset/false) **orphans** removed-case results (`orphaned: true`, excluded from rollup) and retains them on disk. Physical deletion happens only when the reviewer sends a second, explicit `purgeOrphans: true`. There is no code path that deletes a `CaseResult` without `purgeOrphans` being explicitly set, which is the structural guarantee behind NFR-003's "any purge requires explicit user confirmation."

So the destructive operation (delete) requires the strongest signal (`purgeOrphans: true`), the persisting-but-non-destructive operation (orphan) requires a normal confirm, and the read-only operation (classify) requires nothing. This matches FR-017 ("orphaned results are purged only on explicit user confirmation") and the architecture's reconcile endpoint contract (architecture.md:82): `POST .../reconcile { confirm?, purgeOrphans? }`, "without `confirm`, returns the classification preview only; orphan purge happens only when `purgeOrphans` is explicitly set." AC5 holds.

## Recommendation

**Adopt** both decisions as specified here, and carry them into the domain module (#8, #9) and the contract (#1):

- `testbench-canonicalize` implements the AC1 projection + sort + normalise + fixed-key serialisation and returns a string only.
- `testbench-store` hashes that string with `node:crypto` server-side and compares to the stored `planHash` for staleness.
- `testbench-domain.reconcile` implements the AC3 classify-and-orphan algorithm, with `purgeOrphans` as the only delete path.

No deviation from prd.md or architecture.md was found; this spike makes the pre-committed architecture.md:25/architecture.md:131 decisions precise and proves the NFR-003 no-data-loss property by construction.

## Open questions and follow-ups

- **Contract-shape divergence (for #1/#8/#9, not a blocker for this spike).** The current `.specifications/testbench/test-cases.json` fixture on disk is a top-level array of cases with fields `area`, `type`, `tags`, `linked_requirement_ids`, `linked_user_story_ids` and steps shaped `{ action, expected[] }`. The architecture.md data model (architecture.md:46-50) specifies a different `Case` shape: an envelope `{ $schema, schemaVersion, specSlug, cases[] }` with steps shaped `{ id, instruction, observations[] }`. The canonicalisation rules above are written against the **architecture.md contract shape** because that is what `testbench-canonicalize`/`testbench-domain` will consume once the contract (#1) is authored. When #1 finalises the zod source schema, the included-fields table in AC1 must be re-pinned to the final field names (e.g. whether `area`/`tags`/`linked_*` ids are case-content-in-the-hash or presentational-excluded). The default carried from this spike: traceability ids (`linked_requirement_ids`, `linked_user_story_ids`), free-form `tags`, and `area` are presentational/advisory and excluded from the hash, on the same "would a change make a reviewer re-examine their result?" test; confirm at #1.

- **Per-case `caseCanon` snapshot vs hash-only change detection (for #8/#9).** AC3 stores a per-case canonical snapshot to distinguish `changed` from `unchanged`. The alternative (drop the snapshot, drive re-review from the plan-level staleness banner alone) is equally data-loss-safe but coarser. Decide at #8/#9 whether the precise per-case "changed" signal is worth the extra stored field.

- **Bench-dimension reconcile (existing open question, architecture.md:135).** This spike covers case-dimension reconcile (cases added/removed/changed within one bench's results). The distinct question of whether clearing/deleting a TestBench purges that bench's entry from the spec's bench-keyed `test-results.json` is already tracked at architecture.md:135 and is out of scope here. No new issue is filed because that open question is already recorded in the architecture; it should be resolved as part of the bench-lifecycle work, not this hash/reconcile spike.

## Lineage

- **prd.md:** FR-016 (canonicalised content hash for staleness), FR-017 (reconcile preserves results; orphan-not-delete; purge on explicit confirm), NFR-003 (no authored mark/note ever lost; reconcile orphans; purge requires explicit confirmation), US-009 (warn on plan change, reconcile without losing results). PRD open question prd.md:124 ("exactly what is canonicalised and hashed: normalised case-set content vs raw bytes") is the question this spike resolves: normalised case-set content.
- **architecture.md:** lines 25-27 (`testbench-domain` reconcile classify + orphan-not-delete; `testbench-canonicalize` returns a string, no `node:crypto`), 53 (`CaseResult` shape with `orphaned?: true`, `notes`, `observationMarks`, `statusOverride`), 106-111 (staleness + reconcile sequence flow), 131 (the canonicalised, stable-id-sorted, content-normalised, server-side hash decision). The reconcile endpoint contract is architecture.md:82.
