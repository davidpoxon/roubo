# Context — global-bench-limit

## Seed prompt

> I want to create an application wide setting for a global maximum on initialised benches. If the maximum has been reached, new bench creation should be blocked until one or more existing benches have been cleared.

## Problem

Users with many registered projects can spin up enough benches that the local machine becomes resource-saturated (CPU, RAM, disk). Each bench is an initialised workspace on disk with reserved ports and (when started) running components. Per-project caps (`benches.max` in `roubo.yaml`) already prevent a single project from going wild, but nothing prevents the sum across all projects from exhausting the host. This feature adds a global ceiling on top of the existing per-project caps.

## Users

Roubo's single-user, desktop audience: an individual developer running benches on their own laptop / workstation across multiple registered repositories. Roubo is macOS + Linux only (no Windows).

## Goals

- Give the user one application-wide knob that caps total initialised benches across every registered project.
- Make the cap honest: at the cap, the "New bench" affordance is visibly unavailable, and the server enforces the limit defensively.
- Stay backward compatible: the cap is opt-in — existing installs are uncapped until the user sets a number.

## In scope

- A new `maxBenchesGlobal` field on `UserPreferences` (persisted in `~/.roubo/settings.json`, same file/route as theme + other app-wide settings).
- A control in the existing app-wide Settings UI (the **Bench Defaults** tab is renamed to **Benches**) for setting / clearing the cap.
- Cap evaluation in `bench-manager` so that `POST /api/projects/:projectId/benches` returns a 4xx (409) with a clear reason when the cap is hit.
- A disabled-state "New bench" affordance in the bench creation UI when the cap is hit, with an accessible tooltip explaining why.
- Concurrency-safe enforcement: when two creates race at the cap boundary, exactly one succeeds; the other gets 409.
- Counting in-flight bench creations as "taken" the moment a slot is reserved (not only after workspace provisioning completes).
- The cap counts **initialised** benches (workspace exists on disk), regardless of whether their components are currently running or stopped. Clearing a bench (removing the workspace) frees a slot.

## Out of scope

- Per-user / multi-tenant quotas. Roubo is single-user desktop today.
- Surfacing cap state in CLI or any non-UI consumer. CLI / direct API users see only the 409.
- Automatic cap adjustment based on system resources (RAM, CPU). The cap is a user-set number.
- A "force create over cap" escape hatch. The cap is enforced uniformly with no override flag.
- Telemetry on cap-block events. Success is monitored qualitatively in v1.
- Changing the existing per-project `benches.max` mechanism. Per-project caps remain enforced exactly as today.
- Auto-deleting benches when the cap is lowered. Existing benches are never destroyed by a settings change.

## Constraints

- **Backward compatibility:** existing installs must continue to behave as today (unlimited) until the user explicitly sets a cap.
- **Persistence pattern:** must extend `UserPreferences` in `~/.roubo/settings.json` via the existing `GET/PUT /api/settings` route (`server/routes/settings.ts` + `server/services/state.ts:loadSettings/saveSettings`). No new file.
- **UI pattern:** must reuse the existing app-wide Settings tab structure in `client/src/components/ProjectSettings.tsx`. The Bench Defaults tab is renamed to **Benches**.
- **Concurrency:** must be strict first-write-wins via a lock around `state.json`, consistent with the existing serialized-write pattern.
- **Accessibility:** the disabled "New bench" affordance must use React Aria's `Button` with `isDisabled` and an associated description so screen readers explain why; this matches the project's existing React Aria + Tailwind conventions.
- **Brand:** all new strings use the Roubo vocabulary (Bench, Project, Workspace) and avoid em dashes per writing style.
- **No automated bench creation today.** The cap therefore only ever applies to user-initiated creates. Auto-clear's clearing operation must never be blocked by the cap.

## Behaviour decisions

- **Scope of the cap:** truly global, summed across all registered projects. Per-project `benches.max` caps continue to apply independently — both are enforced.
- **Default value:** unlimited (opt-in). Out of the box, behaviour is unchanged.
- **Counting rule:** all initialised benches (workspace exists on disk). Stopped benches still count. Only `clearBench` (workspace removed) frees a slot.
- **In-flight benches:** count as soon as a slot is reserved during creation, before workspace provisioning completes. Prevents over-cap races.
- **Block UX:** disabled "New bench" button with an accessible tooltip ("Global bench limit reached — N of M benches in use") plus a server 409 as defense in depth.
- **Auto-clear interaction:** the cap does not impede the clearing of benches. Since Roubo does not auto-create benches today, the cap only governs user-initiated creates.
- **Concurrency:** strict first-write-wins via a lock around `state.json` (consistent with the existing serialized-write pattern).
- **Lowering the cap below the current count:** allowed. Existing benches remain untouched; new bench creation is blocked until the user clears enough benches to drop below the new cap.
- **Fail mode on settings.json corruption:** fail-open (treat as unlimited) and log a warning. Matches the unlimited-by-default design and avoids locking the user out.

## Success criteria

- **Leading (week 1):** zero user reports of "machine froze / fans pegged from too many benches." Qualitative only — no telemetry in v1.
- **Lagging (30 days):** the cap setting is in active use by users on multi-project setups; no reports of the cap blocking legitimate work or being silently bypassed.

## Open questions / refinement flags

None at end of interview. Every coverage dimension has a real user answer in `qa-log.md`.

## Prior-art notes (not decisions — for downstream stages)

- Per-project cap already exists as `benches.max` (1–99) in `roubo.yaml`, enforced in `server/services/bench-manager.ts` (search for `findNextBenchNumber`, `config.benches.max`). The new global cap is **layered on top** — both apply.
- App-wide settings already persist in `~/.roubo/settings.json` via `UserPreferences` (`shared/types.ts`) and `services/state.ts:loadSettings/saveSettings`. Surfaced through `GET/PUT /api/settings` (`server/routes/settings.ts`).
- App-wide Settings UI lives in `client/src/components/ProjectSettings.tsx` with tabs: `benches` (currently labelled "Bench Defaults"), `appearance`, `jigs`, `integrations`, `plugins`, `claude-code`. Tab labels are in `TAB_LABELS` at line 712 — rename `benches` → `"Benches"`.
- `.handoff/product-flow-plan-mode-collision.md` indicates a prior partial implementation in a previous session (notes adding `maxBenchesGlobal?: number` to `UserPreferences` and validation in `server/routes/settings.ts`). The architecture stage should decide whether to reuse, rebase, or discard those changes — this interview did not validate that earlier work.
