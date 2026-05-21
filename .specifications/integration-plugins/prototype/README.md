# Prototype: integration-plugins

Plain-language mockups of every user-facing surface introduced by this slug. Per Roubo's CLAUDE.md guidance ("use concrete plain-language descriptions and mockups; avoid abstract ASCII diagrams"), each screen is described in concrete terms: layout, components used, copy, state transitions, error states.

## Files

- `mockups.md` — every screen in this slug, organised by user story.
- `prototype-notes.md` (at slug root) — design decisions made during this stage, open questions for architecture, screenshots if/when produced.

## How to read

Each section in `mockups.md` is keyed to one or more `US-NNN` from `prd.md`. Within a section: layout description, component-by-component breakdown, state machine for that screen, and explicit copy strings. Components reference Roubo's existing primitives (React Aria `Button`, `Dialog`, `TextField`, `Checkbox`, `Tooltip`, `MultiSelect`) and follow the design language in `docs/brand.md`.

## What is NOT here

- Pixel-perfect designs or Figma frames.
- HTML / JSX implementations.
- Visual mockups.

If those are needed before architecture begins, raise it as a checkpoint follow-up; this stage was scoped to plain-language mockups.
