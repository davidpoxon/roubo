# Roubo Design System

`schema_version: 1`. This file was reverse-engineered from the existing UI via `/ui-design:init`, then validated by `conform.py` (structural gate plus per-context WCAG AA contrast). Extracted values carry no marker; values supplied by a question because the repo held no source evidence are marked _(question-filled)_ next to where they appear, and listed in `filled_tokens[]` in the token block.

## Aesthetic direction

**Mood.** Warm, precise, minimalist craft. Named after André-Jacob Roubo (1739–1791), the master carpenter whose workbench is the gold standard of precision. Minimalist means fewer elements, not lesser elements: every element that exists must be perfect.

**References.** The roubo brand guide (`CLAUDE.md`, `docs/brand.md`), the Roubo workbench, and a warm stone foundation carrying a single amber accent.

**Chosen dimensions.**

- **Typography.** Inter for UI text, JetBrains Mono for code and technical values (ports, paths, commands). Hierarchy comes from weight, size, tracking, and opacity, not decoration.
- **Colour.** A warm stone neutral spine with one amber-500 accent for primary actions, active states, and focus indicators. Red for danger, green for success.
- **Hierarchy.** Whitespace and small coloured accent markers over divider lines.
- **Motion.** Delicate and purposeful, 150–300ms smooth easing, no bounce or overshoot.
- **Elevation.** Whitespace-first; shadows are deliberately avoided.

**Forbidden defaults.** The canonical deny-list is enforced, with one recorded exception: `Inter` was removed from this project's `forbidden_defaults` because Inter is roubo's deliberate, documented UI typeface (`CLAUDE.md`), not a lazy default. Every other canonical entry (`Roboto`, `Arial`, `Helvetica`, `system-ui default sans`, `Space Grotesk`, the cliché gradients and layouts, `drop-shadow on everything`, `emoji as iconography`) remains enforced.

## Colour

Faithfully extracted from ranked Tailwind utility usage. The neutral `stone` ramp is the spine (3,435 uses); `amber-500` is the single brand accent (443 uses); `red-500` is danger (338 uses); `green-500` is success. Two off-palette families surfaced during extraction (`violet`, ~16 uses; `emerald`, ~3 uses) and were dropped as incidental, not design tokens.

| Role             | Token spine                           | Notes                                                                                                                          |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Surface          | `white`, `stone-50`, `stone-100`      | App and panel backgrounds                                                                                                      |
| Border           | `stone-200`, `stone-300`              | Hairlines, input borders, dividers                                                                                             |
| Text (muted)     | `stone-400`, `stone-500`              | `stone-500` is the lightest that clears AA body on white (4.8:1); `stone-400` is for large/UI use, not body text               |
| Text (secondary) | `stone-600`                           | Secondary copy                                                                                                                 |
| Text             | `stone-700`                           | Body                                                                                                                           |
| Text (strong)    | `stone-800`, `stone-900`, `stone-950` | Headings, on-accent label                                                                                                      |
| Primary          | `amber-50` … `amber-800`              | **`amber-500` `#F59E0B`** is the accent anchor                                                                                 |
| Danger           | `red-50` … `red-900`                  | **`red-500` `#EF4444`**; `red-600` for danger text on white (4.83:1)                                                           |
| Success          | `green-50` … `green-800`              | **`green-500` `#22C55E`** is the status anchor; use `green-800` for success text on light surfaces (`green-600` fails AA body) |

Dark mode exists in the app via a `.dark` class variant, but no distinct per-mode colour pairs were extractable from utility usage, so no `-dark` sibling tokens were fabricated.

## Type

- **Family.** `Inter, system-ui, sans-serif` for UI text _(question-filled: only `--font-mono` was present in `@theme`; Inter confirmed from the brand guide)_. `JetBrains Mono` (extracted from `@theme --font-mono`) is the technical/monospace face for ports, paths, and commands.
- **Scale (px).** `12, 14, 16, 18, 20, 24, 30, 36` _(question-filled: Tailwind default text-size scale, inferred from the utility-based UI)_.
- **Weights.** `400, 500, 600, 700` _(question-filled)_.

## Spacing, radius & elevation

