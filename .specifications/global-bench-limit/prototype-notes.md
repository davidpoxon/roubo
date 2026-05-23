# Prototype notes — global-bench-limit

## Intent and scope

A single-file static HTML mockup at `.specifications/global-bench-limit/prototype/index.html` that visually demonstrates the three new UI surfaces:

1. The "Global bench limit" control inside the renamed **Benches** Settings tab.
2. The disabled "+ New bench" button with accessible tooltip on the dashboard toolbar.
3. The "Global benches" meter on the dashboard, mirroring the existing per-project tile meter.

A scenario switcher at the top lets a reviewer flip between five rendered states (unlimited, below cap, near cap, at cap, lowered cap) without writing code. The whole prototype is a single HTML file with inline CSS and a small inline `<script>` driving the scenario switch. No build, no dependencies, no backend.

## Design decisions made during generation

- **Single static file** because the host stack is exactly what the production implementation will use (React 19 + Vite + Tailwind 4 + React Aria). A parallel Vite + React prototype would duplicate the existing app shell with mocked data for marginal extra value over the static page. The user explicitly chose this scope in the prototype checkpoint.
- **Dark theme only.** Roubo's primary mode. Light mode would double the surface area for marginal value at the prototype stage.
- **Scenario switcher instead of interactive state model.** The point of the prototype is to compare designs across the obvious decision-edges (at cap vs below, lowered cap vs equal). Hard-coded scenarios are faster to review than a fully-interactive state machine.
- **`aria-disabled` on the New bench button, not the native `disabled` attribute.** Native `disabled` removes focus, which would prevent the tooltip from being read by a keyboard user. The production React Aria `Button` with `isDisabled` already does the right thing; the prototype mirrors the contract.
- **Red meter fill at the cap** to give a strong visual signal. The architecture stage may want to tune the threshold (e.g. amber at >= 80%, red at cap).
- **Mocked project list** uses three placeholder names (`roubo`, `marketplace`, `ledger`) just to give per-project tiles realistic counts that sum to the global meter.

## Screens

The page renders one viewport, two side-by-side panels:

- **Left panel — Settings · Benches tab.** Tabs row matching the production layout (Benches, Appearance, Jigs, Integrations, Plugins, Claude Code). Under the active **Benches** tab: a `Global bench limit` field with a two-button **Unlimited / Limit** toggle and a numeric input. Validation message renders red below the input if the user types `0`, a negative number, or a non-integer. A Save button surfaces a transient "Saved" affordance.
- **Right panel — Dashboard.** Toolbar with the **Global benches** meter on the left and the **+ New bench** button on the right. Under the toolbar, the per-project tile list with each project's per-project meter. Switching scenario in the top bar updates both panels in sync.

(Add screenshots after running the prototype locally; the team's screenshot tool of choice is fine.)

## Open questions for the architecture stage

- Exact React Aria component for the Limit / Unlimited toggle. Options: a two-button `ToggleButtonGroup`, a single `Checkbox` (Unlimited checked = cap null), or a custom `RadioGroup`. Pick whatever already appears in `ProjectSettings.tsx` to keep consistency.
- Where to source the "current global count" in the client: sum the existing `useBenches()` cross-project query client-side, or add a derived `totalCount` field on `GET /api/benches`. The latter avoids a refetch loop when individual project queries are stale.
- Whether the meter belongs on a global dashboard header (visible from any view) or scoped to a single "All benches" page. The current `BenchDashboard.tsx` is per-project; the meter would either need to lift up or be duplicated.
- Whether the tooltip should include a "Clear a bench to free a slot" call to action beyond just the count.
- Whether the meter colour ramps in stages (amber near, red at) or stays neutral until the cap.
- Whether the per-project `ProjectTile` meter should also surface the global cap context (e.g. "globally 3 of 5"), or whether the global meter alone is sufficient.
