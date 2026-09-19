# Roubo Design System

`schema_version: 4`. This file is the target the interface is built to, not a survey of what the code currently does. Where the client and this file disagree, the client is wrong. Values are chosen, then validated by `conform.py` and by a per-ground WCAG contrast pass in both themes. `docs/brand.md` owns vocabulary, voice, logo, and philosophy; this file owns every value.

## Aesthetic direction

**Mood.** Warm, precise, minimalist craft. Named after André-Jacob Roubo (1739-1791), the master carpenter whose workbench is the standard of precision. Minimalist means fewer elements, not lesser elements: every token below is load-bearing, and there is one of each.

**References.** The Roubo workbench (precision joinery, nothing ornamental), aged brass tool hardware (the single amber accent), and engineering drawings and tool catalogues (constructed letterforms, tabular figures, measured labels).

**Chosen dimensions.**

- **Typography.** IBM Plex Sans for interface text: an engineered sans with squared terminals and visibly constructed joins, the typographic equivalent of a tight joint. JetBrains Mono for the material itself, meaning anything a developer might copy: ports, paths, branch names, commands. Hierarchy comes from weight, size, and three text tones, never from underlines, backgrounds, or borders on text.
- **Colour.** Warm stone grounds, designed dark first because dark is the default theme. One amber accent. Red and green appear only as status and consequence. The type is cool and exact; the palette carries the warmth.
- **Motion.** Colour on state change, one short rise for surfaces that enter, one pulse for work in progress. Ease-out, 150-300ms, no bounce, no overshoot.
- **Elevation.** Borders and ground steps carry depth. Shadow is reserved for surfaces that float: menus, tooltips, dialogs. In dark mode a shadow is nearly invisible, so every floating surface also carries a hairline border.

**Forbidden defaults.** The canonical deny-list stands in full, `Inter` included. Project additions: any `gradient`; the cool neutrals (`zinc-`, `slate-`, `gray-`, `neutral-`), which are near-duplicates of stone; `wood texture`; `confetti`, `bounce`, and `overshoot`; and `transition-all`, which animates layout properties nobody chose to animate.

## Colour

The block records **roles, not shades**. There are no scale keys such as `stone-400`: a raw palette utility in the client names no token and is a finding for `ui-design:apply`. Each role's light value sits under the canonical key and its dark value under a `-dark` sibling; `design-tokens/semantic-dark.css` points the base variable at the sibling under `.dark`, so one utility (`text-text-secondary`) covers both themes and call sites carry no `dark:` pair.

| Role | Token | Dark | Light |
| --- | --- | --- | --- |
| App ground | `bg-base` | stone-950 | stone-50 |
| Panel, card, dialog, menu | `bg-surface` | stone-900 | white |
| Input ground (inset in dark) | `bg-field` | stone-950 | white |
| Hover wash | `bg-hover` | stone-800 | stone-100 |
| Pressed wash | `bg-pressed` | stone-700 | stone-200 |
| Tooltip ground | `bg-inverse`, `text-on-inverse` | stone-700, stone-100 | stone-900, stone-100 |
| Modal scrim | `scrim` | stone-950 at 60% | same |
| Separator | `border` | stone-800 | stone-200 |
| Emphasised separator, button outline | `border-strong` | stone-700 | stone-300 |
| Input and checkbox boundary | `border-control` | stone-500 | stone-500 |
| Heading text | `text-primary` | stone-100 | stone-900 |
| Body text | `text-body` | stone-300 | stone-700 |
| Labels, metadata, placeholder | `text-secondary` | stone-400 | stone-600 |
| Primary action, selected indicator | `accent`, `accent-hover`, `accent-active`, `on-accent` | amber-500, 400, 600, stone-950 | same |
| Accent text and its ground | `accent-text` on `accent-muted` (amber-500 at 15%), `accent-border` (at 40%) | amber-200 | amber-800 |
| Focus | `focus-ring` | amber-500 | amber-700 |
| Destructive fill | `danger`, `danger-hover`, `danger-active`, `on-danger` | red-600, 700, 800, white | same |
| Failure message | `danger-text`, `danger-surface`, `danger-border` | red-400, red-950, red-900 | red-700, red-50, red-200 |
| Success message | `success-text`, `success-surface`, `success-border` | green-400, green-950, green-900 | green-800, green-50, green-200 |
| Bench and component status | `status-active`, `status-preparing`, `status-error`, `status-idle` | green-500, amber-500, red-500, stone-600 | green-600, amber-600, red-600, stone-400 |

**Three text tones, and each clears AA on every ground.** `text-secondary` is the lowest tone and measures 6.99:1 or better on base, surface, and hover in light, and 6.01:1 or better in dark, so no tone needs a per-ground variant and there is no fourth "muted" tier. Placeholder text uses `text-secondary`. Disabled content is not a tone: it is the whole control at `opacity.disabled`. On `bg-pressed`, secondary text steps up to `text-body`.

