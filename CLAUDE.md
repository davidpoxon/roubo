# Roubo

Local development environment manager for parallel worktree-based development. Named after André-Jacob Roubo, the 18th-century French master carpenter whose workbench design is the gold standard of precision and craft. See [docs/brand.md](docs/brand.md) for the full brand guide and vocabulary.

## Positioning

Roubo is tool-agnostic across AI coding agents (Claude Code, Codex, Gemini CLI, and others). It is not a Claude Code-only product, even though parts of the current codebase and vocabulary lean Claude Code-specific.

- In marketing copy, marketplace listings, README, `/docs`, in-app strings, and any other user-facing prose, use generic terms like "AI coding agent" or "AI coding tool" rather than naming a specific agent.
- Reserve specific tool names (Claude Code, Codex, Gemini CLI) for technical docs, integration lists, and feature pages where naming the integration is the point.
- When touching code or vocabulary that hardcodes "Claude Code" (e.g. the Jig definition below, the `/api/projects/:projectId/permissions` endpoint comments), flag it as a candidate for generalization as multi-agent support expands.

## Writing Style

- **Never use em dashes (—).** Not in code comments, commit messages, PR descriptions, README, `/docs`, in-app strings, or any other prose we ship or commit. Pick the right punctuation for the case: period for a sentence break, comma for an aside, colon for a label/definition, parentheses for a true parenthetical, semicolon for two tightly linked independent clauses. This rule applies to all writing produced in this repo.
- En dashes (–) are fine for numeric ranges only (e.g. `150–300ms`, `1739–1791`).

## Pre-Push Checks

- Run `npm run format` before pushing (CI enforces `npm run format:check` and will fail on drift)
- Always run lint and typecheck locally before pushing to avoid CI round-trips

## PR Completion Criteria

A PR is only 'complete' when: (1) all CI checks pass, (2) no merge conflicts with main, (3) all review comments addressed. Re-check main for new commits before declaring done, and never declare complete with a TypeScript error in the latest commit.

## Follow-up References

When a code comment, commit message, PR description, or plan file mentions deferred work, always open a GitHub issue first and reference it by number (e.g. `#119`) inline. Never gesture at "a follow-up issue" or name the issue by title alone, and never inline a description as a substitute for filing the issue. The flow is: open the ticket, capture the number, then write the reference.

## Architecture

- **Monorepo** with npm workspaces: `shared/`, `server/`, `client/`
- **Runtime**: Node.js >= 24.14.0 required
- **Server**: Node.js + Express 5 + TypeScript (production port 3333, dev port 3335)
- **Client**: React 19 + Vite + Tailwind CSS 4 (dev port 3334, proxies /api to server at 3335)
- **Shared types**: `@roubo/shared`, used by both client and server

## Dev Commands

```bash
# Install all dependencies
nvm use && npm install

# Run both server and client (from root)
npm run dev

# Run server only (from root, no hot-reload)
npx tsx server/index.ts

# Run client dev server only (from root)
npm run dev -w client

# Type-check
npx -w client tsc --noEmit
npx -w server tsc --noEmit

# Test
npm test                    # run all tests once
npx vitest                  # run in watch mode
npx vitest server/          # run only server tests
npx vitest client/          # run only client tests

# Lint
npm run lint
npm run lint:fix

# Format
npm run format          # write
npm run format:check    # CI parity check
```

**Running inside a Roubo bench:** terminals opened by a released Roubo app may carry the host's `ROUBO_PRODUCTION`, `ROUBO_SEED_DIR`, and `ROUBO_PORT` (fixed by #877, but the app you are running may predate the fix). With `ROUBO_PRODUCTION` inherited, a dev or e2e server resolves state to the real `~/.roubo` instead of `~/.roubo-dev/<checkout>`. Prefix server and e2e commands with `env -u ROUBO_PRODUCTION -u ROUBO_SEED_DIR -u ROUBO_PORT` when in doubt.

## Key Directories

- `server/services/`: business logic (bench-manager, jig-manager, config-parser, database, docker, env, exec, github, inspection-runner, issue-assignment, launcher, port-allocator, process-manager, project-registry, repo-scanner, state, terminal, tool-launcher)
- `server/routes/`: Express route handlers (projects, benches, jigs, containers, database, filesystem, inspection, issues, settings, terminal)
- `client/src/components/`: React UI components
- `client/src/hooks/`: React Query hooks for data fetching
- `client/src/lib/api.ts`: typed API client
- `schema/`: JSON Schema for roubo.yaml validation
- `shared/types.ts`: all shared TypeScript interfaces

## State Storage

