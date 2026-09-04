# Roubo Design System

`schema_version: 4`. Reverse-engineered from the existing UI by `/ui-design:init`, then validated by `conform.py`: the structural seed gate plus per-context WCAG AA contrast across sixteen background contexts, light and dark. Values carrying a `file:line` in `roubo/` are extracted and unmarked. Values that came from a question because the repo held no source evidence are marked _(question-filled)_ where they appear and listed in `filled_tokens[]` in the token block.

**Where the values came from.** Three sources, in order of authority. `extract.py` swept the repo and ranked 99 Tailwind colour utilities by usage. A supplementary survey of `dark:` variants supplied the light/dark pairs, because `extract.py` resolves only bare utilities and returned `mode: "none"` for all 99 while the client carries 2,781 `dark:` variants. `docs/brand.md` supplied the semantic names (`--roubo-bg-base`, `--roubo-text-secondary`, `--roubo-accent`), which the survey independently agreed with on every pair.

## Aesthetic direction

**Mood.** Warm, precise, minimalist craft. Named after André-Jacob Roubo (1739-1791), the master carpenter whose workbench is the standard of precision. Minimalist means fewer elements, not lesser elements.

**References.** `docs/brand.md`, the Roubo workbench, and aged brass tool hardware, which is where the single amber accent comes from.

**Chosen dimensions.**

- **Typography.** Inter for interface text, JetBrains Mono for anything a developer might copy: ports, paths, branch names, commands. Hierarchy comes from weight, size, and opacity, never from underlines, backgrounds, or borders on text.
- **Colour.** A warm stone spine (3,518 utility uses) carrying one amber accent (544), red for danger (357), and green for success (41).
- **Motion.** Colour transitions on state change. No bounce, and no overshoot easing is recorded, which is why the `motion.primitives.easings` set deliberately omits one.
- **Elevation.** Shadow is reserved for surfaces that genuinely float: dialogs, popovers, tooltips. Flat surfaces stay flat.

**Forbidden defaults.** The canonical deny-list is enforced with one recorded exception: `Inter` is removed, because Inter is roubo's deliberate, documented interface typeface (`docs/brand.md`, Typography), not a lazy default. Every other canonical entry stands.

## Colour

The block records the palette twice, deliberately. The **scale keys** (`stone-400`, `amber-500`, `red-950`) are the ramp exactly as the utilities spell it, so any shade the code uses resolves. The **semantic keys** are `docs/brand.md`'s own names, and they are where dark mode lives: each carries a `-dark` sibling holding its dark-mode value.

Clustering preserved every step of the stone ramp (adjacent ΔE 0.05 and above, well clear of the 0.02 merge threshold) and proposed no cross-role merges. Tier-1 utility-prefix inference resolved every cluster at high confidence; the value-bucketing fallback never fired. Two off-palette families were dropped as incidental: `violet-400` (6 uses, one mono label) and `emerald-100/400/700` (1 use each, a single badge).

| Role | Light | Dark | Notes |
| --- | --- | --- | --- |
| Page ground | `bg-base` stone-50 | stone-950 | The app shell |
| Panel / card ground | `bg-surface` white | stone-900 | 77 paired uses, the dominant surface pair |
| Raised / hover ground | `bg-hover` stone-100 | stone-800 | 68 paired uses |
| Border | `border` stone-200 | stone-800 | 209 paired uses, the most consistent pair in the app |
| Heading text | `text-primary` stone-900 | stone-100 | 17.49:1 light, 16.03:1 dark |
| Body text | `text-body` stone-700 | stone-300 | 10.27:1 light, 11.74:1 dark |
| Secondary text | `text-secondary` stone-500 | stone-400 | 4.80:1 light, 6.93:1 dark |
| Secondary on raised | `text-secondary-raised` stone-600 | stone-300 | 6.99:1; secondary steps one shade darker on the stone-100 ground |
| Accent | `accent` amber-500 | same | Primary actions, active tabs, every focus ring |
| Danger | `danger` red-500, `danger-text` red-600 | red-400 | `danger-callout-text` red-700 on the callout ground, 5.91:1 |
| Success | `success` green-500, `success-text` green-800 | green-400 | |
| Idle status | `idle` stone-300 | stone-700 | Bench border when nothing is running |