- **Spacing (px).** `4, 8, 12, 16, 24, 32, 48, 64` _(question-filled: Tailwind default spacing scale; the UI is built entirely on Tailwind utilities)_.
- **Radius (px).** `4, 6, 8, 12, 16` _(question-filled: Tailwind default radius scale)_.
- **Elevation.** Empty by design: nothing in the sweep used shadows, and the brand favours whitespace and accent markers over depth.

## Components

Interaction states for the secondary button, input field, and card are _(question-filled)_ (the repo defines styling through Tailwind utilities, not static `cva` variants, so no machine-readable state set existed). The **primary button** is code-evidenced, not question-filled: its states are taken from the live class set at `client/src/components/BenchCard.tsx:238`.

- **Primary button** (`primary action`). Container + label. `amber-500` background with a `stone-950` label (9.2:1). Hover `amber-400`, active `amber-600`, focus a 2px `amber-500` ring offset 2px, disabled at 30% opacity.
- **Secondary button** (`secondary action`). Container + label. `stone-100` background, `stone-700` label. Hover `stone-100`, active `stone-200`, focus a 2px `amber-500` ring, disabled `stone-100` background with `stone-300` label. _(question-filled)_
- **Input field** (`text input`). Container + value + placeholder. `stone-200` border, `stone-900` value, `stone-500` placeholder. Focus `amber-500` border and ring, hover `stone-300` border, active `amber-500` border, disabled `stone-100` background. _(question-filled)_
- **Card** (`container surface`). Container + content. `white` background, `stone-200` border. Hover `stone-300` border, active `stone-400` border, focus a 2px `amber-500` ring when interactive, disabled reduced opacity. _(question-filled)_

TestBench adds these components in Update mode (additive; they reference only existing tokens, no new colour/type/spacing tokens were introduced).

- **Status indicator** (`status indicator`). Dot + label (+ icon). A small filled status dot beside an always-present text label, never colour alone: `not_started` `stone-400` (muted), `in_progress` `amber-500` (the active accent), `passed` `green-500`, `failed` `red-500`, `blocked` `stone-700` with a blocked icon. Label is `stone-700` body. As an interactive filter chip: 2px `amber-500` focus ring, `stone-100` hover row, `stone-200` active, 30% disabled.
- **Observation mark control** (`pass/fail toggle`). A two-segment control: pass and fail. Unset: `stone-500` icons, `stone-200` border. Pass selected: `green-50` background, `green-800` icon/label, `green-600` border. Fail selected: `red-50` background, `red-700` icon/label, `red-600` border. Focus a 2px `amber-500` ring on the focused segment; hover `stone-100`; disabled `stone-100` background with `stone-300` icons. Fully keyboard-operable (NFR-004).
- **Status override control** (`status selector`). Trigger + value + override-marker, built on the input/select pattern. Lets the reviewer set any of the five statuses; an active override shows an `amber-500` marker distinct from the derived value. Focus `amber-500` border + ring, hover `stone-300` border, disabled `stone-100` background with `stone-400` value.
- **Progress bar** (`progress indicator`). A slim segmented track: `green-500` passed, `red-500` failed, `amber-500` in-progress, `stone-200` remaining, with a `stone-600` JetBrains Mono count label. Non-interactive (no focus/hover/active); 30% opacity when its level has no cases.
- **Attention banner** (`inline attention banner`). Container + message + action, used for the stale-results warning. `amber-50` background, `amber-200` border, `amber-800` message, with an action button (focus 2px `amber-500` ring, hover `amber-100`, active `amber-200`, 30% disabled). Amber signals "needs attention" consistent with the system's amber-for-active-states.
- **Timeline note entry** (`append-only log entry`). Meta + body. Append-only: no edit or delete affordance exists. Meta (author, timestamp, status-at-write) in `stone-500` JetBrains Mono; body in `stone-700`; a small status-at-write dot uses the matching status colour. Rendered chronologically in a right-side timeline rail; focus 2px `amber-500` ring when focusable, hover `stone-50`, active `stone-100`.

## Platform rules

One token layer drives both platforms; there is no per-platform token fork.

- **Web.** Breakpoints: mobile ≤480, tablet ~768, desktop ≥1024.
- **iOS (HIG, spec-only).** Large-title nav bar with a `stone-900` title on `stone-50`; tab bar with `amber-500` selected and `stone-400` unselected; respect top and bottom safe-area insets; map `type.scale` onto Dynamic Type text styles. Android/Material is a documented fast-follow, not part of v1.

