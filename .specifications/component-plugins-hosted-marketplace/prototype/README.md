# Prototype: Hosted marketplace and plugin de-bundling

**Parent spec:** component-plugins (`.specifications/component-plugins/`). This increment's prototype, authored branch-new; the parent is read-only.

A standalone, `file://`-openable static page (no build, no server, CDN fonts only, mock data baked in) reproducing Roubo's warm-stone + amber-500 design language. It demonstrates the changed UI surfaces for the re-platforming.

## Open it

Open `index.html` in any browser. Use the left rail to move between screens.

## What it covers

Plugin lifecycle (the four cases requested):

- **Fresh install** : what a clean machine has out of the box (the three seeded plugins `github-com` / `process` / `database`, verified, offline) vs the marketplace-only ones. (FR-004, FR-005, NFR-002)
- **Browse & install** : the hosted catalog with search + integration/component filtering; revoked entries shown but not installable. (FR-001, FR-007)
- **Install & verify** : download a built artifact, verify catalog signature (ed25519) + artifact digest (sha256), unpack; plus a "tamper rejection" that fails closed. (FR-002, FR-003, NFR-001, US-005)
- **Uninstall** : a confirm-then-remove flow; any plugin (including seeded) is marketplace-managed and reinstallable. (FR-008)
- **Configure components** : how a project's components bind to an installed component plugin, with the bound plugin's schema-driven fields; the selector lists only installed component plugins. Shows the removed legacy "Role" toggle. (FR-010, US-006)

States:

- **Errored plugin** : the corrected banner surfacing the real `lastError`, with a before/after. (FR-012)
- **Offline / unreachable** : degrade to last-known catalog + seed cache, never zero plugins. (FR-009, NFR-003)

## Fidelity notes

Design language mined from the repo's `DESIGN.md` (warm stone neutral spine, single amber-500 accent, Inter UI + JetBrains Mono technical, whitespace-first, no shadows). This is a static reproduction, not wired to the real backend.