**One accent, one alpha.** `accent-muted` is the single alpha-bearing token: amber-500 at 15%, as `docs/brand.md` specifies for subtle accent grounds.

**The muted tier is a recorded correction, not an extraction.** The app's most-used text colour is `text-stone-400`, at 631 uses, and it measures **2.52:1** on white; its dark counterpart `stone-600` on `stone-900` measures **2.29:1**. Both fail AA for text. `color.text-muted` is therefore recorded at the nearest AA-clearing shade, stone-500 light and stone-400 dark _(question-filled)_, which makes it identical in value to `text-secondary`; the two tiers have deliberately converged. The extracted shades remain in the block as `color.stone-400` and `color.stone-600` with no text role, so existing code still resolves. **Roughly 900 call sites currently diverge from this record**, and a later `ui-design:apply` run will report every one of them.

`on-danger` is recorded as white (4.83:1) rather than the stone-100 the code uses on `danger-hover` (4.43:1) _(question-filled)_, for the same reason.

## Type

- **Interface.** Inter, at weights 400, 500, 600, 700. `font-medium` (304 uses) and `font-semibold` (138) carry almost all the hierarchy.
- **Mono.** JetBrains Mono, the one family the repo declares as a real token (`@theme --font-mono`, `client/src/globals.css:5`).
- **Scale (px).** `10, 12, 14, 16, 18`, taken from live utility usage: `text-sm` (317), `text-xs` (308), the literal `text-[10px]` (122), `text-base` (7), `text-lg` (3). `docs/brand.md` specifies 11px and 13px instead; the code is recorded as authoritative and the divergence is noted here rather than reconciled away.
- **Metrics.** `line_height` and `letter_spacing` are sparse and parallel to the scale: the 10px step is set solid with wide tracking (the uppercase sidebar labels, `tracking-wider`, 43 uses), and the 12px and 14px steps carry the relaxed leading used for prose (107 uses). The 16px and 18px steps carry no recorded metric because the UI barely uses them.

## Spacing, radius & elevation

- **Spacing (px).** `1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32`, from padding, gap, and ring utilities. The 1px and 2px steps exist so `ring_width` and `ring_offset`, which must resolve into the spacing scale, can name real ring measures.
- **Radius (px).** `2, 4, 6, 8, 12, 9999`. `rounded-lg` (294) is the workhorse, `rounded-xl` (71) frames cards and dialogs, and `rounded-full` (98) is the status dot and the pill.
- **Elevation.** Four recipes, for the four shadows in live use: `shadow-sm` (2 uses), `shadow-lg` (19), `shadow-xl` (10), `shadow-2xl` (43). No `elevation_dark` is recorded, because the repo does not vary its shadows by mode. This corrects the previous `DESIGN.md`, which recorded elevation as empty by design.
- **Border width.** `hairline` 1px is the default rule; `thick` 2px is the focus ring and the rare emphasised border.

## Components

Nine components, each lifted from a live class set rather than question-filled. `roubo` has no `cva` and no shared `ui/` primitives, so every spec is anchored to the component that defines it.

- **Primary button** (`client/src/components/BenchCard.tsx:238`). Amber ground, near-black label at 9.20:1, hover to `accent-hover`, press to `accent-active`, a two-pixel accent ring at a two-pixel offset, and the faint opacity level when disabled.
- **Ghost icon button** (`BenchCard.tsx:239`). Unpainted until hover, when a stone wash fills behind the icon.
- **Danger button** (`BenchCard.tsx:319`). Red ground, white label. The focus ring stays accent, not red: focus colour is one thing in this system.
- **Input field** (`DirectoryPicker.tsx:90`). The one control that rings in stone rather than accent, at one pixel.
- **Bench card** (`BenchCard.tsx:103`). An inset hairline ring rather than a border, so the hover ground change does not shift layout.
- **Dialog** (`BenchCard.tsx:277`). White on a hairline border at `elevation.3`, the deepest recipe.
- **Issue chip** (`IssueChip.tsx:45-51`). The 10px step, medium weight, ringed at a one-pixel offset because the chip is small.
- **Status dot** (`ComponentStatusDot.tsx:4-24`). Always paired with a text label, never colour alone. Carries `motion.status-pulse` while a component is starting.
- **Tooltip** (`BenchCard.tsx:246`). Inverted: stone-900 ground, stone-100 label, and it still appears for a disabled trigger, which is how the reason gets read.

