# Configuration Reference

Every project Roubo manages ships a `roubo.yaml` at `.roubo/roubo.yaml`. This document is the authoritative reference for what each section does. The machine-readable schema is at [`schema/roubo-config.schema.json`](../schema/roubo-config.schema.json) and is what Roubo validates against at registration time.

The full working example used to develop Roubo itself is checked in at [`.roubo/roubo.yaml`](../.roubo/roubo.yaml).

## File structure at a glance

```yaml
project: # Identity: name, displayName, type, repo, GitHub integration
layout: # Repo shape: single-repo, monorepo, or meta-repo
components: # The processes and containers a bench runs
ports: # Port allocation bases per component
tools: # Quick-open actions in the UI (browser, shell)
inspection: # Test/QA command
benches: # Bench cap, root setup command, auto-clear policy
jigs: # Optional: default AI coding agent jig and issue-type mappings
users: # Optional: non-sensitive seed users
```

`project`, `layout`, and `benches` are **required**. Everything else is optional, including `components` and `ports` (omit them for a project with no long-running services).

---

## `project` (required)

Identifies the project and links it to its repo on GitHub.

```yaml
project:
  name: my-app # kebab-case, [a-z0-9-]+ only
  displayName: My App # shown in the UI
  repo: my-org/my-app # owner/repo on GitHub
  github:
    project: 1 # optional, GitHub Project (v2) number
```

| Field            | Required | Type    | Notes                                                         |
| ---------------- | -------- | ------- | ------------------------------------------------------------- |
| `name`           | yes      | string  | Must match `^[a-z0-9-]+$`. Used as the workspace folder name. |
| `displayName`    | yes      | string  | Human-readable title.                                         |
| `repo`           | yes      | string  | `owner/repo` form. Used for GitHub integration.               |
| `github.project` | no       | integer | GitHub Projects v2 number. Used for issue assignment.         |

---

## `layout` (required)

How the project's repository is structured.

```yaml
layout:
  type: single-repo
```

| `type`        | Use when                                             |
| ------------- | ---------------------------------------------------- |
| `single-repo` | A single repo holds all the code.                    |
| `monorepo`    | A single repo with multiple workspaces/packages.     |
| `meta-repo`   | A parent repo that pins sub-repos as git submodules. |

For `meta-repo`, declare the submodules so Roubo can initialise them:

```yaml
layout:
  type: meta-repo
  submodules:
    backend: my-org/my-app-backend
    frontend: my-org/my-app-frontend
```

---

## `components` (optional)

The processes and containers that make up a bench. Each key is the component name; the value describes how to run it. Omit this section (or leave it empty) for a project with no long-running services; a bench can still provide a workspace, jigs, and tools.

```yaml
components:
  database:
    plugin:
      id: database
    config:
      composeFile: docker/db.yml
      service: mssql
      portEnvVar: MSSQL_PORT
      connection:
        template: "Server=localhost,{{ports.database}};Database=app;User=sa;Password=..."
      migration:
        command: dotnet ef database update --project src/Migrations
  backend:
    plugin:
      id: process
    config:
      command: dotnet run --project src/Api/Api.csproj
      setup: dotnet restore
      env:
        ASPNETCORE_URLS: "http://localhost:{{ports.backend}}"
        ConnectionStrings__Default: "{{connection.database}}"
    dependsOn: [database]
  frontend:
    plugin:
      id: process
    config:
      command: npm run dev
      directory: client
      env:
        VITE_PORT: "{{ports.frontend}}"
        VITE_API_URL: "http://localhost:{{ports.backend}}"
    dependsOn: [backend]
```

### Component binding fields

Each component binds to a component plugin and hands it an opaque config block.

