# Brand

The Roubo brand guide. Vocabulary, design philosophy, logo, palette, typography, voice. The source of truth for anything user-facing in the product, and a useful read for anyone contributing to UI, copy, or documentation.

## Origin

André-Jacob Roubo (1739–1791) was a French master carpenter and author of _L'Art du Menuisier_, the definitive encyclopedia of woodworking. His workbench design (a massive, elegant, precisely engineered slab on legs) was rediscovered in the 21st century and is now considered the gold standard of workbench design. It is admired not for ornamentation but for the purity of its engineering: every element serves a purpose, nothing is superfluous, and the quality of the materials is allowed to speak for itself.

**Roubo** (the software) is a local development environment manager. The name connects the tool to a tradition of precision, craftsmanship, and the empowerment of the maker.

---

## Design Philosophy

Roubo's design is guided by five principles drawn from fine woodworking. These are not decorative themes; they are functional values that inform every decision.

**1. Precision over decoration.**
Every element earns its place. If it doesn't communicate status, enable action, or create clarity, it is removed. This is the woodworker's discipline: the joint is precise not because it's pretty, but because precision is what makes it strong.

**2. Let the materials speak.**
In woodworking, the beauty comes from the wood itself: its grain, its warmth, its weight. In Roubo, the "material" is the information: branch names, port numbers, service statuses, project names. The design recedes so the content is prominent. Colour, weight, and space direct attention. Decoration does not.

**3. The user is a maker.**
The vocabulary, interactions, and overall tone assume the user is a skilled builder. The tool is an aid to their craft, not a replacement for their judgment. Confirmations are minimal. Actions are direct. The interface trusts the user.

**4. Attention to detail.**
Transitions are smooth. Alignment is exact. Spacing is consistent. The difference between a good tool and a great one is in the details that most people don't consciously notice but everyone feels.

**5. Quiet confidence.**
The tool doesn't announce itself. It doesn't use exclamation marks, celebration animations, or congratulatory messages. It works, reliably and well, and that is enough.

---

## Vocabulary

All user-facing text uses the Roubo vocabulary. Internal code should also use these terms; PRs introducing competing vocabulary will be asked to align before merging.

### Core Terms

| Term           | Definition                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Roubo**      | The product name. Always capitalised as a proper noun. Never "the Roubo"; just "Roubo".                                                  |
| **Bench**      | An isolated development environment with its own worktree, ports, and running components. The primary workspace unit. Plural: "benches". |
| **Project**    | A registered repository that defines how benches are configured.                                                                         |
| **Component**  | A running part of a bench: database, backend, frontend. Components are what you assemble.                                                |
| **Tool**       | A quick-open action: open the browser, launch the IDE, start a shell. Tools are what you reach for.                                      |
| **Inspection** | Running quality checks against the work on a bench.                                                                                      |
| **Blueprint**  | A set of instructions for an AI coding agent working on a bench. A blueprint is a detailed drawing that guides the build.                |
| **Workspace** | The git worktree directory on disk for a specific bench.                                                                                  |

### Status Labels

| Status       | When                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| `idle`       | Bench exists but nothing is running.                                               |
| `preparing`  | Bench is being set up: creating workspace, pulling containers, running migrations. |
| `active`     | All components are running. Work is underway.                                      |
| `clearing`   | Components are shutting down. The bench is being tidied.                           |
| `error`      | Something went wrong. (No metaphor here; clarity trumps style.)                    |

### Action Labels

| Action          | Label          | Tooltip                                        |
| --------------- | -------------- | ---------------------------------------------- |
| Create bench    | "Set up bench" | "Create a new bench for this project"          |
| Start bench     | "Start"        | "Start all components on this bench"           |
| Stop bench      | "Stop"         | "Stop all components on this bench"            |
| Teardown bench  | "Clear bench"  | "Remove this bench and clean up its resources" |
| Start component | "Start [name]" | "Start the [name] component"                   |
| Stop component  | "Stop [name]"  | "Stop the [name] component"                    |

---

## Logo

### The Mark

The Roubo logomark is an abstract representation of a **mortise-and-tenon joint in cross-section**, the defining joint of fine woodworking. Two timber pieces meet: the mortise piece (receiving) and the tenon piece (inserted), with the solid tenon projecting from one into the other.

The mark is about **precision fit**: how things come together with exactness. This is what Roubo (the tool) does: it assembles isolated development environments from components that fit together precisely.

### Construction

The mark is built from three rectangles at different opacities:

1. **Mortise piece** (left), `opacity: 0.35`. The receiving timber body, rendered translucent to show depth.
2. **Tenon piece** (right), `opacity: 0.2`. The inserted timber body, lightest to recede furthest.
3. **The tenon joint** (centre, overlapping both), `opacity: 1.0` (solid). The joint itself is the focal point. It is the most important part of any piece of furniture, and it is the most prominent element of the mark.

