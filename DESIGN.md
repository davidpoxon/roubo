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
| Terminal ground, text and cursor, selection | `terminal-ground`, `terminal-text`, `terminal-cursor`, `terminal-selection` | stone-950, stone-300, stone-300, stone-700 at 50% | stone-50, stone-700, stone-700, stone-400 at 40% |
| Terminal ANSI palette | `terminal-ansi-black` to `terminal-ansi-bright-white` | see below | see below |

**Three text tones, and each clears AA on every ground.** `text-secondary` is the lowest tone and measures 6.99:1 or better on base, surface, and hover in light, and 6.01:1 or better in dark, so no tone needs a per-ground variant and there is no fourth "muted" tier. Placeholder text uses `text-secondary`. Disabled content is not a tone: it is the whole control at `opacity.disabled`. On `bg-pressed`, secondary text steps up to `text-body`.

**One accent, two jobs kept apart.** `accent` fills primary actions and marks the selected tab. Work in progress is `status-preparing`, its own token, so a bench that is preparing and a button that starts it never share a meaning even where they share a hue. Amber is reserved for these two: no categorical set uses it.

**Focus is one colour everywhere**, on red controls and in inputs alike, and it is tuned per ground: amber-500 is 8.14:1 on the dark surface but 2.15:1 on white, so light mode rings in amber-700 (5.02:1 on white, 4.60:1 on the hover ground).

**Status always carries its label.** The light status values clear 3:1 on the card surface (3.30, 3.19, 4.83). `status-idle` is deliberately quiet, because idle is the absence of status.

**Boundaries that must be found clear 3:1.** `border-control` is the one line that does, at 4.80:1 on white and 3.65:1 on the dark surface. `border` and `border-strong` are separators and never the only cue to a control.

**Categorical hues appear only where the hue identifies something**, and are tuned per ground: the 600 step on light, the 400 step on dark, so a dot holds 3:1 against its surface in both themes.

- **Issue chip tones**, a 15% tint (20% in dark) with a text pair: `issue-open` (emerald), `issue-milestone` (indigo), `issue-type` (violet), and the outlined `issue-label` (cyan). The lowest pair is `issue-label-text` at 4.91:1 on the light hover ground.
- **Plugin kind pills**, one hue per kind, each a `-surface`, `-border`, `-text` set: `kind-agent` (sky), `kind-component` (violet), `kind-integration` (teal). The border takes the categorical 600 step on light and 400 on dark, so the outline holds 3:1 against the pill and the card alike; the lowest is `kind-integration-border` at 3.43:1 in light. The lowest text pair is `kind-agent-text` at 7.09:1 on its light surface, and `kind-component-text` at 11.14:1 over the dark hover ground.
- **Code syntax** in an editor: `syntax-key` (sky), `syntax-string` (violet), `syntax-literal` (emerald, for numbers, booleans, and nulls). Text on `bg-field` only, at the 800 step on light (700 for violet) and the 200 or 300 step on dark. The lowest is `syntax-string`, at 7.10:1 in light and 10.70:1 in dark. Comments, punctuation, and operators are not syntax roles: they take `text-secondary`.
- **Agent swatches** `agent-swatch-1` to `-6`: violet, cyan, emerald, lime, rose, sky. Dots and glyphs only, never text.
- **Project status** `project-status-in-progress`, `-ready`, `-todo`: blue, fuchsia, cyan. Dots only.

Success is `green`, never emerald; emerald is the open-issue tone.

**The terminal follows the theme.** The xterm canvas and the well around it both paint `terminal-ground`, which is the `bg-base` value in each theme, so no rim shows at the canvas edge. The cursor is the text colour and the selection is a stone wash: amber stays with its two jobs. The sixteen ANSI roles (`terminal-ansi-black`, `-red`, `-green`, `-yellow`, `-blue`, `-magenta`, `-cyan`, `-white`, and a `-bright-` twin of each) are the one place where program output, not Roubo, chooses the hue:

- **Dark.** Stone-900 black, stone-300 white, stone-400 bright black, stone-50 bright white; the hues at the 500 step, and at the 400 step for bright.
- **Light.** Stone-900 black, stone-500 white, stone-600 bright black, stone-400 bright white; the hues at the 700 step, and at the 800 step for bright, because on a light ground bright means more emphasis. Magenta is purple; yellow is yellow, never amber.

Every ANSI entry that prints text clears 4.5:1 on its ground (the lowest are light white at 4.59 and light yellow at 4.71). The two exceptions sit next to the ground by definition: dark black (1.13) and light bright white (2.41).

The palette only reaches programs that print through those sixteen roles. An agent that paints in 24-bit colour, say on its own dark theme under a light Roubo, bypasses them, so the terminal also sets xterm's contrast floor to the same 4.5:1: text below it against its cell, the two exceptions above included, is darkened or lightened until it clears, or as close as a mid-tone cell background allows, and the floor follows a live theme switch. Dim text gets half the floor, so it still reads as dim, and block, box-drawing and powerline separator glyphs are left alone because they paint as background.

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

Twenty-seven components. Each spec is the contract; none is anchored to a source line, because the code follows the spec.

