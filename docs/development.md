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
npm install
```

`npm install` resolves the npm workspaces (`shared`, `server`, `client`, `electron`) in a single pass.

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

## Testing

Roubo uses [Vitest](https://vitest.dev) with a single root config. Server tests run in Node; client tests run in jsdom, both auto-matched by file path. Test files live next to the code they test (`foo.ts` → `foo.test.ts`).

```bash
npm test                    # run everything once
npx vitest                  # watch mode
npx vitest server/          # server tests only
npx vitest client/          # client tests only
npm run coverage            # CI-parity run with v8 coverage
```

CI enforces **80% coverage** on lines, functions, branches, and statements via the `pr-check` workflow. Code changes not covered by existing tests must come with new tests. Tests must also produce **zero stderr output**. Suppress or eliminate `console.warn`/`console.error` noise and React `act()` warnings rather than ignoring them. Where the source legitimately calls `console.warn`/`console.error`, mock it with `vi.spyOn` and assert on the arguments.

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
├── schema/                  # JSON Schema for roubo.yaml validation
├── .github/workflows/       # CI: pr-check, dco, release
└── eslint.config.js         # ESLint 9 flat config
```

This is an npm-workspaces monorepo. The `shared/` workspace exports types as `@roubo/shared`, consumed by both `server/` and `client/`.

## Tech stack

| Layer            | Technology                                                       |
| ---------------- | ---------------------------------------------------------------- |
| Server           | Express 5, TypeScript, dockerode, tsx                            |
| Client           | React 19, Vite, Tailwind CSS 4, React Aria Components            |
| Data fetching    | TanStack React Query (5s polling for live state)                 |
| Desktop wrapper  | Electron 38 + electron-forge                                     |
| Persistent state | `~/.roubo/` (JSON files)                                         |
| Project config   | `roubo.yaml`, validated with JSON Schema + AJV                   |
| Tests            | Vitest, Testing Library, supertest, jsdom                        |

Dependencies are pinned (no `^` ranges) and updated by Renovate. Never widen a range manually.

## Conventions

- **React Aria Components** for interactive UI: `<Button>` not `<button>`, `<Dialog>` not a custom modal. Native HTML elements don't integrate with React Aria's event system (tooltips, focus management).
- **PUT, not PATCH**, for update endpoints.
- **Express 5 wildcard syntax** is `/{*path}`, not `*`.
- **Never disable an ESLint rule**. Fix the code.
- All user-facing text must use the Roubo vocabulary (bench, project, component, …). See [brand.md](./brand.md).

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