| Field           | Required | Notes                                                                                                                                                                                  |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin.id`     | yes      | The component plugin's manifest id (for example `process` or `database`).                                                                                                              |
| `plugin.source` | no       | Where the plugin is loaded from (a git URL or path). Omit to use a bundled or already-installed plugin.                                                                                |
| `config`        | no       | A plugin-owned config block. Its shape is defined and validated by the bound plugin's own `configSchema`; Roubo treats it as opaque and passes it through unchanged. Defaults to `{}`. |
| `dependsOn`     | no       | Component names that must be running before this one starts. It lives on the binding, not inside `config`, so start and stop ordering is independent of the plugin.                    |

The contents of `config` depend entirely on the bound plugin: a `process` plugin reads `command` / `setup` / `env` / `directory`, a `database` plugin reads `composeFile` / `service` / `migration` / `connection`, and so on. Roubo validates that `plugin.id` resolves to a loaded component plugin and that `config` satisfies that plugin's `configSchema`. A binding to an unknown plugin, or a `config` block the plugin rejects, fails validation with a clear, path-keyed error.

### Template substitution

Any string value inside a component's `config` block, and in tool URLs, may reference:

- `{{ports.<componentName>}}`: the resolved port for a component on the current bench.
- `{{connection.<componentName>}}`: the resolved connection string for a database component.
- `{{urls.<componentName>}}`: `http://localhost:<port>` for the component.
- `{{workspace}}`: the absolute path of the bench's git worktree.

---

## `ports` (optional)

Port bases per component, usually paired one-to-one with `components`. Roubo computes a bench's actual port as `base + (benchNumber − 1)`. Omit this section when a project has no components.

```yaml
ports:
  database:
    base: 1500
  backend:
    base: 5100
  frontend:
    base: 5200
    https: true # optional, Roubo treats this component as serving https
```

| Field   | Required | Type    | Range   | Notes                                   |
| ------- | -------- | ------- | ------- | --------------------------------------- |
| `base`  | yes      | integer | 1–65535 | The port assigned to bench 1.           |
| `https` | no       | boolean | n/a     | Used when generating `{{urls.<name>}}`. |

Roubo refuses to register a project whose `base` values would collide with any already-registered project's port range. Pick bases that leave a comfortable gap (e.g. 4100, 4200, 4300, never 4100, 4101).

---

## `tools`

Quick-open actions for a bench. Tools appear in the bench panel once their `requires` component is running.

```yaml
tools:
  - name: Web App
    icon: globe
    type: browser
    url: "{{urls.frontend}}"
    requires: frontend
  - name: VS Code
    icon: code
    type: shell
    command: code "{{workspace}}"
```

