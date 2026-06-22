# Verify gate prototype

Standalone, static, `file://`-openable mock of the verify-gate UI surface. No
build, no server, no backend: open `index.html` in a browser.

It reproduces Roubo's `DESIGN.md` design language (warm stone spine, `amber-500`
accent, Inter UI + JetBrains Mono for technical values, the TestBench status
dots, segmented progress bar, and attention banner) statically via the Tailwind
Play CDN.

## Screens / journeys

- **Batches overview** (FR-001, US-001): phase-aligned gates across a spec
  (Phase 1 passed, Phase 2 verifying, Phase 3 blocked).
- **Verify a batch** (FR-008, FR-012, US-003): the gating subset (L1/L2 + e2e),
  pass/fail observation marks that live-update the deterministic gate state
  (pending / failed / passed / stale), the gate-state panel with unresolved
  cases and their covering units, and the close-gate-and-unblock action.
- **Failed case to fix issue** (FR-009, FR-010, US-006): capture notes +
  evidence on a failed case, file a tracker fix issue wired to block the gate,
  including the create-then-link partial-failure recovery (NFR-003).
- **Hard start-gate** (FR-006, NFR-003, US-002): a bench start refused with
  `409 GATE_BLOCKED` when the upstream gate is unpassed, and `409
GATE_INDETERMINATE` (fail-closed) when blocking state cannot be determined.

## Demo levers

- Mark cases pass/fail to drive the gate state and the close action.
- "Simulate plan change (stale)" toggles the planHash-mismatch stale state.
- The enforcement ON/OFF toggle (top bar) and the start-gate "plugin
  unavailable" checkbox demonstrate the fail-closed behavior.

All data is mock; nothing leaves the page.
