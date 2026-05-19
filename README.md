# Roubo

Local development environment manager for parallel worktree-based development. Provides a single dashboard to set up, monitor, and clear isolated development environments (benches) for any registered project.

Named after André-Jacob Roubo (1739–1791), French master carpenter and author of _L'Art du Menuisier_. His workbench design — precise, purposeful, nothing superfluous — is the inspiration for this tool.

## Prerequisites

- Node.js >=24.14.0
- Docker Desktop (for database containers)
- Git

## Quick Start

```bash
# Install dependencies
npm install

# Start both server and client in dev mode
npm run dev
```

The server runs on **http://localhost:3333** and the client dev server on **http://localhost:3334** (proxies API requests to the server).

## Install Globally

> **Requires Node.js >=24.14.0**

```bash
# Build client + server and install globally
# (the prepare script runs the full build automatically; postinstall compiles native bindings)
npm install -g .

# Start Roubo
roubo

# Open browser automatically after start
roubo --open
```

Open **http://localhost:3333** in your browser, then go to Settings to register your first project by providing the path to a repo containing a `roubo.yaml`.

### CLI Options

```
roubo [options]

Options:
  -p, --port <number>  Port to listen on (default: 3333)
  -o, --open           Open browser after server starts
  -q, --quiet          Suppress update notices
  -v, --version        Print version number
  -h, --help           Print this help message
```

> **Note:** Port 3334 is only used in development mode (`npm run dev`). The globally installed `roubo` serves the pre-built client SPA directly from the Express server on port 3333.

## Development

### Running

```bash
# Start everything (server + client)
npm run dev

# Or run individually
npm run dev:server    # Express server on :3333
npm run dev:client    # Vite dev server on :3334
```

### Code Quality

```bash
# Lint
npm run lint
npm run lint:fix

# Format (CI runs `format:check` and fails on drift)
npm run format
npm run format:check

# Type-check
npx -w client tsc --noEmit
npx -w server tsc --noEmit
```

### Project Structure

```
roubo/
├── shared/           # Shared TypeScript types (@roubo/shared)
├── server/           # Express API server
│   ├── index.ts      # Entry point (port 3333)
│   ├── routes/       # API route handlers
│   └── services/     # Business logic
├── client/           # React frontend (Vite)
│   └── src/
│       ├── components/
│       ├── hooks/    # React Query data fetching
│       └── lib/      # API client
├── schema/           # JSON Schema for roubo.yaml validation
└── eslint.config.js  # ESLint 9 flat config
```

This is an npm workspaces monorepo. Shared types in `shared/` are imported by both server and client as `@roubo/shared`.

### Tech Stack

| Layer         | Technology                                                      |
| ------------- | --------------------------------------------------------------- |
| Server        | Express 5, TypeScript, dockerode, tsx                           |
| Client        | React 19, Vite, Tailwind CSS 4, React Aria Components           |
| Data fetching | TanStack React Query (5s polling)                               |
| State         | `~/.roubo/` (JSON files)                                        |
| Config        | `roubo.yaml` per project repo, validated with JSON Schema + ajv |

## How It Works

### Project Registration

Each project repo includes a `roubo.yaml` at `.roubo/roubo.yaml` that describes how to provision benches. Register a project by providing the repo path — Roubo parses and validates the config, checks for port conflicts with other registered projects, and adds it to the registry.

### Benches

A bench is an isolated dev environment for one project: a git worktree, Docker containers, and managed processes. Each bench gets its own port range calculated from the base ports in the project's config.

Setting up a bench:

1. Claims the next available bench number (1 to `benches.max`)
2. Allocates ports: `base + (benchNumber - 1)` for each component
3. Creates a git worktree at `~/.roubo/workspaces/<projectName>/bench-<N>/`
4. Initializes submodules (for meta-repos)

Starting components within a bench:

1. **Database** — `docker compose up` with port overrides, wait for healthy, run migrations
2. **Backend** — `dotnet run` with resolved environment variables
3. **Frontend** — generates `.env` file, runs `npm run dev`

### API

All operations are available via REST API so Claude Code agents can self-serve:

```
GET    /api/projects                                      # List registered projects
POST   /api/projects                                      # Register { repoPath }
DELETE /api/projects/:projectId                           # Unregister
GET    /api/benches                                       # All benches across projects
POST   /api/projects/:projectId/benches                   # Set up bench { branch? }
DELETE /api/projects/:projectId/benches/:id               # Clear bench
POST   /api/projects/:projectId/benches/:id/start         # Start all components
POST   /api/projects/:projectId/benches/:id/stop          # Stop all components
POST   /api/projects/:projectId/benches/:id/components/:name/start
POST   /api/projects/:projectId/benches/:id/components/:name/stop
GET    /api/projects/:projectId/benches/:id/components/:name/logs
```

### roubo.yaml

See `BRANDING.md` for vocabulary and `schema/roubo-config.schema.json` for the full config schema.

## Building the Desktop App

```bash
npm run electron:make
```

This produces a local unsigned build. Unsigned artifacts trigger Gatekeeper warnings on other machines.

Internally, `npm run electron:make` performs a nested `npm install` inside `electron/` before running `electron-forge make`. This populates `electron/node_modules/` with the production deps (`mssql`, `node-pty`, `update-electron-app`) that npm otherwise hoists to the repo root — `electron-forge`'s dependency walker (`flora-colossus`) cannot follow the hoist, so the packaging step would fail without it. The install uses `--no-save --package-lock=false` and does not mutate any tracked files.

For signed/notarized release builds and the full release checklist, see [RELEASING.md](RELEASING.md).