**One accent, two jobs kept apart.** `accent` fills primary actions and marks the selected tab. Work in progress is `status-preparing`, its own token, so a bench that is preparing and a button that starts it never share a meaning even where they share a hue. Amber is reserved for these two: no categorical set uses it.

**Focus is one colour everywhere**, on red controls and in inputs alike, and it is tuned per ground: amber-500 is 8.14:1 on the dark surface but 2.15:1 on white, so light mode rings in amber-700 (5.02:1 on white, 4.60:1 on the hover ground).

**Status always carries its label.** The light status values clear 3:1 on the card surface (3.30, 3.19, 4.83). `status-idle` is deliberately quiet, because idle is the absence of status.

**Boundaries that must be found clear 3:1.** `border-control` is the one line that does, at 4.80:1 on white and 3.65:1 on the dark surface. `border` and `border-strong` are separators and never the only cue to a control.

**Categorical hues appear only where the hue identifies something**, and are tuned per ground: the 600 step on light, the 400 step on dark, so a dot holds 3:1 against its surface in both themes.

- **Issue chip tones**, a 15% tint (20% in dark) with a text pair: `issue-open` (emerald), `issue-milestone` (indigo), `issue-type` (violet), and the outlined `issue-label` (cyan). The lowest pair is `issue-label-text` at 4.91:1 on the light hover ground.
- **Agent kind pill**: `kind-agent-surface`, `-border`, `-text` (sky).
- **Agent swatches** `agent-swatch-1` to `-6`: violet, cyan, emerald, lime, rose, sky. Dots and glyphs only, never text.
- **Project status** `project-status-in-progress`, `-ready`, `-todo`: blue, fuchsia, cyan. Dots only.

Success is `green`, never emerald; emerald is the open-issue tone.

## Type

- **Interface.** IBM Plex Sans at 400, 500, 600. Weight 700 exists for the ROUBO wordmark alone. Figures are tabular wherever numbers align in a column.
- **Mono.** JetBrains Mono at 400 and 500, inheriting the size of its context.
- **Both families are vendored** and served from the app. A desktop app never fetches a font from the network.
- **Scale (px).** `11, 12, 13, 14, 16, 20`. 13 is interface text. 11 is labels, counts, and status. 12 is mono metadata and tooltips. 14 is card titles, 16 dialog titles, 20 page titles. Nothing is set below 11.
- **Metrics.** Leading runs from 1.45 at 11px to 1.3 at 20px. The 11px step is tracked at 0.12em for uppercase section labels; sentence-case 11px text (status, counts) is set at normal tracking, and the wordmark at 0.2em. The 20px step tightens to -0.01em.

## Spacing, radius & elevation

- **Spacing (px).** `1, 2, 4, 6, 8, 12, 14, 16, 20, 24, 32`. Layout uses 4 and up. 1 and 2 exist for rings and hairlines, and 14 exists for icons, because ring and icon measures resolve into this scale.
- **Icons.** Lucide only, at 14 by default, 12 inside chips and dense rows, 16 in section headers.
- **Control padding.** A `padding` binding on a button or field records the block padding; the inline padding is double it.
- **Radius (px).** `4, 6, 12, 9999`: chips and menu items, every control and small popover, cards and dialogs, dots and pills. All buttons share one radius.
- **Elevation.** Two recipes, each with a dark sibling: `elevation.0` under menus and tooltips, `elevation.1` under dialogs. Light shadows are tinted with stone-900 rather than black, so they stay warm.
- **Border width.** `hairline` 1px for every rule and border; `thick` 2px for the selected-tab indicator.

## Components

Fourteen components. Each spec is the contract; none is anchored to a source line, because the code follows the spec.

- **Primary button.** Amber ground, stone-950 label at 9.20:1. At most one per view.
- **Secondary button.** Surface ground with a `border-strong` outline. The default action style.
- **Ghost icon button.** Unpainted until hover. Always has a tooltip, which still appears when the button is disabled.
- **Danger button.** Red ground, white label, darkening on hover and press (4.83, 6.47, 8.31:1). Only inside a confirming dialog.
- **Input field.** `bg-field` with the `border-control` boundary. Focus takes the focus hue on the border plus a tight ring. It carries a fifth state, `invalid`. Paths and commands typed into it are mono.
- **Tabs.** The selected tab is primary text over a 2px accent indicator; the rest are secondary text. Entering tab content uses `motion.rise-in`.
- **Nav item.** The selected destination sits on `accent-muted` in `accent-text`.
- **Bench card.** The border is the bench status, as `docs/brand.md` defines it. The card rests on `bg-surface` and its hover changes the ground only, so nothing shifts.
- **Status indicator.** Dot plus label, never the dot alone. Pulses with `motion.status-pulse` while preparing or clearing.
- **Issue chip.** Tinted with its own tone; the spec shows the `issue-type` tone and the other three swap the two colour bindings.
- **Callout.** The inline home of `danger-text`: states the cause, then the fix. The success variant swaps the three `success-*` tokens.
- **Menu.** A floating surface at `elevation.0`; items take a wash, never a border.
- **Dialog.** Surface at `elevation.1` over the scrim, one decision per dialog, actions right-aligned with the consequential one last.
- **Tooltip.** The inverse surface. It still appears for a disabled trigger, which is how the reason gets read.