- **Primary button.** Amber ground, stone-950 label at 9.20:1. At most one per view.
- **Secondary button.** Surface ground with a `border-strong` outline. The default action style.
- **Ghost icon button.** Unpainted until hover. Always has a tooltip, which still appears when the button is disabled.
- **Danger button.** Red ground, white label, darkening on hover and press (4.83, 6.47, 8.31:1). Only inside a confirming dialog.
- **Input field.** `bg-field` with the `border-control` boundary. Focus takes the focus hue on the border plus a tight ring. It carries a fifth state, `invalid`. Paths and commands typed into it are mono.
- **Tabs.** The selected tab is primary text over a 2px accent indicator; the rest are secondary text. Entering tab content uses `motion.rise-in`.
- **Nav item.** The selected destination sits on `accent-muted` in `accent-text`, at medium weight.
- **Bench card.** The border is the bench status, as `docs/brand.md` defines it. The card rests on `bg-surface` and its hover changes the ground only, so nothing shifts. A TestBench or a Spec Bench carries a variant badge in its head, `accent-text` on `accent-muted`; a normal bench carries none.
- **Status indicator.** Dot plus label, never the dot alone. Pulses with `motion.status-pulse` while preparing or clearing.
- **Issue chip.** Tinted with its own tone; the spec shows the `issue-type` tone and the other three swap the two colour bindings.
- **Callout.** The inline home of `danger-text`: states the cause, then the fix. The success variant swaps the three `success-*` tokens.
- **Menu.** A floating surface at `elevation.0`; items take a wash, never a border.
- **Dialog.** Surface at `elevation.1` over the scrim, one decision per dialog, actions right-aligned with the consequential one last.
- **Tooltip.** The inverse surface. It still appears for a disabled trigger, which is how the reason gets read.
- **Pile card.** One waiting bench in the needs-response pile. The top card is the live bench view under a 2px accent rule. A lower card shows only its title bar (dot, project, bench, terminal, origin, mono age) and raises on click or Enter. The dot marks waiting, and the origin text beside the terminal says whether the wait was signalled or inferred. Cards arrive with `motion.slide-under` and leave with `motion.drop-away`. A card whose sessions ended is dropped, never disabled.
- **Split separator.** The line between two terminal panes, focusable with `role="separator"`. It steps from `border` to `border-strong` on hover and to `border-control` while dragging.
- **Facet placeholder.** Surface ground with a hairline border where a torn-off terminal used to be, with one secondary button: Return.
- **Count badge.** `accent-text` on `accent-muted`, the sidebar's count of waiting benches while the pile is hidden.
- **Unit node.** One work unit in the delivery graph, the map's default view. Lanes are stacks, columns are layers, and edges drawn between nodes are `depends_on`: `border-strong` by default, `success-text` from a merged unit, `status-error` dashed from a gate to the batch it gates, and the 2px accent for the path of the node under the pointer or focus. The node holds the mono id and pull request, the title, and a meta line with the status dot and its label and the figures. The live unit carries the 2px accent rule at its left edge. A gate node swaps the ground to `danger-surface` and the border to `status-error`. Edges are decorative; the node's detail line names its dependencies for the screen reader.
- **Unit row.** One work unit in the map's list view, a dense hairline row: stack, layer, mono id, title, status dot with label, pull request, gate badge, cases and cost in tabular figures. The live unit carries the 2px accent rule at its left edge; every other row omits the rule. Enter opens the unit drill-in.
- **Delivery stat.** One figure in the burn and health strip: a mono eyebrow, a value at `type.scale.4`, a note, and an optional meter whose fill is the only accent on the strip.
- **Health chip.** The shell header's one-word health: fresh, stale, disconnected or blocked. The dot names the state and the label always carries the word; stale takes `status-preparing`, disconnected and blocked take `status-error`. Pressing it opens the reason.
- **Timeline event.** One event in a unit's drill-in timeline, newest first: mono time, a kind badge, the text, and a mono detail line naming the role, attempt and turn. An event that names an artifact is pressable and opens it. The newest event carries the 2px accent rule; every other row omits it.
- **Generation seam.** A hairline rule with a mono label across the timeline where a fresh session or a compaction took over. Events above and below it did not share a context.
- **Decision item.** One question from the delivery session, piled like the needs-response pile: the oldest pending decision is the live top card under the 2px accent rule, with its state badge, a mono origin line naming where it was raised and what it holds, the question, and the options as buttons with the recorded default as the primary. A lower card shows only its title bar (badge and origin) and raises on click or Enter. A new decision arrives with `motion.slide-under`; an answered one leaves with `motion.drop-away` and the next card rises. A default in force is a card too, marked in its badge, and stays until overturned or applied.
- **Steering note.** One queued operator note: a state badge (queued, read back, applied), a mono line naming the boundary it lands at, the note, and the session's read-back once it exists. A queued note opens for edit on Enter; an applied note dims and keeps its read-back.
- **Role matrix row.** One role in the delivery: the mono role name, its model and effort as two menus on the field ground, its spend so far, and an `accent-text` on `accent-muted` badge while a change waits for the next unit boundary. Changing a value writes a control; the badge clears on the session's read-back.

**Which token when.** A ground is always a `bg-*` token and text on it is always one of the three text tones or a paired `*-text`. `accent` is never text. `danger` is never decoration. A `status-*` colour never appears without its label. A categorical hue never carries text.

## Motion

