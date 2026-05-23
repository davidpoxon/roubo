# Architecture

This document describes how Roubo is put together: the concepts you'll see in the UI, how state moves through the system, and the API surface.

## Concepts

Roubo's vocabulary is deliberate; every term carries meaning. See [brand.md](./brand.md) for the full glossary; the essentials are below.

| Term           | What it is                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- |
| **Project**    | A registered repository with a `roubo.yaml` config.                                         |
| **Bench**      | An isolated dev environment for one project: a git worktree, ports, and running components. |
| **Component**  | A running part of a bench, typically a database, backend, and frontend.                     |
| **Tool**       | A quick-open action defined in `roubo.yaml`: open the browser, launch the IDE, run a shell. |
| **Inspection** | Running quality checks (tests, lints) against the work on a bench.                          |
| **Jig**        | AI coding agent instructions injected into a bench's workspace.                             |
| **Workspace**  | The git worktree directory on disk for a specific bench.                                    |

A project can have multiple benches. Each bench is fully isolated from the others: its own worktree, its own port range, its own database container, its own running processes. This is the whole point of Roubo: you can run several agents (or several streams of your own work) against the same project, in parallel, with no collisions.

## State storage

Roubo keeps all of its state under `~/.roubo/`:

```
~/.roubo/
├── projects.json                  # Registered projects: path → metadata
├── state.json                     # All benches: ports, branches, statuses
├── auth.json                      # GitHub OAuth token (mode 0600)
└── workspaces/
    └── <projectName>/
        └── bench-<N>/             # Git worktree for bench N
```

`projects.json` and `state.json` are plain JSON. If you need to inspect or surgically edit the system state, that's where to look. The directory layout is stable.

## Project registration

When you register a project by pointing Roubo at its repo path, Roubo:

1. Reads `.roubo/roubo.yaml` from the repo.
2. Validates it against [`schema/roubo-config.schema.json`](../schema/roubo-config.schema.json) using AJV.
3. Checks the project's port bases against every other registered project. If a base conflicts, registration fails with a clear error showing the conflict.
4. Writes the project into `~/.roubo/projects.json`.

The repo itself isn't modified. Roubo only reads the config and remembers the path.

## Benches

### Numbering and port allocation

Each project declares a maximum number of benches in `benches.max`. Bench numbers are claimed from `1` to `max` in order; freed numbers are re-used when a bench is cleared.

Each component declares a port `base` in `roubo.yaml`. The port assigned to a given bench is:

```
port = base + (benchNumber − 1)
```

So if `ports.server.base = 4100` and you set up bench 3, the server runs on port `4102`. The arithmetic is intentionally trivial. You can predict exactly which port a bench will use, and ports are stable across restarts.

### Worktree

When a bench is set up, Roubo creates a git worktree at:

```
~/.roubo/workspaces/<projectName>/bench-<N>/
```

This is a real git worktree, not a copy. You can `cd` into it, edit files, run `git status`, push, and pull as normal. Roubo just owns its lifecycle: it creates the worktree on **Set up bench** and removes it on **Clear bench**.

For meta-repos (a parent repo that holds submodules pointing at sub-repos), Roubo also initialises the submodules during setup. The `layout` section of `roubo.yaml` controls this.

### Setup sequence

When you click **Set up bench**, Roubo runs the following in order:

1. Claim the next bench number.
2. Compute and allocate ports for every component.
3. Create the git worktree.
4. Initialise submodules (meta-repos only).
5. Run `benches.setup` if defined (typically `npm ci` or similar workspace-wide setup).

When you click **Start**, Roubo starts each component in dependency order (declared via `dependsOn`):

1. **Database components** run `docker compose up` with port overrides, wait for the container to report healthy, then run migrations.
2. **Process components** run their configured command with environment variables resolved from the template (`{{ports.x}}`, `{{urls.y}}`, `{{workspace}}`).

Components are torn down in reverse dependency order on **Stop**.

## Components

Two kinds of component are supported, declared by the `type` field in `roubo.yaml`:

| `type`     | Backed by                               | Used for                                                                       |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `process`  | A long-running process Roubo supervises | Backend servers, frontend dev servers, any `npm`/`node`/`dotnet`/etc. process. |
| `database` | A `docker compose` service              | Postgres, SQL Server, Redis, etc.                                              |

For `process` components, Roubo manages stdout/stderr capture, port-templating of environment variables, restart-on-fail policy, and graceful shutdown.

For `database` components, Roubo overrides the published port on the compose file, waits on the service's healthcheck, and runs the configured `migration.command` once the container is healthy. The actual `docker-compose.yaml` lives in your project repo. Roubo doesn't synthesize it.

See the [Configuration Reference](./configuration.md) for every field.

## Tools

Tools are quick-open actions defined in `roubo.yaml`. Two kinds exist:

- **Browser tools** open a URL in your default browser. The URL can template port and workspace values from the current bench.
- **Shell tools** run an arbitrary command, typically to open the workspace in an editor (`code "{{workspace}}"`).

Tools only appear in the UI when their dependencies are running. A browser tool that `requires: client` is greyed out until the `client` component is healthy.

## API

Roubo's UI is a React frontend that calls the same REST API any external tool can use. This is intentional: AI coding agents (see [Supported AI coding tools](../README.md#supported-ai-coding-tools)) can self-serve benches by hitting the API directly.

The API is JSON, mounted under `/api/*`, binds to `127.0.0.1` only (port 3333 in the Electron app, 3335 in `npm run dev`), and has no authentication on bench, project, component, tool, or inspection routes. Real-time bench and notification events stream over Server-Sent Events at `GET /api/notifications/stream`; terminal sessions use a WebSocket at `WS /ws/terminal/:sessionId`.

The full endpoint reference, with request and response shapes, error codes, status code matrix, and a worked end-to-end curl example, lives in [docs/api.md](./api.md). The complete route list (including admin-only and UI-helper endpoints) is in [CLAUDE.md](../CLAUDE.md#api-endpoints).

## Process model

Roubo runs as a single Electron app that bundles three things:

1. **The Express server**, which exposes the API, owns the state, manages worktrees, supervises processes, and talks to Docker.
2. **The static client**, a React SPA served by the same Express process.
3. **Electron**, which wraps the above in a desktop window and handles deep links (`roubo://`) for OAuth callbacks.

In dev mode the client runs separately on Vite's dev server and proxies API calls to the Express process. In production, the SPA is built once and served directly.

There is no remote server, no telemetry, no account. Everything is local to your machine.

## What Roubo isn't

Roubo isn't a CI system, a deployment tool, or a remote dev environment. It deliberately does one thing: stand up isolated local environments off your existing repo, fast, and let you run more than one at once. Anything past that (building, deploying, running on someone else's machine) is out of scope.
