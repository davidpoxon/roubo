# PRD: Global Bench Limit

> Slug: `global-bench-limit` · Last updated: 2026-05-22

## Problem

Roubo today enforces per-project caps on benches via `benches.max` in `roubo.yaml`, but nothing prevents the sum across all registered projects from exhausting the host machine. Users with many projects can unintentionally fan out enough initialised benches to saturate CPU, RAM, or disk. This feature adds a single application-wide ceiling on top of per-project caps, opt-in and backward-compatible, so users can protect their machine with one knob.

## In scope

- A new optional `benches.maxGlobal` field on `UserPreferences`, persisted in `~/.roubo/settings.json` via the existing `GET/PUT /api/settings` route.
- A control in the existing app-wide Settings UI (tab renamed from **Bench Defaults** to **Benches**) for setting and clearing the cap.
- Pre-create enforcement in `bench-manager` that rejects new bench creation when the cap is hit, returning HTTP 409 with code `GLOBAL_CAP_REACHED`.
- A disabled "New bench" affordance with an accessible tooltip explaining the cap.
- A small global meter on the dashboard, visible only when a cap is set, mirroring the per-project `ProjectTile` meter pattern.
- Strict first-write-wins under concurrent create attempts at the boundary, by piggybacking on the existing synchronous reservation block in `bench-manager.createBench`.
- Counting all benches in the in-memory `benches` Map (statuses `initialised`, `preparing`, `error`) toward the cap.
- Validation in the settings route: cap is a positive integer (>= 1) when set; `null` / absent means unlimited; `0`, negative numbers, non-integers, `NaN`, and `Infinity` are rejected with 400.
- Fail-open behaviour when `~/.roubo/settings.json` is unreadable or corrupt: treat as unlimited and log a warning.
- Allowing a user to lower the cap below their current bench count; existing benches are preserved, new creation is blocked until the count drops below the new cap.

## Out of scope

- Per-user or multi-tenant quotas. Roubo is single-user desktop today.
- Surfacing cap state in CLI or any non-UI consumer. CLI / direct API users see only the 409.
- Automatic cap adjustment based on system resources (RAM, CPU). The cap is a user-set number.
- A "force create over cap" escape hatch on `POST /benches`.
- Telemetry on cap-block events.
- Changing the existing per-project `benches.max` mechanism. Per-project caps continue to be enforced independently.
- Auto-deleting benches when the cap is lowered.
- Blocking the auto-clear path. The cap only governs user-initiated bench creation.

## User stories

### US-001 — Cap total benches across all my projects
As a developer running benches across many registered projects, I want one application-wide cap on total initialised benches, so that I cannot accidentally fan out enough benches to saturate my machine.

### US-002 — See why I cannot create another bench
As a developer at the cap, I want the "New bench" button to be visibly disabled with a tooltip explaining the limit, so that I understand the constraint without having to attempt creation and read an error.

### US-003 — Track how close I am to the cap
As a developer with a cap set, I want a small global meter on the dashboard showing `N of M` benches, so that I can see ahead of time when I am near the limit.

### US-004 — Lower the cap without losing benches
As a developer, I want to lower the cap below my current bench count without my existing benches being destroyed, so that I keep all in-progress work and just stop creating new benches until I voluntarily clear some.

### US-005 — Keep my install behaving as before
As an existing user who upgrades, I want the cap to be unlimited by default, so that nothing about my workflow changes until I opt in.

## Functional requirements

### FR-001 — `benches.maxGlobal` field on `UserPreferences`
The `UserPreferences` type gains an optional nested `benches` object with an optional `maxGlobal: number` field. Both `benches` and `maxGlobal` may be absent. When absent or `null`, the cap is unlimited.

### FR-002 — Settings route validates the cap value
`PUT /api/settings` rejects payloads where `benches.maxGlobal` is present and is not a positive integer (>= 1). Rejected values include `0`, negative numbers, non-integers, `NaN`, and `Infinity`. Rejection returns HTTP 400 with a clear error message naming the offending field. A `null` or absent value is accepted and means unlimited.

### FR-003 — Cap enforcement in `bench-manager.createBench`
Before reserving a slot for a new bench, `createBench` reads the current `benches.maxGlobal` from `UserPreferences`. If the cap is set and the count of benches in the in-memory `benches` Map is already at or above the cap, creation is rejected. The rejection surfaces to `POST /api/projects/:projectId/benches` as HTTP 409 with code `GLOBAL_CAP_REACHED` and a message naming the current and max counts.

