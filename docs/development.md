# Development

This guide is for working on Roubo itself. If you just want to use it, start with [Getting Started](./getting-started.md).

## Prerequisites

- **Node.js** >= 24.14.0. Version is pinned in [`.nvmrc`](../.nvmrc); `nvm use` will pick it up.
- **Docker Desktop**. Required for database containers in benches you set up against test projects.
- **Git**.

## Setup

```bash
git clone https://github.com/davidpoxon/roubo.git
cd roubo
nvm use
npm install
```

`npm install` resolves every npm workspace in a single pass: `shared`, `plugin-sdk`, `server`, `client`, `electron`, the first-party plugins under `plugins/`, and the e2e fixtures. The authoritative list is the `workspaces` array in the root [`package.json`](../package.json).

## Running the dev stack

```bash
# Server + client together
npm run dev
```

This runs the Express API server on **`localhost:3335`** and the Vite dev server for the client on **`localhost:3334`**. The Vite dev server proxies `/api` requests to the Express server. Open `http://localhost:3334` in your browser to use the dev UI.

To run the Electron app on top of the dev servers:

```bash
npm run electron:dev
```

This spawns the Vite dev server, the Express server, and Electron together with hot reload on the renderer side.

To run pieces individually:

```bash
npm run dev:server    # Express only, port 3335
npm run dev:client    # Vite only, port 3334
```

> **Note.** Production builds (both the Electron app and a globally-run server) serve everything from a single Express process on port **3333**. The split ports (3334 / 3335) are only used during `npm run dev`.

## Code quality

CI runs all of the following on every PR. Run them locally before pushing to avoid round-trips.

```bash
# Lint
npm run lint
npm run lint:fix      # auto-fix where possible

# Format (CI runs format:check and fails on drift)
npm run format
npm run format:check

# Type-check
npm run typecheck
```

> **Note.** `npm run typecheck` covers the SDK, client, server, project build, plugin, and e2e fixture workspaces. The CI `typecheck` job only runs `client` and `server`, so the local command is the stricter gate: a green CI run does not mean the plugin and fixture workspaces type-check.

## Testing