The layered opacity creates a sense of depth and assembly: you can see how the pieces relate to each other, which one is in front, and where they connect.

### File

The canonical SVG is at [`client/src/assets/roubo-logo.svg`](../client/src/assets/roubo-logo.svg). It uses `currentColor` for flexible theming; the mark inherits whatever colour is set on its parent element.

### Usage

| Context                          | Size        | Colour                   |
| -------------------------------- | ----------- | ------------------------ |
| Sidebar header (next to "ROUBO") | 18px        | `--roubo-accent` (amber) |
| Browser favicon                  | 32px / 16px | `--roubo-text-primary`   |
| README / documentation           | 48px        | `--roubo-text-primary`   |

### Rules

- **Do** use the mark at `currentColor`; it should adapt to its context.
- **Do** give the mark adequate clear space, at least the width of the tenon joint on all sides.
- **Don't** rotate, stretch, or distort the mark.
- **Don't** add effects (shadows, glows, outlines) to the mark.
- **Don't** redraw or simplify the mark for small sizes; the SVG scales cleanly to 14px.
- **Don't** use the mark as a decorative pattern or wallpaper.

---

## Iconography

Roubo uses **Lucide React** icons throughout the interface. Icons are functional: they communicate what an element does, not what the product is about.

### Tool-adjacent icons are welcome

Icons that reference physical tools (wrench, hammer, hand-plane) are acceptable when they serve as **functional category indicators**. For example, a wrench icon for the "Tools" section. The test: if someone who'd never heard of Roubo looked at the icon, would they understand what it represents? If yes, it's functional. If it only makes sense within the woodworking metaphor, it's decorative.

### Rules

- **Do** use tool icons (wrench, hammer, etc.) as functional indicators for relevant sections.
- **Do** keep icons at consistent sizes within a context (14px for navigation, 16px for section headers).
- **Don't** use literal workshop scene illustrations (a workbench with tools on it, a workshop interior).
- **Don't** use decorative icons that don't communicate function.
- **Don't** mix icon styles; stay within the Lucide set for consistency.

---

## Colour Palette

Roubo uses a warm, dark foundation. The shift from zinc (cool blue-grey) to a warmer neutral is subtle; felt more than seen. Status colours remain bold and purely functional.

### Foundation (Dark Mode, primary)

| Token                    | Value                     | Usage                  |
| ------------------------ | ------------------------- | ---------------------- |
| `--roubo-bg-base`        | `stone-950`               | Page background        |
| `--roubo-bg-surface`     | `stone-900` / 50% opacity | Cards, panels          |
| `--roubo-bg-sidebar`     | `stone-950` / 60% opacity | Sidebar background     |
| `--roubo-bg-hover`       | `stone-800` / 70% opacity | Hover states           |
| `--roubo-border`         | `stone-800` / 40% opacity | Borders, dividers      |
| `--roubo-text-primary`   | `stone-100`               | Primary text           |
| `--roubo-text-secondary` | `stone-400`               | Secondary text, labels |
| `--roubo-text-muted`     | `stone-600`               | Disabled, placeholder  |

### Foundation (Light Mode)

| Token                    | Value       | Usage           |
| ------------------------ | ----------- | --------------- |
| `--roubo-bg-base`        | `stone-50`  | Page background |
| `--roubo-bg-surface`     | `white`     | Cards, panels   |
| `--roubo-bg-hover`       | `stone-100` | Hover states    |
| `--roubo-border`         | `stone-200` | Borders         |
| `--roubo-text-primary`   | `stone-900` | Primary text    |
| `--roubo-text-secondary` | `stone-500` | Secondary text  |

### Accent: Warm Brass

A single accent colour inspired by aged brass hardware, the kind found on quality hand tools and traditional bench fittings. Used sparingly for primary actions and focused states.

| Token                  | Value                     | Usage                                               |
| ---------------------- | ------------------------- | --------------------------------------------------- |
| `--roubo-accent`       | `amber-500`               | Primary buttons, active tab indicators, focus rings |
| `--roubo-accent-hover` | `amber-400`               | Button hover                                        |
| `--roubo-accent-muted` | `amber-500` / 15% opacity | Subtle accent backgrounds                           |
| `--roubo-accent-text`  | `amber-200`               | Accent text on dark backgrounds                     |

### Status Colours

These are functional, not decorative. They remain at full saturation for clarity.

| Status               | Colour                    | Usage                              |
| -------------------- | ------------------------- | ---------------------------------- |
| Active (running)     | `green-500`               | Bench border, component status dot |
| Preparing / Clearing | `amber-500`               | Bench border, progress indicators  |
| Error                | `red-500`                 | Bench border, error states         |
| Idle                 | `stone-300` / `stone-700` | Bench border (light / dark mode)   |

---

## Typography