- `~/.roubo/projects.json`: registered project paths
- `~/.roubo/state.json`: bench state (ports, branches, workspace paths)
- `~/.roubo/workspaces/<projectName>/bench-<N>/`: git worktrees

## API Endpoints

```
GET    /api/projects   List registered projects
POST   /api/projects   Register project { repoPath }
DELETE /api/projects/:projectId   Unregister project
GET    /api/projects/:projectId/config   Get parsed config
GET    /api/benches   List all benches (cross-project)
GET    /api/projects/:projectId/benches   List benches for project
POST   /api/projects/:projectId/benches   Create bench { branch? }
GET    /api/projects/:projectId/benches/:id   Get bench detail
DELETE /api/projects/:projectId/benches/:id   Clear (?removeWorkspace=true)
POST   /api/projects/:projectId/benches/:id/start   Start all components
POST   /api/projects/:projectId/benches/:id/stop   Stop all components
POST   /api/projects/:projectId/benches/:id/components/:name/start
POST   /api/projects/:projectId/benches/:id/components/:name/stop
GET    /api/projects/:projectId/benches/:id/components/:name/logs
GET    /api/projects/:projectId/benches/:id/audit-log   Query recorded privileged broker calls (optional ?pluginId=), chronological AuditEntry[]
GET    /api/projects/:projectId/benches/:id/inspection   Get inspection results
POST   /api/projects/:projectId/benches/:id/inspection   Start inspection run
DELETE /api/projects/:projectId/benches/:id/inspection   Abort inspection run
GET    /api/projects/:projectId/benches/:id/tools   List tools
POST   /api/projects/:projectId/benches/:id/tools/:index/execute   Execute tool
DELETE /api/projects/:projectId/benches/:id/notifications   Dismiss all notifications
DELETE /api/projects/:projectId/benches/:id/notifications/:notificationId   Dismiss one notification
POST   /api/projects/:projectId/benches/:id/inject-jig   Inject jig
POST   /api/projects/:projectId/issues/:externalId/assign   Assign issue to user via active integration plugin
DELETE /api/projects/:projectId/issues/:externalId/assign   Unassign issue from user via active integration plugin
GET    /api/projects/:projectId/permissions   Get project Claude Code tool permissions
PUT    /api/projects/:projectId/permissions   Replace project Claude Code tool permissions
POST   /api/projects/:projectId/permissions/resync   Re-inject current permission set into all non-clearing bench workspaces
GET    /api/projects/:projectId/integration/status-categories   Discover the connected instance's live status categories (graceful fallback when unsupported)
GET    /api/projects/:projectId/issue-types   Fetch issue types for project's linked GitHub Project
GET    /api/projects/:projectId/jigs/issue-type-mappings   Get issue-type → jig mappings
PUT    /api/projects/:projectId/jigs/issue-type-mappings   Replace issue-type → jig mappings { mappings }
GET    /api/projects/:projectId/jigs   List jigs
POST   /api/projects/:projectId/jigs   Create project-level jig (201)
GET    /api/projects/:projectId/jigs/:id   Get project jig detail
PUT    /api/projects/:projectId/jigs/:id   Update project-level jig
DELETE /api/projects/:projectId/jigs/:id   Delete project-level jig (204, 409 if referenced)
GET    /api/projects/:projectId/benches/overrides   Get bench overrides { enforceIssueDependencies }
PUT    /api/projects/:projectId/benches/overrides   Set bench overrides (partial body, null removes key)
GET    /api/projects/:projectId/gates   List effective verify gates as { gates: GateState[], invalidSpecs: { slug, errors }[] } (operator merge/split overrides applied; invalidSpecs names present-but-invalid work-units.json specs skipped from the load)
GET    /api/projects/:projectId/gates/:gateId   Get one effective gate's GateState (404 unknown id)
POST   /api/projects/:projectId/gates/merge   Record an operator merge { gateIds } (409 if a gate is signed off, 400 unknown id / cross-spec)
POST   /api/projects/:projectId/gates/split   Record an operator split { gateId, parts } (409 if signed off, 400 unknown id / non-partition)
POST   /api/projects/:projectId/gates/:gateId/fix-issues   File a fix issue for a failed gating case and block the gate { failedCaseId, notes, evidence?, existingFixRef? } (201 complete / 207 link_pending / 422 empty notes or capability absent / 409 no tracker ref or no integration / 400 path-escaping evidence)
DELETE /api/projects/:projectId/gates/overrides   Reset all operator gate regroupings (204)
GET    /api/jigs   List global jigs
GET    /api/containers   List database containers
GET    /api/plugins/:pluginId/integration   Get per-plugin global default + manifest snippet
POST   /api/plugins/:pluginId/integration/test   Test a config snapshot against the plugin (uses ~/.roubo/integrations/_global/{pluginId}.yaml)
PUT    /api/plugins/:pluginId/integration/config   Persist global defaults for the plugin (rejects `sources`)
POST   /api/plugins/github-com/oauth/authorize   Generate GitHub OAuth authorization URL
POST   /api/plugins/github-com/oauth/exchange   Exchange OAuth code for token (called by Electron deep-link handler)
GET    /api/notifications/stream   SSE stream: real-time notification events
WS     /ws/terminal/:sessionId   Terminal session WebSocket
```

