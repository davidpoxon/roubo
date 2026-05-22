# Prototype — global-bench-limit

A self-contained static HTML mockup of the three user-facing surfaces for the global bench limit feature. No build step, no dependencies, no backend.

## Run

Open `index.html` directly in any modern browser:

```bash
open .specifications/global-bench-limit/prototype/index.html
```

Or serve it through Roubo's normal dev workflow if you prefer a localhost URL:

```bash
cd .specifications/global-bench-limit/prototype && python3 -m http.server 8765
# then visit http://localhost:8765
```

## What it covers

The page renders two panels side-by-side, plus a scenario switcher at the top.

| User story | Surface | How to see it |
|---|---|---|
| US-001 | "Global bench limit" control in Settings · Benches tab | Left panel. Toggle between **Unlimited** and **Limit**; numeric input disables in Unlimited mode. Try invalid values (0, -3) to see validation. |
| US-002 | Disabled "+ New bench" button with accessible tooltip | Right panel. Click the **Cap 5 · 5 in use (at cap)** scenario. Hover or focus the button to read the tooltip. |
| US-003 | Global meter on the dashboard | Right panel toolbar. Visible only when a cap is set. Fill bar mirrors the per-project tile meter pattern; turns red at the cap. |
| US-004 | Lower the cap below current count | Click **Cap 3 · 5 in use (lowered)**. Existing benches preserved; meter shows 5 of 3; new bench is blocked. |
| US-005 | Unlimited (default) behaviour | Click **No cap (default)**. Meter hides; button is always enabled; per-project tiles unchanged. |

## What is mocked

- The five scenarios in the top bar are hardcoded JSON-shaped objects in the inline `<script>`. They drive both panels deterministically.
- Project tiles are static names: `roubo`, `marketplace`, `ledger`. Per-project bench counts shift between scenarios.
- "Save" is a fake animation only. No persistence, no network.

## Design references

- Inter for UI text, JetBrains Mono for numeric values (matches Roubo's typography rules).
- Warm stone palette + amber accent on primary actions and active states (matches `docs/brand.md`).
- React Aria patterns are not used (this is plain HTML), but ARIA attributes match what the real components must do:
  - Button uses `aria-disabled` (not the HTML `disabled` attribute) so it remains focusable and the tooltip can be announced.
  - Meter uses `role="group"` + `aria-label="Global benches: N of M"`.
  - Tab list uses `role="tablist"` / `role="tab"`.

## Not covered

- Real React Aria component behaviour (focus rings, real radio group semantics) — only an approximation.
- Theming (light mode). Hardcoded to dark theme since that is Roubo's primary mode.
- Error states beyond input validation (e.g. server 409 surfaced as a toast).
- The full Settings page chrome (header, FirstNSessionsBanner, etc.) is elided to keep focus on the new control.

## Open questions for the architecture stage

- Exact React Aria component for the "Limit / Unlimited" toggle. Options: a two-button `ToggleButtonGroup`, a `Checkbox` (Unlimited checked = cap null), or a custom radio group. Pick the one that already appears elsewhere in `ProjectSettings.tsx`.
- Where to source the "current global count" in the client. Either:
  1. Use the existing `useBenches()` cross-project query and sum, or
  2. Add a small derived field on `GET /api/benches` (e.g. `totalCount`).
- Whether the meter belongs on the dashboard header (visible across project views) or only on the top-level "All benches" page.
- Whether the tooltip should also include a "Clear a bench to free a slot" call to action.
