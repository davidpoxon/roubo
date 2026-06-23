# Feasibility: Verify gate

> **Recommendation: DE-RISK**: every dimension is feasible-with-conditions; the core (schema, deterministic gate evaluation, hard start-gate, batch surface) builds cleanly on existing primitives, but the failed-case fix-issue filing introduces an unproven cross-tracker issue-create + blocking-link capability and two fail-safety decisions that should be settled with spikes before committing.

**Brief:** ./brief.md

## Per-dimension summary

| Dimension                | Verdict                  | Confidence | Top risk                                                                                                                                     | Mitigation                                                                                     |
| ------------------------ | ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Technical                | feasible-with-conditions | medium     | No issue-create path exists; `createIssue` + `addBlockedBy` across GitHub/GHE/Jira is unproven (write side, GHE, Jira)                       | Phase failed-case capture: notes-only v1a, GitHub-first; defer GHE/Jira and screenshots        |
| Effort / delivery        | feasible-with-conditions | medium     | External dep "breakdown emits gates" must land before end-to-end exercise; piece 6 is a large cross-tracker long pole                        | Build a fixture `work-units.json`; ship pieces 1-5 as a milestone, phase piece 6               |
| Operational / robustness | feasible-with-conditions | high       | Hard gate defaults fail-open today; must invert to fail-closed when enforcement is ON. Fix-issue filing has a create-then-link atomicity gap | Fail-closed when ON + blocking data unavailable; capability flags + retry UI for the link step |

## Dimension detail

### Technical

**Summary:** Five of the six sub-problems are low-to-medium risk on well-precedented primitives: the work-units schema + ajv validator, the deterministic results-to-passed rule, the hard start-gate upgrade, the TestBench batch-subset surface, and gate close-on-pass. The one high-risk item is failed-case fix-issue creation: Roubo has no issue-create path, and registering a blocking relationship back to the gate is unproven for GHE and Jira. Verdict feasible-with-conditions, medium confidence.

Key findings (evidence):

- `schema/test-results.schema.json` and `schema/test-cases.schema.json` prove the envelope pattern a new `schema/work-units.schema.json` must follow; `ajv 8.20.0` is already a dependency (`server/package.json`). A validator mirroring the existing test-cases/test-results validators is low-effort.
- `schema/test-results.schema.json:59-62` already defines `derivedStatus` enum `{not_started,in_progress,passed,failed,blocked}` and the `orphaned` marker; `planHash` staleness is a first-class `stale` boolean at `server/lib/testbench-store.ts:243-251,296`. The results-to-passed rule consumes only fields that already exist and are validated.
- The hard start-gate is a behavior change at two callsites: `POST /benches` (`server/routes/benches.ts:71-177`) and the assign path (`server/services/issue-assignment.ts:381-508`). Today's blocking read at `server/routes/benches.ts:188-212` is explicitly "Best-effort and informational" and never refuses a start. No new data plumbing, a single-service behavior change.
- Closing the gate issue on pass can reuse `pluginManager.invoke(pluginId, 'applyTransition', ...)` (proven at `server/routes/issues.ts:200-202`) with a transition discovered from `NormalizedIssue.allowedTransitions`.
- No issue-create path exists anywhere in the server. The failed-case UX needs a new sandboxed plugin method (`createIssue`), a blocking-link method (`addBlockedBy` / Jira link-type equivalent), and a new declared plugin capability + consent (guarded by `plugin-undeclared-actions-blocked.e2e.test.ts`). For GitHub, `addBlockedBy` is a known mutation (`work-unit-model.md:232`) but the write side is not exercised in this repo; GHE and Jira maturity is unconfirmed.
- Screenshot/attachment storage has no existing primitive: `test-results.schema.json` carries only text notes and marks. Either a tracker-upload plugin method or a sidecar file with a new schema reference field is required.
- The gate-blocking-fix-issue topology is a clean extension of `work-unit-model.md` R1 (`depends_on` is authority, `blocked_by_refs` is a derived projection): a spawned fix issue added to the gate's blockers at the tracker level is an augmentation, not a contradiction, and the pass rule (all gating cases passed AND no blocker open) is already correctly formulated because Roubo reads blocking from the tracker, not from `work-units.json`.

### Effort / delivery