| Field      | Required | Type   | Notes                                                            |
| ---------- | -------- | ------ | ---------------------------------------------------------------- |
| `name`     | yes      | string | Label shown in the UI.                                           |
| `icon`     | yes      | string | A [Lucide](https://lucide.dev) icon name (e.g. `globe`, `code`). |
| `type`     | yes      | enum   | `browser` or `shell`.                                            |
| `url`      | yes¹     | string | For `browser` tools.                                             |
| `command`  | yes¹     | string | For `shell` tools.                                               |
| `requires` | no       | string | Component name that must be running for the tool to be enabled.  |
| `login`    | no       | object | Browser tools only; automated login steps. See below.            |

¹ `url` is required for `browser` tools; `command` for `shell` tools.

### `login.steps`

For browser tools that need to auto-fill a login form, declare a sequence of `fill` and `click` steps. Each step's `selector` is a CSS selector. `fill` steps require a `value`.

```yaml
tools:
  - name: Admin Console
    icon: shield
    type: browser
    url: "{{urls.backend}}/admin"
    requires: backend
    login:
      steps:
        - selector: "#username"
          action: fill
          value: admin@example.com
        - selector: "#password"
          action: fill
          value: changeme
        - selector: "button[type=submit]"
          action: click
```

`shell` tools cannot declare `login`.

---

## `inspection`

The command Roubo runs when you click **Run inspection** on a bench.

```yaml
inspection:
  framework: vitest
  directory: .
  command: npx vitest run
  env:
    CI: "1"
```

| Field       | Required | Notes                                                         |
| ----------- | -------- | ------------------------------------------------------------- |
| `framework` | yes      | Free-form label (`vitest`, `playwright`, `jest`, …). UI only. |
| `directory` | yes      | Working directory relative to the workspace.                  |
| `command`   | yes      | The command to run.                                           |
| `env`       | no       | Extra environment for the command.                            |

---

## `benches` (required)

Bench cap and shared lifecycle settings.

```yaml
benches:
  max: 6
  setup: npm ci
  autoClear: true
```

| Field       | Required | Type    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max`       | yes      | integer | 1–99. Hard cap on concurrent benches for this project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `setup`     | no       | string  | Command run once after worktree creation, before components start. Typically `npm ci` or workspace bootstrapping. Runs through your login shell, so shell syntax works: `&&` chaining, redirection, and pipes. On zsh the shell is also interactive so `~/.zshrc` loads, which is what makes version managers such as `nvm`, `fnm`, and `asdf` resolve. On bash and other shells only the login profile files load (`~/.bash_profile`, `~/.profile`, not `~/.bashrc`), so a version-manager snippet installed into `~/.bashrc` must be moved into the profile file to resolve here. |
| `autoClear` | no       | boolean | When `true` (default), benches are cleared automatically when the linked GitHub issue moves to Done / is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## `jigs`

Optional AI coding agent configuration. Today this drives [Claude Code](../README.md#supported-ai-coding-tools) integration. Any tool that can read Markdown files from a workspace can consume the resolved jig content; the [API Reference](./api.md#jigs) covers the inject endpoint.

```yaml
jigs:
  defaultJig: standard
  issueTypeMappings:
    Bug: bug-fix
    Feature: feature
```

| Field               | Notes                                                   |
| ------------------- | ------------------------------------------------------- |
| `defaultJig`        | The jig name to use when no issue-type mapping matches. |
| `issueTypeMappings` | Map of GitHub issue type name → jig name.               |

Jigs themselves are managed through the Roubo UI under **Jigs**. The `roubo.yaml` only declares which jig to inject for a given bench.

---

## `users`

Optional list of seed users to provision into the bench's environment (e.g. inserted into a database for local testing). Only non-sensitive fields belong here. Use environment variable references for anything secret.

```yaml
users:
  - name: alice
    properties:
      role: admin
      email: alice@example.com
  - name: bob
    properties:
      role: member
      email: bob@example.com
```

| Field        | Required | Notes                               |
| ------------ | -------- | ----------------------------------- |
| `name`       | yes      | Unique identifier.                  |
| `properties` | yes      | Map of arbitrary string properties. |

> **Do not** commit passwords, API keys, or other secrets here. Roubo does not encrypt this file.

---

## Validation

Roubo validates `roubo.yaml` against [`schema/roubo-config.schema.json`](../schema/roubo-config.schema.json) when you register a project. Validation errors are reported inline in the UI with the path to the offending field. The same JSON Schema can be wired into your editor (VS Code, IntelliJ) for live validation: point your YAML language server at the schema URL.

---

## Full example

This is the real `roubo.yaml` from the Roubo repo, kept up to date with the schema as it evolves:

```yaml
project:
  name: roubo
  displayName: Roubo
  repo: davidpoxon/roubo
  github:
    project: 1
layout:
  type: single-repo
components:
  server:
    plugin:
      id: process
    config:
      command: npx tsx watch server/index.ts
      env:
        ROUBO_PORT: "{{ports.server}}"
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
tools:
  - name: Web App
    icon: globe
    type: browser
    url: "{{urls.client}}"
    requires: client
  - name: VS Code
    icon: code
    type: shell
    command: code "{{workspace}}"
inspection:
  framework: vitest
  directory: .
  command: npx vitest run
benches:
  max: 6
  setup: npm ci
```
