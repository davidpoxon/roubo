# Architecture

This document describes how Roubo is put together: the concepts you'll see in the UI, how state moves through the system, and the API surface.

## Concepts

Roubo's vocabulary is deliberate; every term carries meaning. See [brand.md](./brand.md) for the full glossary; the essentials are below.

| Term          | What it is                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------- |
| **Project**   | A registered repository with a `roubo.yaml` config.                                         |
| **Bench**     | An isolated dev environment for one project: a git worktree, ports, and running components. |
| **Component** | A running part of a bench, typically a database, backend, and frontend.                     |
| **Tool**      | A quick-open action defined in `roubo.yaml`: open the browser, launch the IDE, run a shell. |
| **Jig**       | AI coding agent instructions injected into a bench's workspace.                             |
| **Workspace** | The git worktree directory on disk for a specific bench.                                    |

A project can have multiple benches. Each bench is fully isolated from the others: its own worktree, its own port range, its own database container, its own running processes. This is the whole point of Roubo: you can run several agents (or several streams of your own work) against the same project, in parallel, with no collisions.

## State storage

Roubo keeps all of its state under `~/.roubo/`:

```
~/.roubo/
├── projects.json                  # Registered projects: path → metadata
├── state.json                     # All benches: ports, branches, statuses
├── auth.json                      # GitHub OAuth token (mode 0600)
├── terminal-sessions/
│   └── <sessionId>.json           # One bench terminal session: its record, scrollback and,
│                                   # for an agent, why it ended if it did not end normally
├── logs/
│   ├── current.log                # Main-process console.warn/console.error, since the
│   │                               # packaged app has no attached terminal
│   └── previous.log               # Rotated out once current.log passes 5MB
└── workspaces/
    └── <projectName>/
        └── bench-<N>/             # Git worktree for bench N
```

`projects.json` and `state.json` are plain JSON. If you need to inspect or surgically edit the system state, that's where to look. The directory layout is stable.

A terminal session file outlives the server. After a restart the session comes back as ended, with its scrollback, and keeps the record of how an agent session ended (a launch failure, or an unexpected exit) so a tab opened later still says why.

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
5. Run `benches.setup` if defined (typically `npm ci` or similar workspace-wide setup). The command is executed through the user's login shell, so `&&` chaining, redirection, and pipes all work. On zsh the shell is started interactively as well, so `~/.zshrc` loads and version managers such as `nvm`, `fnm`, and `asdf` resolve. On bash and other shells only the login profile files load (`~/.bash_profile`, `~/.profile`, not `~/.bashrc`), so a version-manager snippet installed into `~/.bashrc` must be moved into the profile file to resolve here.

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

Tools only appear in the UI when their dependencies are running, or have run to completion. A browser tool that `requires: client` is greyed out until the `client` component is healthy; one that `requires` a one-shot component enables as soon as that component completes.

## Session notifications

A bench terminal session is either working, waiting on you, or gone. Roubo turns the last two into bench notifications so a tab you are not looking at can still ask for attention: a **waiting** notification while a session sits idle at a prompt, an **exited** notification when its process ends, and an **unexpected-exit** notification when an agent dies on its own (see below). All three are session-scoped: they carry the session id, and the terminal tab strip renders an indicator on any inactive tab with a matching notification. A waiting session is surfaced on the pane as well, where the terminal shows a `Waiting for your input` strip, which covers the session you are looking at (the one the tab indicator deliberately skips).

### Two waiting-detection mechanisms

**Hook-driven.** The agent tells Roubo it is waiting. Roubo exposes a local endpoint, `POST /api/hooks/claude-notification` (a historical path, kept because shipped plugin manifests point at it), and the agent is configured at launch to call it with its own session id. This is immediate and precise: it fires on a permission prompt or a finished turn rather than on a guess about idleness. An AI coding agent launched from a plugin declares this wiring in its launch descriptor (`capabilities.notification`, `kind: "http-hook"`); Roubo executes the declared workspace write that registers the hook, substituting the real session id and port so the plugin never learns either.

**Quiescence.** No hook, so Roubo infers waiting from silence: if a session's PTY produces no output for a debounce window, it is treated as waiting. A plugin tunes its own window with `capabilities.waitingDetection`, either `quiescence-only` with a `debounceMs`, or `hook-driven` with a `quiescenceFallbackMs` used as a safety net behind its hook (an agent TUI redraws while it works, so the fallback window is deliberately long, defaulting to 8000ms). A session declaring nothing gets the generic 2000ms terminal window and a plain `terminal-waiting` notification.

The two compose: a hook-driven agent still arms the quiescence timer, because a hook covers the states the agent knows to report and quiescence covers the rest.

### Correlation

The session id is minted by Roubo before the agent is asked for anything, so the id in the agent's argv, the id written into its hook configuration, and the id on the session record are all the same value. A hook POST is honoured only when that id names a session that is **still live** and whose agent **declared hook wiring**. Both halves matter: for a plugin agent, eligibility is a property of the launch descriptor rather than of the command name, so no plugin is privileged by what its binary is called, and the live check is what expires a correlation token. An exited session, or one restored from disk after a restart, keeps its record so its scrollback survives, but a POST quoting it is rejected and logged rather than raising a notification.