## Motion

Four transitions and four keyframes, all extracted. `transition-colors` at 150ms is the spine, at 397 uses; `duration-200` (13), `duration-100` (5), and `duration-300` (4) fill in around it. The keyframes are the two declared in `client/src/globals.css` (`status-pulse`, `tab-fade-in`) plus Tailwind's `spin` and `pulse`.

Every entry carries `reduced: "none"`, which is not an assumption: `globals.css:36` already gates `tab-fade-in` behind `prefers-reduced-motion: no-preference`.

## Opacity

Six named levels, from `disabled:opacity-*` usage. `disabled` 0.4 is the common case (42 uses), `faint` 0.3 is the primary and ghost buttons (11), `muted` 0.5 (38) and `subtle` 0.6 (8) carry press and hover dimming.

**No `layout` family is recorded.** `#root` is `position: fixed; inset: 0` (`globals.css`), so the app has no page content measure; every `max-w-*` in the tree is a dialog width. Recording one would give the renderers a width the product does not have.

## Platform rules

One token layer, one platform. roubo ships as an Electron desktop app, so `platforms[]` carries `web` alone; the previous `DESIGN.md` recorded an iOS HIG mapping for a platform the product does not target, and that has been dropped.

Breakpoints `mobile 480 / tablet 768 / desktop 1024` are _(question-filled)_: the client uses only 13 responsive prefixes in total, so no breakpoints are expressed in source and these are recorded as a convention.

## Tokens (machine-checkable)

<!-- ui-design:tokens v4 -->