| Role             | Font           | Weight         | Size    | Tracking | Usage                                |
| ---------------- | -------------- | -------------- | ------- | -------- | ------------------------------------ |
| Product name     | Inter          | 700 (bold)     | 11px    | 0.2em    | Sidebar header "ROUBO"               |
| Section headers  | Inter          | 600 (semibold) | 11px    | 0.15em   | Sidebar section labels               |
| UI text          | Inter          | 400–500        | 13px    | Normal   | Navigation, labels, body             |
| Technical values | JetBrains Mono | 400            | Inherit | Normal   | Ports, paths, branch names, commands |
| Status badges    | Inter          | 500 (medium)   | 10px    | Normal   | Status pills, counts                 |

### Rules

- Use **Inter** for all interface text. It is clean, legible at small sizes, and has the quiet precision the brand requires.
- Use **JetBrains Mono** for any value that a developer might copy, type, or reference: port numbers, file paths, branch names, git commands.
- Hierarchy is created through **weight, size, and opacity**, never through decoration (underlines, backgrounds, borders on text).
- The product name "ROUBO" in the sidebar uses uppercase with wide tracking. It should feel like an engraving: precise, deliberate, permanent.

---

## Voice and Tone

Roubo speaks like a skilled colleague: competent, direct, and economical with words. It does not try to be friendly, funny, or motivational. It is respectful of the user's intelligence and time.

### Principles

- **Direct.** Say what happened. Say what to do. No filler.
- **Precise.** Use exact terms. "Component 'backend' failed to start" not "Something went wrong".
- **Calm.** Errors are stated factually, not dramatised. No red exclamation marks in prose. No "Oops!".
- **Economical.** If ten words will do, don't use twenty.
- **Confident.** No hedging ("maybe try…"), no apologies ("sorry, we couldn't…"). Just state the situation and the options.

### Examples

| Context          | Do                                                                    | Don't                                                                                    |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Bench created    | "Bench 2 ready"                                                       | "Your new bench has been successfully created!"                                          |
| Component failed | "Component 'database' failed to start: port 1434 in use"              | "Oops! Something went wrong starting your database service. Please try again."           |
| Empty state      | "No benches. Set up a bench to start."                                | "Welcome! You don't have any benches yet. Click below to get started on your first one!" |
| Teardown confirm | "Clear Bench 3? This removes the workspace and stops all components." | "Are you sure you want to delete this? This action cannot be undone!"                    |
| Config error     | "roubo.yaml: missing required field 'project.name'"                   | "We found an error in your configuration file. Please check your settings."              |

### Punctuation

- **Never use em dashes (—).** Pick the punctuation that fits the structural role: period for a sentence break, comma for an aside, colon for a label/definition, parentheses for a true parenthetical, semicolon for two tightly linked independent clauses. This rule applies to all writing produced for this project.
- En dashes (–) are fine for numeric ranges only (e.g. `150–300ms`, `1739–1791`).

---

## Do / Don't

### Naming

- **Do** use "Roubo" as a proper noun, capitalised. "Open Roubo", "in Roubo".
- **Don't** say "the Roubo" or "Roubo app"; just "Roubo".
- **Do** use the full vocabulary consistently: bench, project, component, tool, inspection, blueprint.
- **Don't** mix old and new terms. Never "slot" in the UI. Never "service" where "component" is meant.
- **Don't** over-extend the metaphor. If a woodworking term doesn't immediately make sense, use a plain word instead.

### Visual Design

- **Do** use warm neutrals (stone scale) as the foundation.
- **Do** use the brass accent sparingly: primary actions, focus states, active indicators.
- **Don't** use wood textures or literal workshop scene imagery.
- **Do** use tool-adjacent icons (wrench, hammer) as functional indicators where they communicate purpose (see Iconography section).
- **Don't** add decorative elements. No ornamental borders, no flourishes, no gradients.
- **Do** use whitespace generously. Let content breathe.
- **Don't** use divider lines between sections when whitespace and a section header achieve the same clarity.
- **Do** keep animations subtle: 150–300ms, ease-out, no bounce, no overshoot.
- **Don't** add celebration animations (confetti, checkmarks that animate in, success bounces).

### Tone

- **Do** write error messages that include the specific cause and, where possible, a fix.
- **Don't** use exclamation marks in UI text. Ever.
- **Don't** use "please" in system messages. The tool is stating facts, not making requests.
- **Don't** use emoji in the interface.
- **Do** trust the user to understand technical language. "Port 1434 in use" is clearer than "another program is using the connection".

---

## Related files

| File                                                                          | Purpose                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`client/src/assets/roubo-logo.svg`](../client/src/assets/roubo-logo.svg)     | The canonical logomark SVG. Uses `currentColor`.                                     |
| [`../CLAUDE.md`](../CLAUDE.md)                                                | Contributor instructions. Cross-references this document for brand compliance.       |
| [`../schema/roubo-config.schema.json`](../schema/roubo-config.schema.json)    | JSON Schema for `roubo.yaml` validation. Field names follow Roubo's vocabulary.      |
