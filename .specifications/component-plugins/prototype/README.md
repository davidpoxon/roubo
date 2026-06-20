# Component Plugins prototype

A standalone, high-fidelity static mock of the user-facing surfaces of the Component Plugins feature. Open `index.html` directly in a browser (no build, no server, no install). It reproduces Roubo's design language from the root `DESIGN.md` (warm stone spine, single amber-500 accent, Inter UI + JetBrains Mono technical values, whitespace-first, no shadows).

## What it demonstrates

- **Marketplace catalog** (FR-020, US-010): browse / search / filter the first-party-curated plugin catalog, with both `component` and `integration` kinds, per-plugin integrity ("Verified") and version, and Install / Update / Installed states.
- **Plugin detail drawer** (FR-011, FR-021, US-011): a plugin's declared permission categories in plain language, its integrity / provenance / signing, sandbox status, and lifecycle (long-running vs the one-shot `clasp-deploy`, the FR-022 deploy stress-test).
- **Permission-consent dialog** (FR-012, FR-011, NFR-001, NFR-007, US-004): the install flow enumerates every declared permission category in plain language, labels the plugin unsandboxed (v1, enforcement in v2), and **blocks Install until the consumer explicitly acknowledges** (the checkbox gates the primary button). Keyboard navigable with amber focus rings, `role="dialog" aria-modal`, Esc to dismiss.
- **Plugin-backed bench view** (FR-014, FR-016, US-002, US-006): a `responda` bench whose `sql` / host / `frontend` components are each backed by a plugin (`roubo/database`, `roubo/process`), with status dots paired with labels, ports, brokered host logs, the migrated `roubo.yaml` binding, and a `frontend` component that crashed and **auto-recovered** (graceful degradation + cleanup).

## How to open

Double-click `index.html`, or `open index.html`. Requires internet at view time for the CDN assets (Tailwind, fonts, icons); no local build.

## Primary journeys to click

1. Marketplace → search / filter by kind → click **Install** on `redis` or `clasp-deploy` → review the consent dialog → tick the acknowledgement → **Install** → toast confirms.
2. Click a plugin name → detail drawer → review declared permissions, provenance, and lifecycle.
3. Sidebar → **Benches** → see components running on plugins, including the auto-recovered `frontend`.
