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
5. Run `benches.setup`, if defined (for example, `npm ci`). It runs through your login shell, so shell syntax works: `cd app && nvm use && npm ci` chains as written. On zsh the shell is interactive too, so `~/.zshrc` loads and version managers such as `nvm` resolve. On bash and other shells only the login profile files load (`~/.bash_profile`, `~/.profile`, not `~/.bashrc`), so an `nvm` snippet installed into `~/.bashrc` must be moved into the profile file to resolve here.

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

## Configuring AI agents

**Settings > AI Agents** is where you set the application-level defaults for each AI coding agent you have installed.

Every installed `agent`-kind plugin gets its own card, and every card renders a form built from that plugin's declared config schema. Two agent plugins therefore show two different forms: one may offer a model and a permission mode, another a reasoning effort and a sandbox setting. Roubo does not interpret those fields; it renders what the plugin declares and validates what you save against the same schema, so a value outside a field's allowed set is refused with the field and its allowed values named.

- **Save defaults** writes the form to disk. **Reset** discards unsaved edits and restores the last saved values.
- Defaults are stored one file per plugin, at `~/.roubo/agents/_global/<pluginId>.yaml`. Because each plugin has its own file, configuring one agent never disturbs another.
- Saved defaults persist across navigation and restarts, and apply to every project.
- With no agent plugins installed the screen shows an empty state. Install one from the **Marketplace** tab and it appears here.

### Choosing which agent a jig launches

**Settings > Jigs** is where you pick the agent a jig runs with.

- **Default agent** is a radio group over the agents that are installed and configured, one tile each, with that agent's current effective params under its name. Exactly one is the default at a time, and picking one saves immediately and confirms with a toast. An agent that is not installed, not consented, or otherwise unavailable is not listed, so the default can only ever be an agent that can actually launch. With a single configured agent, that agent is the default.
- **Per-jig agent** is the select beside each custom jig under **Custom Jigs**. Leave it on **Default agent** and the jig follows whatever the default is, including later changes to it. Point it at a specific agent and the jig keeps that agent regardless of what the default becomes.
- At launch the two resolve in that order: the jig's own binding first, then the default agent, and finally the single configured agent when there is exactly one. With no agent configured at all, or with several configured and no default chosen, a jig with no binding launches on the built-in command path, exactly as before.
- If a jig is bound to an agent that is later uninstalled, the select says so rather than reading as "Default agent", and the launch falls back to the default agent so the session still starts. A default agent that is itself uninstalled falls through the same way rather than failing the launch. Neither the binding nor the default is rewritten, so re-installing the plugin makes it take effect again.
- The binding lives in the jig's own frontmatter (`agentPluginId`), so it travels with the jig: a repo-level jig carries its agent to everyone who checks out the repo.

### Agent tools: named launch presets

**Settings > Jigs > Agent tools** is where you name a launch configuration once and reuse it. A preset records three things: which agent it launches, parameter overrides for that agent, and jig behavior.

- Three presets ship with Roubo: **Agent**, **Agent (Plan)** and **Agent (Auto)**. All three bind the default agent, so changing the default under **Default agent** re-points them immediately. They are marked `built-in` and cannot be edited or deleted.
- **New agent tool** opens the editor: Name, Agent, the three parameter overrides (Model, Effort, Mode), and Jig. **Cancel** discards the draft entirely; nothing is saved and no entry appears in the list.
- **Agent** is either **Default agent** or a specific plugin. A default-bound preset reads as `default agent -> <current default>` and follows the default forever; a plugin-bound preset stays on its plugin whatever the default becomes.
- Parameter overrides are per-agent, so the editor offers the values the bound agent actually declares. Leaving a field on **inherit** means the preset does not touch it, and the agent's app-level and project-level configuration carry through.
- **Jig** is either **Inherit (effective default)**, a named jig, or **None**.
- A preset bound to a plugin that is not installed is flagged in the list and cannot launch, so it can never leave a dead session behind. Fix it by re-installing the plugin or re-pointing the preset. Opening the editor keeps the binding named in the **Agent** select, which says so rather than reading as "Default agent", so saving without touching the field leaves the binding as it was.
- Presets saved here are app-level and local to your machine. To share one with everyone working on a project, declare it in that project's `roubo.yaml` under `tools:` as a `type: agent` entry (see [configuration.md](configuration.md#agent-tools)). Project presets sit alongside app presets in the launch list; a project preset whose parameters the bound agent rejects is flagged with the offending parameter named, and never launches.

### Overriding agent configuration per project

**Project > Settings > Agent overrides** is where one project departs from those application-level defaults. Every installed agent plugin gets a card, and every field the plugin declares gets a row with its own override toggle and the current app default shown beside it.

- A field is either **overridden** or **inherits**. Leave a field inheriting and it keeps tracking the app default, so changing the default on the AI Agents screen changes what this project launches with, without touching the project.
- Turning an override on seeds the field with the app default when one is set, and otherwise with the field's own schema default or its first allowed value, so the seeded value is always visible in the row before you save. Turning it off again drops the override and the field goes straight back to inheriting.
- The **Effective** line under each card previews what the two layers resolve to: the app defaults with only the overridden fields replaced. It covers those two layers only; anything resolved at launch time is applied later.
- Overrides are stored per project and per plugin, at `~/.roubo/agents/<projectId>/<pluginId>.yaml`, and hold only the fields you overrode. Overriding one field in one project never touches another field, another plugin, or another project.
- Values are validated against the same plugin schema as an app-level save, so an out-of-range override is refused with the field and its allowed values named.
- If a project has an override for an agent plugin that is no longer installed, the section says so and ignores it. Nothing resolves a configuration for a plugin that is not installed.

### Launching an agent from a bench

**Bench > Terminal** is where a configured agent actually starts. The tab bar carries a split button: the left segment launches, and the chevron beside it opens the launch menu.

- The **left segment** runs the built-in **Agent** preset, which follows whatever you chose as the default agent. Its label and tooltip name the agent that preset currently resolves to, so you can tell what will start before you press it, and a toast confirms it afterwards. With no default agent available the segment is disabled rather than launching something arbitrary.
- The **launch menu** is three groups, always in the same order. **Built-in · default agent** holds the presets Roubo ships, **Agent tools** holds the app-level and `roubo.yaml` presets, and **All agents** holds one entry per installed agent plugin. Each entry carries a compact summary of the parameters it will launch with, matching what **Settings > AI Agents** shows for the same agent.
- An agent appears under **All agents** once its plugin is installed and its effective configuration is valid. One that is installed but not yet configured is listed disabled, marked `configure first` and carrying the offending field, so it can be fixed rather than quietly disappearing. It cannot be launched, so an unconfigured agent never leaves a dead session behind. The same holds for a preset bound to a plugin that is missing or to parameters the agent rejects.
- Jig behaviour is unchanged by which entry you pick. Auto-inject still decides the jig for a bench with an assigned issue, and a preset that names its own jig, or explicitly none, overrides that. To push a jig into a session that is already running, use the jig picker beside the split button.
- Session tabs identify their agent with a coloured glyph, one colour per agent, plus the launch mode where the agent reports one. The glyph and badge are the same for every agent.

## Next steps

- Read the [Configuration Reference](./configuration.md) to learn what each `roubo.yaml` section does.
- Read [Architecture](./architecture.md) for a deeper look at how benches, ports, and components fit together.
- Configure GitHub integration so Roubo can assign issues and track PRs. See [integrations.md](./integrations.md).