**Which token when.** A ground is always a `bg-*` token and text on it is always one of the three text tones or a paired `*-text`. `accent` is never text. `danger` is never decoration. A `status-*` colour never appears without its label. A categorical hue never carries text.

## Motion

Three durations (`fast` 150ms, `standard` 200ms, `slow` 300ms) and two easings: `standard`, a crisp ease-out with no overshoot, and `accelerate` for exits. Three transitions (`colors`, `opacity`, `exit`) and three keyframes (`spin`, `status-pulse`, `rise-in`). `rise-in` runs once, at `standard`, on anything that enters: tab content, menus, dialogs.

Reduced motion is a rule, not an observation: under `prefers-reduced-motion: reduce`, transitions resolve instantly and every keyframe is suppressed, including the looping ones. A suppressed `status-pulse` leaves a static dot beside its label, which already carries the meaning.

## Opacity

One level: `disabled` at 0.4, applied to the whole control. Hover and press are colour changes, never dimming.

**No `layout` family is recorded.** `#root` is `position: fixed; inset: 0`, so the app has no page content measure; every `max-w-*` in the tree is a dialog width.

## Platform rules

One token layer, one platform. Roubo ships as an Electron desktop app, so `platforms[]` carries `web` alone, and no breakpoints are recorded: the window is a fixed viewport of inner scrolling panes, not a responsive page.

## Tokens (machine-checkable)

<!-- ui-design:tokens v4 -->