## Brand Vocabulary

Always use the Roubo vocabulary in all new code, UI text, and documentation:

| Term           | Replaces    | Meaning                                                          |
| -------------- | ----------- | ---------------------------------------------------------------- |
| **Bench**      | Slot        | Isolated dev environment (worktree + ports + running components) |
| **Project**    | Application | Registered repository with a `roubo.yaml` config                 |
| **Component**  | Service     | A running part of a bench (database, backend, frontend)          |
| **Tool**       | Launcher    | Quick-open action (browser, IDE, shell)                          |
| **Inspection** | Testing     | Quality checks run against a bench                               |
| **Jig**        | Prompt      | AI coding agent instructions injected into the bench workspace   |
| **Workspace**  | Worktree    | The git worktree directory for a bench                           |

## Design Philosophy

Minimalist means fewer elements, not lesser elements. Every element that exists must be perfect.

- **Typography.** Inter for UI text, JetBrains Mono for code/technical values (ports, paths, commands). Clear hierarchy through weight, size, tracking, and opacity, not through decoration.
- **Visual hierarchy.** When sections need separation, prefer colored accent markers (small dots, icons) + generous whitespace over divider lines. Whitespace (large gap between sections vs small gap within) combined with a visual anchor on section headers is more effective than divider lines.
- **Color.** Warm stone foundation. Amber accent (`amber-500`) for primary actions, active states, and focus indicators. Status colors (green/amber/red) remain bold and functional. Every color communicates meaning, never decoration.
- **Transitions & Animation.** Delicate, purposeful motion. Smooth easing, short durations (150–300ms). Elements feel alive but never distracting. No bouncing, no overshoot.
- **Spacing.** Generous whitespace as a design element. Let content breathe. Consistent use of the spacing scale.
- **Interactive states.** Every interactive element has clear, satisfying hover/active/focus states. The interface should feel like it's responding to the user.
- **Overall feeling.** The user should feel empowered, productive, and in-control. The tool gets out of the way while making every interaction feel precise and considered.

See [docs/brand.md](docs/brand.md) for the full design system including color tokens, typography rules, and do/don't guidance.

## Testing

- **Framework**: Vitest with a single root config (`vitest.config.ts`)
- Server tests run in Node; client tests run in jsdom (auto-matched by path)
- Test files live next to the code they test: `foo.ts` → `foo.test.ts`
- CI runs `npm run coverage` (enforces 80% lines/functions/branches/statements), lint, and type-check via the `pr-check` workflow
- **Critical**: Any code change not already covered by unit tests must include new unit tests for the change
- **Critical**: Tests must produce zero stdout and zero stderr output (beyond the vitest reporter's own summary). Suppress or eliminate all `console.log`/`console.info`/`console.warn`/`console.error` noise, React `act()` warnings, and library warnings (e.g. React Aria PressResponder). Vitest hides captured console output during passing runs by default; verify cleanliness with `npx vitest run --disableConsoleIntercept`. When source code intentionally calls `console.*` as part of expected behavior (e.g. a fallback path), mock it with `vi.spyOn(console, '<level>').mockImplementation(() => {})` and assert it was called with the expected message. This both silences the output and verifies the behavior. For all other cases, fix the root cause rather than suppressing.

## Configuration Conventions

- This repo uses roubo.yaml for configuration; do NOT propose settings.json or other JSON config alternatives

## Conventions

- Fixed dependency versions (no `^` ranges); Renovate manages updates
- React Aria Components for interactive elements (Button, Dialog, TextField, Checkbox, Tooltip) + Tailwind CSS for styling. Always prefer React Aria equivalents over native HTML elements (e.g. `<Button>` over `<button>`). Native elements don't integrate with React Aria's event system (tooltips, focus management, etc.)
- Express 5 uses `/{*path}` for wildcard routes (not `*`)
- Never disable ESLint rules. Fix the code instead
- Use PUT (not PATCH) for update endpoints. This project does not use PATCH

## Clarifying Questions

- When presenting design options, use concrete plain-language descriptions and mockups; avoid abstract ASCII diagrams
- Offer 3+ options when asking for a design decision