There is no exception. Roubo removed its own built-in agent launch path in #1114, so a launch descriptor is the only thing that can confer hook eligibility and a command name confers nothing.

### Unexpected exits

An agent that launched fine and later dies on its own is not an ordinary end. Roubo calls an exit unexpected when it comes after the early launch window and is either a nonzero exit code or a signal other than a deliberate stop. A wrapper that supervises the agent reports a killed child as exit code 128 plus the signal number, so `137` is read as `SIGKILL`, which is what an out-of-memory kill looks like. `SIGHUP`, `SIGINT` and `SIGTERM` (codes 129, 130 and 143) count as an ordinary end, as does a clean exit.

An exit inside the early window is judged as a launch failure rather than an unexpected exit, and a signal kill there is reported as one with its signal named. Closing a tab, tearing down a bench and quitting the app never count: Roubo marks the session before it kills the process, so the exit that follows is not classified at all and never raises an unexpected-exit notification.

For an unexpected exit Roubo does four things:

- **Records it** on the terminal session (`unexpectedExit`: the exit code, the signal name, how long the session ran, and when it ended), which is persisted with the session.
- **Logs it** as a warning to `logs/current.log`.
- **Raises** an `agent-exited-unexpectedly` notification in place of the plain exited one, so there is one notice, not two. It is raised by the session itself, so an agent launched automatically for an assigned issue is covered as well.
- **Shows it** in three places: an inline notice on the bench view, a panel and a red line in the terminal pane (replayed on reconnect and after a restart), and an alert mark on the session's tab.

### Dismissal

Waiting notifications are transient by design and clear themselves as soon as the premise stops holding: fresh PTY output dismisses them (the session resumed work), as does typing into the session (you engaged with it). Exited notifications are sticky and stay until dismissed, because a process does not un-exit. An unexpected-exit notification is the one session-scoped notification that opening its tab does not clear: it stays until you dismiss it from the bench view.

## Terminal clipboard and links

A bench terminal is xterm.js, bridged over a WebSocket to a PTY on the server; the byte path between
them does not inspect or filter anything a process writes. Two features need the Electron host to
honour sequences xterm itself only parses:

An agent copies by writing an `OSC 52` clipboard sequence. Roubo registers a write-only handler for
it, routed through Electron's main process so a write still reaches the clipboard when the window is
in the background (`navigator.clipboard.writeText` otherwise rejects on an unfocused document). A
read query (`OSC 52 ; c ; ?`) is recognised and never answered, so a bench cannot read back whatever
the user last copied on the host; in the browser-served client, where there is no Electron bridge,
writes fall back to `navigator.clipboard` and reads are equally unimplemented.

An agent TUI that enables mouse reporting makes xterm route click-drag to the program instead of
selecting. The modifier that overrides this is Shift off macOS and Option on macOS; once a selection
exists, the platform copy shortcut (`Cmd+C` or the Electron Edit menu) copies it as normal.

Links render from plain text matching a URL pattern, opened in the system browser rather than a new
Electron window.

## API

Roubo's UI is a React frontend that calls the same REST API any external tool can use. This is intentional: AI coding agents (see [Supported AI coding tools](../README.md#supported-ai-coding-tools)) can self-serve benches by hitting the API directly.

The API is JSON, mounted under `/api/*`, binds to `127.0.0.1` only (port 3333 in the Electron app, 3335 in `npm run dev`), and has no authentication on bench, project, component, or tool routes. Real-time bench and notification events stream over Server-Sent Events at `GET /api/notifications/stream`; terminal sessions use a WebSocket at `WS /ws/terminal/:sessionId`.

The full endpoint reference, with request and response shapes, error codes, status code matrix, and a worked end-to-end curl example, lives in [docs/api.md](./api.md). The complete route list, including admin-only and UI-helper endpoints, is generated from the source into [docs/routes.md](./routes.md); the handlers themselves live in [`server/routes/`](../server/routes/), and [`client/src/lib/api.ts`](../client/src/lib/api.ts) is the typed client for the surface the UI actually uses.

## Process model

Roubo runs as a single Electron app that bundles three things:

1. **The Express server**, which exposes the API, owns the state, manages worktrees, supervises processes, and talks to Docker.
2. **The static client**, a React SPA served by the same Express process.
3. **Electron**, which wraps the above in a desktop window and handles deep links (`roubo://`) for OAuth callbacks.

In dev mode the client runs separately on Vite's dev server and proxies API calls to the Express process. In production, the SPA is built once and served directly.

There is no remote server, no telemetry, no account. Everything is local to your machine.

## What Roubo isn't

Roubo isn't a CI system, a deployment tool, or a remote dev environment. It deliberately does one thing: stand up isolated local environments off your existing repo, fast, and let you run more than one at once. Anything past that (building, deploying, running on someone else's machine) is out of scope.