## Tokens (machine-checkable)

<!-- ui-design:tokens v1 -->

```json
{
  "schema_version": 1,
  "colors": {
    "white": {
      "hex": "#FFFFFF",
      "role": "surface"
    },
    "stone-50": {
      "hex": "#FAFAF9",
      "role": "surface"
    },
    "stone-100": {
      "hex": "#F5F5F4",
      "role": "surface"
    },
    "stone-200": {
      "hex": "#E7E5E4",
      "role": "border"
    },
    "stone-300": {
      "hex": "#D6D3D1",
      "role": "border"
    },
    "stone-400": {
      "hex": "#A8A29E",
      "role": "text-muted"
    },
    "stone-500": {
      "hex": "#78716C",
      "role": "text-muted"
    },
    "stone-600": {
      "hex": "#57534E",
      "role": "text-secondary"
    },
    "stone-700": {
      "hex": "#44403C",
      "role": "text"
    },
    "stone-800": {
      "hex": "#292524",
      "role": "text-strong"
    },
    "stone-900": {
      "hex": "#1C1917",
      "role": "text-strong"
    },
    "stone-950": {
      "hex": "#0C0A09",
      "role": "text-strong"
    },
    "amber-50": {
      "hex": "#FFFBEB",
      "role": "primary"
    },
    "amber-100": {
      "hex": "#FEF3C7",
      "role": "primary"
    },
    "amber-200": {
      "hex": "#FDE68A",
      "role": "primary"
    },
    "amber-300": {
      "hex": "#FCD34D",
      "role": "primary"
    },
    "amber-400": {
      "hex": "#FBBF24",
      "role": "primary"
    },
    "amber-500": {
      "hex": "#F59E0B",
      "role": "primary"
    },
    "amber-600": {
      "hex": "#D97706",
      "role": "primary"
    },
    "amber-700": {
      "hex": "#B45309",
      "role": "primary"
    },
    "amber-800": {
      "hex": "#92400E",
      "role": "primary"
    },
    "red-50": {
      "hex": "#FEF2F2",
      "role": "danger"
    },
    "red-100": {
      "hex": "#FEE2E2",
      "role": "danger"
    },
    "red-200": {
      "hex": "#FECACA",
      "role": "danger"
    },
    "red-300": {
      "hex": "#FCA5A5",
      "role": "danger"
    },
    "red-400": {
      "hex": "#F87171",
      "role": "danger"
    },
    "red-500": {
      "hex": "#EF4444",
      "role": "danger"
    },
    "red-600": {
      "hex": "#DC2626",
      "role": "danger"
    },
    "red-700": {
      "hex": "#B91C1C",
      "role": "danger"
    },
    "red-800": {
      "hex": "#991B1B",
      "role": "danger"
    },
    "red-900": {
      "hex": "#7F1D1D",
      "role": "danger"
    },
    "green-50": {
      "hex": "#F0FDF4",
      "role": "success"
    },
    "green-200": {
      "hex": "#BBF7D0",
      "role": "success"
    },
    "green-300": {
      "hex": "#86EFAC",
      "role": "success"
    },
    "green-400": {
      "hex": "#4ADE80",
      "role": "success"
    },
    "green-500": {
      "hex": "#22C55E",
      "role": "success"
    },
    "green-600": {
      "hex": "#16A34A",
      "role": "success"
    },
    "green-800": {
      "hex": "#166534",
      "role": "success"
    }
  },
  "type": {
    "family": "Inter, system-ui, sans-serif",
    "scale": [12, 14, 16, 18, 20, 24, 30, 36],
    "weights": [400, 500, 600, 700]
  },
  "spacing": [4, 8, 12, 16, 24, 32, 48, 64],
  "radius": [4, 6, 8, 12, 16],
  "elevation": [],
  "components": [
    {
      "name": "Primary button",
      "anatomy": ["container", "label"],
      "states": {
        "focus": "2px amber-500 focus ring, offset 2px (ring-offset white / stone-950 dark)",
        "hover": "background amber-400",
        "active": "background amber-600",
        "disabled": "opacity 30%"
      },
      "role": "primary action",
      "token_refs": [
        "color.amber-500",
        "color.amber-400",
        "color.amber-600",
        "color.stone-950",
        "radius.2"
      ]
    },
    {
      "name": "Secondary button",
      "anatomy": ["container", "label"],
      "states": {
        "focus": "2px amber-500 focus ring, offset 2px",
        "hover": "background stone-100",
        "active": "background stone-200",
        "disabled": "background stone-100, label stone-300"
      },
      "role": "secondary action",
      "token_refs": [
        "color.stone-100",
        "color.stone-200",
        "color.stone-300",
        "color.stone-700",
        "color.amber-500",
        "radius.2"
      ]
    },
    {
      "name": "Input field",
      "anatomy": ["container", "value", "placeholder"],
      "states": {
        "focus": "border amber-500, 2px amber-500 ring",
        "hover": "border stone-300",
        "active": "border amber-500",
        "disabled": "background stone-100, value stone-400"
      },
      "role": "text input",
      "token_refs": [
        "color.stone-200",
        "color.stone-300",
        "color.stone-400",
        "color.stone-900",
        "color.amber-500",
        "color.stone-100",
        "radius.1"
      ]
    },
    {
      "name": "Card",
      "anatomy": ["container", "content"],
      "states": {
        "focus": "2px amber-500 focus ring when interactive",
        "hover": "border stone-300",
        "active": "border stone-400",
        "disabled": "opacity reduced, border stone-200"
      },
      "role": "container surface",
      "token_refs": [
        "color.white",
        "color.stone-200",
        "color.stone-300",
        "color.stone-400",
        "radius.3"
      ]
    },
    {
      "name": "Status indicator",
      "anatomy": ["dot", "label", "icon"],
      "states": {
        "focus": "2px amber-500 ring when used as an interactive filter chip, offset 2px",
        "hover": "row background stone-100 when interactive",
        "active": "row background stone-200 when interactive",
        "disabled": "opacity 30%"
      },
      "role": "status indicator",
      "token_refs": [
        "color.stone-400",
        "color.amber-500",
        "color.green-500",
        "color.red-500",
        "color.stone-700"
      ]
    },
    {
      "name": "Observation mark control",
      "anatomy": ["pass-segment", "fail-segment"],
      "states": {
        "focus": "2px amber-500 ring on the focused segment, offset 2px",
        "hover": "segment background stone-100",
        "active": "pass selected: green-50 background, green-800 icon/label, green-600 border; fail selected: red-50 background, red-700 icon/label, red-600 border",
        "disabled": "stone-100 background, stone-300 icon, not operable"
      },
      "role": "pass/fail toggle",
      "token_refs": [
        "color.green-50",
        "color.green-600",
        "color.green-800",
        "color.red-50",
        "color.red-600",
        "color.red-700",
        "color.stone-200",
        "color.stone-300",
        "color.stone-500",
        "color.amber-500"
      ]
    },
    {
      "name": "Status override control",
      "anatomy": ["trigger", "value", "override-marker"],
      "states": {
        "focus": "border amber-500, 2px amber-500 ring",
        "hover": "border stone-300",
        "active": "border amber-500; override-active shows an amber-500 marker distinct from the derived value",
        "disabled": "background stone-100, value stone-400"
      },
      "role": "status selector",
      "token_refs": [
        "color.stone-200",
        "color.stone-300",
        "color.stone-900",
        "color.amber-500",
        "color.stone-100",
        "color.stone-400"
      ]
    },
    {
      "name": "Progress bar",
      "anatomy": [
        "track",
        "passed-segment",
        "failed-segment",
        "in-progress-segment",
        "count-label"
      ],
      "states": {
        "focus": "not focusable (decorative readout)",
        "hover": "no hover affordance",
        "active": "no active state (non-interactive)",
        "disabled": "opacity 30% when its level has no cases"
      },
      "role": "progress indicator",
      "token_refs": [
        "color.green-500",
        "color.red-500",
        "color.amber-500",
        "color.stone-200",
        "color.stone-600"
      ]
    },
    {
      "name": "Attention banner",
      "anatomy": ["container", "message", "action"],
      "states": {
        "focus": "2px amber-500 ring on the action, offset 2px",
        "hover": "action background amber-100",
        "active": "action background amber-200",
        "disabled": "opacity 30%"
      },
      "role": "inline attention banner",
      "token_refs": [
        "color.amber-50",
        "color.amber-100",
        "color.amber-200",
        "color.amber-800",
        "color.amber-500",
        "color.stone-700"
      ]
    },
    {
      "name": "Timeline note entry",
      "anatomy": ["meta", "body"],
      "states": {
        "focus": "2px amber-500 ring when the entry is focusable, offset 2px",
        "hover": "background stone-50",
        "active": "background stone-100",
        "disabled": "opacity 30%"
      },
      "role": "append-only log entry",
      "token_refs": [
        "color.stone-500",
        "color.stone-700",
        "color.green-500",
        "color.red-500",
        "color.amber-500",
        "color.stone-400"
      ]
    }
  ],
  "platforms": [
    {
      "platform": "web",
      "web_breakpoints": {
        "mobile": 480,
        "tablet": 768,
        "desktop": 1024
      }
    },
    {
      "platform": "ios",
      "ios_hig": {
        "nav": "large-title nav bar, stone-900 title on stone-50",
        "tab_bar": "amber-500 selected, stone-400 unselected",
        "safe_area": "respect top/bottom insets",
        "dynamic_type": "map type.scale to Dynamic Type text styles"
      }
    }
  ],
  "aesthetic": {
    "mood": "Warm, precise, minimalist craft. The Roubo workbench: every element perfect, nothing decorative.",
    "references": [
      "roubo CLAUDE.md brand guide",
      "docs/brand.md",
      "Andre-Jacob Roubo workbench (1739-1791)",
      "warm stone foundation with a single amber accent"
    ],
    "forbidden_defaults": [
      "Roboto",
      "Arial",
      "Helvetica",
      "system-ui default sans",
      "Space Grotesk",
      "purple-on-white gradient",
      "purple-to-blue gradient",
      "indigo-to-violet gradient",
      "800px centered card on gray",
      "single centered column",
      "predictable hero-over-three-cards",
      "drop-shadow on everything",
      "emoji as iconography"
    ],
    "chosen_dimensions": {
      "typography": "Inter for UI text, JetBrains Mono for code and technical values (ports, paths, commands)",
      "color": "Warm stone neutral spine with a single amber-500 accent for primary actions, active states, and focus; red danger, green success",
      "hierarchy": "Whitespace and colored accent markers over divider lines; weight/size/opacity over decoration",
      "motion": "Delicate, purposeful, 150-300ms smooth easing; no bounce or overshoot",
      "elevation": "Whitespace-first; shadows avoided"
    }
  },
  "filled_tokens": [
    {
      "key": "type.family",
      "filled_by": "question",
      "asked": "UI/body font (only JetBrains Mono was extracted)?",
      "note": "Inter confirmed as deliberate brand standard per CLAUDE.md; 'Inter' removed from this project's forbidden_defaults with recorded rationale. JetBrains Mono extracted from @theme --font-mono is the technical/mono face."
    },
    {
      "key": "type.scale",
      "filled_by": "question",
      "asked": "Type scale (none in @theme)?",
      "note": "Tailwind default text-size scale inferred from the utility-based UI; not literally extracted."
    },
    {
      "key": "type.weights",
      "filled_by": "question",
      "asked": "Font weights (none extracted)?",
      "note": "Standard 400/500/600/700 weights."
    },
    {
      "key": "spacing",
      "filled_by": "question",
      "asked": "Spacing scale (none in @theme)?",
      "note": "Tailwind default spacing scale; the UI is built on Tailwind utilities."
    },
    {
      "key": "radius",
      "filled_by": "question",
      "asked": "Radius scale (none in @theme)?",
      "note": "Tailwind default radius scale."
    },
    {
      "key": "Secondary button.states",
      "filled_by": "question",
      "asked": "Secondary button interaction states (no cva found)?",
      "note": "Stone-based with amber-500 focus ring."
    },
    {
      "key": "Input field.states",
      "filled_by": "question",
      "asked": "Input field interaction states (no cva found)?",
      "note": "amber-500 focus border/ring; stone borders."
    },
    {
      "key": "Card.states",
      "filled_by": "question",
      "asked": "Card interaction states (no cva found)?",
      "note": "Stone borders; amber-500 focus when interactive."
    }
  ]
}
```