### FR-004 — All in-memory benches count toward the cap
The count used for cap evaluation is `benches.size` from the in-memory Map in `bench-manager`. Benches in any status (`initialised`, `preparing`, `error`) count. Only a successful `clearBench` (which removes the entry from the Map and the workspace from disk) decreases the count.

### FR-005 — In-flight bench creations reserve a slot immediately
A bench creation reserves its slot inside the existing synchronous reservation block in `createBench`, before any `await`. This guarantees that an in-flight `preparing` bench is already counted by the time a parallel create attempts its own reservation.

### FR-006 — Strict first-write-wins under concurrent creation
When two `createBench` calls race at the cap boundary, the synchronous reservation block ensures exactly one succeeds; the other rejects with `GLOBAL_CAP_REACHED`. No new lock around `state.json` is introduced; the in-memory Map plus Node's single-threaded event loop is the serialization point, consistent with how the existing per-project cap is enforced.

### FR-007 — Clearing a bench is never blocked by the cap
`clearBench` (the path used by `DELETE /api/projects/:projectId/benches/:id`, the `autoClear` flow, and `workUnitAutoClear`) is never gated by the global cap. The cap only governs new bench creation.

### FR-008 — Settings UI: tab renamed and global limit control added
The existing Settings tab labelled "Bench Defaults" is renamed to "Benches" (update the `TAB_LABELS` entry in `client/src/components/ProjectSettings.tsx`). The tab content gains a "Global bench limit" control. The control offers an "Unlimited" mode (clears the cap) and a numeric mode (positive integer, >= 1). Saving updates `UserPreferences.benches.maxGlobal` via `PUT /api/settings`.

### FR-009 — Disabled "New bench" button with accessible tooltip
The "New bench" button in the bench creation UI is rendered with React Aria's `Button` and `isDisabled` set whenever the global cap is hit. An associated description (visible as a tooltip on hover/focus and exposed to assistive tech) explains the cap in the form: "Global bench limit reached. N of M benches in use."

### FR-010 — Global cap meter on the dashboard
When a cap is set, the dashboard renders a small "Global benches" meter showing the current count and the cap, mirroring the visual treatment of the per-project meter on `ProjectTile`. When no cap is set, the meter is not rendered.

### FR-011 — Lowering the cap below current count is allowed
`PUT /api/settings` accepts a new cap value that is below the current bench count. No benches are deleted. After saving, `POST /api/projects/:projectId/benches` returns `GLOBAL_CAP_REACHED` until the user clears enough benches to bring the count below the new cap.

### FR-012 — Fail-open on unreadable or corrupt settings
If `~/.roubo/settings.json` cannot be read or parsed when `bench-manager` evaluates the cap, the cap is treated as unlimited and a warning is logged. Bench creation proceeds.

## Non-functional requirements

### NFR-001 — Cap-check performance
Category: performance
The cap check on the create path is O(1) (a single `benches.size` read against an in-memory Map). No measurable latency budget is required; the check must remain O(1) and must not introduce any I/O on the hot path.

### NFR-002 — Accessibility of cap UI
Category: accessibility
All new UI (the settings control, the disabled "New bench" button + tooltip, and the dashboard meter) meets WCAG 2.1 AA. The "New bench" button uses React Aria's `Button` with `isDisabled` and an associated description so screen readers explain the disabled state. The meter exposes an `aria-label` of the form "Global benches: N of M".

### NFR-003 — Security posture
Category: security
The cap setting introduces no new auth surface. It reuses the existing `/api/settings` route, which has no auth (Roubo is a single-user desktop tool today). Input validation per FR-002 protects against malformed values reaching `bench-manager`.

### NFR-004 — Reliability under settings corruption
Category: reliability
A corrupted or unreadable `~/.roubo/settings.json` must not prevent the user from creating benches. The server treats the corruption as "unlimited" and logs a single warning per process load. Recovery on next successful read requires no user action beyond fixing or removing the file.

### NFR-005 — Backward compatibility
Category: reliability
Existing installs that have never set the cap behave identically to today: unlimited, no UI gating, no migration. The new field is optional at every layer (types, route validation, settings file).

## Leading indicators of success

- Within the first week after release, no user report of "machine froze / fans pegged from too many benches" cites a missing or unenforced cap.
- The settings UI is reachable, the control persists across reloads, and toggling between Unlimited and a numeric cap produces the expected disabled-button / meter behaviour on the dashboard.

## Lagging indicators of success

- At 30 days, multi-project users who have opted in report no instances of the cap silently failing, no instances of the cap blocking a clear operation, and no instances of bench creation succeeding past the cap.
- No follow-up issues filed against `bench-manager` related to cap correctness, concurrency at the boundary, or fail-mode behaviour.