```json
{
  "schema_version": 4,
  "colors": {
    "bg-base": {"hex": "#FAFAF9", "role": "surface"}, "bg-base-dark": {"hex": "#0C0A09", "role": "surface"},
    "bg-surface": {"hex": "#FFFFFF", "role": "surface"}, "bg-surface-dark": {"hex": "#1C1917", "role": "surface"},
    "bg-field": {"hex": "#FFFFFF", "role": "surface"}, "bg-field-dark": {"hex": "#0C0A09", "role": "surface"},
    "bg-hover": {"hex": "#F5F5F4", "role": "surface"}, "bg-hover-dark": {"hex": "#292524", "role": "surface"},
    "bg-pressed": {"hex": "#E7E5E4", "role": "surface"}, "bg-pressed-dark": {"hex": "#44403C", "role": "surface"},
    "bg-inverse": {"hex": "#1C1917", "role": "surface-inverse"}, "bg-inverse-dark": {"hex": "#44403C", "role": "surface-inverse"},
    "scrim": {"hex": "#0C0A09", "role": "scrim", "alpha": 0.6},
    "border": {"hex": "#E7E5E4", "role": "border"}, "border-dark": {"hex": "#292524", "role": "border"},
    "border-strong": {"hex": "#D6D3D1", "role": "border"}, "border-strong-dark": {"hex": "#44403C", "role": "border"},
    "border-control": {"hex": "#78716C", "role": "border-control"},
    "text-primary": {"hex": "#1C1917", "role": "text-strong"}, "text-primary-dark": {"hex": "#F5F5F4", "role": "text-strong"},
    "text-body": {"hex": "#44403C", "role": "text"}, "text-body-dark": {"hex": "#D6D3D1", "role": "text"},
    "text-secondary": {"hex": "#57534E", "role": "text-secondary"}, "text-secondary-dark": {"hex": "#A8A29E", "role": "text-secondary"},
    "text-on-inverse": {"hex": "#F5F5F4", "role": "text-inverse"},
    "accent": {"hex": "#F59E0B", "role": "primary"},
    "accent-hover": {"hex": "#FBBF24", "role": "primary"},
    "accent-active": {"hex": "#D97706", "role": "primary"},
    "on-accent": {"hex": "#0C0A09", "role": "text-on-accent"},
    "accent-text": {"hex": "#92400E", "role": "text-accent"}, "accent-text-dark": {"hex": "#FDE68A", "role": "text-accent"},
    "accent-muted": {"hex": "#F59E0B", "role": "surface-accent", "alpha": 0.15},
    "accent-border": {"hex": "#F59E0B", "role": "border-accent", "alpha": 0.4},
    "focus-ring": {"hex": "#B45309", "role": "focus-ring"}, "focus-ring-dark": {"hex": "#F59E0B", "role": "focus-ring"},
    "danger": {"hex": "#DC2626", "role": "danger"},
    "danger-hover": {"hex": "#B91C1C", "role": "danger"},
    "danger-active": {"hex": "#991B1B", "role": "danger"},
    "on-danger": {"hex": "#FFFFFF", "role": "text-on-danger"},
    "danger-text": {"hex": "#B91C1C", "role": "text-danger"}, "danger-text-dark": {"hex": "#F87171", "role": "text-danger"},
    "danger-surface": {"hex": "#FEF2F2", "role": "surface-danger"}, "danger-surface-dark": {"hex": "#450A0A", "role": "surface-danger"},
    "danger-border": {"hex": "#FECACA", "role": "border-danger"}, "danger-border-dark": {"hex": "#7F1D1D", "role": "border-danger"},
    "success-text": {"hex": "#166534", "role": "text-success"}, "success-text-dark": {"hex": "#4ADE80", "role": "text-success"},
    "success-surface": {"hex": "#F0FDF4", "role": "surface-success"}, "success-surface-dark": {"hex": "#052E16", "role": "surface-success"},
    "success-border": {"hex": "#BBF7D0", "role": "border-success"}, "success-border-dark": {"hex": "#14532D", "role": "border-success"},
    "status-active": {"hex": "#16A34A", "role": "status"}, "status-active-dark": {"hex": "#22C55E", "role": "status"},
    "status-preparing": {"hex": "#D97706", "role": "status"}, "status-preparing-dark": {"hex": "#F59E0B", "role": "status"},
    "status-error": {"hex": "#DC2626", "role": "status"}, "status-error-dark": {"hex": "#EF4444", "role": "status"},
    "status-idle": {"hex": "#A8A29E", "role": "status"}, "status-idle-dark": {"hex": "#57534E", "role": "status"},
    "issue-open": {"hex": "#10B981", "role": "surface-issue", "alpha": 0.15}, "issue-open-dark": {"hex": "#10B981", "role": "surface-issue", "alpha": 0.2},
    "issue-open-text": {"hex": "#065F46", "role": "text-issue"}, "issue-open-text-dark": {"hex": "#6EE7B7", "role": "text-issue"},
    "issue-milestone": {"hex": "#6366F1", "role": "surface-issue", "alpha": 0.15}, "issue-milestone-dark": {"hex": "#6366F1", "role": "surface-issue", "alpha": 0.2},
    "issue-milestone-text": {"hex": "#4338CA", "role": "text-issue"}, "issue-milestone-text-dark": {"hex": "#A5B4FC", "role": "text-issue"},
    "issue-type": {"hex": "#8B5CF6", "role": "surface-issue", "alpha": 0.15}, "issue-type-dark": {"hex": "#8B5CF6", "role": "surface-issue", "alpha": 0.2},
    "issue-type-text": {"hex": "#6D28D9", "role": "text-issue"}, "issue-type-text-dark": {"hex": "#C4B5FD", "role": "text-issue"},
    "issue-label-border": {"hex": "#06B6D4", "role": "border-issue", "alpha": 0.4},
    "issue-label-text": {"hex": "#0E7490", "role": "text-issue"}, "issue-label-text-dark": {"hex": "#67E8F9", "role": "text-issue"},
    "kind-agent-surface": {"hex": "#F0F9FF", "role": "surface-kind-agent"}, "kind-agent-surface-dark": {"hex": "#082F49", "role": "surface-kind-agent", "alpha": 0.2},
    "kind-agent-border": {"hex": "#BAE6FD", "role": "border-kind-agent"}, "kind-agent-border-dark": {"hex": "#0C4A6E", "role": "border-kind-agent", "alpha": 0.4},
    "kind-agent-text": {"hex": "#075985", "role": "text-kind-agent"}, "kind-agent-text-dark": {"hex": "#BAE6FD", "role": "text-kind-agent"},
    "agent-swatch-1": {"hex": "#7C3AED", "role": "swatch-agent"}, "agent-swatch-1-dark": {"hex": "#A78BFA", "role": "swatch-agent"},
    "agent-swatch-2": {"hex": "#0891B2", "role": "swatch-agent"}, "agent-swatch-2-dark": {"hex": "#22D3EE", "role": "swatch-agent"},
    "agent-swatch-3": {"hex": "#059669", "role": "swatch-agent"}, "agent-swatch-3-dark": {"hex": "#34D399", "role": "swatch-agent"},
    "agent-swatch-4": {"hex": "#65A30D", "role": "swatch-agent"}, "agent-swatch-4-dark": {"hex": "#A3E635", "role": "swatch-agent"},
    "agent-swatch-5": {"hex": "#E11D48", "role": "swatch-agent"}, "agent-swatch-5-dark": {"hex": "#FB7185", "role": "swatch-agent"},
    "agent-swatch-6": {"hex": "#0284C7", "role": "swatch-agent"}, "agent-swatch-6-dark": {"hex": "#38BDF8", "role": "swatch-agent"},
    "project-status-in-progress": {"hex": "#2563EB", "role": "swatch-project-status"}, "project-status-in-progress-dark": {"hex": "#60A5FA", "role": "swatch-project-status"},
    "project-status-ready": {"hex": "#C026D3", "role": "swatch-project-status"}, "project-status-ready-dark": {"hex": "#E879F9", "role": "swatch-project-status"},
    "project-status-todo": {"hex": "#0891B2", "role": "swatch-project-status"}, "project-status-todo-dark": {"hex": "#22D3EE", "role": "swatch-project-status"}
  },
  "type": {
    "family": "\"IBM Plex Sans\", system-ui, -apple-system, sans-serif",
    "scale": [11, 12, 13, 14, 16, 20],
    "weights": [400, 500, 600, 700],
    "line_height": [1.45, 1.5, 1.5, 1.45, 1.4, 1.3],
    "letter_spacing": ["0.12em", null, null, null, null, "-0.01em"],
    "fonts": {
      "display": {"name": "IBM Plex Sans", "stack": "\"IBM Plex Sans\", system-ui, -apple-system, sans-serif", "faces": [
        {"file": "client/src/assets/fonts/ibm-plex-sans-latin-400-normal.woff2", "weight": "400", "style": "normal"},
        {"file": "client/src/assets/fonts/ibm-plex-sans-latin-500-normal.woff2", "weight": "500", "style": "normal"},
        {"file": "client/src/assets/fonts/ibm-plex-sans-latin-600-normal.woff2", "weight": "600", "style": "normal"},
        {"file": "client/src/assets/fonts/ibm-plex-sans-latin-700-normal.woff2", "weight": "700", "style": "normal"}
      ]},
      "mono": {"name": "JetBrains Mono", "stack": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", "faces": [
        {"file": "client/src/assets/fonts/jetbrains-mono-latin-400-normal.woff2", "weight": "400", "style": "normal"},
        {"file": "client/src/assets/fonts/jetbrains-mono-latin-500-normal.woff2", "weight": "500", "style": "normal"}
      ]}
    }
  },
  "spacing": [1, 2, 4, 6, 8, 12, 14, 16, 20, 24, 32],
  "radius": [4, 6, 12, 9999],
  "elevation": ["0 8px 24px -6px rgb(28 25 23 / 0.16), 0 2px 6px -2px rgb(28 25 23 / 0.08)", "0 24px 48px -12px rgb(28 25 23 / 0.28)"],
  "elevation_dark": ["0 8px 24px -6px rgb(0 0 0 / 0.6), 0 2px 6px -2px rgb(0 0 0 / 0.4)", "0 24px 48px -12px rgb(0 0 0 / 0.7)"],
  "border_width": {"hairline": 1, "thick": 2},
  "opacity": {"disabled": 0.4},
  "motion": {
    "primitives": {"durations": {"fast": "150ms", "standard": "200ms", "slow": "300ms"}, "easings": {"standard": "cubic-bezier(0.2, 0, 0, 1)", "accelerate": "cubic-bezier(0.3, 0, 1, 1)"}},
    "transitions": {
      "colors": {"duration": "motion.duration.fast", "easing": "motion.easing.standard", "properties": ["color", "background-color", "border-color", "outline-color"], "reduced": {"duration": "0ms"}},
      "opacity": {"duration": "motion.duration.fast", "easing": "motion.easing.standard", "properties": ["opacity"], "reduced": {"duration": "0ms"}},
      "exit": {"duration": "motion.duration.fast", "easing": "motion.easing.accelerate", "properties": ["opacity"], "reduced": {"duration": "0ms"}}
    },
    "keyframes": {
      "spin": {"properties": ["transform"], "keyframes": "rotate(0deg) -> rotate(360deg), linear, looping", "reduced": "none"},
      "status-pulse": {"properties": ["opacity"], "keyframes": "opacity 1 -> 0.25 -> 1 over two seconds, looping", "reduced": "none"},
      "rise-in": {"properties": ["opacity", "transform"], "keyframes": "opacity 0 -> 1 with translateY(4px) -> translateY(0), once, at duration.standard on easing.standard", "reduced": "none"}
    }
  },
  "components": [
    {
      "name": "Primary button",
      "role": "primary action, at most one per view",
      "states": {
        "focus": "two-pixel focus ring at a two-pixel offset, outside the frame",
        "hover": "ground lightens to accent-hover",
        "active": "ground darkens to accent-active",
        "disabled": "whole control drops to the disabled opacity and ignores pointer and key"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.accent", "radius": "radius.1", "padding": "space.3"},
          "arrangement": {"kind": "row", "gap": "space.3", "align": "center"},
          "state_deltas": {
            "hover": {"background": "color.accent-hover"},
            "active": {"background": "color.accent-active"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {"name": "icon", "archetype": "icon", "bindings": {"color": "color.on-accent", "size": "space.6"}},
            {"name": "label", "archetype": "text", "sample": "Start", "bindings": {"color": "color.on-accent", "font_size": "type.scale.2", "font_weight": "type.weights.1"}}
          ]
        }
      ]
    },
    {
      "name": "Secondary button",
      "role": "neutral action beside or instead of a primary",
      "states": {"focus": "two-pixel focus ring at a two-pixel offset", "hover": "ground moves to bg-hover", "active": "ground moves to bg-pressed", "disabled": "whole control drops to the disabled opacity"},
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.bg-surface", "border": "color.border-strong", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.3"},
          "arrangement": {"kind": "row", "gap": "space.3", "align": "center"},
          "state_deltas": {
            "hover": {"background": "color.bg-hover"},
            "active": {"background": "color.bg-pressed"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [{"name": "label", "archetype": "text", "sample": "Stop", "bindings": {"color": "color.text-body", "font_size": "type.scale.2", "font_weight": "type.weights.1"}}]
        }
      ]
    },
    {
      "name": "Ghost icon button",
      "role": "tertiary icon action inside a dense row",
      "states": {
        "focus": "two-pixel focus ring at a two-pixel offset on an otherwise unpainted frame",
        "hover": "a bg-hover wash fills behind the icon",
        "active": "the wash deepens to bg-pressed",
        "disabled": "drops to the disabled opacity, no wash; its tooltip still explains why"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "label": "Stop all components",
          "bindings": {"radius": "radius.1", "padding": "space.3"},
          "state_deltas": {
            "hover": {"background": "color.bg-hover"},
            "active": {"background": "color.bg-pressed"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [{"name": "icon", "archetype": "icon", "bindings": {"color": "color.text-secondary", "size": "space.6"}}]
        }
      ]
    },
    {
      "name": "Danger button",
      "role": "destructive action, only inside a confirming dialog",
      "states": {
        "focus": "two-pixel focus ring at a two-pixel offset; focus stays the accent hue even on red",
        "hover": "ground darkens to danger-hover",
        "active": "ground darkens again to danger-active",
        "disabled": "whole control drops to the disabled opacity"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.danger", "radius": "radius.1", "padding": "space.3"},
          "arrangement": {"kind": "row", "gap": "space.3", "align": "center"},
          "state_deltas": {
            "hover": {"background": "color.danger-hover"},
            "active": {"background": "color.danger-active"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [{"name": "label", "archetype": "text", "sample": "Clear bench", "bindings": {"color": "color.on-danger", "font_size": "type.scale.2", "font_weight": "type.weights.1"}}]
        }
      ]
    },
    {
      "name": "Input field",
      "role": "single-line text input",
      "states": {
        "focus": "border takes the focus hue and a two-pixel focus ring sits tight to the frame",
        "hover": "no change; the field reacts to focus, not to the pointer",
        "active": "the focus treatment holds while the caret is in the field",
        "disabled": "the field drops to the disabled opacity and the caret never lands",
        "invalid": "border takes the danger hue; the message below is danger-text"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.bg-field", "border": "color.border-control", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.4"},
          "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
          "state_deltas": {
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "border": "color.focus-ring"},
            "active": {"ring_color": "color.focus-ring", "ring_width": "space.1", "border": "color.focus-ring"},
            "invalid": {"border": "color.danger"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {"name": "value", "archetype": "text", "sample": "~/Developer/roubo", "bindings": {"color": "color.text-primary", "font_size": "type.scale.2", "font_family": "type.fonts.mono"}},
            {"name": "placeholder", "archetype": "text", "sample": "/path/to/your/repo", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.2", "font_family": "type.fonts.mono"}}
          ]
        }
      ]
    },
    {
      "name": "Tabs",
      "role": "switch between sibling views of one surface",
      "states": {
        "focus": "two-pixel focus ring tight to the tab",
        "hover": "an unselected label steps up from secondary to primary text",
        "active": "the pressed tab takes a bg-hover wash",
        "disabled": "the tab drops to the disabled opacity and is skipped by arrow keys"
      },
      "motion_refs": ["motion.colors", "motion.rise-in"],
      "parts": [
        {
          "name": "list",
          "archetype": "container",
          "arrangement": {"kind": "row", "gap": "space.7", "align": "end"},
          "children": [
            {
              "name": "tab-selected",
              "archetype": "control",
              "bindings": {"padding": "space.3", "radius": "radius.0"},
              "arrangement": {"kind": "column", "gap": "space.2", "align": "stretch"},
              "state_deltas": {"focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}},
              "children": [
                {"name": "label", "archetype": "text", "sample": "Components", "bindings": {"color": "color.text-primary", "font_size": "type.scale.2", "font_weight": "type.weights.1"}},
                {"name": "indicator", "archetype": "divider", "bindings": {"color": "color.accent", "thickness": "border_width.thick"}}
              ]
            },
            {
              "name": "tab",
              "archetype": "control",
              "bindings": {"padding": "space.3", "radius": "radius.0", "color": "color.text-secondary"},
              "state_deltas": {"hover": {"color": "color.text-primary"}, "active": {"background": "color.bg-hover"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}},
              "children": [{"name": "label", "archetype": "text", "sample": "Inspections", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.2", "font_weight": "type.weights.1"}}]
            }
          ]
        }
      ]
    },
    {
      "name": "Nav item",
      "role": "sidebar destination",
      "states": {
        "focus": "two-pixel focus ring tight to the row",
        "hover": "row takes a bg-hover wash",
        "active": "the selected row sits on accent-muted with accent-text and medium weight",
        "disabled": "row drops to the disabled opacity"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "row",
          "archetype": "control",
          "bindings": {"radius": "radius.1", "padding": "space.3"},
          "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
          "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.accent-muted"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}},
          "children": [
            {"name": "icon", "archetype": "icon", "bindings": {"color": "color.text-secondary", "size": "space.6"}},
            {"name": "label", "archetype": "text", "sample": "roubo-plugins", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}},
            {"name": "count", "archetype": "text", "sample": "3", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1"}}
          ]
        }
      ]
    },
    {
      "name": "Bench card",
      "role": "container surface for one bench; its border is the bench status",
      "states": {
        "focus": "two-pixel focus ring at a two-pixel offset around the card",
        "hover": "ground moves to bg-hover; the status border is unchanged",
        "active": "the hover ground holds while the bench opens",
        "disabled": "the whole card drops to the disabled opacity while the bench clears"
      },
      "motion_refs": ["motion.colors", "motion.status-pulse"],
      "parts": [
        {
          "name": "frame",
          "archetype": "container",
          "bindings": {"background": "color.bg-surface", "border": "color.status-active", "border_width": "border_width.hairline", "radius": "radius.2", "padding": "space.7"},
          "arrangement": {"kind": "column", "gap": "space.5", "align": "stretch"},
          "state_deltas": {
            "hover": {"background": "color.bg-hover"},
            "active": {"background": "color.bg-hover"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {
              "name": "head",
              "archetype": "container",
              "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
              "children": [
                {"name": "dot", "archetype": "custom", "label": "active", "bindings": {"background": "color.status-active", "radius": "radius.3"}},
                {"name": "title", "archetype": "text", "sample": "Bench 2", "bindings": {"color": "color.text-primary", "font_size": "type.scale.3", "font_weight": "type.weights.2"}},
                {"name": "status", "archetype": "text", "sample": "active", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1"}}
              ]
            },
            {"name": "workspace", "archetype": "text", "sample": "feat/verify-gate", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_family": "type.fonts.mono"}},
            {"name": "rule", "archetype": "divider", "bindings": {"color": "color.border", "thickness": "border_width.hairline"}},
            {
              "name": "component",
              "archetype": "container",
              "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
              "children": [
                {"name": "dot", "archetype": "custom", "label": "active", "bindings": {"background": "color.status-active", "radius": "radius.3"}},
                {"name": "name", "archetype": "text", "sample": "backend", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}},
                {"name": "port", "archetype": "text", "sample": ":3021", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_family": "type.fonts.mono"}}
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "Status indicator",
      "role": "status of a bench or component; the dot never appears without its label",
      "states": {"focus": "not focusable; it describes its parent", "hover": "no change; the label already carries the meaning", "active": "no change", "disabled": "drops to the disabled opacity when its parent is disabled"},
      "motion_refs": ["motion.status-pulse"],
      "parts": [
        {
          "name": "row",
          "archetype": "container",
          "arrangement": {"kind": "row", "gap": "space.3", "align": "center"},
          "state_deltas": {"disabled": {"opacity": "opacity.disabled"}},
          "children": [
            {"name": "dot", "archetype": "custom", "label": "preparing", "bindings": {"background": "color.status-preparing", "radius": "radius.3"}},
            {"name": "label", "archetype": "text", "sample": "preparing", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1"}}
          ]
        }
      ]
    },
    {
      "name": "Issue chip",
      "role": "compact issue metadata; the tone names the kind of metadata",
      "states": {
        "focus": "two-pixel focus ring tight to the chip",
        "hover": "the chip takes a hairline border in its own text hue; the tone is unchanged",
        "active": "the hairline holds",
        "disabled": "the chip drops to the disabled opacity and stops being pressable"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "control",
          "bindings": {"background": "color.issue-type", "color": "color.issue-type-text", "radius": "radius.0", "padding": "space.2"},
          "arrangement": {"kind": "row", "gap": "space.2", "align": "center"},
          "state_deltas": {
            "hover": {"border": "color.issue-type-text", "border_width": "border_width.hairline"},
            "active": {"border": "color.issue-type-text", "border_width": "border_width.hairline"},
            "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"},
            "disabled": {"opacity": "opacity.disabled"}
          },
          "children": [
            {"name": "icon", "archetype": "icon", "bindings": {"color": "color.issue-type-text", "size": "space.5"}},
            {"name": "label", "archetype": "text", "sample": "Feature", "bindings": {"color": "color.issue-type-text", "font_size": "type.scale.0", "font_weight": "type.weights.1"}}
          ]
        }
      ]
    },
    {
      "name": "Callout",
      "role": "inline message that needs a decision or names a failure",
      "states": {"focus": "not focusable; controls inside it take their own ring", "hover": "no change", "active": "no change", "disabled": "a callout is removed, never disabled"},
      "parts": [
        {
          "name": "frame",
          "archetype": "container",
          "bindings": {"background": "color.danger-surface", "border": "color.danger-border", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.5"},
          "arrangement": {"kind": "column", "gap": "space.2", "align": "stretch"},
          "children": [
            {"name": "title", "archetype": "text", "sample": "Component 'database' failed to start", "bindings": {"color": "color.danger-text", "font_size": "type.scale.2", "font_weight": "type.weights.1"}},
            {"name": "body", "archetype": "text", "sample": "Port 1434 in use. Stop the other process or change ports.database in roubo.yaml.", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}}
          ]
        }
      ]
    },
    {
      "name": "Menu",
      "role": "popover list of actions or options",
      "states": {
        "focus": "the focused item takes a bg-hover wash and a tight two-pixel focus ring",
        "hover": "the item under the pointer takes a bg-hover wash",
        "active": "the pressed item deepens to bg-pressed",
        "disabled": "the item drops to the disabled opacity and is skipped by arrow keys"
      },
      "motion_refs": ["motion.rise-in", "motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "surface",
          "bindings": {"background": "color.bg-surface", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.2", "elevation": "elevation.0"},
          "arrangement": {"kind": "column", "gap": "space.1", "align": "stretch"},
          "children": [
            {
              "name": "item",
              "archetype": "control",
              "bindings": {"radius": "radius.0", "padding": "space.3"},
              "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
              "state_deltas": {
                "hover": {"background": "color.bg-hover"},
                "active": {"background": "color.bg-pressed"},
                "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "background": "color.bg-hover"},
                "disabled": {"opacity": "opacity.disabled"}
              },
              "children": [
                {"name": "icon", "archetype": "icon", "bindings": {"color": "color.text-secondary", "size": "space.6"}},
                {"name": "label", "archetype": "text", "sample": "Open in editor", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}}
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "Dialog",
      "role": "modal surface for one decision",
      "states": {
        "focus": "focus moves to the first control inside and is trapped there; the frame itself takes no ring",
        "hover": "the surface does not react to the pointer",
        "active": "the surface does not react to press",
        "disabled": "a dialog is dismissed, never disabled"
      },
      "motion_refs": ["motion.rise-in", "motion.opacity"],
      "parts": [
        {"name": "scrim", "archetype": "surface", "bindings": {"background": "color.scrim"}},
        {
          "name": "frame",
          "archetype": "surface",
          "bindings": {"background": "color.bg-surface", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.2", "padding": "space.8", "elevation": "elevation.1"},
          "arrangement": {"kind": "column", "gap": "space.5", "align": "stretch"},
          "children": [
            {"name": "title", "archetype": "text", "sample": "Clear Bench 3?", "bindings": {"color": "color.text-primary", "font_size": "type.scale.4", "font_weight": "type.weights.2"}},
            {"name": "body", "archetype": "text", "sample": "This removes the workspace and stops all components.", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}},
            {
              "name": "actions",
              "archetype": "container",
              "arrangement": {"kind": "row", "gap": "space.4", "align": "end"},
              "children": [
                {
                  "name": "cancel",
                  "archetype": "control",
                  "label": "Cancel",
                  "bindings": {"background": "color.bg-surface", "border": "color.border-strong", "border_width": "border_width.hairline", "color": "color.text-body", "radius": "radius.1", "padding": "space.3"}
                },
                {"name": "confirm", "archetype": "control", "label": "Clear bench", "bindings": {"background": "color.danger", "color": "color.on-danger", "radius": "radius.1", "padding": "space.3"}}
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "Tooltip",
      "role": "names an icon-only control or explains a disabled one",
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
          "bindings": {"background": "color.bg-inverse", "radius": "radius.1", "padding": "space.3", "elevation": "elevation.0"},
          "children": [{"name": "label", "archetype": "text", "sample": "Start all components on this bench", "bindings": {"color": "color.text-on-inverse", "font_size": "type.scale.1"}}]
        }
      ]
    }
  ],
  "platforms": [{"platform": "web"}],
  "aesthetic": {
    "mood": "Warm, precise, minimalist craft: warm stone grounds, one aged-brass accent, an engineered sans beside a mono, and hierarchy built from weight, size and tone rather than decoration.",
    "references": [
      "the Roubo workbench: precision joinery, every element load-bearing, no ornament",
      "aged brass tool hardware (the amber accent)",
      "engineering drawings and tool catalogues: constructed letterforms, tabular figures, measured labels"
    ],
    "forbidden_defaults": [
      "Inter",
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
      "uniformly muted palette",
      "gradient",
      "zinc-",
      "slate-",
      "gray-",
      "neutral-",
      "wood texture",
      "confetti",
      "bounce",
      "overshoot",
      "transition-all"
    ],
    "chosen_dimensions": {
      "typography": "IBM Plex Sans for interface text, JetBrains Mono for any value a developer might copy: ports, paths, branch names, commands.",
      "colour": "Warm stone grounds, dark first, with one amber accent. Red and green only as status and consequence. Categorical hues only where the hue identifies something.",
      "hierarchy": "Weight, size and three text tones; never underlines, backgrounds or borders on text.",
      "motion": "Colour on state change, one short rise for surfaces that enter, one pulse for work in progress. Ease-out, no bounce.",
      "elevation": "Borders and ground steps carry depth. Shadow only under surfaces that float: menus, tooltips, dialogs."
    }
  }
}
```