Three durations (`fast` 150ms, `standard` 200ms, `slow` 300ms) and two easings: `standard`, a crisp ease-out with no overshoot, and `accelerate` for exits. Three transitions (`colors`, `opacity`, `exit`) and five keyframes (`spin`, `status-pulse`, `rise-in`, `slide-under`, `drop-away`). `rise-in` runs once, at `standard`, on anything that enters: tab content, menus, dialogs, a raised pile card. `slide-under` runs once, at `standard`, on a card entering beneath the pile. `drop-away` runs once, at `fast` on `accelerate`, on the top card leaving it. One orchestration, `stagger.gate-cases`, runs `rise-in` across the escalated cases when a gate sitting opens, 40ms apart in forward order, and is suppressed under reduced motion.

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
    "kind-agent-border": {"hex": "#0284C7", "role": "border-kind-agent"}, "kind-agent-border-dark": {"hex": "#38BDF8", "role": "border-kind-agent"},
    "kind-agent-text": {"hex": "#075985", "role": "text-kind-agent"}, "kind-agent-text-dark": {"hex": "#BAE6FD", "role": "text-kind-agent"},
    "kind-component-surface": {"hex": "#F5F3FF", "role": "surface-kind-component"}, "kind-component-surface-dark": {"hex": "#2E1065", "role": "surface-kind-component", "alpha": 0.2},
    "kind-component-border": {"hex": "#7C3AED", "role": "border-kind-component"}, "kind-component-border-dark": {"hex": "#A78BFA", "role": "border-kind-component"},
    "kind-component-text": {"hex": "#5B21B6", "role": "text-kind-component"}, "kind-component-text-dark": {"hex": "#DDD6FE", "role": "text-kind-component"},
    "kind-integration-surface": {"hex": "#F0FDFA", "role": "surface-kind-integration"}, "kind-integration-surface-dark": {"hex": "#042F2E", "role": "surface-kind-integration", "alpha": 0.2},
    "kind-integration-border": {"hex": "#0D9488", "role": "border-kind-integration"}, "kind-integration-border-dark": {"hex": "#2DD4BF", "role": "border-kind-integration"},
    "kind-integration-text": {"hex": "#115E59", "role": "text-kind-integration"}, "kind-integration-text-dark": {"hex": "#99F6E4", "role": "text-kind-integration"},
    "syntax-key": {"hex": "#075985", "role": "text-syntax"}, "syntax-key-dark": {"hex": "#BAE6FD", "role": "text-syntax"},
    "syntax-string": {"hex": "#6D28D9", "role": "text-syntax"}, "syntax-string-dark": {"hex": "#C4B5FD", "role": "text-syntax"},
    "syntax-literal": {"hex": "#065F46", "role": "text-syntax"}, "syntax-literal-dark": {"hex": "#6EE7B7", "role": "text-syntax"},
    "agent-swatch-1": {"hex": "#7C3AED", "role": "swatch-agent"}, "agent-swatch-1-dark": {"hex": "#A78BFA", "role": "swatch-agent"},
    "agent-swatch-2": {"hex": "#0891B2", "role": "swatch-agent"}, "agent-swatch-2-dark": {"hex": "#22D3EE", "role": "swatch-agent"},
    "agent-swatch-3": {"hex": "#059669", "role": "swatch-agent"}, "agent-swatch-3-dark": {"hex": "#34D399", "role": "swatch-agent"},
    "agent-swatch-4": {"hex": "#65A30D", "role": "swatch-agent"}, "agent-swatch-4-dark": {"hex": "#A3E635", "role": "swatch-agent"},
    "agent-swatch-5": {"hex": "#E11D48", "role": "swatch-agent"}, "agent-swatch-5-dark": {"hex": "#FB7185", "role": "swatch-agent"},
    "agent-swatch-6": {"hex": "#0284C7", "role": "swatch-agent"}, "agent-swatch-6-dark": {"hex": "#38BDF8", "role": "swatch-agent"},
    "project-status-in-progress": {"hex": "#2563EB", "role": "swatch-project-status"}, "project-status-in-progress-dark": {"hex": "#60A5FA", "role": "swatch-project-status"},
    "project-status-ready": {"hex": "#C026D3", "role": "swatch-project-status"}, "project-status-ready-dark": {"hex": "#E879F9", "role": "swatch-project-status"},
    "project-status-todo": {"hex": "#0891B2", "role": "swatch-project-status"}, "project-status-todo-dark": {"hex": "#22D3EE", "role": "swatch-project-status"},
    "terminal-ground": {"hex": "#FAFAF9", "role": "surface-terminal"}, "terminal-ground-dark": {"hex": "#0C0A09", "role": "surface-terminal"},
    "terminal-text": {"hex": "#44403C", "role": "text-terminal"}, "terminal-text-dark": {"hex": "#D6D3D1", "role": "text-terminal"},
    "terminal-cursor": {"hex": "#44403C", "role": "cursor-terminal"}, "terminal-cursor-dark": {"hex": "#D6D3D1", "role": "cursor-terminal"},
    "terminal-selection": {"hex": "#A8A29E", "role": "selection-terminal", "alpha": 0.4}, "terminal-selection-dark": {"hex": "#44403C", "role": "selection-terminal", "alpha": 0.5},
    "terminal-ansi-black": {"hex": "#1C1917", "role": "ansi-terminal"}, "terminal-ansi-black-dark": {"hex": "#1C1917", "role": "ansi-terminal"},
    "terminal-ansi-red": {"hex": "#B91C1C", "role": "ansi-terminal"}, "terminal-ansi-red-dark": {"hex": "#EF4444", "role": "ansi-terminal"},
    "terminal-ansi-green": {"hex": "#15803D", "role": "ansi-terminal"}, "terminal-ansi-green-dark": {"hex": "#22C55E", "role": "ansi-terminal"},
    "terminal-ansi-yellow": {"hex": "#A16207", "role": "ansi-terminal"}, "terminal-ansi-yellow-dark": {"hex": "#EAB308", "role": "ansi-terminal"},
    "terminal-ansi-blue": {"hex": "#1D4ED8", "role": "ansi-terminal"}, "terminal-ansi-blue-dark": {"hex": "#3B82F6", "role": "ansi-terminal"},
    "terminal-ansi-magenta": {"hex": "#7E22CE", "role": "ansi-terminal"}, "terminal-ansi-magenta-dark": {"hex": "#A855F7", "role": "ansi-terminal"},
    "terminal-ansi-cyan": {"hex": "#0E7490", "role": "ansi-terminal"}, "terminal-ansi-cyan-dark": {"hex": "#06B6D4", "role": "ansi-terminal"},
    "terminal-ansi-white": {"hex": "#78716C", "role": "ansi-terminal"}, "terminal-ansi-white-dark": {"hex": "#D6D3D1", "role": "ansi-terminal"},
    "terminal-ansi-bright-black": {"hex": "#57534E", "role": "ansi-terminal"}, "terminal-ansi-bright-black-dark": {"hex": "#A8A29E", "role": "ansi-terminal"},
    "terminal-ansi-bright-red": {"hex": "#991B1B", "role": "ansi-terminal"}, "terminal-ansi-bright-red-dark": {"hex": "#F87171", "role": "ansi-terminal"},
    "terminal-ansi-bright-green": {"hex": "#166534", "role": "ansi-terminal"}, "terminal-ansi-bright-green-dark": {"hex": "#4ADE80", "role": "ansi-terminal"},
    "terminal-ansi-bright-yellow": {"hex": "#854D0E", "role": "ansi-terminal"}, "terminal-ansi-bright-yellow-dark": {"hex": "#FACC15", "role": "ansi-terminal"},
    "terminal-ansi-bright-blue": {"hex": "#1E40AF", "role": "ansi-terminal"}, "terminal-ansi-bright-blue-dark": {"hex": "#60A5FA", "role": "ansi-terminal"},
    "terminal-ansi-bright-magenta": {"hex": "#6B21A8", "role": "ansi-terminal"}, "terminal-ansi-bright-magenta-dark": {"hex": "#C084FC", "role": "ansi-terminal"},
    "terminal-ansi-bright-cyan": {"hex": "#155E75", "role": "ansi-terminal"}, "terminal-ansi-bright-cyan-dark": {"hex": "#22D3EE", "role": "ansi-terminal"},
    "terminal-ansi-bright-white": {"hex": "#A8A29E", "role": "ansi-terminal"}, "terminal-ansi-bright-white-dark": {"hex": "#FAFAF9", "role": "ansi-terminal"}
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
      "rise-in": {"properties": ["opacity", "transform"], "keyframes": "opacity 0 -> 1 with translateY(4px) -> translateY(0), once, at duration.standard on easing.standard", "reduced": "none"},
      "slide-under": {"properties": ["opacity", "transform"], "keyframes": "opacity 0 -> 1 with translateY(-8px) -> translateY(0), once, at duration.standard on easing.standard; a card entering beneath the pile", "reduced": "none"},
      "drop-away": {"properties": ["opacity", "transform"], "keyframes": "opacity 1 -> 0 with translateY(0) -> translateY(12px), once, at duration.fast on easing.accelerate; the top card leaving the pile", "reduced": "none"}
    },
    "orchestration": {
      "stagger.gate-cases": {
        "child": "motion.rise-in",
        "stagger": "40ms",
        "order": "forward",
        "reduced": "none"
      }
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
            {"name": "label", "archetype": "text", "sample": "roubo-plugins", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}, "state_deltas": {"active": {"color": "color.accent-text", "font_weight": "type.weights.1"}}},
            {"name": "count", "archetype": "text", "sample": "3", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1"}}
          ]
        }
      ]
    },
    {
      "name": "Bench card",
      "role": "container surface for one bench; its border is the bench status, and a variant badge names a TestBench or a Spec Bench",
      "states": {"focus": "two-pixel focus ring at a two-pixel offset around the card", "hover": "ground moves to bg-hover; the status border is unchanged", "active": "the hover ground holds while the bench opens", "disabled": "the whole card drops to the disabled opacity while the bench clears"},
      "motion_refs": ["motion.colors", "motion.status-pulse"],
      "parts": [
        {"name": "frame", "archetype": "container", "bindings": {"background": "color.bg-surface", "border": "color.status-active", "border_width": "border_width.hairline", "radius": "radius.2", "padding": "space.7"}, "arrangement": {"kind": "column", "gap": "space.5", "align": "stretch"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-hover"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "head", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.4", "align": "center"}, "children": [
            {"name": "dot", "archetype": "custom", "label": "active", "bindings": {"background": "color.status-active", "radius": "radius.3"}},
            {"name": "title", "archetype": "text", "sample": "Bench 2", "bindings": {"color": "color.text-primary", "font_size": "type.scale.3", "font_weight": "type.weights.2"}},
            {"name": "status", "archetype": "text", "sample": "active", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1"}},
            {"name": "variant", "archetype": "badge", "label": "Spec Bench", "bindings": {"background": "color.accent-muted", "color": "color.accent-text", "radius": "radius.0", "padding": "space.2"}}
          ]},
          {"name": "workspace", "archetype": "text", "sample": "feat/verify-gate", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_family": "type.fonts.mono"}},
          {"name": "rule", "archetype": "divider", "bindings": {"color": "color.border", "thickness": "border_width.hairline"}},
          {"name": "component", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.4", "align": "center"}, "children": [
            {"name": "dot", "archetype": "custom", "label": "active", "bindings": {"background": "color.status-active", "radius": "radius.3"}},
            {"name": "name", "archetype": "text", "sample": "backend", "bindings": {"color": "color.text-body", "font_size": "type.scale.2"}},
            {"name": "port", "archetype": "text", "sample": ":3021", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_family": "type.fonts.mono"}}
          ]}
        ]}
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
    },
    {
      "name": "Pile card",
      "role": "one waiting bench in the needs-response pile; the top card is the live bench view, a lower card shows only its title bar",
      "states": {
        "focus": "the title bar takes the focus ring; Enter raises a lower card",
        "hover": "a lower card's title bar takes the bg-hover wash",
        "active": "the pressed title bar takes the bg-pressed wash",
        "disabled": "a card is never disabled: a card whose sessions have ended leaves the pile with motion.drop-away"
      },
      "motion_refs": ["motion.slide-under", "motion.drop-away", "motion.rise-in", "motion.status-pulse", "motion.colors"],
      "parts": [
        {
          "name": "frame",
          "archetype": "container",
          "bindings": {"background": "color.bg-base", "border": "color.border-strong", "border_width": "border_width.hairline", "radius": "radius.2"},
          "arrangement": {"kind": "column", "align": "stretch"},
          "children": [
            {
              "name": "title-bar",
              "archetype": "control",
              "label": "Raise this bench",
              "bindings": {"background": "color.bg-surface", "padding": "space.3", "radius": "radius.2", "color": "color.text-body"},
              "arrangement": {"kind": "row", "gap": "space.4", "align": "center"},
              "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}},
              "children": [
                {
                  "name": "dot",
                  "archetype": "custom",
                  "label": "waiting",
                  "bindings": {"background": "color.status-preparing", "radius": "radius.3"}
                },
                {
                  "name": "project",
                  "archetype": "text",
                  "sample": "roubo",
                  "bindings": {"color": "color.text-secondary", "font_size": "type.scale.2"}
                },
                {
                  "name": "bench",
                  "archetype": "text",
                  "sample": "#1421 hot-reload",
                  "bindings": {"color": "color.text-primary", "font_size": "type.scale.2", "font_weight": "type.weights.1"}
                },
                {
                  "name": "terminal",
                  "archetype": "text",
                  "sample": "claude",
                  "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0"}
                },
                {
                  "name": "origin",
                  "archetype": "text",
                  "sample": "signalled · permission",
                  "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0"}
                },
                {
                  "name": "age",
                  "archetype": "text",
                  "sample": "4m 12s",
                  "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_family": "type.fonts.mono"}
                }
              ]
            },
            {
              "name": "top-rule",
              "archetype": "divider",
              "bindings": {"color": "color.accent", "thickness": "border_width.thick"}
            }
          ]
        }
      ]
    },
    {
      "name": "Split separator",
      "role": "resizes two terminal panes by pointer or by arrow keys",
      "states": {
        "focus": "the focus ring outlines the whole separator",
        "hover": "the line steps up from border to border-strong",
        "active": "while dragging, the line takes border-control so it can be found",
        "disabled": "a separator beside a torn-off pane is hidden, never disabled"
      },
      "motion_refs": ["motion.colors"],
      "parts": [
        {
          "name": "handle",
          "archetype": "control",
          "label": "Resize panes",
          "bindings": {"background": "color.border", "radius": "radius.0"},
          "state_deltas": {"hover": {"background": "color.border-strong"}, "active": {"background": "color.border-control"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}}
        }
      ]
    },
    {
      "name": "Facet placeholder",
      "role": "stands in for a terminal that is torn off into its own window",
      "states": {
        "focus": "the Return control takes the focus ring",
        "hover": "the Return control takes the bg-hover wash",
        "active": "the Return control takes the bg-pressed wash",
        "disabled": "the placeholder drops to the disabled opacity while the torn-off window is closing"
      },
      "parts": [
        {
          "name": "frame",
          "archetype": "container",
          "bindings": {"background": "color.bg-surface", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.8"},
          "arrangement": {"kind": "column", "gap": "space.5", "align": "center"},
          "state_deltas": {"disabled": {"opacity": "opacity.disabled"}},
          "children": [
            {
              "name": "message",
              "archetype": "text",
              "sample": "claude is in its own window",
              "bindings": {"color": "color.text-secondary", "font_size": "type.scale.2"}
            },
            {
              "name": "return",
              "archetype": "control",
              "label": "Return",
              "bindings": {"background": "color.bg-surface", "border": "color.border-strong", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.2", "color": "color.text-primary"},
              "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}
            }
          ]
        }
      ]
    },
    {
      "name": "Count badge",
      "role": "number of waiting benches on the sidebar while the pile is hidden",
      "states": {
        "focus": "not focusable; it describes its parent",
        "hover": "no change",
        "active": "no change",
        "disabled": "drops to the disabled opacity when its parent is disabled"
      },
      "parts": [
        {
          "name": "pill",
          "archetype": "badge",
          "label": "3",
          "bindings": {"background": "color.accent-muted", "color": "color.accent-text", "radius": "radius.3", "padding": "space.2"},
          "state_deltas": {"disabled": {"opacity": "opacity.disabled"}}
        }
      ]
    },
    {
      "name": "Unit row",
      "role": "one work unit in the delivery map; the live row carries the accent rule and opens the unit on Enter",
      "states": {"focus": "two-pixel focus ring tight to the row; Enter opens the unit drill-in", "hover": "ground moves to bg-hover; the status and the rule are unchanged", "active": "the pressed row takes the bg-pressed wash while the drill-in opens", "disabled": "a held or blocked row drops to the disabled opacity and keeps its reason chip readable"},
      "motion_refs": ["motion.colors", "motion.status-pulse", "motion.rise-in"],
      "parts": [
        {"name": "frame", "archetype": "control", "label": "Open SB-WU-007", "bindings": {"background": "color.bg-surface", "color": "color.text-body", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.0", "padding": "space.3"}, "arrangement": {"kind": "row", "gap": "space.5", "align": "center"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "rule", "archetype": "divider", "bindings": {"color": "color.accent", "thickness": "border_width.thick"}},
          {"name": "stack", "archetype": "text", "sample": "#1", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
          {"name": "layer", "archetype": "text", "sample": "4", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
          {"name": "unit-id", "archetype": "text", "sample": "SB-WU-007", "bindings": {"color": "color.text-body", "font_size": "type.scale.1", "font_weight": "type.weights.1", "font_family": "type.fonts.mono"}},
          {"name": "title", "archetype": "text", "sample": "TestBench host resolver", "bindings": {"color": "color.text-primary", "font_size": "type.scale.1", "font_weight": "type.weights.1"}},
          {"name": "status", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.3", "align": "center"}, "children": [
            {"name": "dot", "archetype": "custom", "label": "review", "bindings": {"background": "color.status-preparing", "radius": "radius.3"}},
            {"name": "label", "archetype": "text", "sample": "review", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1"}}
          ]},
          {"name": "pull-request", "archetype": "text", "sample": "#47 draft", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
          {"name": "gate", "archetype": "badge", "label": "19/22 · 3 escalated", "bindings": {"background": "color.bg-hover", "color": "color.text-secondary", "radius": "radius.0", "padding": "space.2"}},
          {"name": "cases", "archetype": "text", "sample": "3", "bindings": {"color": "color.text-body", "font_size": "type.scale.1", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
          {"name": "cost", "archetype": "text", "sample": "2.65", "bindings": {"color": "color.text-body", "font_size": "type.scale.1", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}}
        ]}
      ]
    },
    {
      "name": "Delivery stat",
      "role": "one figure in the burn and health strip: an eyebrow, a value, a note, and an optional meter",
      "states": {"focus": "not focusable; it describes the delivery", "hover": "no change", "active": "no change", "disabled": "drops to the disabled opacity while the record is nonconformant"},
      "motion_refs": ["motion.colors"],
      "parts": [
        {"name": "cell", "archetype": "container", "bindings": {"background": "color.bg-surface", "padding": "space.5"}, "arrangement": {"kind": "column", "gap": "space.2", "align": "start"}, "state_deltas": {"disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "eyebrow", "archetype": "text", "sample": "Spent", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1", "font_family": "type.fonts.mono"}},
          {"name": "value", "archetype": "text", "sample": "41.20", "bindings": {"color": "color.text-primary", "font_size": "type.scale.4", "font_weight": "type.weights.2", "font_family": "type.fonts.mono"}},
          {"name": "note", "archetype": "text", "sample": "of 118.00 soft budget", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0"}},
          {"name": "meter", "archetype": "custom", "label": "38 percent", "bindings": {"background": "color.bg-hover", "radius": "radius.3"}, "children": [
            {"name": "fill", "archetype": "custom", "label": "spent", "bindings": {"background": "color.accent", "radius": "radius.3"}}
          ]}
        ]}
      ]
    },
    {
      "name": "Health chip",
      "role": "one-word delivery health in the shell header: fresh, stale, disconnected or blocked; pressing it opens the reason",
      "states": {"focus": "two-pixel focus ring tight to the chip", "hover": "the hairline steps up to border-control", "active": "the chip takes the bg-hover wash", "disabled": "drops to the disabled opacity when there is no record to describe"},
      "motion_refs": ["motion.colors", "motion.status-pulse"],
      "parts": [
        {"name": "frame", "archetype": "control", "label": "Show health detail", "bindings": {"background": "color.bg-surface", "color": "color.text-secondary", "border": "color.border-strong", "border_width": "border_width.hairline", "radius": "radius.0", "padding": "space.2"}, "arrangement": {"kind": "row", "gap": "space.3", "align": "center"}, "state_deltas": {"hover": {"border": "color.border-control"}, "active": {"background": "color.bg-hover"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "dot", "archetype": "custom", "label": "fresh", "bindings": {"background": "color.status-active", "radius": "radius.3"}},
          {"name": "label", "archetype": "text", "sample": "fresh · plan 9fe2ae9f", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1", "font_family": "type.fonts.mono"}}
        ]}
      ]
    },
    {
      "name": "Unit node",
      "role": "one work unit in the delivery graph; a compact node in its stack lane at its layer, with edges drawn between nodes for depends_on",
      "states": {"focus": "two-pixel focus ring at a two-pixel offset; the node's edges highlight in accent and the detail line names its dependencies", "hover": "ground moves to bg-hover and the node's edges highlight in accent", "active": "the pressed node takes the bg-pressed wash while the drill-in opens", "disabled": "a held node drops to the disabled opacity and keeps its held reason in the meta line"},
      "motion_refs": ["motion.colors", "motion.status-pulse", "motion.rise-in"],
      "parts": [
        {"name": "frame", "archetype": "control", "label": "Open SB-WU-006", "bindings": {"background": "color.bg-base", "color": "color.text-body", "border": "color.border-strong", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.4"}, "arrangement": {"kind": "column", "gap": "space.2", "align": "stretch"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "rule", "archetype": "divider", "bindings": {"color": "color.accent", "thickness": "border_width.thick"}},
          {"name": "head", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.5", "align": "center"}, "children": [
            {"name": "unit-id", "archetype": "text", "sample": "SB-WU-006", "bindings": {"color": "color.text-body", "font_size": "type.scale.0", "font_weight": "type.weights.1", "font_family": "type.fonts.mono"}},
            {"name": "pull-request", "archetype": "text", "sample": "#45 draft", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}}
          ]},
          {"name": "title", "archetype": "text", "sample": "Record loader and event ingest", "bindings": {"color": "color.text-primary", "font_size": "type.scale.1", "font_weight": "type.weights.1"}},
          {"name": "meta", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.5", "align": "center"}, "children": [
            {"name": "dot", "archetype": "custom", "label": "active", "bindings": {"background": "color.status-preparing", "radius": "radius.3"}},
            {"name": "state", "archetype": "text", "sample": "active", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
            {"name": "figures", "archetype": "text", "sample": "4 cases · 6.40", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}}
          ]}
        ]}
      ]
    },
    {
      "name": "Timeline event",
      "role": "one event in a unit's timeline: the time, the kind, the text, and an optional link to the artifact it names; the newest event carries the accent rule",
      "states": {"focus": "two-pixel focus ring tight to the row; Enter follows the event's link when it has one", "hover": "ground moves to bg-hover on a row with a link; a row without one is unchanged", "active": "the pressed row takes the bg-pressed wash while the link opens", "disabled": "an event from a replaced attempt drops to the disabled opacity and stays readable"},
      "motion_refs": ["motion.colors", "motion.rise-in"],
      "parts": [
        {"name": "row", "archetype": "control", "label": "Open pull request #47", "bindings": {"background": "color.bg-surface", "color": "color.text-body", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.0", "padding": "space.4"}, "arrangement": {"kind": "row", "gap": "space.6", "align": "start"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "rule", "archetype": "divider", "bindings": {"color": "color.accent", "thickness": "border_width.thick"}},
          {"name": "time", "archetype": "text", "sample": "08:37:12", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
          {"name": "kind", "archetype": "badge", "label": "pull request", "bindings": {"background": "color.bg-hover", "color": "color.text-secondary", "radius": "radius.0", "padding": "space.2"}},
          {"name": "body", "archetype": "container", "arrangement": {"kind": "column", "gap": "space.2", "align": "start"}, "children": [
            {"name": "text", "archetype": "text", "sample": "Draft #47 opened on stack #12, layer 4, base SB-WU-003", "bindings": {"color": "color.text-body", "font_size": "type.scale.1", "font_weight": "type.weights.0"}},
            {"name": "detail", "archetype": "text", "sample": "manager · attempt 1 · turn 23", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}}
          ]}
        ]}
      ]
    },
    {
      "name": "Generation seam",
      "role": "a rule across a unit's timeline where a fresh session or a compaction took over, so the reader knows the context above and below are not the same",
      "states": {"focus": "not focusable; it describes the timeline", "hover": "no change", "active": "no change", "disabled": "drops to the disabled opacity with the events around it"},
      "parts": [
        {"name": "seam", "archetype": "container", "bindings": {"padding": "space.3"}, "arrangement": {"kind": "row", "gap": "space.5", "align": "center"}, "state_deltas": {"disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "line", "archetype": "divider", "bindings": {"color": "color.border-strong", "thickness": "border_width.hairline"}},
          {"name": "label", "archetype": "text", "sample": "session 2 · resumed 2026-09-27 08:14 · compaction none", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.1", "font_family": "type.fonts.mono"}},
          {"name": "line-end", "archetype": "divider", "bindings": {"color": "color.border-strong", "thickness": "border_width.hairline"}}
        ]}
      ]
    },
    {
      "name": "Decision item",
      "role": "one question the delivery session raised, piled with the others: the oldest pending decision is the live top card with its options, a lower card shows only its title bar and raises on click or Enter",
      "states": {"focus": "the title bar takes the focus ring; Enter raises a lower card, and Tab moves through the top card's options", "hover": "a lower card's title bar takes the bg-hover wash; the top card is unchanged", "active": "the pressed title bar takes the bg-pressed wash while the card raises", "disabled": "a card is never disabled: an answered decision leaves the pile with motion.drop-away, and a withdrawn one drops to the disabled opacity until it leaves"},
      "motion_refs": ["motion.slide-under", "motion.drop-away", "motion.rise-in", "motion.colors"],
      "parts": [
        {"name": "frame", "archetype": "container", "bindings": {"background": "color.bg-surface", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.0", "padding": "space.5"}, "arrangement": {"kind": "column", "gap": "space.3", "align": "stretch"}, "state_deltas": {"disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "rule", "archetype": "divider", "bindings": {"color": "color.accent", "thickness": "border_width.thick"}},
          {"name": "title-bar", "archetype": "control", "arrangement": {"kind": "row", "gap": "space.5", "align": "center"}, "label": "Raise this decision", "bindings": {"background": "color.bg-surface", "padding": "space.3", "radius": "radius.2", "color": "color.text-body"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}}, "children": [
            {"name": "state", "archetype": "badge", "label": "D-004 · pending", "bindings": {"background": "color.accent-muted", "color": "color.accent-text", "radius": "radius.0", "padding": "space.2"}},
            {"name": "origin", "archetype": "text", "sample": "raised at SB-WU-006 · holds SB-WU-011", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}}
          ]},
          {"name": "question", "archetype": "text", "sample": "Keep the zod root refine for unique unit ids, or move uniqueness into the runtime validator only?", "bindings": {"color": "color.text-primary", "font_size": "type.scale.2", "font_weight": "type.weights.1"}},
          {"name": "options", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.3", "align": "center"}, "children": [
            {"name": "default", "archetype": "control", "label": "Keep zod refine (default)", "bindings": {"background": "color.accent", "color": "color.on-accent", "radius": "radius.1", "padding": "space.3"}, "state_deltas": {"hover": {"background": "color.accent-hover"}, "active": {"background": "color.accent-active"}}},
            {"name": "option", "archetype": "control", "label": "Validator only", "bindings": {"background": "color.bg-surface", "color": "color.text-body", "border": "color.border-strong", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.3"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}}}
          ]}
        ]}
      ]
    },
    {
      "name": "Steering note",
      "role": "one operator note queued for the next unit boundary, with its read-back once the session has it; queued, read back and applied are the three states of its badge",
      "states": {"focus": "two-pixel focus ring tight to the row; Enter opens the note for edit while it is still queued", "hover": "ground moves to bg-hover while the note is still queued", "active": "the pressed row takes the bg-pressed wash while the editor opens", "disabled": "an applied note drops to the disabled opacity and keeps its read-back readable"},
      "motion_refs": ["motion.colors", "motion.rise-in"],
      "parts": [
        {"name": "row", "archetype": "control", "label": "Edit steering note S-002", "bindings": {"background": "color.bg-surface", "color": "color.text-body", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.0", "padding": "space.4"}, "arrangement": {"kind": "column", "gap": "space.2", "align": "stretch"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1"}, "disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "head", "archetype": "container", "arrangement": {"kind": "row", "gap": "space.5", "align": "center"}, "children": [
            {"name": "state", "archetype": "badge", "label": "S-002 · queued", "bindings": {"background": "color.bg-hover", "color": "color.text-secondary", "radius": "radius.0", "padding": "space.2"}},
            {"name": "applies", "archetype": "text", "sample": "applies at the next boundary · SB-WU-007", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}}
          ]},
          {"name": "text", "archetype": "text", "sample": "Prefer React Aria Dialog over a custom modal.", "bindings": {"color": "color.text-primary", "font_size": "type.scale.1", "font_weight": "type.weights.0"}},
          {"name": "read-back", "archetype": "text", "sample": "Read-back: will use Dialog from React Aria for every new modal from SB-WU-007 on.", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.0", "font_weight": "type.weights.0"}}
        ]}
      ]
    },
    {
      "name": "Role matrix row",
      "role": "one role in the delivery's role matrix: the role, its model and effort as menus, its spend so far, and a pending badge while a change waits for the next unit boundary",
      "states": {"focus": "two-pixel focus ring tight to the focused menu; arrow keys change the value and Enter commits it as a control", "hover": "the hovered menu's ground moves to bg-hover", "active": "the open menu holds the bg-pressed wash", "disabled": "the row drops to the disabled opacity while the delivery is ended or the record is nonconformant"},
      "motion_refs": ["motion.colors"],
      "parts": [
        {"name": "row", "archetype": "container", "bindings": {"background": "color.bg-surface", "border": "color.border", "border_width": "border_width.hairline", "radius": "radius.0", "padding": "space.4"}, "arrangement": {"kind": "row", "gap": "space.6", "align": "center"}, "state_deltas": {"disabled": {"opacity": "opacity.disabled"}}, "children": [
          {"name": "role", "archetype": "text", "sample": "coder", "bindings": {"color": "color.text-primary", "font_size": "type.scale.1", "font_weight": "type.weights.1", "font_family": "type.fonts.mono"}},
          {"name": "model", "archetype": "control", "label": "sonnet", "bindings": {"background": "color.bg-field", "color": "color.text-body", "border": "color.border-control", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.3"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"}}},
          {"name": "effort", "archetype": "control", "label": "medium", "bindings": {"background": "color.bg-field", "color": "color.text-body", "border": "color.border-control", "border_width": "border_width.hairline", "radius": "radius.1", "padding": "space.3"}, "state_deltas": {"hover": {"background": "color.bg-hover"}, "active": {"background": "color.bg-pressed"}, "focus": {"ring_color": "color.focus-ring", "ring_width": "space.1", "ring_offset": "space.1"}}},
          {"name": "spent", "archetype": "text", "sample": "17.60 · 43 percent", "bindings": {"color": "color.text-secondary", "font_size": "type.scale.1", "font_weight": "type.weights.0", "font_family": "type.fonts.mono"}},
          {"name": "pending", "archetype": "badge", "label": "pending · next boundary", "bindings": {"background": "color.accent-muted", "color": "color.accent-text", "radius": "radius.0", "padding": "space.2"}}
        ]}
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