**Summary:** Medium-large for a solo developer, decomposing into five small-to-medium pieces plus one large long pole (failed-case capture + cross-tracker fix-issue filing). The critical external dependency on "breakdown emits gates" means the runtime cannot be exercised end-to-end until that upstream lands. Verdict feasible-with-conditions, medium confidence.

Key findings:

- Piece 1 (work-units schema + validator): SMALL. The schema pipeline already exists (`scripts/generate-schema.ts`, two shipped schemas).
- Piece 2 (results-to-passed evaluation): SMALL-MEDIUM. Pure logic over data already modeled; `planHash` staleness already computed.
- Piece 3 (gate lifecycle, close on pass): MEDIUM. Needs a new sandboxed close/transition RPC implemented across the three plugins.
- Piece 4 (hard start-gate): MEDIUM. Inverts the informational read into a refusal; touches `bench-manager.ts`, `issue-assignment.ts`, `benches.ts`; mandatory tests under 80% coverage.
- Piece 5 (TestBench batch surface): MEDIUM. TestBench is mature (~34 client files + server lib/routes); a filtered slice of `test-cases.json` by the gate's `implements.test_case_ids`, not a rebuild. Operator merge/split is the scope-creep risk.
- Piece 6 (failed-case capture + fix-issue filing): LARGE. New plugin action, consent, three-plugin implementation, blocking-link registration, attachment storage, pass-condition reconciliation.
- External dependency: Roubo's runtime consumes `work-units.json` with `kind:"verify"` units carrying `tracker.ref`, which the external product-dev "breakdown emits gates" effort produces.

### Operational / runtime robustness

