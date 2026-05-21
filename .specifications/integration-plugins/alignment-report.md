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
