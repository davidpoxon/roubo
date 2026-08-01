# Roubo

Local development environment manager for parallel worktree-based development. Named after André-Jacob Roubo, the 18th-century French master carpenter whose workbench design is the gold standard of precision and craft.

The docs below are the source of truth. This file holds only what reading the repo will not tell you.

| For                                                       | Read                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Concepts, `~/.roubo` state layout, bench lifecycle        | [docs/architecture.md](docs/architecture.md)                                                            |
| Setup, commands, project structure, conventions, pre-push | [docs/development.md](docs/development.md)                                                              |
| API                                                       | [docs/api.md](docs/api.md), then the generated [docs/routes.md](docs/routes.md) for the full route list |
| `roubo.yaml` reference                                    | [docs/configuration.md](docs/configuration.md)                                                          |
| Vocabulary, voice, colour, typography, do/don't           | [docs/brand.md](docs/brand.md)                                                                          |
| Design tokens and component specs (machine-checkable)     | [DESIGN.md](DESIGN.md)                                                                                  |
| Plugin authoring                                          | [docs/plugin-sdk.md](docs/plugin-sdk.md)                                                                |
| PR process, DCO sign-off                                  | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                      |

## Positioning

Roubo is tool-agnostic across AI coding agents (Claude Code, Codex, Gemini CLI, and others), even though parts of the codebase and vocabulary still lean Claude Code-specific.

- In user-facing prose (marketing copy, marketplace listings, README, `/docs`, in-app strings) write "AI coding agent" or "AI coding tool", never a specific product name.
- Reserve specific names for technical docs, integration lists, and feature pages where naming the integration is the point.
- When you touch code that hardcodes "Claude Code", flag it as a candidate for generalisation as multi-agent support expands.

## CI gates you cannot infer from the code

- **`no-ai-coauthorship`** fails a PR when a `Co-Authored-By:` trailer on any commit in the range, or the PR body, credits an AI coding agent, or when either carries a "Generated with ..." attribution footer. Roubo commits credit the human author only. Denylist: `scripts/check-ai-coauthorship.mjs`.
- **`schema-drift`** re-runs `npm run generate:schema` and fails on any diff under `schema/`. Change a zod source, regenerate, and commit the output. The hand-authored `schema/roubo-*.json` files are exempt.
- **`route-inventory-drift`** re-runs `npm run generate:routes` and fails on any diff in `docs/routes.md`. Add, remove, or rename a route, regenerate, and commit the output.
- **`lint:component-guard`** (CP-NFR-006) fails if a component-type literal or a docker/compose field branch reappears in `server/` or `shared/`.
- **`lint:agent-guard`** (AP-NFR-006) fails if `server/` or `shared/` regrows an agent-specific identifier (any symbol or property naming a specific AI coding agent) or assembles a native agent CLI flag itself. Agent names survive in core only inside string literals: the install-location table, the `/claude-notification` hook endpoint, the workspace settings path. Denylist: `scripts/agent-identifier-guard.mjs`.
- **`lint:em-dash`** enforces the no-em-dash rule from [docs/brand.md](docs/brand.md#punctuation), but only over tracked files under `server/ client/ shared/ schema/ docs/`. The rule itself also covers commit messages, PR bodies, `plugins/`, `electron/`, `e2e/`, and root markdown, where nothing checks it.
- The `commit-msg` hook installed by `npm install` requires a DCO `Signed-off-by` line matching `git config user.email`.
- `npm run typecheck` covers the SDK, client, server, project build, plugin, and e2e fixture workspaces. The CI `typecheck` job only runs client and server, so the local command is the stricter gate, not the looser one.
- `.claude/hooks/pre-push-checks.sh` runs prettier, lint, and typecheck on any `git push` but always exits 0. It advises rather than blocks, so read what it prints.

## Gotchas

- Terminals opened by a released Roubo app may carry the host's `ROUBO_PRODUCTION` and `ROUBO_PORT` (fixed by #877, but the app you are running may predate the fix). With `ROUBO_PRODUCTION` inherited, a dev or e2e server resolves state to the real `~/.roubo` instead of `~/.roubo-dev/<checkout>`, so it writes to live state. Prefix server and e2e commands with `env -u ROUBO_PRODUCTION -u ROUBO_PORT` when in doubt.
- Vitest hides captured console output on passing runs. Confirm a suite is genuinely silent with `npx vitest run --disableConsoleIntercept`.

## Vocabulary

Never reintroduce the legacy terms. Slot is a **bench**, application is a **project**, service is a **component**, launcher is a **tool**, testing is an **inspection**, prompt is a **jig**, worktree is a **workspace**. Definitions, status labels, and action labels are in [docs/brand.md](docs/brand.md#vocabulary).

## Working agreements

- Configuration is `roubo.yaml`. Do not propose `settings.json` or other JSON alternatives.
- Deferred work is cited by issue number. File the GitHub issue first, then write the reference inline (`#119`). Never "a follow-up issue", never the issue title alone, and never an inline description instead of the filed issue.
- A PR is done when CI is green, main merges cleanly, and every review comment is resolved.
- When a design decision needs input, offer three or more concrete options in plain language. No ASCII diagrams.
- Delegate narrowly. Subagents are for read-only exploration you would otherwise do serially across unrelated areas; cap at three concurrent for one task. Implementation, refactors, and anything that writes to the tree stay in this thread.
- Size written deliverables to their content, not to a default. Match the length and section depth of the nearest existing example of the same artifact in this repo.