**Summary:** The deterministic rule plus the existing `planHash` staleness signal give a trustworthy gate core, and the local-tool context removes hosting/scaling concerns. Two fail-safety conditions must be resolved: the fail-open-vs-fail-closed default for the hard gate (today's code is fail-open, the wrong default when enforcement is ON), and the create-then-link atomicity gap in fix-issue filing. Verdict feasible-with-conditions, high confidence.

Key findings:

- `derivedStatus` is deterministic (`shared/testbench-domain.ts:37-74`); `blocked` is reachable only via explicit `statusOverride`. The gate must evaluate the **effective** status (`statusOverride.status ?? derivedStatus`), not raw `derivedStatus`.
- `planHash` staleness is live (`server/lib/testbench-store.ts:296`): a mid-batch `test-cases.json` change sets `stale=true` on next read, so the gate cannot spuriously pass after a plan change.
- The results sidecar load is fail-open by design (`server/lib/testbench-store.ts:119-171`): a missing/corrupt/invalid file maps gating cases to absent, which the rule treats as **pending**, never passed. Safe default for evaluation.
- The current blocking read swallows RPC errors and serves the bench (`server/routes/benches.ts:208-210`). For a hard gate this must become a blocking 4xx when enforcement is ON and blocking data cannot be fetched.
- Fix-issue filing is two sequential tracker calls (create, then register block-link) with no transactional wrapper; if the link step fails, the gate has an orphaned fix issue it does not know blocks it, leaving a falsely-passable state.
- Orphaned results are retained (`server/lib/testbench-store.ts:462-530`) and the rule treats orphaned/absent as pending, so a stale prior-plan result cannot cause a false pass.

## Top risks (ranked, cross-dimension)

1. **No cross-tracker issue-create + blocking-link capability** (Technical/Effort/Operational): severity high; owner of mitigation: a pre-build spike + phasing. Roubo has no `createIssue`/`addBlockedBy`; GHE and Jira write-side maturity is unknown.
2. **Hard gate fail-open default** (Operational): severity high; owner: the start/assign-path implementation. When enforcement is ON and blocking data is unavailable, the gate must fail closed, not allow the start.
3. **Fix-issue filing atomicity** (Operational): severity high; owner: the failed-case capture design. Create-then-link is non-atomic; a half-wired fix issue leaves the gate falsely passable.
4. **External "breakdown emits gates" dependency** (Effort): severity high; owner: external product-dev milestone + a local fixture. Roubo cannot be exercised end-to-end until gates are filed.
5. **Screenshot/attachment storage undecided** (Technical/Effort): severity medium; owner: a storage decision before piece 6. Sidecar vs tracker-upload are architecturally different.
6. **TestBench batch merge/split scope creep** (Effort): severity medium; owner: v1 scope discipline. Constrain v1 to read-only batch presentation driven by the gate's `implements.test_case_ids`.

## De-risking plan (resolve before/early in the build)

- [x] **Spike: cross-tracker issue-create + blocking-link.** Confirm `createIssue` and a block-link (`addBlockedBy` for GitHub, the Jira "is blocked by" link type) across GitHub, GHE, and Jira; define `supportsCreateIssue` / `supportsBlockingLinks` capability flags. Resolves risks 1 and the capability open questions. **Resolved by Spike 704 (#704, adopt).**
- [ ] **Decision: hard-gate fail-closed.** Specify that when `enforceIssueDependencies` is ON and blocking/results data cannot be fetched, the start/assign path refuses with a clear 4xx (fail-closed), while the informational bench-detail read keeps its fail-open behavior. Resolves risk 2.
- [ ] **Decision: fix-issue filing atomicity + recovery.** Specify partial-failure handling: on block-link failure after create, surface an explicit error, record the partial state on the gate, and offer a retry that covers only the link step. Resolves risk 3.
- [ ] **Decision: screenshot/attachment storage.** Pick sidecar-vs-tracker-upload (default: defer to notes-only for v1, add a follow-on for evidence attachment). Resolves risk 5.
- [ ] **Fixture: a hand-authored `work-units.json` with a `kind:"verify"` unit** so the Roubo runtime can be unit/integration-tested without waiting on the external "breakdown emits gates" effort. Resolves risk 4 for local development.
- [ ] **Decision: phasing.** Ship pieces 1-5 (schema, evaluation, gate lifecycle, hard start-gate, batch surface) as a first milestone delivering jobs 1-2; phase piece 6 (auto-file fix issue) starting GitHub-first and notes-only. De-risks the effort long pole.
- [ ] **Confirm: gate pass-condition extension is allowed.** Record that "results-to-passed rule AND all gate blockers (incl. spawned fix issues) done" is a clean extension of the settled contract (tracker-level blocking is what Roubo reads). Low-risk confirmation; unblocks piece 3.

_(These become `spike` issues when `breakdown` runs.)_

## Recommendation

**DE-RISK**: proceed to `/product-dev:prd`, but carry the de-risking plan into the PRD as named NFRs and the spike list, and resolve the cross-tracker spike, the two fail-safety decisions, and the phasing before committing piece 6. The core feature (jobs 1-2: batched verification with a real hard gate) is independently shippable on existing primitives; the fix-issue filing is the part that needs the spikes.

## Assumptions to validate

- The "breakdown emits gates" external product-dev effort is a runtime prerequisite for end-to-end exercise, not a blocker for building and unit-testing the Roubo side (a fixture stands in).
- `work-unit-model.md` and `verify-gate.md` are settled and adopted as-is; no re-design of the model happens during the build.
- A new `createIssue` plugin action follows the established declared-capability + consent pattern, not a new framework.
- Pieces 1-5 are independently shippable and deliver jobs 1-2 even if piece 6 is phased or deferred.
- `enforceIssueDependencies` OFF fully bypasses the gate (no blocking check, no enforcement, no gate UI state); operational risk is opt-in.

## Open questions

- [x] Does the GitHub/GHE plugin support the `addBlockedBy` write path, and does the Jira plugin support an equivalent block-link type? **Resolved by Spike 704 (#704, adopt):** feasible on all three (GitHub-first); GitHub blocking-link GA is runtime-probed, GHE is write-unwired and version-gated, Jira uses the configured blocks-family link type.
- [ ] Where do screenshots live: tracker attachment upload (new plugin method), sidecar alongside `test-results.json` (new write primitive), or both?
- [ ] Does the batch-subset filter live server-side (a new query param on the plan endpoint) or client-side (filter by the gate's `test_case_ids`)?
- [ ] Exact timeout / unavailable-data handling at each callsite for the fail-closed hard gate.
- [ ] How re-verification after a fix interacts with `planHash` staleness when the fix also edits `test-cases.json` (spec-level vs per-case hash granularity).
- [ ] Is the operator batch merge/split mechanic in v1 scope, or deferred behind read-only batch presentation?
