# Roubo

Local development environment manager for parallel worktree-based development. Named after André-Jacob Roubo, the 18th-century French master carpenter whose workbench design is the gold standard of precision and craft. See `BRANDING.md` for the full brand guide and vocabulary.

## Pre-Push Checks

- Run `npm run format` before pushing (CI enforces `npm run format:check` and will fail on drift)
- Always run lint and typecheck locally before pushing to avoid CI round-trips

## PR Completion Criteria

A PR is only 'complete' when: (1) all CI checks pass, (2) no merge conflicts with main, (3) all review comments addressed. Re-check main for new commits before declaring done, and never declare complete with a TypeScript error in the latest commit.

## Architecture

- **Monorepo** with npm workspaces: `shared/`, `server/`, `client/`
- **Runtime**: Node.js >= 24.14.0 required
- **Server**: Node.js + Express 5 + TypeScript (production port 3333, dev port 3335)
- **Client**: React 19 + Vite + Tailwind CSS 4 (dev port 3334, proxies /api to server at 3335)
- **Shared types**: `@roubo/shared` — imported by both client and server

## Dev Commands

```bash
# Install all dependencies
npm install

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

## Key Directories

- `server/services/` — Business logic (bench-manager, blueprint-manager, config-parser, database, docker, env, exec, github, inspection-runner, issue-assignment, launcher, port-allocator, process-manager, project-registry, repo-scanner, state, terminal, tool-launcher)
- `server/routes/` — Express route handlers (projects, benches, blueprints, containers, database, filesystem, inspection, issues, settings, terminal)
- `client/src/components/` — React UI components
- `client/src/hooks/` — React Query hooks for data fetching
- `client/src/lib/api.ts` — Typed API client
- `schema/` — JSON Schema for roubo.yaml validation
- `shared/types.ts` — All shared TypeScript interfaces

## State Storage

- `~/.roubo/projects.json` — Registered project paths
- `~/.roubo/state.json` — Bench state (ports, branches, workspace paths)
- `~/.roubo/workspaces/<projectName>/bench-<N>/` — Git worktrees

## API Endpoints

```
GET    /api/projects                                    — List registered projects
POST   /api/projects                                    — Register project { repoPath }
DELETE /api/projects/:projectId                         — Unregister project
GET    /api/projects/:projectId/config                  — Get parsed config
GET    /api/benches                                     — List all benches (cross-project)
GET    /api/projects/:projectId/benches                 — List benches for project
POST   /api/projects/:projectId/benches                 — Create bench { branch? }
GET    /api/projects/:projectId/benches/:id             — Get bench detail
DELETE /api/projects/:projectId/benches/:id             — Clear (?removeWorkspace=true)
POST   /api/projects/:projectId/benches/:id/start       — Start all components
POST   /api/projects/:projectId/benches/:id/stop        — Stop all components
POST   /api/projects/:projectId/benches/:id/sync        — Trigger immediate work-unit PR sync
POST   /api/projects/:projectId/benches/:id/components/:name/start
POST   /api/projects/:projectId/benches/:id/components/:name/stop
GET    /api/projects/:projectId/benches/:id/components/:name/logs
GET    /api/projects/:projectId/benches/:id/inspection  — Get inspection results
POST   /api/projects/:projectId/benches/:id/inspection  — Start inspection run
DELETE /api/projects/:projectId/benches/:id/inspection  — Abort inspection run
GET    /api/projects/:projectId/benches/:id/tools       — List tools
POST   /api/projects/:projectId/benches/:id/tools/:index/execute — Execute tool
DELETE /api/projects/:projectId/benches/:id/notifications    — Dismiss all notifications
DELETE /api/projects/:projectId/benches/:id/notifications/:notificationId — Dismiss one notification
POST   /api/projects/:projectId/benches/:id/inject-blueprint — Inject blueprint
GET    /api/projects/:projectId/permissions             — Get project Claude Code tool permissions
PUT    /api/projects/:projectId/permissions             — Replace project Claude Code tool permissions
POST   /api/projects/:projectId/permissions/resync      — Re-inject current permission set into all non-clearing bench workspaces
GET    /api/projects/:projectId/issue-types             — Fetch issue types for project's linked GitHub Project
GET    /api/projects/:projectId/blueprints/issue-type-mappings — Get issue-type → blueprint mappings
PUT    /api/projects/:projectId/blueprints/issue-type-mappings — Replace issue-type → blueprint mappings { mappings }
GET    /api/projects/:projectId/blueprints              — List blueprints
POST   /api/projects/:projectId/blueprints              — Create project-level blueprint (201)
GET    /api/projects/:projectId/blueprints/:id          — Get project blueprint detail
PUT    /api/projects/:projectId/blueprints/:id          — Update project-level blueprint
DELETE /api/projects/:projectId/blueprints/:id          — Delete project-level blueprint (204, 409 if referenced)
GET    /api/projects/:projectId/benches/overrides        — Get bench overrides { autoClear, enforceIssueDependencies, workUnitAutoClear }
PUT    /api/projects/:projectId/benches/overrides        — Set bench overrides (partial body, null removes key)
GET    /api/blueprints                                  — List global blueprints
GET    /api/containers                                  — List database containers
GET    /api/auth/github/status                          — Get GitHub connection status
GET    /api/auth/github/authorize                       — Generate GitHub OAuth authorization URL
POST   /api/auth/github/exchange                        — Exchange OAuth code for token (called by Electron deep-link handler)
GET    /api/notifications/stream                        — SSE stream: real-time notification events
WS     /ws/terminal/:sessionId                          — Terminal session WebSocket
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
| **Blueprint**  | Prompt      | Claude Code agent instructions                                   |
| **Workspace**  | Worktree    | The git worktree directory for a bench                           |

