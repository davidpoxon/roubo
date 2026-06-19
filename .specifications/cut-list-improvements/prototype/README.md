# Cut list improvements: prototype

A single standalone page demonstrating the new cut-list experience. **Open `index.html` directly in a browser** (double-click / `file://`). No build, no server; it loads Tailwind, Inter/JetBrains Mono, and lucide icons from CDNs and bakes all data in.

It reproduces Roubo's design language (warm stone spine, `amber-500` accent, hairline borders, no shadows, uppercase tracked section labels) from `DESIGN.md`.

## What it covers

- **Warm / cold / refreshing / plugin-down states** with the cache-state badge and last-updated indicator (FR-001, FR-002, FR-005, FR-006, NFR-006).
- **Prev/Next pagination** replacing infinite scroll, page indicator, Prev disabled on page 1; filter/sort changes reset to page 1 (FR-007, FR-008).
- **Plugin-declared sort picker** with direction toggle, default ascending by item key; the field set differs per plugin to show capability divergence (Jira: key/updated/created/priority/rank; GitHub: created/updated/comments, no native key sort) (FR-009, FR-010, FR-014).
- **Only-To-Do default** list with the "N hidden by status" note and the one-time migration banner (FR-012, FR-018), plus the per-project status-filter config dialog with the per-plugin mapping note (FR-013, FR-014).
- **Source-side facet hygiene:** the Milestone menu lists only live milestones and states that closed/archived are excluded at the source (FR-015).
- **Accessibility:** native focusable controls, `aria-label`s, and a polite live region announcing refresh and page changes (NFR-007).

## Demo controls

The "Prototype controls" panel (bottom right, clearly marked demo-only) switches the active plugin and the load state, and toggles the migration banner. Each switch prints which requirement it exercises.
