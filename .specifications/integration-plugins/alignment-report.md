# Alignment report — integration-plugins

> Generated: 2026-05-21T13:40:00Z · Findings: 3 · Resolved: 0 · Deferred: 3 · Dismissed: 0 · Unresolved: 0 · Suppressed (from deferral queue): 0

## Counts before

- critical: 0
- high: 3
- medium: 0
- low: 0

## Deferred items reviewed

(None — this is the first alignment run for this slug; the deferral queue was empty at start.)

## Walk

- **AF-001** [unresolved_refinement_marker · high · `architecture.md:527`] — **deferred** (resurface trigger: `never`) — Spike A outcome on Ubuntu headless. The marker has a named external blocker (run Spike A) and a documented resolution recipe (`libsecret-tools` + `dbus-run-session` + `gnome-keyring-daemon --start --components=secrets`). Parked because the question is a build-stage spike, not a checkpoint-stage decision. PD-001 created.
- **AF-002** [unresolved_refinement_marker · high · `architecture.md:538`] — **deferred** (resurface trigger: `never`) — Whether the forward-compat paper sketch (FR-038, WU-026) forces `ports` / `docker` permission categories now rather than as a 1.x minor. The architecture's `permissions` object is already `.passthrough()`-aware at the category level, so additional categories can be added in a 1.x minor without breaking compat. The orchestrator has no "build" stage to set as `after_stage:<build>`, so the trigger is `never`; the marker will be resolved naturally when WU-026 is executed. PD-002 created.
- **AF-003** [unresolved_refinement_marker · high · `architecture.md:541`] — **deferred** (resurface trigger: `never`) — Source picker pagination on very large Jira instances. The design ships an opt-in `nextCursor` field on `SourceCandidatesResponse` so pagination can be added in a 1.x minor. Re-evaluate only if Spike B surfaces real instance sizes that break the always-all approach. PD-003 created.

## Remaining unresolved

(None — all three high-severity findings were deferred, not left unresolved.)

## Active deferral queue

- **PD-001** — `unresolved_refinement_marker` — `architecture.md:527` — resurface trigger: `never` — Spike A outcome on Ubuntu headless.
- **PD-002** — `unresolved_refinement_marker` — `architecture.md:538` — resurface trigger: `never` — Paper sketch may force `ports` / `docker` permission categories.
- **PD-003** — `unresolved_refinement_marker` — `architecture.md:541` — resurface trigger: `never` — Source picker pagination on very large Jira instances.

## Notes

- All three findings are honestly-deferred build-stage open questions. None are cross-artifact drift; the spec is internally consistent.
- The `prd_drift` check did not fire: `work-units.json` mtime is later than `prd.md` mtime.
- No `nfr_category_missing`: security (NFR-001/002/003/004), performance (NFR-005/006), accessibility (NFR-007) are all present.
- No `orphan_test`, `orphan_work_unit`, or `unknown_id_reference` findings: every linkage in `test-cases.json` and `work-units.json` resolves to a real id in `prd.md`.
- No `missing_l1_coverage` or `level_gating_violation`: every FR / NFR / US has at least one L1 case.
- No `stale_issue` findings because every `issue` field in `work-units.json` is null (issues were not filed during this run; `gh` CLI not installed).
- Each `resurface_trigger: never` means the deferral does not auto-resurface in future `/product-align` runs. To re-open one, edit `flow-state.json` (clear the matching `PD-NNN` entry) and re-run.

---

## Re-alignment run - 2026-05-24

> Generated: 2026-05-24T03:30:00Z (after the 2026-05-24 addendum for security & quality alerts). Findings: 1 · Resolved: 1 · Deferred: 0 · Dismissed: 0 · Unresolved: 0 · Suppressed: 3 (PD-001, PD-002, PD-003 still parked with resurface_trigger=`never`).

### Counts before (addendum scope only)

- critical: 0
- high: 0
- medium: 1
- low: 0

### Deferred items reviewed

PD-001, PD-002, PD-003 are still parked with `resurface_trigger: never`. They are out-of-scope for the addendum re-alignment and remain suppressed.

### Addendum scope verified

- 11 functional requirements (FR-040..FR-050) — every one has L1 test coverage and is referenced by at least one work unit.
- 4 non-functional requirements (NFR-012..NFR-015) — every one has L1 test coverage and is referenced by at least one work unit.
- 3 user stories (US-011..US-013) — every one has at least one test case and is referenced by at least one work unit.
- 23 test cases (TC-085..TC-107) — every one links to at least one requirement or user story.
- 9 work units (WU-028..WU-036) — every one links to at least one requirement and has a populated issue URL (GitHub #104..#112).
- No dangling `depends_on` references; topological order respected during issue creation.

### Walk

- **AF-004** [unresolved_refinement_marker · medium · `context.md:299`] — **edited** — The re-interview section's "Open questions flagged for refinement" list named three items (OAuth re-consent placement, frozen bench snapshot, type-chip for regular Issues) that were all decided downstream during PRD / prototype / architecture stages. context.md was edited in place to retitle the section "Open questions raised during re-interview (all resolved downstream)" and to replace each bullet with the concrete decision (and the artifact that records it). The `architecture.md:1009` co-finding was a false positive (meta-prose stating no markers were added by the addendum), no edit needed.

### Remaining unresolved

(None.)

### Active deferral queue (unchanged from prior run)

- **PD-001** — `unresolved_refinement_marker` — `architecture.md:527` — resurface trigger: `never` — Spike A outcome on Ubuntu headless.
- **PD-002** — `unresolved_refinement_marker` — `architecture.md:538` — resurface trigger: `never` — Paper sketch may force `ports` / `docker` permission categories.
- **PD-003** — `unresolved_refinement_marker` — `architecture.md:541` — resurface trigger: `never` — Source picker pagination on very large Jira instances.

### Notes (addendum)

- No `prd_drift`: work-units.json mtime is later than prd.md mtime.
- No `orphan_test` or `orphan_work_unit`: every addendum linkage resolves.
- No `nfr_category_missing`: addendum NFRs cover security (NFR-012), performance (NFR-013), accessibility (NFR-014), reliability (NFR-015).
- No `unknown_id_reference`: every TC and WU linkage in the addendum resolves to a real id.
- No `stale_issue`: every addendum WU has a github.com issue URL populated.
- No host-API change introduced by the addendum; `hostApiVersion` remains 1.0.0 (verified by architecture addendum).
- Addendum re-alignment did NOT touch the three pre-existing deferrals; they remain suppressed per their original `resurface_trigger: never`.