## Design Philosophy

Minimalist means fewer elements, not lesser elements. Every element that exists must be perfect.

- **Typography** — Inter for UI text, JetBrains Mono for code/technical values (ports, paths, commands). Clear hierarchy through weight, size, tracking, and opacity — not through decoration.
- **Visual hierarchy** — When sections need separation, prefer colored accent markers (small dots, icons) + generous whitespace over divider lines. Whitespace (large gap between sections vs small gap within) combined with a visual anchor on section headers is more effective than divider lines.
- **Color** — Warm stone foundation. Amber accent (`amber-500`) for primary actions, active states, and focus indicators. Status colors (green/amber/red) remain bold and functional. Every color communicates meaning — never decorative.
- **Transitions & Animation** — Delicate, purposeful motion. Smooth easing, short durations (150–300ms). Elements feel alive but never distracting. No bouncing, no overshoot.
- **Spacing** — Generous whitespace as a design element. Let content breathe. Consistent use of the spacing scale.
- **Interactive states** — Every interactive element has clear, satisfying hover/active/focus states. The interface should feel like it's responding to the user.
- **Overall feeling** — The user should feel empowered, productive, and in-control. The tool gets out of the way while making every interaction feel precise and considered.

See `BRANDING.md` for the full design system including color tokens, typography rules, and do/don't guidance.

## Testing

- **Framework**: Vitest with a single root config (`vitest.config.ts`)
- Server tests run in Node; client tests run in jsdom (auto-matched by path)
- Test files live next to the code they test: `foo.ts` → `foo.test.ts`
- CI runs `npm run coverage` (enforces 80% lines/functions/branches/statements), lint, and type-check via the `pr-check` workflow
- **Critical**: Any code change not already covered by unit tests must include new unit tests for the change
- **Critical**: Tests must produce zero stderr output. Suppress or eliminate all `console.warn`/`console.error` noise, React `act()` warnings, and library warnings (e.g. React Aria PressResponder). When source code intentionally calls `console.warn`/`console.error` as part of expected behavior (e.g. a fallback path), mock it with `vi.spyOn(console, 'warn').mockImplementation(() => {})` and assert it was called with the expected message — this both silences the output and verifies the behavior. For all other cases, fix the root cause rather than suppressing.

## Configuration Conventions

- This repo uses roubo.yaml for configuration; do NOT propose settings.json or other JSON config alternatives

## Conventions

- Fixed dependency versions (no `^` ranges) — Renovate manages updates
- React Aria Components for interactive elements (Button, Dialog, TextField, Checkbox, Tooltip) + Tailwind CSS for styling. Always prefer React Aria equivalents over native HTML elements (e.g. `<Button>` over `<button>`) — native elements don't integrate with React Aria's event system (tooltips, focus management, etc.)
- Express 5 uses `/{*path}` for wildcard routes (not `*`)
- Never disable ESLint rules — fix the code instead
- Use PUT (not PATCH) for update endpoints — this project does not use PATCH

## Clarifying Questions

- When presenting design options, use concrete plain-language descriptions and mockups; avoid abstract ASCII diagrams
- Offer 3+ options when asking for a design decision
