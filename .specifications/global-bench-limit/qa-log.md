# Q&A Log — global-bench-limit

Interview conducted 2026-05-22 in the `/product-flow` orchestrator thread, using `AskUserQuestion` from the main thread (the `product-interviewer` subagent could not be used because `AskUserQuestion` is unavailable inside subagents — captured as issue `iss_20260522_001`).

## Cluster 1 — problem, what counts, scope

**Q1.** What's the core problem the bench cap solves? _(multi-select)_

**A1.** Resource exhaustion (CPU/RAM/disk).

**Q2.** What counts toward the cap?

**A2.** All initialised benches (workspace exists on disk).

**Q3.** What's the scope of the cap?

**A3.** Both: per-project caps with a global ceiling.

## Cluster 2 — configuration UX, default, persistence

**Q4.** Where is the global cap configured?

**A4.** Reuse and rename the existing 'Bench Defaults' tab.

**Q5.** What's the default cap, and is 'unlimited' allowed?

**A5.** Unlimited by default (opt-in only).

**Q6.** Where does the cap value persist?

**A6.** _(verbatim, asked back as a clarifier)_ Where do other settings live, i.e., settings for 'bench defaults', 'appearance' and 'claude code'?

**A6-resolved.** Orchestrator answered: settings already live in `~/.roubo/settings.json` as `UserPreferences` (`shared/types.ts`), served by `GET/PUT /api/settings` and persisted by `services/state.ts:loadSettings/saveSettings`. The user accepted this by proceeding to Cluster 2b without changing the decision.

## Cluster 2b — tab naming, per-project interaction

**Q7.** What should the tab be renamed to?

**A7.** Benches.

**Q8.** How does the global cap interact with per-project state?

**A8.** _(verbatim)_ projects already have a bench limit. those should remain enforced. this enw setting is a global limit that provides a cap across all projects.

## Cluster 3 — block UX, auto-clear, concurrency

**Q9.** When a user tries to create a bench at the global cap, what happens?

**A9.** Disabled 'New bench' button with tooltip + server 4xx as defense in depth.

**Q10.** How does the global cap interact with auto-clear?

**A10.** _(verbatim)_ We don't currently automate bench creation. The global cap should not impede the auto-clearing of benches.

**Q11.** What happens on concurrent create requests at the boundary?

**A11.** First-write-wins via a lock around state.json (strict).

## Cluster 4 — success, out of scope, fail mode

**Q12.** What's the success signal for this feature?

**A12.** Qualitative — zero user reports of 'machine froze from too many benches'.

**Q13.** What's explicitly OUT of scope for v1? _(multi-select)_

**A13.** Per-user / multi-tenant quotas; Automatic cap adjustment based on system resources; A 'force create over cap' escape hatch; Surfacing cap state in CLI / non-UI consumers.

**Q14.** On settings.json corruption / unreadable, what's the behavior?

**A14.** Fail-open: treat as unlimited (current default) and log a warning.

## Cluster 5 — edge cases (lowered cap, in-flight benches)

**Q15.** If a user lowers the global cap below their current bench count, what happens?

**A15.** Allow lowering; existing benches stay; new creation blocked until they're back under.

**Q16.** Should the cap apply to in-flight / placeholder benches (e.g. a bench being created right now)?

**A16.** Yes — in-flight benches count as soon as a slot is reserved.