Roubo uses [Vitest](https://vitest.dev) with a single root config. Server tests run in Node; client tests run in jsdom, both auto-matched by file path. Test files live next to the code they test (`foo.ts` → `foo.test.ts`).

```bash
npm test                    # run everything once
npx vitest                  # watch mode
npx vitest server/          # server tests only
npx vitest client/          # client tests only
npm run coverage            # CI-parity run with v8 coverage
npm run test:perf           # the performance harnesses, budget assertions on
npx vitest run --disableConsoleIntercept   # verify a suite is genuinely silent
```

Performance budgets live in `*.perf*.test.*` files beside the code they measure. Their budget assertions are gated behind `RUN_PERF_HARNESS=1`, so the default run skips them (a wall-clock assertion on a shared CI runner is a flake generator) and each file keeps a sentinel plus a non-gated structural test so it still asserts something. `npm run test:perf` sets the flag, runs those files alone, and prints each one's `perf-evidence` JSON. No CI job runs them; they are an opt-in local check.

CI enforces **80% coverage** on lines, functions, branches, and statements via the `pr-check` workflow. Code changes not covered by existing tests must come with new tests.

Tests must also produce **zero stdout and zero stderr output**, beyond the Vitest reporter's own summary. That covers `console.log`, `console.info`, `console.warn`, and `console.error` noise, React `act()` warnings, and library warnings such as React Aria's `PressResponder`. Vitest hides captured console output during passing runs by default, so a clean-looking run proves nothing; verify with `npx vitest run --disableConsoleIntercept`.

Where the source legitimately calls `console.*` as part of expected behaviour (a fallback path, for instance), mock it with `vi.spyOn(console, "<level>").mockImplementation(() => {})` and assert it was called with the expected message. That silences the output and verifies the behaviour at once. In every other case, fix the root cause rather than suppressing the symptom.

## Project structure

```
roubo/
├── shared/                  # @roubo/shared, TypeScript types imported by both server and client
├── server/                  # Express API server
│   ├── index.ts             # Entry point
│   ├── routes/              # Express route handlers
│   └── services/            # Business logic (bench-manager, port-allocator, docker, …)
├── client/                  # React 19 + Vite frontend
│   └── src/
│       ├── components/      # UI components
│       ├── hooks/           # React Query data fetching
│       └── lib/             # API client
├── electron/                # Electron wrapper (forge config, main process)
├── plugin-sdk/              # @roubo/plugin-sdk, published independently
├── plugins/                 # First-party bundled plugins (github-com, process, database)
├── schema/                  # JSON Schema for roubo.yaml and plugin manifests
├── scripts/                 # Lint guards, schema generation, git hooks, release tooling
├── e2e/                     # Playwright specs and their fixture workspaces
├── docs/                    # This documentation set
├── .github/workflows/       # CI: pr-check, dco, no-ai-coauthorship, e2e, release
└── eslint.config.js         # ESLint 9 flat config
```

This is an npm-workspaces monorepo. The `shared/` workspace exports types as `@roubo/shared`, consumed by both `server/` and `client/`.

## Tech stack

| Layer            | Technology                                            |
| ---------------- | ----------------------------------------------------- |
| Server           | Express 5, TypeScript, dockerode, tsx                 |
| Client           | React 19, Vite, Tailwind CSS 4, React Aria Components |
| Data fetching    | TanStack React Query (5s polling for live state)      |
| Desktop wrapper  | Electron 38 + electron-forge                          |
| Persistent state | `~/.roubo/` (JSON files)                              |
| Project config   | `roubo.yaml`, validated with JSON Schema + AJV        |
| Tests            | Vitest, Testing Library, supertest, jsdom             |

Dependencies are pinned (no `^` ranges) and updated by Renovate. Never widen a range manually.

## Conventions

- **React Aria Components** for interactive UI: `<Button>` not `<button>`, `<Dialog>` not a custom modal. Native HTML elements don't integrate with React Aria's event system (tooltips, focus management).
- **PUT, not PATCH**, for update endpoints.
- **Express 5 wildcard syntax** is `/{*path}`, not `*`.
- **Never disable an ESLint rule**. Fix the code.
- All user-facing text must use the Roubo vocabulary (bench, project, component, …). See [brand.md](./brand.md).
- **No em dashes** in any prose we ship or commit, including code comments, commit messages, and PR descriptions. See [brand.md](./brand.md#punctuation); partially enforced by `npm run lint:em-dash`.

The CI gates that are not visible from the code, and the repo-specific gotchas worth knowing before you run anything, are in [CLAUDE.md](../CLAUDE.md).

## Building the desktop app

```bash
npm run electron:make
```

This builds the client and server, then runs `electron-forge make`, producing an unsigned local DMG and ZIP under `electron/out/`. Unsigned artifacts trigger Gatekeeper warnings on other machines. They are fine for local testing, not for distribution.

Internally, `electron:make` performs a nested `npm install` inside `electron/` before invoking `electron-forge make`. This populates `electron/node_modules/` with the production dependencies (`mssql`, `node-pty`, `update-electron-app`) that npm normally hoists to the repo root. electron-forge's dependency walker (`flora-colossus`) cannot follow the hoist, so without this step packaging fails with `Failed to locate module "mssql" …`. The install uses `--no-save --package-lock=false` and does not modify any tracked files.

For **signed, notarized release builds** and the full release checklist (including the GitHub Actions workflow, code signing certificates, and notarization), see [releasing.md](./releasing.md).

## Pre-push checklist

Run the same checks CI runs, in this order:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

If any of these fail locally, CI will fail too. The fix is faster locally.

## Contributing back

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the PR process, DCO sign-off, and what to expect during review.
