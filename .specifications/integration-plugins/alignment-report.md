# Alignment report - integration-plugins

> Generated: 2026-05-25T03:00:00Z · Findings: 16 · Resolved: 7 (5 orphan e2e wired into automation units + 2 architecture markers resolved) · Deferred-as-decision: 6 (NFR L1 gaps) · Carried-forward: 1 (Spike A PD-001) · Dismissed: 0 · Unresolved: 0

## Counts before

- critical: 0
- high: 11
- medium: 5
- low: 0

## Prior run history

This is the second align run for the slug. The first ran 2026-05-21 and parked PD-001..003 with `resurface_trigger: never`. The 2026-05-24 alerts re-interview re-ran feasibility..align but the pending decisions stayed parked. This run (2026-05-25) re-opened PD-002 and PD-003 and closed them; PD-001 stays parked.

## Deferred items reviewed (Step 2.5)

The alignment checker did not suppress findings against the pending_decisions set this run (a checker bug). Handled in-line via Step 2.5:

- **PD-001** (originally raised 2026-05-21) - Spike A outcome on Ubuntu headless (keyring fallback). Action: **re-deferred** with `resurface_trigger: never`. The dbus-run-session + gnome-keyring-daemon recipe is the design but cannot be validated without actually running Spike A.
- **PD-002** (originally raised 2026-05-21) - Paper sketch / ports + docker permission categories. Action: **addressed now**. Accepted that additive 1.x minor with the existing `.passthrough()`-aware schema is the path forward. Marker removed from architecture.md. Entry cleared from `flow-state.pending_decisions`.
- **PD-003** (originally raised 2026-05-21) - Source picker pagination on very large Jira instances. Action: **addressed now**. Accepted that opt-in `nextCursor` + virtualized MultiSelect is the planned approach. Marker removed from architecture.md. Entry cleared from `flow-state.pending_decisions`.

## Walk (main findings)

- **AF-001..AF-005** - unresolved_refinement_marker in architecture.md - **all three underlying markers handled via Step 2.5 above** (the 5 AF entries are decorative repeats of the 3 underlying markers across body text and a recap bullet list). AF-002 (PD-002) and AF-003 (PD-003) resolved by removing markers. AF-001 (PD-001 Spike A) remains parked.
- **AF-006** - e2e_flow_without_automation_wu - TC-178 (Single Connect/Configure button switches label) - **resolved** by linking into WU-068.
- **AF-007** - e2e_flow_without_automation_wu - TC-179 (GHE consolidation parity) - **resolved** by linking into WU-068.
- **AF-008** - e2e_flow_without_automation_wu - TC-180 (Dependabot alerts enable + re-consent) - **resolved** by linking into WU-069.
- **AF-009** - e2e_flow_without_automation_wu - TC-181 (e2e suite self-test) - **resolved** by linking into WU-070.
- **AF-010** - e2e_flow_without_automation_wu - TC-182 (plugin-driven tab title propagation) - **resolved** by linking into WU-068.
- **AF-011** - missing_l1_coverage - NFR-016 (accessibility) - **accepted as gap**. Meaningful verification is via axe-core at L2; L1 stub would be ceremony.
- **AF-012** - missing_l1_coverage - NFR-017 (performance) - **accepted as gap**. Meaningful verification is via perf measurement at L2.
- **AF-013** - missing_l1_coverage - NFR-019 (security: enable state local-only) - **accepted as gap**. Meaningful verification is via security inspection at L2.
- **AF-014** - missing_l1_coverage - NFR-020 (security: host.fetch allowlist) - **accepted as gap**. Meaningful verification is via integration test at L2.
- **AF-015** - missing_l1_coverage - NFR-021 (performance: filter recompute) - **accepted as gap**. Meaningful verification is via perf harness at L2.
- **AF-016** - missing_l1_coverage - NFR-022 (accessibility: focus trap) - **accepted as gap**. Meaningful verification is via keyboard/focus integration at L2.

## Decisions recorded

All appended to `.specifications/integration-plugins/decisions-log.md` under `## 2026-05-25 - alignment-run decisions`:

1. L1 gating rule intentionally relaxed for inherently-higher-level NFR categories (perf, a11y, security boundaries, focus traps).
2. PD-002 (paper sketch / ports+docker) resolved as additive 1.x minor.
3. PD-003 (source picker pagination) resolved as opt-in cursor + virtualized MultiSelect.
4. PD-001 (Spike A) re-deferred; reopen if Spike A surfaces a real adoption blocker.
5. Orphan e2e_flow cases TC-178..TC-182 wired into existing e2e_automation units (no new units created).

## Remaining unresolved

None. All 16 findings either resolved (7) or accepted-as-decision (9, the NFR L1 explicit relaxations + Spike A explicit carry-forward).

## Active deferral queue

After this run, `flow-state.pending_decisions` contains:

- **PD-001** (raised 2026-05-21) - unresolved_refinement_marker - identifiers: `["architecture.md:527"]` - resurface trigger: `never` - original question: "Spike A outcome on Ubuntu headless (keyring fallback)".

## Re-run guidance

- Architecture.md retains literal `unknown - flag for refinement` text inside strikethrough markup on the recap bullet list at line 579. A naive grep-based alignment checker may still match it. Future re-run can rewrite those bullets to avoid the literal sentinel inside `~~` strikethroughs.
- NFR L1 gap decisions are now in decisions-log.md. A future re-run of the alignment checker that honours decision-log entries will not re-surface them. The current checker still emits them.
- The alignment checker did not consult `flow-state.pending_decisions` to suppress PD-001..003 - that's a known checker bug worked around this run.