```json
{
  "schema_version": 4,
  "colors": {
    "amber-50": {"hex": "#FFFBEB", "role": "primary"},
    "amber-100": {"hex": "#FEF3C7", "role": "primary"},
    "amber-200": {"hex": "#FDE68A", "role": "primary"},
    "amber-300": {"hex": "#FCD34D", "role": "primary"},
    "amber-400": {"hex": "#FBBF24", "role": "primary"},
    "amber-500": {"hex": "#F59E0B", "role": "primary"},
    "amber-600": {"hex": "#D97706", "role": "primary"},
    "amber-700": {"hex": "#B45309", "role": "primary"},
    "amber-800": {"hex": "#92400E", "role": "primary"},
    "amber-900": {"hex": "#78350F", "role": "primary"},
    "green-50": {"hex": "#F0FDF4", "role": "success"},
    "green-200": {"hex": "#BBF7D0", "role": "success"},
    "green-300": {"hex": "#86EFAC", "role": "success"},
    "green-400": {"hex": "#4ADE80", "role": "success"},
    "green-500": {"hex": "#22C55E", "role": "success"},
    "green-600": {"hex": "#16A34A", "role": "success"},
    "green-700": {"hex": "#15803D", "role": "success"},
    "green-800": {"hex": "#166534", "role": "success"},
    "red-50": {"hex": "#FEF2F2", "role": "danger"},
    "red-100": {"hex": "#FEE2E2", "role": "danger"},
    "red-200": {"hex": "#FECACA", "role": "danger"},
    "red-300": {"hex": "#FCA5A5", "role": "danger"},
    "red-400": {"hex": "#F87171", "role": "danger"},
    "red-500": {"hex": "#EF4444", "role": "danger"},
    "red-600": {"hex": "#DC2626", "role": "danger"},
    "red-700": {"hex": "#B91C1C", "role": "danger"},
    "red-800": {"hex": "#991B1B", "role": "danger"},
    "red-900": {"hex": "#7F1D1D", "role": "danger"},
    "stone-50": {"hex": "#FAFAF9", "role": "surface"},
    "stone-100": {"hex": "#F5F5F4", "role": "text"},
    "stone-200": {"hex": "#E7E5E4", "role": "border"},
    "stone-300": {"hex": "#D6D3D1", "role": "text"},
    "stone-400": {"hex": "#A8A29E", "role": "text"},
    "stone-500": {"hex": "#78716C", "role": "text"},
    "stone-600": {"hex": "#57534E", "role": "text"},
    "stone-700": {"hex": "#44403C", "role": "text"},
    "stone-800": {"hex": "#292524", "role": "border"},
    "stone-900": {"hex": "#1C1917", "role": "text"},
    "stone-950": {"hex": "#0C0A09", "role": "text"},
    "white": {"hex": "#FFFFFF", "role": "surface"},
    "amber-950": {"hex": "#451A03", "role": "primary"},
    "red-950": {"hex": "#450A0A", "role": "danger"},
    "green-900": {"hex": "#14532D", "role": "success"},
    "green-950": {"hex": "#052E16", "role": "success"},
    "bg-base": {"hex": "#FAFAF9", "role": "surface"},
    "bg-base-dark": {"hex": "#0C0A09", "role": "surface"},
    "bg-surface": {"hex": "#FFFFFF", "role": "surface"},
    "bg-surface-dark": {"hex": "#1C1917", "role": "surface"},
    "bg-hover": {"hex": "#F5F5F4", "role": "surface"},
    "bg-hover-dark": {"hex": "#292524", "role": "surface"},
    "bg-hover-strong": {"hex": "#E7E5E4", "role": "surface"},
    "bg-hover-strong-dark": {"hex": "#44403C", "role": "surface"},
    "border": {"hex": "#E7E5E4", "role": "border"},
    "border-dark": {"hex": "#292524", "role": "border"},
    "border-strong": {"hex": "#D6D3D1", "role": "border"},
    "border-strong-dark": {"hex": "#44403C", "role": "border"},
    "text-primary": {"hex": "#1C1917", "role": "text-strong"},
    "text-primary-dark": {"hex": "#F5F5F4", "role": "text-strong"},
    "text-body": {"hex": "#44403C", "role": "text"},
    "text-body-dark": {"hex": "#D6D3D1", "role": "text"},
    "text-secondary": {"hex": "#78716C", "role": "text-secondary"},
    "text-secondary-dark": {"hex": "#A8A29E", "role": "text-secondary"},
    "text-muted": {"hex": "#78716C", "role": "text-muted"},
    "text-muted-dark": {"hex": "#A8A29E", "role": "text-muted"},
    "accent": {"hex": "#F59E0B", "role": "primary"},
    "accent-hover": {"hex": "#FBBF24", "role": "primary"},
    "accent-active": {"hex": "#D97706", "role": "primary"},
    "accent-text": {"hex": "#92400E", "role": "text-accent"},
    "accent-text-dark": {"hex": "#FDE68A", "role": "text-accent"},
    "accent-surface": {"hex": "#FFFBEB", "role": "surface-accent"},
    "accent-surface-dark": {"hex": "#451A03", "role": "surface-accent"},
    "accent-border": {"hex": "#FDE68A", "role": "border-accent"},
    "accent-border-dark": {"hex": "#78350F", "role": "border-accent"},
    "focus-ring": {"hex": "#F59E0B", "role": "focus-ring"},
    "on-accent": {"hex": "#0C0A09", "role": "text-on-accent"},
    "danger": {"hex": "#EF4444", "role": "danger"},
    "danger-hover": {"hex": "#DC2626", "role": "danger"},
    "danger-text": {"hex": "#DC2626", "role": "text-danger"},
    "danger-text-dark": {"hex": "#F87171", "role": "text-danger"},
    "danger-surface": {"hex": "#FEF2F2", "role": "surface-danger"},
    "danger-surface-dark": {"hex": "#450A0A", "role": "surface-danger"},
    "danger-border": {"hex": "#FECACA", "role": "border-danger"},
    "danger-border-dark": {"hex": "#7F1D1D", "role": "border-danger"},
    "on-danger": {"hex": "#FFFFFF", "role": "text-on-danger"},
    "success": {"hex": "#22C55E", "role": "success"},
    "success-text": {"hex": "#166534", "role": "text-success"},
    "success-text-dark": {"hex": "#4ADE80", "role": "text-success"},
    "success-surface": {"hex": "#F0FDF4", "role": "surface-success"},
    "success-surface-dark": {"hex": "#052E16", "role": "surface-success"},
    "success-border": {"hex": "#BBF7D0", "role": "border-success"},
    "success-border-dark": {"hex": "#14532D", "role": "border-success"},
    "idle": {"hex": "#D6D3D1", "role": "status-idle"},
    "idle-dark": {"hex": "#44403C", "role": "status-idle"},
    "tooltip-bg": {"hex": "#1C1917", "role": "surface-inverted"},
    "tooltip-bg-dark": {"hex": "#292524", "role": "surface-inverted"},
    "tooltip-text": {"hex": "#F5F5F4", "role": "text-inverted"},
    "tooltip-text-dark": {"hex": "#E7E5E4", "role": "text-inverted"},
    "accent-muted": {"hex": "#F59E0B", "role": "primary", "alpha": 0.15},
    "text-secondary-raised": {"hex": "#57534E", "role": "text-secondary"},
    "text-secondary-raised-dark": {"hex": "#D6D3D1", "role": "text-secondary"},
    "danger-callout-text": {"hex": "#B91C1C", "role": "text-danger"},
    "danger-callout-text-dark": {"hex": "#FCA5A5", "role": "text-danger"}
  },
  "type": {
    "family": "Inter, system-ui, -apple-system, sans-serif",
    "scale": [10, 12, 14, 16, 18],
    "weights": [400, 500, 600, 700],
    "line_height": [1, 1.625, 1.625, null, null],
    "letter_spacing": ["0.05em", null, null, null, null],
    "fonts": {
      "display": {"name": "Inter", "stack": "Inter, system-ui, -apple-system, sans-serif"},
      "mono": {
        "name": "JetBrains Mono",
        "stack": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Courier New\", monospace"
      }
    }
  },
  "spacing": [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32],
  "radius": [2, 4, 6, 8, 12, 9999],
  "elevation": [
    "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
    "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    "0 25px 50px -12px rgb(0 0 0 / 0.25)"
  ],
  "border_width": {"hairline": 1, "thick": 2},
  "opacity": {"hidden": 0, "faint": 0.3, "disabled": 0.4, "muted": 0.5, "subtle": 0.6, "full": 1},
  "motion": {
    "primitives": {
      "durations": {"instant": "100ms", "fast": "150ms", "standard": "200ms", "slow": "300ms"},
      "easings": {
        "standard": "cubic-bezier(0.4, 0, 0.2, 1)",
        "decelerate": "cubic-bezier(0, 0, 0.2, 1)",
        "accelerate": "cubic-bezier(0.4, 0, 1, 1)",
        "emphasized": "cubic-bezier(0.4, 0, 0.2, 1)"
      }
    },
    "transitions": {
      "colors": {
        "duration": "motion.duration.fast",
        "easing": "motion.easing.standard",
        "properties": ["color", "background-color", "border-color"],
        "reduced": "none"
      },
      "opacity": {"duration": "motion.duration.fast", "easing": "motion.easing.standard", "properties": ["opacity"], "reduced": "none"},
      "transform": {
        "duration": "motion.duration.standard",
        "easing": "motion.easing.decelerate",
        "properties": ["transform"],
        "reduced": "none"
      },
      "all": {"duration": "motion.duration.standard", "easing": "motion.easing.standard", "properties": ["all"], "reduced": "none"}
    },
    "keyframes": {
      "spin": {"properties": ["transform"], "keyframes": "rotate(0deg) -> rotate(360deg)", "reduced": "none"},
      "pulse": {"properties": ["opacity"], "keyframes": "opacity 1 -> 0.5 -> 1", "reduced": "none"},
      "status-pulse": {"properties": ["opacity"], "keyframes": "opacity 1 -> 0.25 -> 1, looping", "reduced": "none"},
      "tab-fade-in": {
        "properties": ["opacity", "transform"],
        "keyframes": "opacity 0 -> 1 with translateY(5px) -> translateY(0)",
        "reduced": "none"
      }
    }
  },
  "components": [
    {
      "name": "Primary button",
      "role": "primary action",
      "states": {
        "focus": "a two-pixel accent ring, offset, drawn outside the frame so nothing shifts",
        "hover": "container background moves to accent-hover",
        "active": "container background moves to accent-active",
        "disabled": "container drops to the faint opacity level and stops responding to pointer and key"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.accent", "radius": "radius.2", "padding": "space.3"},
          "arrangement": {"kind": "row", "gap": "space.2", "align": "center"},
          "state_deltas": {
            "hover": {"background": "color.accent-hover"},
            "active": {"background": "color.accent-active"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.faint"}
          },
          "children": [
            {"name": "icon", "archetype": "icon", "bindings": {"color": "color.on-accent", "size": "space.6"}},
            {
              "name": "label",
              "archetype": "text",
              "sample": "Start bench",
              "bindings": {"color": "color.on-accent", "font_size": "type.scale.2", "font_weight": "type.weights.1"}
            }
          ]
        }
      ]
    },
    {
      "name": "Ghost icon button",
      "role": "tertiary icon action",
      "states": {
        "focus": "a two-pixel accent ring, offset, on an otherwise unpainted frame",
        "hover": "a stone wash fills behind the icon and the icon itself darkens to body text",
        "active": "the same wash, held",
        "disabled": "drops to the faint opacity level, no wash on hover"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "label": "Stop all components",
          "bindings": {"radius": "radius.2", "padding": "space.3"},
          "state_deltas": {
            "hover": {"background": "color.bg-hover-strong"},
            "active": {"background": "color.bg-hover-strong"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.faint"}
          },
          "children": [{"name": "icon", "archetype": "icon", "bindings": {"color": "color.text-secondary", "size": "space.6"}}]
        }
      ]
    },
    {
      "name": "Danger button",
      "role": "destructive action",
      "states": {
        "focus": "a two-pixel accent ring, offset; the accent stays the focus colour even on a red control",
        "hover": "container lightens from danger-hover to danger",
        "active": "container holds at danger",
        "disabled": "container drops to the disabled opacity level"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.danger-hover", "radius": "radius.3", "padding": "space.4"},
          "arrangement": {"kind": "row", "gap": "space.2", "align": "center"},
          "state_deltas": {
            "hover": {"background": "color.danger"},
            "active": {"background": "color.danger"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {
              "name": "label",
              "archetype": "text",
              "sample": "Clear bench",
              "bindings": {"color": "color.on-danger", "font_size": "type.scale.2", "font_weight": "type.weights.1"}
            }
          ]
        }
      ]
    },
    {
      "name": "Input field",
      "role": "text input",
      "states": {
        "focus": "a one-pixel neutral ring; this control is the one place the system rings in stone rather than accent",
        "hover": "border moves to border-strong",
        "active": "the focus ring is held while the caret is in the field",
        "disabled": "the field drops to the disabled opacity level and the caret never lands"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {
            "background": "color.bg-hover",
            "border": "color.border-strong",
            "border_width": "border_width.hairline",
            "radius": "radius.3",
            "padding": "space.6"
          },
          "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
          "state_deltas": {
            "focus": {"ring_color": "color.border-strong", "ring_width": "space.0"},
            "hover": {"border": "color.border-strong"},
            "active": {"ring_color": "color.border-strong", "ring_width": "space.0"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {
              "name": "value",
              "archetype": "text",
              "sample": "/Users/you/Developer/roubo",
              "bindings": {"color": "color.text-primary", "font_size": "type.scale.2"}
            },
            {
              "name": "placeholder",
              "archetype": "text",
              "sample": "/path/to/your/repo",
              "bindings": {"color": "color.text-muted", "font_size": "type.scale.2"}
            }
          ]
        }
      ]
    },
    {
      "name": "Bench card",
      "role": "container surface for one bench",
      "states": {
        "focus": "a two-pixel accent ring, offset, replacing the inset hairline",
        "hover": "the card ground moves one step up the stone ramp; the inset hairline is unchanged",
        "active": "the hover ground is held while the card is being opened",
        "disabled": "the whole card drops to the disabled opacity level while it clears"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "container",
          "bindings": {
            "background": "color.bg-hover",
            "radius": "radius.4",
            "padding": "space.7",
            "ring_color": "color.border",
            "ring_width": "space.0"
          },
          "arrangement": {"kind": "column", "gap": "space.4", "align": "stretch"},
          "state_deltas": {
            "hover": {"background": "color.bg-hover-strong"},
            "active": {"background": "color.bg-hover-strong"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {
              "name": "head",
              "archetype": "container",
              "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
              "children": [
                {
                  "name": "status-dot",
                  "archetype": "custom",
                  "label": "running",
                  "bindings": {"background": "color.success", "radius": "radius.5"}
                },
                {
                  "name": "title",
                  "archetype": "text",
                  "sample": "feat/verify-gate",
                  "bindings": {"color": "color.text-primary", "font_size": "type.scale.2", "font_weight": "type.weights.2"}
                }
              ]
            },
            {
              "name": "path",
              "archetype": "text",
              "sample": "~/Developer/roubo/.benches/feat-verify-gate",
              "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_family": "type.fonts.mono"}
            },
            {
              "name": "rule",
              "archetype": "divider",
              "bindings": {"color": "color.border", "thickness": "border_width.hairline"}
            }
          ]
        }
      ]
    },
    {
      "name": "Dialog",
      "role": "modal surface",
      "states": {
        "focus": "a two-pixel accent ring, offset, on the first focusable child; the dialog frame itself is not focusable",
        "hover": "the surface does not react to the pointer",
        "active": "the surface does not react to press",
        "disabled": "a dialog is never disabled; it is dismissed"
      },
      "motion_refs": ["motion.opacity"],
      "parts": [
        {
          "name": "frame",
          "archetype": "surface",
          "bindings": {
            "background": "color.bg-surface",
            "border": "color.border",
            "border_width": "border_width.hairline",
            "radius": "radius.4",
            "padding": "space.7",
            "elevation": "elevation.3"
          },
          "arrangement": {"kind": "column", "gap": "space.4", "align": "stretch"},
          "state_deltas": {"focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"}},
          "children": [
            {
              "name": "title",
              "archetype": "text",
              "sample": "Clear this bench?",
              "bindings": {"color": "color.text-primary", "font_size": "type.scale.3", "font_weight": "type.weights.2"}
            },
            {
              "name": "body",
              "archetype": "text",
              "sample": "Uncommitted changes in the worktree will be discarded.",
              "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}
            }
          ]
        }
      ]
    },
    {
      "name": "Issue chip",
      "role": "compact metadata chip",
      "states": {
        "focus": "a two-pixel accent ring at a one-pixel offset, tight to the chip",
        "hover": "the chip brightens; the tone colour is unchanged",
        "active": "the chip settles to the muted opacity level",
        "disabled": "the chip drops to the disabled opacity level and stops being pressable"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.accent-surface", "color": "color.accent-text", "radius": "radius.1", "padding": "space.3"},
          "arrangement": {"kind": "row", "gap": "space.2", "align": "center"},
          "state_deltas": {
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.0"},
            "hover": {"opacity": "opacity.subtle"},
            "active": {"opacity": "opacity.muted"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {"name": "icon", "archetype": "icon", "bindings": {"color": "color.accent-text", "size": "space.5"}},
            {
              "name": "label",
              "archetype": "text",
              "sample": "#1019",
              "bindings": {"color": "color.accent-text", "font_size": "type.scale.0", "font_weight": "type.weights.1"}
            }
          ]
        }
      ]
    },
    {
      "name": "Status dot",
      "role": "status indicator",
      "states": {
        "focus": "not focusable on its own; the dot is always paired with a text label, never colour alone",
        "hover": "no change; the label already carries the meaning",
        "active": "no change",
        "disabled": "drops to the disabled opacity level when the component is stopped"
      },
      "motion_refs": ["motion.status-pulse"],
      "parts": [
        {
          "name": "row",
          "archetype": "container",
          "arrangement": {"kind": "row", "gap": "space.2", "align": "center"},
          "state_deltas": {"disabled": {"opacity": "opacity.disabled"}},
          "children": [
            {
              "name": "dot",
              "archetype": "custom",
              "label": "running",
              "bindings": {"background": "color.success", "radius": "radius.5"}
            },
            {
              "name": "label",
              "archetype": "text",
              "sample": "running",
              "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1"}
            }
          ]
        }
      ]
    },
    {
      "name": "Tooltip",
      "role": "hover tooltip",
      "states": {
        "focus": "appears on keyboard focus of its trigger, not only on hover",
        "hover": "appears after a short delay on its trigger",
        "active": "dismissed on press of the trigger",
        "disabled": "a disabled trigger still shows its tooltip, which is how the reason is read"
      },
      "motion_refs": ["motion.opacity"],
      "parts": [
        {
          "name": "frame",
          "archetype": "surface",
          "bindings": {"background": "color.tooltip-bg", "radius": "radius.2", "padding": "space.4", "elevation": "elevation.1"},
          "children": [
            {
              "name": "label",
              "archetype": "text",
              "sample": "Start all components on this bench",
              "bindings": {"color": "color.tooltip-text", "font_size": "type.scale.1"}
            }
          ]
        }
      ]
    }
  ],
  "platforms": [{"platform": "web", "web_breakpoints": {"mobile": 480, "tablet": 768, "desktop": 1024}}],
  "aesthetic": {
    "mood": "Warm, precise, minimalist craft: a warm stone foundation carrying a single aged-brass accent, hierarchy built from weight and opacity rather than decoration.",
    "references": [
      "docs/brand.md, the roubo brand guide",
      "the Roubo workbench: precision joinery, no ornament",
      "aged brass tool hardware (the amber accent)"
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
      "emoji as iconography",
      "isoluminant value hues",
      "uniformly muted palette"
    ],
    "chosen_dimensions": {
      "typography": "Inter for interface text, JetBrains Mono for any value a developer might copy: ports, paths, branch names, commands.",
      "colour": "A warm stone neutral spine (3,518 utility uses) with one amber accent (544), red for danger (357) and green for success (41).",
      "hierarchy": "Weight, size and opacity; never underlines, backgrounds or borders on text.",
      "motion": "Colour transitions on state change, no bounce and no overshoot easing.",
      "elevation": "Shadow is reserved for surfaces that genuinely float: dialogs, popovers and tooltips. Flat surfaces stay flat."
    }
  },
  "filled_tokens": [
    {
      "key": "color.text-muted",
      "filled_by": "question",
      "asked": "The muted text tier fails WCAG AA in both modes. How should DESIGN.md record it?",
      "note": "Extraction found stone-400 (2.52:1 on white, 631 uses). User chose the AA-clearing shade stone-500 (4.80:1); the extracted value stays recorded as color.stone-400 with no text role."
    },
    {
      "key": "color.text-muted-dark",
      "filled_by": "question",
      "asked": "The muted text tier fails WCAG AA in both modes. How should DESIGN.md record it?",
      "note": "Extraction found stone-600 (2.29:1 on stone-900, 268 paired uses). User chose the AA-clearing shade stone-400 (6.93:1)."
    },
    {
      "key": "color.on-danger",
      "filled_by": "question",
      "asked": "Applied consistently with the muted-tier AA decision above.",
      "note": "The danger button label is stone-100 on red-600, 4.43:1, just under AA. Recorded as white (4.83:1)."
    },
    {
      "key": "platforms.web.web_breakpoints",
      "filled_by": "question",
      "asked": "Which platform rules should DESIGN.md carry?",
      "note": "roubo is a fixed-viewport Electron shell (#root is position:fixed inset:0) with only 13 responsive prefixes app-wide, so no breakpoints are expressed in source. The standard web thresholds are recorded as a convention, not an extraction."
    }
  ]
}
```
