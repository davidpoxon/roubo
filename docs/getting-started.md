# Getting Started

This guide walks through installing Roubo, registering your first project, and setting up your first bench.

## 1. Install Roubo

> **Platform support.** Roubo currently ships a signed, notarized **macOS (Apple Silicon)** build. Intel macOS, Windows, and Linux builds are on the roadmap.

1. Open the [latest release](https://github.com/davidpoxon/roubo/releases/latest) on GitHub.
2. Download `Roubo-<version>-arm64.dmg`.
3. Open the DMG and drag **Roubo** into your `Applications` folder.
4. Launch Roubo from Spotlight or Launchpad.

The first launch opens the Roubo window and starts the local server. The web UI is served at `http://localhost:3333`. The Electron app loads it directly, but you can also open the same URL in any browser if you prefer.

## 2. Add a `roubo.yaml` to your project

Roubo expects each project to describe itself with a `roubo.yaml` at `.roubo/roubo.yaml` in the project repo. This file tells Roubo what components make up a bench (database, backend, frontend), what ports they need, and how to start them. Components are optional, so a project with no long-running services can ship a `roubo.yaml` without them.

Here is a minimal example for a single-repo web project:

```yaml
project:
  name: my-app
  displayName: My App
  type: web
  repo: my-org/my-app

layout:
  type: single-repo

components:
  server:
    plugin:
      id: process
    config:
      command: npx tsx watch server/index.ts
      env:
        PORT: "{{ports.server}}"
  client:
    plugin:
      id: process
    config:
      command: npm run dev
      directory: client
      env:
        DEV_PORT: "{{ports.client}}"
        DEV_API_PORT: "{{ports.server}}"
    dependsOn:
      - server

ports:
  server:
    base: 4100
  client:
    base: 4200

benches:
  max: 4
  setup: npm ci
```

The full schema is documented in the [Configuration Reference](./configuration.md), and there is a working example at [`.roubo/roubo.yaml`](../.roubo/roubo.yaml) in this repo.

Commit `.roubo/roubo.yaml` to the project's repo. It is intentionally checked in: anyone who clones the project should get the same bench configuration.

## 3. Register the project with Roubo

In the Roubo window:

1. Open **Settings**.
2. Click **Register project**.
3. Paste the absolute path to the project repo on disk.

Roubo parses and validates the `roubo.yaml`, checks for port conflicts with any other registered projects, and adds the project to the registry. If validation fails, Roubo shows the specific error inline.

## 4. Set up your first bench

From the project's page in Roubo, click **Set up bench**. Optionally specify a branch. If you leave this empty, Roubo creates the bench from the project's default branch.

Roubo will, in order:

1. Claim the next available bench number (`1` through `benches.max`).
2. Allocate ports for each component: `base + (benchNumber - 1)`.
3. Create a git worktree at `~/.roubo/workspaces/<projectName>/bench-<N>/`.
4. Initialise submodules, if the project is a meta-repo.
5. Run `benches.setup`, if defined (for example, `npm ci`). It runs through your login shell, so shell syntax works: `cd app && nvm use && npm ci` chains as written, and profile-sourced functions such as `nvm` resolve.

When setup completes, the bench appears with status **idle**.

## 5. Start the bench

Click **Start** on the bench. Roubo starts each component in dependency order, waits for it to become healthy, and updates the status pill as it goes. When every component is running, the bench is **active**.

From here you can:

- Click any tool defined in `roubo.yaml` (browser, IDE, shell) to open it pointed at this bench.
- Open the workspace directly: it is just a normal git worktree at the path Roubo allocated.
- Point your AI coding tool (Roubo has first-class integration with [Claude Code](https://www.anthropic.com/claude-code); see [Supported AI coding tools](../README.md#supported-ai-coding-tools)) at the workspace and have it work in isolation.

To run another stream of work in parallel, set up a second bench from a different branch. Each bench gets its own port range, its own worktree, and its own database container. They do not collide.

## Stopping and clearing

- **Stop** halts the components but keeps the worktree on disk, so you can come back to it.
- **Clear bench** stops the components and removes the worktree and any associated resources. Use this when you are done with a stream of work and want the bench number back in the pool.

## Next steps

- Read the [Configuration Reference](./configuration.md) to learn what each `roubo.yaml` section does.
- Read [Architecture](./architecture.md) for a deeper look at how benches, ports, and components fit together.
- Configure GitHub integration so Roubo can assign issues and track PRs. See [integrations.md](./integrations.md).
