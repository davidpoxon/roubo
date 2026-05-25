# Architecture: Integration plugins (extensible plugin system, first use case: issue-source integrations)

> Slug: `integration-plugins` · Designed: 2026-05-21

> **Platform scope.** This design targets macOS and Linux only. Roubo does not support Windows as a host platform (licensing constraint surfaced 2026-05-21, recorded in `context.md` and `decisions-log.md`). All references to Windows-specific CLIs (PowerShell, `cmdkey`, DPAPI), Windows-only paths, and Windows CI runners have been removed from this design. The supported-platforms matrix is macOS plus Linux (desktop and headless variants).

## Context and constraints

Roubo today reads issues only from GitHub.com through `server/services/github.ts` and `server/services/github-auth.ts`, with the OAuth token stored in plaintext at `~/.roubo/auth.json`. Enterprise developers on GitHub Enterprise or self-hosted Jira are blocked at evaluation. This slug introduces an extensible plugin runtime, three bundled integration plugins (GitHub.com, GitHub Enterprise, self-hosted Jira), a published SDK, and a fully automatic migration of every existing GitHub.com project. The runtime is the load-bearing piece: it is designed so the planned AI-agent and project-component plugin slugs can attach to the same host API without a major-version bump.

The architecture is constrained by five hard rules from context and PRD. First, no native modules anywhere, which forces the OS keyring to a pure-JS shellout to `security` (macOS) and `secret-tool` (Linux). Second, plugins never run inside the Roubo server process; each runs as a `child_process.spawn`ed Node script with JSON-RPC over stdio. Third, plugins never bring their own HTTP client; the host owns `host.fetch` and enforces the manifest network allowlist, system proxy (via `EnvHttpProxyAgent` reading `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`), and per-plugin self-signed-TLS opt-in. Fourth, credentials never touch disk in plaintext, and the legacy `auth.json` is deleted as the final step of migration. Fifth, migration is atomic, all-or-nothing, and idempotent; `state.json` `schemaVersion` is the single commit point.

The supplementary constraints come from existing code shape. `shared/config-schema.ts:235` is `.strict()`, so adding the `integration` block to `roubo.yaml` is a real schema migration that must ship in lockstep with the JSON Schema artifact at `schema/roubo-config.schema.json`. The hard-block on issue dependencies at `server/services/issue-assignment.ts:102` and its UI counterpart at `client/src/components/IssuePickerModal.tsx:91` must flip to soft-warn in lockstep. The `githubRequest` helper at `server/services/github.ts:255` (ETag store, exponential backoff, 30s TTL caches, GraphQL batching, Projects v2 pagination) must be preserved verbatim inside the bundled github.com plugin; re-deriving it is a documented top risk. `host.fetch` must surface raw response headers so the plugin's ETag store and `Retry-After` backoff remain implementable across the RPC boundary.

Feasibility called for two spikes that gate `hostApiVersion` 1.0.0 freeze: Spike A (pure-JS keyring across macOS, Ubuntu desktop, Ubuntu headless) and Spike B (`host.fetch` cache-header fidelity + `githubRequest` rewrite). This design assumes Spike A passes on macOS and Ubuntu desktop, and flags the Ubuntu headless fallback explicitly under `risks_and_alternatives`.

## Existing architecture summary

Files this design touches or directly extends:

- `server/services/process-manager.ts:1` — child-process supervisor with ring-buffered logs, `treeKill` SIGTERM-then-SIGKILL, `stopAllProcesses` on host shutdown. Direct template for `plugin-manager.ts`.
- `server/services/jig-manager.ts:65, :179, :372, :384, :405` — two-tier discovery (bundled + user-installed), per-dir FS watcher with debounced invalidation. Direct template for plugin discovery.
- `server/services/state.ts:49, :91, :162, :206` — `atomicWrite`, `loadState`, `loadSettings` shallow merge, `resolvePermissionsPath` path-traversal guard. Re-used for the per-user override file and migration commit point.
- `server/services/exec.ts:32` — `runCommand` with subprocess timeout and captured I/O. Used by the keyring shellouts (with a passthrough for `DBUS_SESSION_BUS_ADDRESS`).
- `server/services/github.ts:101, :255, :476, :516, :618, :840, :944, :960, :988, :1061` — all of GitHub.com today. Migrates verbatim into `plugins/github-com/` source tree.
- `server/services/github-auth.ts:18, :132, :145` — OAuth state machine, token persistence to `auth.json`. Migrates into `plugins/github-com/`; persistence call sites become the migration source of truth.
- `server/services/issue-assignment.ts:102` — hard-block throw site. Flips to passthrough with `blockedBy` attached to response.
- `server/services/pr-sync.ts:18, :35, :129` — gates on `getGithubToken()`. Re-gated on `project.integration.plugin === "github-com"`.
- `server/services/auto-clear.ts:32, :51` — 30s `setInterval` PR sync. Gated on the github.com integration.
- `server/routes/issues.ts:27, :55, :78, :101, :116, :155` — all delegated to `githubService.*`. Re-delegated to `pluginRuntime.invoke(pluginId, method, args)`.
- `server/routes/auth.ts:14` — GitHub OAuth routes. Stay at this path; proxy through the github.com plugin.
- `shared/config-schema.ts:235` — `.strict()` zod schema for `roubo.yaml`. Gains an optional `integration` block.
- `shared/types.ts:401, :622, :646` — `PersistedBench`, `GitHubIssue`, `AssignedIssue`. Receive `integrationId` + `externalId` with load-time defaulting.
- `client/src/components/IssuePickerModal.tsx:91` — disabled-row treatment for blocked issues. Flips to warn-only chip.
- `client/src/hooks/useProjectItems.ts:4, :15` — single React Query call. Becomes `useInfiniteQuery`.
- `client/src/lib/api.ts` — typed API client; renamed and extended.
- `electron/src/main.ts:127` — `roubo://oauth/github/callback` deep-link handler. Unchanged; remains the github.com plugin's auth surface.

## Proposed components

### Plugin manifest and host-API shared schema

- **Path**: `shared/plugin-manifest.ts` (new), `schema/roubo-plugin.schema.json` (new).
- **Responsibility**: define the zod schema for `roubo-plugin.yaml`, export TypeScript types, and provide a `parseManifest(yamlText, sourcePath)` helper that returns `{ ok: true, manifest } | { ok: false, error }`. Emit a hand-maintained JSON Schema mirror for IDE tooling (matches today's `schema/roubo-config.schema.json` discipline).
- **Reuse vs new**: new module, but cribs the dual-source discipline from `shared/config-schema.ts` + `schema/roubo-config.schema.json`.
- **Public interface**: `PluginManifest` zod schema and TS type with fields: `id` (string, kebab-case), `name` (string), `version` (semver string), `kind` (literal `"integration"`; future kinds added by union widening, not by replacement), `roubo` (semver range; the host-API range the plugin requires), `entry` (relative path to the Node entry script), `description` (string, one-line), `configSchema` (JSON Schema object describing user config), `permissions` (object with four sub-keys: `network.hosts: string[]` (glob patterns); `credentials: { slot: string, scope: "read" | "read-write", description: string }[]`; `filesystem.paths: string[]` (absolute or `~`-prefixed paths beyond the plugin's own dir); `childProcess: { executables: string[] } | false`), and optional `capabilities: { prSync?: boolean }` (declarative capability flags consumed by the host for routing decisions like PR sync gating).
- **Dependencies**: `yaml` (already a dep at `package.json:54`), `zod`.

### Plugin manager (host supervisor)

- **Path**: `server/services/plugin-manager.ts` (new).
- **Responsibility**: discover, load, spawn, supervise, and tear down plugin processes. Owns the registry of `{ pluginId → PluginInstance }`. Enforces the 3-restarts-in-5-minutes window per plugin. Wires plugin stdout/stderr to per-plugin log files. Exposes `invoke(pluginId, method, params)` to routes.
- **Reuse vs new**: new module, but extends the `process-manager.ts:1` pattern (ChildProcess + ring-buffered logs + `treeKill` shutdown) with the addition of (a) JSON-RPC framing, (b) restart-budget tracking, (c) per-plugin log file rotation, (d) lifecycle state machine. Reuses `jig-manager.ts:179` (`resolveJigsForProject`) discovery idiom for two-tier scan (bundled `plugins/` then `~/.roubo/plugins/<id>/`).
- **Public interface**:
  - `initialize(): Promise<void>` — called from `server/index.ts` next to `projectRegistry.initialize()`. Discovers plugins, validates manifests, spawns enabled ones, returns once all spawn attempts complete (success or failure). Never throws; per-plugin failures surface on the Plugins page.
  - `listInstalled(): PluginRecord[]` — returns `{ id, manifest, status: "enabled" | "disabled" | "errored" | "incompatible", source: "bundled" | "git" | "local", lastError?: PluginError, restartHistory: RestartEvent[] }`.
  - `enable(pluginId): Promise<void>` / `disable(pluginId): Promise<void>` — graceful start / stop without host restart. Disable invokes `treeKill(pid, "SIGTERM")` with a 5000ms grace then SIGKILL, matching `process-manager.ts`.
  - `install({ source: { kind: "git", url } | { kind: "local", path } }): Promise<InstallResult>` — clones or validates, parses manifest, returns the manifest and source for the permissions dialog. Does not enable until `acceptInstall(pluginId)` is called.
  - `acceptInstall(pluginId): Promise<void>` — flips the install gate; enables.
  - `uninstall(pluginId): Promise<void>` — only third-party. SIGTERM, then `rm -rf ~/.roubo/plugins/<id>/`, then unregister.
  - `invoke<T>(pluginId, method, params, opts?: { timeoutMs?: number }): Promise<T>` — host-to-plugin RPC. Default 30s timeout. On timeout cancels the in-flight request id without killing the plugin process.
  - `restart(pluginId): Promise<void>` — clears the restart-window counter and re-spawns (per prototype-notes resolution; see open-question response below).
  - `readLogs(pluginId, file: "current" | "previous", lines: number): Promise<LogLine[]>` — backs the in-app log viewer.
  - `shutdown(): Promise<void>` — registered in `server/index.ts` shutdown sequence; calls SIGTERM on every child, awaits exit with 5000ms grace then SIGKILL via `treeKill`. Mirrors `processManager.stopAllProcesses`. POSIX signal semantics on macOS and Linux are sufficient; no platform-specific shutdown handling is required.
- **Dependencies**: `child_process.spawn`, `vscode-jsonrpc` (new dep, zero native deps), `tree-kill` (existing dep), `node:fs/promises`, the credential-store service, the host.fetch service, the manifest schema.

### RPC transport

- **Path**: `server/services/plugin-rpc.ts` (new).
- **Responsibility**: wrap `vscode-jsonrpc`'s `StreamMessageReader` / `StreamMessageWriter` over `proc.stdout` / `proc.stdin`. Provide `createConnection(proc)` returning `{ sendRequest, sendNotification, onRequest, onNotification, dispose }`. Owns Content-Length framing.
- **Reuse vs new**: new, thin wrapper over `vscode-jsonrpc`. We considered hand-rolled framing; rejected because LSP-style framing is the only widely battle-tested approach for Node stdio.
- **Public interface**: `createConnection(proc: ChildProcessByStdio): JsonRpcConnection`.
- **Dependencies**: `vscode-jsonrpc`.

### Host services exposed to plugins (the "host" RPC surface)

The plugin process calls these via the same JSON-RPC channel; the plugin manager dispatches the request method names below to in-host implementations. Methods are prefixed `host.` on the wire to namespace away from plugin-to-host methods.

- **Path**: `server/services/plugin-host-api.ts` (new). Single file binds all `host.*` handlers to a connection at spawn time.
- **Methods**:
  - `host.fetch(url, init)` — see component below.
  - `host.credentials.get(slot)`, `host.credentials.set(slot, value)`, `host.credentials.delete(slot)` — backed by the credential store, scoped to the plugin's manifest-declared slots.
  - `host.logger.info(payload)`, `host.logger.warn(payload)`, `host.logger.error(payload)` — appends to `~/.roubo/plugins/<pluginId>/logs/current.log` with timestamp + level + structured fields.
  - `host.spawn(executable, args, opts)` — only enabled if the manifest declares the executable under `permissions.childProcess.executables`. Returns `{ code, stdout, stderr }`. Internally delegates to `exec.ts:32` (`runCommand`) with a passthrough on env vars needed for keyring access on Linux.
- **Dependencies**: credential store, host fetch, logger, exec service.

### Host fetch (network gateway)

- **Path**: `server/services/plugin-fetch.ts` (new).
- **Responsibility**: serve `host.fetch(url, init)` calls from plugins. Enforce the manifest network allowlist, respect system proxy env vars, apply per-plugin self-signed-TLS opt-in, and return `{ status, headers, body }` with every response header surfaced to the plugin verbatim (so plugin-internal ETag store and `Retry-After` backoff remain implementable).
- **Reuse vs new**: new module. Uses `undici` (built-in to Node 24, no install needed). The Octokit dep at `server/package.json:32` moves into `plugins/github-com/package.json`.
- **Public interface**: `createPluginFetcher(manifest, runtimeConfig): (url, init) => Promise<FetchResult>` where `FetchResult = { status: number, headers: Record<string, string | string[]>, body: ArrayBuffer | string }`. The plugin SDK exposes `host.fetch(url, init)` as the ergonomic wrapper.
- **Network allowlist enforcement**: each `manifest.permissions.network.hosts` glob is compiled at plugin load via `picomatch`-compatible (or hand-rolled, given the small surface) glob matcher; every outbound URL is parse-validated against the host portion. Denials are returned as a structured `{ error: "permission-denied", host, reason }` envelope, and an `info` line is appended to the plugin log file (NFR-001).
- **Per-plugin undici dispatcher**: built once per `(pluginId, configHash)` tuple. `EnvHttpProxyAgent` covers system proxy by reading `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` from the host process env. This is the standard proxy convention on macOS and Linux and requires no further OS integration. Self-signed-TLS opt-in is implemented as `new Agent({ connect: { rejectUnauthorized: false } })` on a dispatcher that is _only_ installed when the user has explicitly toggled the per-plugin "Allow self-signed TLS" checkbox in the configure dialog. Re-toggling rebuilds the dispatcher; the in-flight requests on the old dispatcher are not cancelled (a 30s drift window is acceptable).
- **Header surfacing**: `undici` exposes all response headers including `ETag`, `Retry-After`, `X-RateLimit-*`, `X-GitHub-Request-Id`. The fetcher returns them as a flat `Record<string, string | string[]>` (lower-cased keys; arrays preserved for multi-value headers) so the plugin's GitHub ETag-aware request layer continues to work.
- **Body framing**: response body is sent over RPC as `ArrayBuffer` for binary or as `string` for `Content-Type: text/* | application/json | application/xml`. There is no body streaming this slug; the use cases are issue-list JSON, all small. Future plugin kinds that need streaming get a separate `host.fetchStream` method in a 1.x minor.
- **Dependencies**: `undici`, the manifest schema (to read `network.hosts`).

### Credential store

- **Path**: `server/services/credential-store.ts` (new).
- **Responsibility**: implement `get(slot)` / `set(slot, value)` / `delete(slot)` backed by the OS keyring via pure-JS shellouts.
- **Reuse vs new**: new module. Internally uses `exec.ts:32` (`runCommand`) for shellouts. On Linux we pass through `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (`cleanEnv` currently strips them; the credential store calls `runCommand` with an env extension or bypasses `cleanEnv` for these specific vars).
- **Supported-platform matrix**: macOS and Linux only (Windows is out of scope per the platform constraint at the top of this document).
- **Platform implementations**:
  - macOS: `security add-generic-password -a <slot> -s roubo-plugins -w <secret> -U` to write; `security find-generic-password -a <slot> -s roubo-plugins -w` to read.
  - Linux: `secret-tool store --label='roubo-<pluginId>-<slot>' service roubo-plugins account <slot>` reading the password from stdin (so it never appears in argv). `secret-tool lookup service roubo-plugins account <slot>` to read.
- **Slot naming**: slots are namespaced `<pluginId>/<slotName>` at the storage layer to prevent slot-name collisions across plugins. The credential service rejects `get`/`set` requests whose `<slotName>` is not declared in the manifest's `permissions.credentials[].slot` array, providing the cooperative-enforcement boundary noted in feasibility.
- **Headless-Linux behaviour (open spike)**: on headless Ubuntu (no graphical session, no `gnome-keyring-daemon` running by default), `secret-tool` shellouts will fail. The credential store hard-fails at first credential read/write with `CredentialStoreError("keyring-unavailable", ...)`, surfacing the failure to the calling plugin (which logs it). The PRD constraint is "no plaintext on disk," so we do not silently fall back to a plaintext file. The recommended user recipe, which is documented in full in `server/services/credential-store.README.md`:

  ```bash
  # one-time install
  sudo apt-get install -y libsecret-tools gnome-keyring dbus-user-session

  # per shell session (interactive)
  export $(dbus-launch)
  printf '\n' | gnome-keyring-daemon --unlock --components=secrets
  gnome-keyring-daemon --start --components=secrets

  # or as a one-shot wrapper for headless CI / servers
  dbus-run-session -- sh -c 'printf "\n" | gnome-keyring-daemon --unlock --components=secrets && roubo'
  ```

  Whether this recipe is sufficient for typical headless adopters is the remaining open question; this is gated by Spike A and tracked under `risks_and_alternatives`.

- **Public interface**: `get(pluginId, slot): Promise<string | null>`, `set(pluginId, slot, value): Promise<void>`, `delete(pluginId, slot): Promise<void>`, `listSlotsForPlugin(pluginId): Promise<string[]>`.
- **Dependencies**: `exec.ts:32`.

### Plugin SDK package

- **Path**: `sdk/` (new npm workspace), published as `@roubo/plugin-sdk`.
- **Responsibility**: lets a plugin author write `import { definePlugin, host } from "@roubo/plugin-sdk"`. Encapsulates the RPC binding so the plugin author writes plain async methods; the SDK turns them into JSON-RPC request handlers. The host's `host.fetch` / `host.credentials.get` / `host.logger` show up as imports the plugin calls; under the hood, the SDK proxies them as JSON-RPC requests to the host.
- **Reuse vs new**: new workspace; depends on `vscode-jsonrpc` and the manifest types from `shared/plugin-manifest.ts`.
- **Public interface**:
  - `definePlugin({ listSourceCandidates, listIssues, getIssue, getAvailableTransitions, applyTransition, assignIssue, unassignIssue, validateConfig, getCurrentUser, listIssueTypes? }): void` — the plugin author calls this once at entry; the SDK starts the RPC reader and binds the handlers.
  - `host.fetch(url, init): Promise<{ status, headers, body }>`.
  - `host.credentials.get(slot)`, `host.credentials.set(slot, value)`.
  - `host.logger.info(payload)`, `host.logger.warn(payload)`, `host.logger.error(payload)`.
  - `host.spawn(executable, args, opts)` (only available if manifest declares it).
- **Versioning**: `hostApiVersion` semver lives in the SDK as an exported constant; the SDK's `package.json` version is the same as `hostApiVersion`. Major bumps require the SDK and host to ship together. 1.x bumps stay backwards compatible (FR-005).
- **Dependencies**: `vscode-jsonrpc`, `shared/plugin-manifest.ts`.

### Bundled plugins

- **Path**: `plugins/github-com/`, `plugins/github-enterprise/`, `plugins/jira-server/`. Each is its own npm workspace, with `roubo-plugin.yaml` at the top, `package.json`, `src/index.ts`, and tests.
- **Responsibility**: implement the integration. Each plugin's `src/index.ts` calls `definePlugin({...})` from the SDK.
- **Reuse vs new**: github-com is a verbatim move of `server/services/github.ts` and `server/services/github-auth.ts` content; the `githubRequest` helper at `server/services/github.ts:255`, `buildBlockingQuery` at `:476`, `fetchBlockingRelationships` at `:516`, the Projects v2 pagination at `:840`, `fetchIssueTypes` at `:960`, `fetchOpenPullRequestByBranch` at `:1061`, and `fetchLinkedPullRequests` at `:618` all move into the plugin source tree unchanged in behaviour (only the `Octokit` constructor and the token source change: `getOctokit()` reads from `host.credentials.get("github-oauth-token")` instead of `auth.json`). github-enterprise reuses the same code paths with a configurable instance URL. jira-server is new code; ADF-to-markdown walker is hand-rolled (no `@atlaskit/adf-utils` dep).
- **Capabilities**: github-com and github-enterprise declare `capabilities.prSync: true`; jira-server omits it. The host gates `pr-sync.ts` and `auto-clear.ts` on this flag.
- **Dependencies**: SDK, plugin-local deps (`octokit` for GitHub plugins; no extras for Jira).

### Per-user override store

- **Path**: `server/services/integration-overrides.ts` (new). On-disk: `~/.roubo/integrations/<projectId>.yaml` (one file per project, YAML for visual parity with `roubo.yaml`).
- **Responsibility**: load and write the per-user override. Provide deep-merge against the committed `roubo.yaml` integration block. Provide path-traversal-safe resolution mirroring `resolvePermissionsPath` at `state.ts:206`.
- **Reuse vs new**: new module. Uses `atomicWrite` from `state.ts:49`. Path-traversal guard reuses the pattern from `resolvePermissionsPath`.
- **Public interface**:
  - `loadOverride(projectId): Promise<IntegrationOverride | null>` — null on missing file.
  - `saveOverride(projectId, override): Promise<void>` — `atomicWrite`s YAML.
  - `deleteOverride(projectId): Promise<void>`.
  - `effectiveIntegrationConfig(committed, override): IntegrationConfig` — deep-merge; **arrays REPLACE** at every nesting level (per decisions-log); objects merge per field; explicit `null` in override means "delete this field."
- **Deep merge implementation**: hand-rolled in `shared/deep-merge.ts` (new). Library alternatives like `lodash.merge` were considered; rejected because (a) `lodash.merge` concats arrays by default, which is the wrong semantics, and (b) we already avoid lodash in the codebase. The hand-rolled implementation is ~30 lines: walk both shapes recursively; for each key, if both sides are plain objects, recurse; if either side is an array, the override side wins (or both-absent falls through); for primitives, override wins if present.
- **File shape**: `{ schemaVersion: 1, integration: { plugin?, instance?, sources?, advanced?, capturedUserId? } }`. `capturedUserId` is the value returned from `plugin.getCurrentUser` at last successful `validateConfig`.
- **Dependencies**: `yaml`, `state.ts:49`.

### `roubo.yaml` schema additions

- **Path**: `shared/config-schema.ts:235` (modified), `schema/roubo-config.schema.json` (modified in lockstep).
- **Responsibility**: introduce the optional `integration` block.
- **Reuse vs new**: extension of the existing zod schema. The root remains `.strict()`; the `integration` block is the only addition.
- **Public interface (additions only)**: an `integration` object with all fields optional: `plugin: string` (plugin id), `instance?: string` (URL for plugins that have an instance, like GHE / Jira), `sources?: unknown` (shape is plugin-defined; we store whatever `listSourceCandidates` returns selections for, as opaque-to-roubo JSON), `advanced?: unknown` (plugin-defined advanced settings, e.g. Jira link-type names; opaque-to-roubo). Validating the inner `sources` and `advanced` against the plugin's `configSchema` happens after the active plugin is loaded; the roubo.yaml zod schema only enforces "looks like an object." This is consistent with how Roubo treats jig frontmatter today.
- **Dependencies**: zod.

### Migration service

- **Path**: `server/services/migrate.ts` (new).
- **Responsibility**: detect a pre-plugin `~/.roubo/` (`schemaVersion` missing or 0 in `state.json`) and run the atomic migration. Idempotent. Surfaces structured success / failure to the host for the banner.
- **Reuse vs new**: new module; uses `atomicWrite` from `state.ts:49` extensively. Re-uses `loadProjects` from `project-registry`.
- **Atomic ordering (single commit point on `state.json.schemaVersion`)**:
  1. Detect: read `state.json`; if `schemaVersion >= 1`, return `{ already-migrated: true }`.
  2. Read `~/.roubo/auth.json` (token + scopes). If absent and no projects reference github.com, set `schemaVersion: 1` and exit (the user is a fresh install).
  3. For each registered project that today has a configured GitHub.com source: build the per-user override YAML in memory (`integration.plugin: "github-com"`, `integration.sources: { projectV2: <existing project number>, repos: [] }`, `integration.capturedUserId: <viewer login>`).
  4. Write every per-user override file via `atomicWrite` to `~/.roubo/integrations/<projectId>.yaml`. Each write is atomic; the cross-file sequence is not, but the commit marker is below.
  5. Write the migrated token to the OS keyring under slot `github-com/oauth-token` via the credential store. The token in `auth.json` is left on disk for now.
  6. Bump `state.json.schemaVersion` to `1` via `atomicWrite`. **This is the single commit point.** Up to this line, a crash on next boot causes the migration to re-run; the credential-store write is idempotent (overwrites the same slot), the override writes are idempotent (atomicWrite-overwrite-same-content).
  7. After the bump, unlink `~/.roubo/auth.json`. If unlink fails (rare), the bump is already committed; on next boot we observe `schemaVersion === 1 && auth.json present` and re-attempt the unlink. Document this in the boot path.
- **One-time banner**: write a `state.json.migrationBannerDismissed` boolean (default false). Banner shows until dismissed. Across Roubo upgrades, once dismissed, stays dismissed.
- **Public interface**: `run(): Promise<{ migrated: boolean, banner: "success" | "rolled-back" | null }>`.
- **Dependencies**: credential store, project registry, `state.ts`.

### Plugins API routes

- **Path**: `server/routes/plugins.ts` (new), wired under `/api/plugins` in `server/index.ts`.
- **Responsibility**: thin HTTP layer over `plugin-manager.ts`.
- **Reuse vs new**: new router; mirrors the layered structure of existing `server/routes/*.ts`.
- **Endpoints**:
  - `GET /api/plugins` — `pluginManager.listInstalled()`.
  - `POST /api/plugins/install` — body `{ source: { kind: "git", url } | { kind: "local", path } }`. Returns the manifest + permissions for the install permissions dialog. Plugin is not yet enabled.
  - `POST /api/plugins/:pluginId/accept` — finalize install; enable plugin.
  - `DELETE /api/plugins/:pluginId` — uninstall (third-party only; 409 on bundled).
  - `POST /api/plugins/:pluginId/enable`, `POST /api/plugins/:pluginId/disable`.
  - `POST /api/plugins/:pluginId/restart` — clears restart-window counter and re-spawns.
  - `GET /api/plugins/:pluginId/logs?file=current|previous&lines=500`.
- **Dependencies**: `plugin-manager.ts`.

### Integration-config API routes (per-project)

- **Path**: `server/routes/integration.ts` (new), wired under `/api/projects/:projectId/integration`.
- **Responsibility**: read the effective integration config; write the per-user override; run `validateConfig` and `getCurrentUser` round-trips.
- **Reuse vs new**: new router; collaborates with `integration-overrides.ts` and `plugin-manager.ts`.
- **Endpoints**:
  - `GET /api/projects/:projectId/integration` — returns `{ committed, override, effective }`. `committed` comes from the project's `roubo.yaml`; `override` from the per-user override store; `effective` is the deep-merged result.
  - `PUT /api/projects/:projectId/integration` — writes the per-user override only. Never writes back to `roubo.yaml`.
  - `POST /api/projects/:projectId/integration/test` — body `{ config }`. Proxies to `pluginManager.invoke(pluginId, "validateConfig", config)` and `getCurrentUser(config)`. Returns `{ ok: true, identity: { externalId, displayName } } | { ok: false, error: PluginError }`.
  - `GET /api/projects/:projectId/integration/sources` — proxies `listSourceCandidates`.
  - `POST /api/projects/:projectId/integration/transition` — body `{ externalId, transitionName }`; proxies `applyTransition`.
  - `POST /api/projects/:projectId/integration/assign` — body `{ externalId }`; uses captured identity; proxies `assignIssue`.
  - `POST /api/projects/:projectId/integration/unassign` — body `{ externalId }`; proxies `unassignIssue`.
- **Dependencies**: `plugin-manager.ts`, `integration-overrides.ts`, `project-registry`.

### Issues route re-shape (existing routes, modified)

- **Path**: `server/routes/issues.ts:27, :55, :78, :101, :116, :155` (modified).
- **Responsibility**: change `listIssues`-equivalent endpoints to be paginated and integration-routed. Today's GitHub-direct calls become `pluginManager.invoke(activePluginId, "listIssues", { cursor, pageSize, filters })`. Response shape: `{ items: NormalizedIssue[], nextCursor: string | null }`.
- **Reuse vs new**: in-place edit of the existing router. The pre-existing branch-name slugification, conflict resolution, jig injection in `issue-assignment.ts` stays integration-agnostic and unchanged. `checkIssueDependencies` at `issue-assignment.ts:102` flips to passthrough and attaches `blockedBy` on the response payload.
- **Endpoints affected**:
  - `GET /api/projects/:projectId/issues` — was returning `GitHubIssue[]`; now `{ items: NormalizedIssue[], nextCursor }`.
  - `GET /api/projects/:projectId/issues/:externalId` — was numeric id; now string id.
  - `GET /api/projects/:projectId/project-items` — collapses into `/api/projects/:projectId/issues` since the picker is now driven by the plugin's source selection.
  - `POST /api/projects/:projectId/benches/:id/assign-issue` — body's `issueNumber: number` becomes `externalId: string`; the legacy `issueNumber` is accepted for one release as a fallback (`externalId = String(issueNumber)`) and is then dropped.
- **Dependencies**: `plugin-manager.ts`.

### Source picker (host-rendered)

- **Path**: `client/src/components/SourcePicker.tsx` (new), `client/src/components/MultiList.tsx` (new; or fold into `SourcePicker`), `client/src/components/CategorizedMultiList.tsx` (new).
- **Responsibility**: render the declarative source picker shape returned by `listSourceCandidates`. Switches on `{ shape: "multi-list" } | { shape: "categorized-multi-list" }`.
- **Reuse vs new**: new top-level component; **reuses** the existing `client/src/components/MultiSelect.tsx` primitive for the actual selection list. The categorized variant wraps it in React Aria `Tabs`.
- **Public interface**: a React component accepting `{ projectId, pluginId, value, onChange }`. Internally calls `GET /api/projects/:projectId/integration/sources` once on open. Pagination: always-all in this slug per the open-question resolution below; the response shape includes an optional `nextCursor` field so 1.x plugins can opt into pagination without a host change.
- **Dependencies**: React Aria `Tabs`, the existing `MultiSelect.tsx`.

### Plugins page (client)

- **Path**: `client/src/components/PluginsPage.tsx` (new), `client/src/components/PluginCard.tsx` (new), `client/src/components/InstallPluginDialog.tsx` (new), `client/src/components/InstallPermissionsDialog.tsx` (new), `client/src/components/PluginConfigureDialog.tsx` (new), `client/src/components/PluginLogViewer.tsx` (new).
- **Responsibility**: implement screens 1, 2, 3, 4, 5 from `prototype/mockups.md`.
- **Reuse vs new**: new components; use React Aria `Dialog`, `Button`, `TextField`, `Checkbox`, `Tabs`, `RadioGroup` per project conventions. `PluginLogViewer` uses a `Dialog` (Roubo does not ship a `Drawer` primitive today, see open-question response below).
- **Public interface**: routed at `/settings/plugins`.
- **Dependencies**: React Aria Components, React Query, the typed API client.

### Issue source tile (client)

- **Path**: `client/src/components/IssueSourceTile.tsx` (new), `client/src/components/SwitchIntegrationDialog.tsx` (new).
- **Responsibility**: implement screens 6 and 7. Mounts on the project detail page next to existing tiles.
- **Reuse vs new**: new components. Reuse `PluginConfigureDialog.tsx` for the inner Configure flow.
- **Dependencies**: React Aria Components, React Query.

### Bench-view write-back controls (client)

- **Path**: `client/src/components/IssueTransitionDropdown.tsx` (new), `client/src/components/AssignIssueControl.tsx` (new).
- **Responsibility**: implement screens 10 and 11. Mount inside the bench view next to the assigned issue display.
- **Reuse vs new**: new components. Optimistic UI update on click; on error, revert + inline structured error from the plugin (see open-question response below).
- **Dependencies**: React Aria Components, React Query mutations.

### Soft-block warning banner + IssuePickerModal flip

- **Path**: `client/src/components/SoftBlockBanner.tsx` (new); `client/src/components/IssuePickerModal.tsx:91` (modified).
- **Responsibility**: implement screen 12. The banner is informational; bench creation proceeds. The `IssuePickerModal` flips the disabled-row treatment to a warn-only chip on the same row, keeping the `Lock` icon as a visual cue.
- **Reuse vs new**: new banner component; in-place edit of `IssuePickerModal.tsx`. The server flip is at `server/services/issue-assignment.ts:102` and changes from `throw ServiceError(409, ...)` to attaching `{ blockedBy }` on the response payload. Existing tests at `server/services/issue-assignment.test.ts` and `client/src/components/IssuePickerModal.test.tsx` (if present) flip in lockstep.
- **Dependencies**: none.

### Missing-plugin prompt + install source resolution

- **Path**: `client/src/components/MissingPluginDialog.tsx` (new).
- **Responsibility**: implement screen 14. Resolution strategy for the install source: see the open-question response below.
- **Reuse vs new**: new dialog; uses React Aria `Dialog`, `TextField`.
- **Install source hint**: the architecture's recommended resolution is **(a) extend `roubo.yaml` `integration` block to optionally allow a `source` hint** per plugin, e.g. `integration.pluginSource: "https://github.com/example/roubo-plugin-linear"`. This is a single optional string, not a separate lock file. Rationale below.
- **Dependencies**: React Aria, the typed API client.

### Migration banner (client)

- **Path**: `client/src/components/MigrationBanner.tsx` (new).
- **Responsibility**: implement screen 13. Reads `state.json.migrationBannerDismissed` via a `GET /api/migration/status` endpoint.
- **Reuse vs new**: new component. Top-of-shell banner placement.
- **Dependencies**: React Query.

### Active-bench "previous integration" badge

- **Path**: `client/src/components/PreviousIntegrationBadge.tsx` (new), `client/src/components/BenchDetail.tsx` (modified).
- **Responsibility**: screen 15. Renders when `bench.assignedIssue.integrationId !== project.effectiveIntegration.plugin`. Source-sync controls inside the bench are visibly disabled.
- **Reuse vs new**: new badge; in-place edit of the bench detail to read the new field.
- **Dependencies**: none.

## Data model

### Type additions

```ts
// shared/integration-types.ts (new)
export interface NormalizedIssue {
  integrationId: string;
  externalId: string;
  externalUrl: string;
  title: string;
  body: string | null;
  currentState: string;
  allowedTransitions: string[];
  assignees: Array<{ externalId: string; displayName: string }>;
  labels: string[];
  issueType: string | null;
  blocks: string[]; // externalId values
  blockedBy: string[]; // externalId values
  updatedAt: string; // ISO-8601
  raw: unknown; // plugin-scoped opaque payload, never persisted beyond active bench
}

export interface SourceCandidatesResponse {
  shape: "multi-list" | "categorized-multi-list";
  items?: SourceCandidateItem[]; // multi-list
  categories?: Array<{
    id: string;
    label: string;
    items: SourceCandidateItem[];
  }>; // categorized-multi-list
  nextCursor?: string | null; // reserved for future pagination; v1 plugins return undefined
}

export interface SourceCandidateItem {
  externalId: string;
  label: string;
  sublabel?: string;
  icon?: "repo" | "project" | "board" | "epic" | "filter";
}

export interface IntegrationConfig {
  plugin: string;
  pluginSource?: string; // optional install-source hint per roubo.lock-equivalent decision
  instance?: string;
  sources?: unknown;
  advanced?: unknown;
  capturedUserId?: { externalId: string; displayName: string };
}
```

### Modifications

```ts
// shared/types.ts (modify in place)
export interface AssignedIssue {
  // legacy: kept for one release for backwards compat; load-time defaulting fills externalId
  number?: number;
  integrationId: string; // NEW: defaults to "github-com" on load if missing
  externalId: string; // NEW: defaults to String(number) on load if missing
  title: string;
  body?: string | null;
  currentState?: string;
  allowedTransitions?: string[];
  blockedBy?: Array<{ externalId: string; title: string }>; // shape change: numeric → string
  linkedPullRequests?: Array<{ repoFullName: string; number: number }>; // GitHub-only, unchanged
}

export interface PersistedState {
  benches: PersistedBench[];
  schemaVersion?: number; // NEW: 0 (or missing) = pre-plugin; 1 = post-migration
  migrationBannerDismissed?: boolean; // NEW
}
```

### File-system additions

```
~/.roubo/
├── auth.json                          (deleted by migration)
├── projects.json                      (unchanged)
├── state.json                         (gains schemaVersion + migrationBannerDismissed)
├── permissions/<projectId>.json       (existing pattern; unchanged)
├── integrations/<projectId>.yaml      (NEW: per-user override store)
└── plugins/<pluginId>/                (NEW: third-party plugin install directory)
    ├── roubo-plugin.yaml
    ├── package.json
    ├── ... plugin source ...
    └── logs/
        ├── current.log
        └── previous.log
```

```mermaid
erDiagram
    PROJECT ||--o| ROUBO_YAML : commits
    PROJECT ||--o| INTEGRATION_OVERRIDE : per-user-customizes
    ROUBO_YAML ||--o| INTEGRATION_BLOCK : optionally-includes
    INTEGRATION_BLOCK }o--|| PLUGIN : references-by-id
    INTEGRATION_OVERRIDE }o--|| PLUGIN : references-by-id
    INTEGRATION_OVERRIDE ||--o| CAPTURED_IDENTITY : stores
    PLUGIN ||--|| MANIFEST : declares
    MANIFEST ||--|| PERMISSIONS : declares
    PLUGIN ||--o{ CREDENTIAL_SLOT : owns
    BENCH ||--o| ASSIGNED_ISSUE : has
    ASSIGNED_ISSUE }o--|| PLUGIN : sourced-from
```

## Sequence flows

### Plugin lifecycle state machine

```mermaid
stateDiagram-v2
    [*] --> discovered: scan plugins/ and ~/.roubo/plugins/
    discovered --> incompatible: hostApiVersion mismatch
    discovered --> invalid: manifest invalid
    discovered --> disabled: user previously disabled
    discovered --> spawning: enabled at host start
    spawning --> enabled: handshake ok
    spawning --> errored: spawn failed
    enabled --> stopping: user clicks Disable or host shutdown
    enabled --> restarting: child process exit code != 0
    restarting --> spawning: under 3-in-5-minutes budget
    restarting --> errored: budget exhausted
    errored --> spawning: user clicks Restart (counter clears)
    stopping --> disabled
    disabled --> spawning: user clicks Enable
    invalid --> [*]: surfaced on Plugins page; not loaded
    incompatible --> [*]: surfaced on Plugins page; not loaded
```

### Primary flow: paginated listIssues

```mermaid
sequenceDiagram
    participant UI as React (IssueQueuePanel)
    participant API as /api/projects/:id/issues
    participant PM as plugin-manager
    participant PR as plugin-rpc
    participant Plugin as bundled plugin (child proc)
    participant Host as host.fetch (in-host)
    participant Remote as Jira/GitHub

    UI->>API: GET ?cursor=&pageSize=50
    API->>PM: invoke(pluginId, "listIssues", {cursor, pageSize, filters})
    PM->>PR: sendRequest("listIssues", params, timeout=30s)
    PR->>Plugin: JSON-RPC framed over stdin
    Plugin->>Plugin: build remote URL, derive headers (If-None-Match)
    Plugin->>PR: sendRequest("host.fetch", {url, init})
    PR->>Host: dispatch
    Host->>Host: enforce manifest allowlist
    Host->>Remote: undici fetch (proxy, TLS opt-in applied)
    Remote-->>Host: 200 + ETag/Retry-After/RateLimit headers
    Host-->>PR: {status, headers, body}
    PR-->>Plugin: result
    Plugin->>Plugin: cache ETag, normalize, build nextCursor
    Plugin-->>PR: {items, nextCursor}
    PR-->>PM: result
    PM-->>API: result
    API-->>UI: {items, nextCursor}
    UI->>UI: append page; useInfiniteQuery sets next page param
```

### Migration sequence (atomic, idempotent)

```mermaid
sequenceDiagram
    participant Boot as server/index.ts
    participant Mig as migrate.run()
    participant State as state.ts (atomicWrite)
    participant Cred as credential-store
    participant FS as fs (unlink auth.json)

    Boot->>Mig: run()
    Mig->>State: read state.json
    alt schemaVersion >= 1
        Mig-->>Boot: { migrated: false, already up to date }
    else
        Mig->>FS: read auth.json
        loop each github.com project
            Mig->>State: atomicWrite ~/.roubo/integrations/<projectId>.yaml
        end
        Mig->>Cred: set("github-com", "oauth-token", value)
        Mig->>State: atomicWrite state.json with schemaVersion=1
        Note over State: SINGLE COMMIT POINT
        Mig->>FS: unlink auth.json
        alt unlink failed
            Note over Mig: commit already happened; retry on next boot
        end
        Mig-->>Boot: { migrated: true, banner: "success" }
    end
```

### Source picker render flow

```mermaid
sequenceDiagram
    participant UI as SourcePicker
    participant API as /api/projects/:id/integration/sources
    participant PM as plugin-manager
    participant Plugin as active plugin

    UI->>API: GET
    API->>PM: invoke(pluginId, "listSourceCandidates", {config})
    PM->>Plugin: JSON-RPC
    Plugin-->>PM: { shape: "multi-list" | "categorized-multi-list", items|categories, nextCursor? }
    PM-->>API: result
    API-->>UI: SourceCandidatesResponse
    UI->>UI: switch on shape; render MultiList or Tabs(MultiList per tab)
```

## Integration points

- **`/api/projects/:projectId/issues` and siblings** — `server/routes/issues.ts:27, :55, :78, :101, :116`. Re-routed through `pluginManager.invoke(activePluginId, "listIssues", {...})`. Pagination shape change ripples to `client/src/hooks/useProjectItems.ts:4` (becomes `useInfiniteQuery` keyed by `["issues", projectId, integrationId, filters]`) and to `client/src/components/IssueQueuePanel.tsx:47` + `client/src/components/IssuePickerModal.tsx:131` (consume `.items`, add "load more").
- **`/api/auth/github/*`** — `server/routes/auth.ts:14`. Stays at this path; the routes call into the bundled github-com plugin via `pluginManager.invoke("github-com", "oauthStart" | "oauthExchange" | "oauthStatus", ...)`. The bundled github-com plugin's RPC surface includes these GitHub-specific methods alongside the standard integration contract. The Electron deep-link handler at `electron/src/main.ts:127` is unchanged; the callback URL `roubo://oauth/github/callback` remains the github-com plugin's auth surface. Future plugins that need deep links would get `roubo://oauth/<pluginId>/callback` and a prefix-dispatch on the Electron side. Out of scope this slug.
- **`/api/projects/:projectId/issue-types`** — `server/routes/projects.ts:168`. Re-routed to `pluginManager.invoke(activePluginId, "listIssueTypes", {})`. The existing `/api/projects/:projectId/jigs/issue-type-mappings` endpoints (per CLAUDE.md) continue to work unchanged at the persistence layer (`Record<string, string>`); the issueType strings are now plugin-sourced.
- **`/api/projects/:projectId/benches/:id/assign-issue`** — `server/routes/issues.ts:155`. The branch-name slugification, conflict resolution, jig injection stay integration-agnostic. Body shape changes `issueNumber: number` → `externalId: string`; the legacy `issueNumber` is accepted for one release.
- **`server/services/pr-sync.ts:18, :35, :129`** — gates flip from `!githubService.getGithubToken()` to `project.effectiveIntegration.plugin !== "github-com"` (more precisely: check the active plugin's manifest `capabilities.prSync`).
- **`server/services/auto-clear.ts:32, :51`** — same gate; classification short-circuits to "blocked: integration does not support PR-driven clear" for non-github benches.
- **`server/services/issue-assignment.ts:102`** — flips from `throw ServiceError(409, ...)` to attaching `{ blockedBy }` on the response. The `enforceIssueDependencies` toggle (`project-registry.ts:215`) now only controls whether the banner shows.
- **`client/src/components/IssuePickerModal.tsx:91`** — disabled-row treatment becomes a warn-only chip with `Lock` icon retained for visual cue; `aria-disabled` and the no-onPress fall-through are removed.
- **`shared/config-schema.ts:235`** — `.strict()` zod gains an optional `integration` block. JSON Schema artifact at `schema/roubo-config.schema.json` updated in lockstep in the same PR (this is the no-partial-rollout-window risk called out in feasibility).
- **`server/index.ts`** — boot sequence gains a `pluginManager.initialize()` call adjacent to `projectRegistry.initialize()`, plus a `migrate.run()` call BEFORE `pluginManager.initialize()` so the migration's `state.json` `schemaVersion` bump is visible. Shutdown sequence gains `pluginManager.shutdown()` before `processManager.stopAllProcesses()`.
- **Electron `electron/src/main.ts`** — unchanged this slug; only the github.com deep-link path matters and it is hardcoded as today.

## Observability

- **Logs**:
  - Per-plugin stdout / stderr captured by the supervisor and written to `~/.roubo/plugins/<pluginId>/logs/current.log`. Size-based rotation at 5 MB: when `current.log` exceeds 5 MB, it is renamed to `previous.log` (overwriting any existing `previous.log`); a new `current.log` is opened. Two-file rotation; older history is intentionally bounded.
  - Plugin-emitted log lines arrive via `host.logger.{info, warn, error}` and are written to the same `current.log` with the schema `{ ts: ISO-8601, level: "info"|"warn"|"error", pluginId, methodName?, payload }`. The in-app log viewer at `client/src/components/PluginLogViewer.tsx` reads through `GET /api/plugins/:pluginId/logs?file=current|previous&lines=500`.
  - Host-side denial events (network allowlist violations, credential slot mismatches, FS-permission rejections) are appended to the plugin's log file at level `warn` with a stable structured shape: `{ kind: "denied", category: "network"|"credentials"|"filesystem"|"childProcess", detail }`.
- **Metrics**: this slug does not introduce telemetry collection; Roubo is a local dev tool and the lagging indicators are tracked by support volume + incident reports, not metrics. The Plugins page surface acts as the in-app metric for end users: status pill + last-N-restart timeline per card.
- **Traces**: plugin error envelopes carry a stable identifier `<pluginId>.<methodName>` (e.g. `github-com.listIssues`) so a banner shown in the UI can be correlated to a log line. The host injects `request-id` and propagates it to plugins via the JSON-RPC `params._meta.requestId`; plugins include it in `host.fetch` calls so a downstream HTTP error can be traced back to the originating UI event.

## Security considerations

The plugin-host security model is _cooperative_, not adversarial. A malicious plugin running with full Node permissions can still call Node APIs directly (read disk, open sockets, spawn children) by ignoring the SDK. The enforcement boundary is the user-accepted permission set plus the install-source URL the user vetted. Roubo does not ship signing or a trust root in this slug. This must be called out in the SDK author docs and the install permissions dialog (FR-007's footer disclosure).

Within that frame, the threats this design counters:

- **Plugin reaches network outside allowlist.** Mitigated by `host.fetch` being the only ergonomic network API the SDK exposes, plus a manifest-driven allowlist enforced in-host before the undici dispatcher runs. A plugin that imports `node:net` or `node:http` directly bypasses this; the SDK author docs document that doing so violates the permission contract and will cause Roubo to refuse to publish the plugin into community discovery (a non-technical control consistent with the no-signing decision).
- **Plugin reads another plugin's credentials.** Mitigated by namespacing credentials at the storage layer as `<pluginId>/<slotName>` and rejecting `credential-store.get(pluginId, slot)` calls whose `slot` is not in that plugin's manifest. A plugin that shells to `security` (macOS) or `secret-tool` (Linux) directly bypasses this; same SDK-contract-violation framing.
- **Plugin writes outside its directory.** Mitigated by the SDK not exposing FS helpers beyond `host.logger` (which writes to the plugin's own log dir). A plugin that imports `node:fs` directly bypasses this; the manifest's `filesystem.paths` declaration is the user-visible commitment.
- **Plugin survives Roubo shutdown.** Mitigated by `pluginManager.shutdown()` SIGTERM-then-SIGKILL via `tree-kill`. POSIX signal semantics on macOS and Linux carry the parent-exits-takes-down-children behaviour we need; no additional platform plumbing is required. On a non-graceful Roubo crash (SIGKILL of the host), the OS will reparent plugin children to PID 1 and they exit on their next stdio read failure; `process-manager.ts`'s existing patterns cover this.
- **Plugin persistently exfiltrates via the `raw` field.** Mitigated by NFR-004's contract: plugins MUST NOT include PII in `raw` unless functionally required, and Roubo does not persist `raw` to `state.json` beyond the active bench's `assignedIssue`. Persistence of `raw` is in-memory only; the bench's `state.json` writer strips `assignedIssue.raw` before serializing.
- **Third-party plugin installs without user consent.** Mitigated by FR-007's permissions dialog with the install-source URL and full permission list; install only completes on `POST /api/plugins/:pluginId/accept` which is wired to the dialog's primary button.
- **Self-signed TLS opt-in is global rather than per-plugin.** Mitigated by per-plugin undici dispatchers; the self-signed-TLS rejectUnauthorized=false agent is bound to a single plugin instance's dispatcher and never reused. The configure dialog shows the per-plugin checkbox; the Plugins page surfaces "Self-signed TLS enabled" inline on the plugin card whenever it is on. Each toggle change is logged at level `warn` to the plugin's log file (audit trail).
- **Plaintext credentials on disk.** Mitigated by the OS keyring requirement plus the migration that unlinks `auth.json`. The headless-Linux fallback is hard-fail by design (no plaintext file); see `risks_and_alternatives`.

## Risks and alternatives

- **Pure-JS keyring on Linux headless (Spike A).** If `secret-tool` is unavailable on the user's headless Ubuntu box, the design hard-fails the credential write with a directive to install `libsecret-tools` and start a keyring daemon (`gnome-keyring-daemon --start --components=secrets`, optionally wrapped in `dbus-run-session` for fully headless boxes). Alternative considered: a passphrase-encrypted file at `~/.roubo/credentials/<pluginId>.enc` with a master passphrase prompted at first launch; rejected for this slug because it weakens the "no plaintext on disk" constraint and requires UX for passphrase entry that Roubo does not have. Re-open if Spike A surfaces this as a real adoption blocker. `unknown — flag for refinement: Spike A outcome on Ubuntu headless`.
- **`githubRequest` fidelity across the RPC boundary (Spike B).** The plugin's ETag store, primary/secondary rate-limit backoff, and GraphQL batching all depend on `host.fetch` surfacing raw response headers verbatim. Mitigated by the design contract that `host.fetch` returns `{ status, headers, body }` with headers lower-cased and arrays preserved. Verification gate is Spike B before host-API freeze. If a header is dropped (e.g. by undici default sanitization) the plugin's ETag store silently regresses to no-cache; the spike's test plan must explicitly assert `If-None-Match` round-trips return `304` from GitHub.
- **`.strict()` zod root forces schema+migration+code to ship in one PR.** Documented in feasibility. No partial-rollout window. The JSON Schema artifact at `schema/roubo-config.schema.json` must land in the same PR as the zod edit.
- **Plugin process orphans on Roubo hard-crash.** Mitigated by `tree-kill` SIGTERM-then-SIGKILL on graceful shutdown. On a non-graceful host crash, POSIX reparenting to PID 1 plus stdio-read failure causes plugin children to exit on their own; no extra mechanism needed on macOS or Linux.
- **Plugin restart budget hides reliability problems.** Mitigated by surfacing the last-5-restart timeline + most recent error on the Plugins page card so the user sees the flapping signal even if the plugin recovers each cycle.
- **Pagination cache invalidation on manual refresh.** Mitigated by React Query's `invalidateQueries(["issues", projectId, integrationId])` resetting the infinite query; the UI returns to page 1 on a manual refresh. Documented in NFR-005's accept criteria.
- **Soft-block migration changes UX expectations.** Mitigated by the one-time migration banner (screen 13) and updated tests at `server/services/issue-assignment.test.ts` + `client/src/components/IssuePickerModal.test.tsx`.
- **No tarball install format.** Rejected per decisions-log; Git URL + local path cover bundled, community, and local-dev workflows. Tarball adds another verification pipeline for no clear win.
- **No version pin in `roubo.yaml`.** Rejected per decisions-log; users run whatever they have installed, and plugins are responsible for backwards compat within their declared `hostApiVersion` range. If this proves painful, a future minor host-API bump can add an optional `minVersion` field without breaking compat.
- **Drawer primitive for log viewer.** Rejected; Roubo does not ship a Drawer today and introducing one for one surface is not justified. The log viewer uses a wide React Aria `Dialog` per screen 5's fallback.
- **Per-plugin live-reload on config change.** Rejected for the safer "restart on credential or instance-URL change; refetch on sources change" pattern. Implementation: the configure dialog's Save action calls `pluginManager.invoke(pluginId, "applyConfig", config)`; if the diff touches credentials or instance, the manager calls `disable(pluginId)` then `enable(pluginId)` before returning. If the diff is sources-only, no restart.
- **Forward-compat: ports / docker as permission categories.** The feasibility doc noted that project-component plugins (a follow-on slug) may need `ports` and `docker` permission categories. This slug's manifest schema is designed so additional permission categories can be added in a 1.x minor (the zod schema's `permissions` object is `.passthrough()`-aware at the category level, and the host treats unknown categories as opt-out). FR-038's paper sketch verifies this before host-API 1.0.0 freeze. **Resolved 2026-05-25:** additive 1.x minor is the accepted path; the existing `.passthrough()`-aware schema is sufficient.
- **Migration banner versioning across Roubo releases.** Once dismissed, never re-shown. Stored as a single boolean `state.json.migrationBannerDismissed`. If a future slug needs to surface a new banner, it adds its own dismissal key; this slug's banner does not carry a version.
- **Optimistic UI for `applyTransition` / `assignIssue` on host crash mid-flight.** Persist nothing; reconcile from source on next refresh. The bench's local UI flips the label optimistically; on error or refresh-detected divergence, the local label is overwritten by the source's truth. Documented in `client/src/components/IssueTransitionDropdown.tsx` and `AssignIssueControl.tsx`.
- **Source picker pagination.** Always-all in this slug. The `SourceCandidatesResponse` shape includes an optional `nextCursor` field so 1.x plugins can opt in. Real-world Jira instances with hundreds of filters get virtualization at the UI level (the `MultiSelect` primitive already virtualizes long lists). Re-evaluate if Spike B's Jira testing surfaces actual instance sizes that break this. **Resolved 2026-05-25:** opt-in cursor on response + virtualized MultiSelect is the accepted approach; revisit only if Spike B surfaces a breaking instance.
- **Plugin restart-window counter reset on manual Restart.** Confirmed: clicking Restart on an errored card clears the 3-in-5-minutes window and attempts a fresh spawn. This is what users expect from a manual recovery action.

## Closing summary

This design has both `context.md`, `prd.md`, and `feasibility.md` to lean on, plus the prototype mockups; no input file was missing.

**Resolution of the eight open questions from prototype-notes.md:**

1. **`roubo.lock`-equivalent.** Extend the `roubo.yaml` `integration` block with an optional `pluginSource` field (string: Git URL or local path). Rationale: single source of truth, no second file to coordinate, teams that want to lock the source for clones commit it; teams that don't, don't. The missing-plugin prompt prefers `pluginSource` when present and falls back to a manual entry field otherwise.
2. **Per-user override location.** `~/.roubo/integrations/<projectId>.yaml`. YAML for visual parity with `roubo.yaml`; envelope `{ schemaVersion: 1, integration: {...} }`.
3. **Test-connection-success Save-gate.** Tracked in `PluginConfigureDialog.tsx` local React state (`hasTestedSuccessfully: boolean`), reset on any field change. Mentioned and trivial.
4. **Drawer vs Dialog for log viewer.** Wide React Aria `Dialog`. No new Drawer primitive this slug.
5. **Optimistic UI mid-flight crash semantics.** Reconcile from source on next refresh. No persisted in-flight state.
6. **Migration-banner versioning.** Once dismissed, forever. Single boolean `state.json.migrationBannerDismissed`.
7. **Restart-window counter reset on manual Restart.** Yes. Clicking Restart clears the counter.
8. **Source-picker pagination.** Always-all in this slug. Shape carries an optional `nextCursor` for future opt-in.

**Component counts: 18 `proposed_components`, 11 `integration_points`, 15 `risks_and_alternatives`.**

**The single biggest architectural call to sanity-check:** the `host.fetch` design as a transparent header-passthrough rather than a sandboxed wrapper. The plugin sees raw response headers (ETag, Retry-After, rate-limit) and is trusted to use them; the host enforces only the network allowlist, system proxy, and self-signed-TLS opt-in. This is what makes the github.com plugin's existing rate-limit-aware code path implementable across the RPC boundary, but it also means `host.fetch` is closer to a routed-fetch than a sandboxed-fetch. Worth confirming this matches the security mental model under FR-008 and NFR-006.

**`unknown — flag for refinement` markers in this design:**

- Spike A outcome on Ubuntu headless (keyring fallback path; whether the `dbus-run-session` + `gnome-keyring-daemon` recipe is sufficient for typical headless adopters). Still deferred pending real-world Spike A data.
- ~~Paper sketch (FR-038) may force `ports` and/or `docker` permission categories now rather than as a 1.x minor.~~ **Resolved 2026-05-25:** additive 1.x minor is the accepted path.
- ~~Source picker pagination on very large Jira instances (re-evaluate after Spike B Jira testing).~~ **Resolved 2026-05-25:** opt-in cursor + virtualized MultiSelect is the accepted approach.

**CI matrix recommendation.** GitHub Actions `pr-check` should run the test matrix on `macos-latest` and `ubuntu-latest` only. No Windows runner. The Ubuntu runner should additionally exercise a headless-keyring smoke test (Spike A deliverable) once the recipe lands.

## Forward compatibility

FR-038 and NFR-011 require a one-page paper sketch verifying that the host API surface designed in this slug can host the planned AI-agent and project-component plugin kinds without a host-API major-version bump. That sketch is the build-time review gate before `hostApiVersion` 1.0.0 is frozen.

The sketch's conclusion: 1.0.0 freeze is safe for both kinds. AI-agent plugins fit the current `host.fetch` / `host.credentials` / `host.logger` surface unchanged, with `host.fetchStream` available as a non-breaking 1.x minor when streaming is needed. Project-component plugins fit the runtime surface unchanged, with new `ports` and `docker` permission categories arriving as a non-breaking 1.x minor when the project-component slug ships. Both follow-up additions are anticipated by the existing `kind`-union and permission-category extensibility design.

See [`forward-compat-sketch.md`](./forward-compat-sketch.md) for the full sketch, including proposed manifest deltas and method sets for each kind.

## Addendum - 2026-05-24: Security & quality issues option

> Scope: design for the per-source alerts option added in the 2026-05-24 PRD addendum (US-011 through US-013, FR-040 through FR-050, NFR-012 through NFR-015). All prior decisions in this file remain in force. The addendum is strictly additive: no host-API change is required, no new RPC method is introduced, no new permission category is declared, and `hostApiVersion` stays at 1.0.0.

### Component design (addendum)

#### Shared GitHub helpers workspace

- **Path**: `plugins/_shared-github/` (new npm workspace). Source tree: `src/fetchers/code-scanning.ts`, `src/fetchers/secret-scanning.ts`, `src/fetchers/dependabot.ts`, `src/scope-detector.ts`, `src/scope-cache.ts`, `src/redact.ts`, `src/external-id.ts`, `src/warnings.ts`, `src/types.ts`, `src/index.ts`. Compiled output under `dist/`. Tests under `src/__tests__/`.
- **Responsibility**: own the three alert fetchers, the per-pull token-scope detector, the in-process scope cache, the alert-payload redactor, the alert external-id formatter/parser, and the HTTP-code-to-cause-string mapping used by the per-category warning surface. Consumed by both `plugins/github-com/` and `plugins/ghe/`.
- **Reuse vs new**: new workspace, but every helper is a focused extension of an existing plugin module. Fetchers call the existing `githubRequest` adapter passed in by the consuming plugin (the workspace does NOT own its own `host.fetch` binding; the consuming plugin's `githubRequest` is dependency-injected). The external-id parser is a strict extension of `plugins/github-com/src/external-id.ts:10` (`parseExternalId`); the addendum changes its parser to recognise the `<category>-<n>` suffix shape.
- **Public interface**:
  - `fetchCodeScanningAlerts(deps, repoFullName, opts)`, `fetchSecretScanningAlerts(...)`, `fetchDependabotAlerts(...)` — each returns `{ items: RawAlert[], hasNextPage: boolean, warnings: SourceWarning[] }`. `deps` is `{ githubRequest, redact, formatExternalId }`. `opts` is `{ page, perPage }`.
  - `detectTokenScopes(deps, opts): Promise<TokenScopeProbe>` — returns `{ kind: "known"; scopes: string[] } | { kind: "unknown"; reason: "no-scope-header" }`. Reads from the in-process scope cache; on cache miss issues one `host.fetch` against `/user` (cheap, ETag-cached by the consuming plugin's `githubRequest`).
  - `invalidateScopeCache(tokenFingerprint: string): void` — wiped by the github-com plugin's OAuth re-consent success handler; wiped by the GHE plugin when the user's PAT is replaced via the configure dialog Save action.
  - `formatAlertExternalId(repoFullName, category, alertNumber): string` — produces `<owner>/<repo>#<category>-<alert_number>` (`code-scanning`, `secret-scanning`, `dependabot`).
  - `parseAlertExternalId(externalId): ParsedAlertExternalId | null` — returns `{ repoFullName, category, alertNumber }` or `null` if the id is a regular issue (caller falls through to the existing issue parser).
  - `redactAlertRaw(category, alertPayload): RedactedRaw` — applies NFR-012's contract (see Security considerations below).
  - `httpStatusToCauseString(category, status, body?): SourceWarning["cause"]` — the per-category mapping table (see "GHAS HTTP code → cause string mapping" below).
- **Dependencies**: none beyond `@roubo/plugin-sdk` types and the consuming plugin's injected `githubRequest`. The package is NOT exposed through `@roubo/plugin-sdk` per the 2026-05-24 decision; third-party plugins do not depend on it.

#### Per-source category booleans in plugin manifests and active config

- **Paths modified**:
  - `plugins/github-com/roubo-plugin.yaml:14` — `configSchema.properties.sources.items.properties` gains three optional boolean fields: `includeCodeScanningAlerts`, `includeSecretScanningAlerts`, `includeDependabotAlerts`. Each has `default: false`.
  - `plugins/ghe/roubo-plugin.yaml:36` — same three booleans on the GHE per-source item shape.
  - `plugins/github-com/src/active-config.ts:47` (`parseConfig`) — extend the per-source entry validator: read the three optional booleans, coerce `undefined → false`, attach to the typed `ConfiguredSource`. Surface non-boolean values as field-scoped validation errors (`sources[i].includeCodeScanningAlerts: must be a boolean`).
  - `plugins/github-com/src/types.ts` and `plugins/ghe/src/types.ts` — `ConfiguredSource` gains `includeCodeScanningAlerts: boolean`, `includeSecretScanningAlerts: boolean`, `includeDependabotAlerts: boolean`. All three default to `false`.
- **Reuse vs new**: in-place extension of the existing per-source config plumbing. No new module.
- **Merge semantics**: the booleans flow through the existing `roubo.yaml` integration block + per-user override deep-merge (`shared/deep-merge.ts`). Because the override's `sources` array REPLACES the committed array per the 2026-05-21 array-replace decision, a teammate who wants to opt out of a team-committed `includeDependabotAlerts: true` must redeclare the source entry with the boolean flipped (or omit it; `undefined` resolves to `false`). This matches the broader override pattern; no new merge logic is needed.

#### Alert fetcher functions (one per category, dependency-injected pagination)

- **Path**: `plugins/_shared-github/src/fetchers/{code-scanning,secret-scanning,dependabot}.ts` (new).
- **Responsibility**: per-category paginated REST calls reusing the consuming plugin's `githubRequest` for auth, ETag caching, primary/secondary rate-limit backoff, and `Retry-After` handling. The fetcher does NOT own any caching policy; it is a pure pagination + normalization loop.
- **Reuse vs new**: shape mirrors `plugins/github-com/src/github-fetchers.ts:44` (`fetchIssuesPage`). Same `page/perPage` parameters, same `{ items, hasNextPage }` envelope (extended with `warnings`). Same `per_page` clamping to 1..100.
- **Public interface**: `fetchCodeScanningAlerts({ githubRequest }, repoFullName, { page, perPage }): Promise<AlertFetchResult>`. `AlertFetchResult = { items: RawAlert[]; hasNextPage: boolean; warnings: SourceWarning[] }`. The `warnings` array is non-empty when the endpoint returned a structured "category unavailable" status (see HTTP-mapping table below); the `items` array is empty in that case. The fetcher NEVER throws on the "unavailable" path; it returns `warnings` and an empty `items` so the calling `listIssues` can continue with other categories per FR-046.
- **REST endpoints**:
  - Code Scanning: `GET /repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page={n}&page={p}`.
  - Secret Scanning: `GET /repos/{owner}/{repo}/secret-scanning/alerts?state=open&per_page={n}&page={p}`.
  - Dependabot: `GET /repos/{owner}/{repo}/dependabot/alerts?state=open&per_page={n}&page={p}`.
- **Dependencies**: injected `githubRequest`, `redactAlertRaw`, `formatAlertExternalId`, `httpStatusToCauseString`.

#### Token-scope detector and in-process cache

- **Path**: `plugins/_shared-github/src/scope-detector.ts`, `plugins/_shared-github/src/scope-cache.ts` (new).
- **Responsibility**: determine whether the active token grants `security_events` BEFORE the first alert fetcher runs on a given pull. The cache key is a SHA-256 fingerprint of the bearer token (NEVER the token itself); the cached value is `{ kind: "known"; scopes: string[]; capturedAt: number } | { kind: "unknown"; reason: "no-scope-header"; capturedAt: number }`. TTL is 5 minutes per cache entry. The cache is process-local (the bundled plugin's child process); it does NOT persist to disk and does NOT survive a plugin restart.
- **Reuse vs new**: new module. Closest prior art is the `etagStore` and `issueCache` modules inside `plugins/github-com/src/github-request.ts` (in-process Maps with a TTL). Same idiom; lifted into the shared workspace because both plugins need it.
- **Cache invalidation**:
  - On a successful OAuth re-consent in the github.com plugin: the github.com plugin's OAuth-exchange handler calls `invalidateScopeCache(tokenFingerprintBefore)` immediately after writing the new token to the keyring, then calls `detectTokenScopes(newToken)` once to warm the cache with the new scopes. The next `listIssues` pull observes the warmed cache and runs the previously-failing category fetcher.
  - On a successful PAT replacement in the GHE plugin: same flow, triggered from the configure-dialog Save action's per-source apply path.
  - On the 5-minute TTL expiry: a fresh probe runs against `/user`; if `X-OAuth-Scopes` is present, the cache stores `{ kind: "known", scopes }`; if absent (GHE fine-grained PAT path per NFR-015), it stores `{ kind: "unknown", reason: "no-scope-header" }`.
  - On plugin restart: cache is empty (in-process only). First pull repopulates.
- **Why host-side caching was rejected**: host-side caching would require a new `host.scopes` RPC method, which violates the no-host-API-change constraint. Plugin-side caching also lines up with the broader design's principle that the plugin owns its HTTP-layer state (ETag, rate-limit, scopes are all the plugin's business; the host knows only the allowlist and TLS toggle).
- **Public interface**: `detectTokenScopes(deps): Promise<TokenScopeProbe>`, `invalidateScopeCache(tokenFingerprint): void`. `tokenFingerprint` is computed once at plugin startup from `host.credentials.get("github-token")` (or the GHE slot) and stored on the active config struct so the consuming plugin can pass it in.

#### Warning surface (inline on `ListIssuesResult`)

- **Path**: `plugin-sdk/src/types.ts:40` (modified).
- **Responsibility**: thread per-source per-category warnings from the plugin to the host on every `listIssues` pull, without introducing a new RPC method.
- **Reuse vs new**: in-place extension of `ListIssuesResult`. Adds one optional field; existing plugins that do not populate it remain wire-compatible.
- **Public interface (SDK type change, additive only)**:

  ```ts
  export interface SourceWarning {
    sourceExternalId: string; // matches ConfiguredSource.externalId
    category: "code-scanning" | "secret-scanning" | "dependabot";
    code:
      | "missing-scope"
      | "scope-unverifiable"
      | "ghas-not-enabled"
      | "feature-disabled"
      | "insufficient-permission"
      | "not-found"
      | "rate-limited"
      | "timed-out"
      | "unknown";
    cause: string; // human-readable, ready for UI rendering; NFR-014 accessible name
  }

  export interface ListIssuesResult {
    items: NormalizedIssue[];
    nextCursor: string | null;
    warnings?: SourceWarning[]; // NEW: addendum field
  }
  ```

- **Wire path**: the bundled github.com `listIssues` accumulates warnings from each enabled category's fetcher into a per-pull array and returns them with the result. The host route at `server/routes/issues.ts:27` forwards them verbatim through the response envelope. The Configure dialog reads them out of the React Query cache for `["issues", projectId, integrationId]` rather than via a new endpoint. Rationale: warnings are naturally per-pull-fresh; coupling them to the pull means they auto-clear on the next successful pull per FR-046.
- **Why a separate `getSourceWarnings` RPC was rejected**: a separate RPC creates a freshness-coupling problem (warnings could be stale relative to the last pull), adds a new method to the contract (which we explicitly do not want to do at host-API 1.0.0), and doubles the work on noisy refresh. Inline is strictly smaller.

#### OAuth re-consent flow integration

- **Path**: `plugins/github-com/src/methods/validate-config.ts` (modified), `plugins/github-com/src/methods/list-issues.ts` (modified), `client/src/components/PluginConfigureDialog.tsx` (modified), `client/src/hooks/useGitHubAuth.ts` (modified), `electron/src/main.ts:87` (UNCHANGED).
- **Responsibility**: when a `SourceWarning` with `code: "missing-scope"` is surfaced for a github.com source, the per-source warning chip becomes the actionable button that re-enters the existing OAuth flow with `scope=repo,read:org,read:project,security_events`. On successful callback, the github.com plugin's OAuth-exchange handler writes the new token, invalidates the scope cache, and the next pull picks up the new scope.
- **Reuse vs new**: NO new deep-link path. The callback URL stays `roubo://oauth/github/callback`; the Electron handler at `electron/src/main.ts:87` is untouched. The github.com plugin's OAuth-exchange handler at the post-migration location of `server/services/github-auth.ts:1` (which moves into `plugins/github-com/src/methods/oauth-exchange.ts` per the broader migration) gains one extra step in its success path: `invalidateScopeCache(oldFingerprint); detectTokenScopes(newToken)`. The authorize URL builder gains a conditional scope: `requiredScopesFor(activeConfig)` returns `BASE_SCOPES.concat(anyAlertCategoryEnabled ? ["security_events"] : [])`. This preserves the 2026-05-24 decision "users who never enable any category never see a re-consent prompt."
- **Dialog state during round-trip**: the Configure dialog stays open. On `Continue to GitHub` (mockup screen 19), the warning chip flips to a `Waiting for browser...` state via local React state. The dialog itself does NOT subscribe to OAuth status; instead, the `useGitHubAuth` hook observes `GET /api/auth/github/status` via React Query's `useQuery` with a 2-second `refetchInterval` ONLY while the chip is in `Waiting for browser...` state (the chip mounts a side-effect that toggles the polling on/off). On status flip to `connected`, the chip side-effect calls `queryClient.invalidateQueries(["issues", projectId, integrationId])` to force a fresh pull, which will repopulate warnings; if the scope is now present and the endpoint returns 200, the warning clears. On dialog close mid-round-trip, the polling unsubscribes; the next dialog open resumes from the OAuth status. This matches today's `useGitHubAuth.ts` pattern for the existing Reconnect banner.
- **GHE variant**: GHE uses a PAT, not OAuth. The warning chip text for `code: "missing-scope"` becomes `Open token settings on <instance URL>` with a plain external link to `<instance>/settings/tokens`. There is no deep-link round-trip; the user regenerates the PAT manually, pastes it into the existing `Personal access token` field, and clicks Save. The Save handler calls `invalidateScopeCache` for the GHE token fingerprint before triggering the next pull. The `NFR-015` `code: "scope-unverifiable"` warning (fine-grained PAT) renders with `Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.` and no actionable button.

#### Test connection per-category extension

- **Path**: `plugins/github-com/src/methods/validate-config.ts` (modified), `plugins/ghe/src/methods/validate-config.ts` (modified), `server/routes/integration.ts` (the `POST /api/projects/:projectId/integration/test` handler, modified), `client/src/components/PluginConfigureDialog.tsx` (modified, mockup screen 20).
- **Responsibility**: when `Test connection` is invoked on a source whose effective config has at least one alert category enabled, the plugin's `validateConfig` issues per-category probes against the relevant REST endpoint with `per_page=1` in parallel, returning a per-category status alongside the existing connection result.
- **Reuse vs new**: extension of the existing `validateConfig` return shape. The `ValidateConfigResult` interface at `plugin-sdk/src/types.ts:57` gains an optional `categoryProbes?: Array<{ sourceExternalId, category, status: "ok" | "unavailable" | "timed-out", cause?: string }>`. Additive; older plugins remain compatible.
- **Probe details**:
  - **Parallelism**: the per-source per-category probes run in parallel via `Promise.allSettled`. For a configured source set of 5 sources with all 3 categories enabled, that is 15 concurrent in-flight requests. Each one is a `per_page=1` REST call, which is cheap relative to a full `listIssues` pull. The existing primary rate-limit backoff inside `githubRequest` handles bursts.
  - **Per-probe timeout**: 5 seconds, hard. A probe that exceeds 5s resolves to `{ status: "timed-out" }` and does NOT fail the overall Test connection result. The 5s cap is enforced inside `validateConfig` via `Promise.race([probe, sleep(5000).then(() => ({ status: "timed-out" }))])`.
  - **Overall Test connection budget**: 12 seconds (the existing connection-test budget; not changed by this addendum). The host route's outer timeout is the existing `pluginManager.invoke` 30s default minus a safety margin; the plugin's internal budget is 12s. Per-category probes that have not resolved by 12s are forcibly cut off and rendered as `timed-out` rows.
  - **Order of operations**: the existing connection probe (the `getCurrentUser` call from FR-035) runs FIRST and serially; on its success, the per-category probes fan out in parallel. On `getCurrentUser` failure, no category probes run.

#### Issue-list category chip and bench Transition/Assign suppression

- **Path**: `client/src/components/IssueQueuePanel.tsx:47` (modified), `client/src/components/IssuePickerModal.tsx:131` (modified), `client/src/components/IssueTransitionDropdown.tsx` (modified), `client/src/components/AssignIssueControl.tsx` (modified), `client/src/components/BenchDetail.tsx` (modified).
- **Responsibility**: render the category chip (`CodeQL` / `Secret` / `Dependabot`) in the Issues list when `issue.issueType` matches one of the three security strings; hide the Transition dropdown and disable the Assign control on benches whose `assignedIssue.issueType` matches.
- **Reuse vs new**: small in-place edits. A new `client/src/components/IssueCategoryChip.tsx` component encapsulates the chip rendering with the three label/background variants (mockup screen 18). The Transition dropdown's render path adds an early-return when `issueType.startsWith("security-")`. The Assign control adds `isDisabled={isSecurityAlert}` plus a React Aria `<Tooltip>` with the explanatory string from mockup screen 10-extended.
- **Dependencies**: React Aria `<Tooltip>`, existing chip styling tokens (see Forward compatibility section below for token notes).

### Data model (addendum)

#### `ListIssuesResult` envelope change

Already detailed under "Warning surface" above. Recap:

```ts
// plugin-sdk/src/types.ts (additive only)
export interface SourceWarning {
  sourceExternalId: string;
  category: "code-scanning" | "secret-scanning" | "dependabot";
  code:
    | "missing-scope"
    | "scope-unverifiable"
    | "ghas-not-enabled"
    | "feature-disabled"
    | "insufficient-permission"
    | "not-found"
    | "rate-limited"
    | "timed-out"
    | "unknown";
  cause: string;
}

export interface ListIssuesResult {
  items: NormalizedIssue[];
  nextCursor: string | null;
  warnings?: SourceWarning[]; // NEW
}

export interface ValidateConfigResult {
  ok: boolean;
  errors?: Array<{ field?: string; message: string; code?: string }>;
  categoryProbes?: Array<{
    sourceExternalId: string;
    category: "code-scanning" | "secret-scanning" | "dependabot";
    status: "ok" | "unavailable" | "timed-out";
    cause?: string;
  }>; // NEW
}
```

#### Normalized issue `issueType` candidate set expansion

The `issueType: string | null` field at `plugin-sdk/src/types.ts:19` is unchanged in shape. The candidate set the github.com and GHE plugins emit now includes three additional values:

- `security-code-scanning`
- `security-secret-scanning`
- `security-dependabot`

The `listIssueTypes` method (`plugins/github-com/src/methods/list-issue-types.ts:1`, `plugins/ghe/src/methods/list-issue-types.ts:1`) appends these three to the returned `IssueTypeOption[]` ONLY when at least one configured source has the corresponding category boolean on. Rationale: the blueprint-by-issue-type mapping UI at `/api/projects/:projectId/blueprints/issue-type-mappings` lists exactly the types the user can encounter; we do not clutter the UI with categories that are off for every source.

The blueprint resolver at `server/services/blueprint-manager.ts:339` (`findBlueprintForIssue`) requires no change; the mapping keys are opaque strings.

#### External-id format change for alerts (FR-044)

- **Regular issues** (unchanged): `<owner>/<repo>#<issue_number>`, integer after `#`. Example: `wday-planning/roubo#123`.
- **Alerts** (new): `<owner>/<repo>#<category>-<alert_number>`, where `<category>` is one of `code-scanning`, `secret-scanning`, `dependabot`. Example: `wday-planning/roubo#code-scanning-17`. The integer is preserved after the `-`; the category prefix disambiguates the namespace.
- **Parser contract**: `plugins/_shared-github/src/external-id.ts` exposes `parseExternalId(id): { kind: "issue", repoFullName, issueNumber } | { kind: "alert", repoFullName, category, alertNumber } | { kind: "invalid" }`. The github-com and GHE plugins replace their local `parseExternalId` callers with this shared variant. The existing `plugins/github-com/src/external-id.ts:10` parser stays as a thin wrapper that calls the shared one and narrows to `kind: "issue"` for backwards compatibility with existing call sites; alert-targeted method calls (`getIssue`, `getComments` against an alert external id) currently are not exercised because alerts are read-only and there is no per-alert refetch path.
- **Stability**: the format is stable across pulls. The category prefix is part of the externalId, so dedup at the `(integrationId, externalId)` level (FR-020) naturally distinguishes between an issue numbered 17 and an alert numbered 17 in the same repo.

#### External-id dedup logic in BenchManager, pr-sync, issue-assignment

A grep across the codebase shows the following call sites that consume `assignedIssue.externalId` or assume integer-parseable formats:

- `server/services/state.ts:104` (`migrateAssignedIssue`) — defaults `externalId` from legacy numeric `number`. Treats `externalId` as an opaque string. **Safe** for the new format; no change.
- `server/services/issue-assignment.ts:186, :295` — assigns `externalId: String(issueNumber)` on bench creation for regular issues. **Safe**; alert benches go through a separate creation path (the Issue picker resolves the externalId from the plugin's `listIssues` return, which is already in the correct format).
- `server/services/bench-manager.ts` — no externalId-string parsing. The bench manager treats `assignedIssue.externalId` as opaque. **Safe**.
- `server/services/pr-sync.ts` — does not read `externalId` (grep returned no matches). PR sync operates on branch names + PR numbers, not issue externalIds. **Safe**. Also already gated on `integrationId === "github-com"` per the broader design; alerts have no linked PRs so this path naturally short-circuits.
- `plugins/github-com/src/methods/{get-issue,get-comments,apply-transition,assign-issue,unassign-issue}.ts` — all call `parseExternalId` from the plugin's local `external-id.ts:10`. The current parser throws on non-integer suffixes. **Action**: the shared `parseExternalId` returns `{ kind: "alert", ... }` for the new format. Alert-targeted calls to these methods are NOT expected (alerts are read-only and have no comments path exposed), but to be defensive, each method's entry point checks `if (parsed.kind === "alert") throw new Error("[github-com] alert externalIds are read-only; method '<name>' is not supported on alerts")`. This produces a clear error rather than a confusing "not in expected form" message if the host ever routes such a call.
- `server/services/state.test.ts` and `server/services/issue-assignment.test.ts` — test fixtures use integer-string externalIds. **Action**: add fixture coverage for alert-format externalIds to verify load-time round-trip through `migrateAssignedIssue` and bench creation.

No new dedup logic is required in BenchManager; the existing `(integrationId, externalId)` key already distinguishes alerts from issues per FR-020.

#### Token-scope cache shape

```ts
// plugins/_shared-github/src/scope-cache.ts (new)
interface ScopeCacheEntry {
  // SHA-256 hex of the bearer token; the actual token is NEVER stored here.
  fingerprint: string;
  // Resolved scope state at capture time.
  state: { kind: "known"; scopes: string[] } | { kind: "unknown"; reason: "no-scope-header" };
  // Wall-clock ms epoch.
  capturedAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, ScopeCacheEntry>(); // keyed by fingerprint
```

In-memory only (NFR-012 reinforcement: scopes are not on disk). Plugin-process-local. Cleared on plugin restart. Wiped explicitly by `invalidateScopeCache` after a credential change.

#### `raw` redaction contract (NFR-012)

The `redactAlertRaw(category, alertPayload)` function in `plugins/_shared-github/src/redact.ts` applies the following per-category transforms BEFORE the alert is placed in `NormalizedIssue.raw`:

- **`category: "code-scanning"`**:
  - **Drop**: `most_recent_instance.location.snippet` (code excerpt from the source file), `most_recent_instance.message.text` if it contains a snippet (heuristic: includes newline characters), the entire `most_recent_instance.classifications` array (unbounded vendor blob).
  - **Keep**: `rule.id`, `rule.severity`, `rule.description`, `most_recent_instance.location.path`, `most_recent_instance.location.start_line`, `most_recent_instance.location.end_line`, `html_url`, `state`, `created_at`, `updated_at`, `number`.
- **`category: "secret-scanning"`**:
  - **Drop**: `secret` (the leaked secret value in full). Replace with `secret_preview: string` where the preview is `<first 4 chars> + "..." + <redaction marker>` (e.g. `ghp_...REDACTED`). If the secret is shorter than 4 chars, use the whole string + marker. Also drop `secret_type_display_name` if it includes the secret value as a substring (defensive against API regressions).
  - **Keep**: `secret_type`, `resolution`, `html_url`, `state`, `created_at`, `updated_at`, `number`, `locations[].path`, `locations[].start_line`, `locations[].end_line`. The `locations[].blob_sha` and `locations[].commit_sha` are kept (sha hashes, not secret material).
- **`category: "dependabot"`**:
  - **Drop**: `security_advisory.description` (verbose CVE body), `security_advisory.references` (long URL list).
  - **Keep**: `security_advisory.ghsa_id`, `security_advisory.cve_id`, `security_advisory.severity`, `security_advisory.summary` (short single-line summary), `security_advisory.cvss.score`, `dependency.package.name`, `dependency.package.ecosystem`, `dependency.manifest_path`, `html_url`, `state`, `auto_dismissed_at`, `created_at`, `updated_at`, `number`.

The redactor is total: it never returns the original payload object reference. Output is a freshly-constructed object with only the allowlisted fields. The plugin's `console.log` / `console.error` paths NEVER receive the un-redacted payload; the `githubRequest` adapter's debug log path strips response bodies entirely for alert endpoints (a one-line check on the route prefix in `plugins/_shared-github/src/fetchers/*.ts` runs the redactor before any logger call). Unit tests against recorded REST fixtures per category verify the redactor leaves no PII or secret material; see NFR-012's "verified by unit test against a recorded REST fixture" clause.

### Sequence flows (addendum)

#### Successful `listIssues` pull with categories enabled

```mermaid
sequenceDiagram
    participant UI as Client (useInfiniteQuery)
    participant Route as /api/projects/.../issues
    participant Plugin as github-com plugin
    participant Shared as _shared-github (scope+fetchers)
    participant GH as api.github.com

    UI->>Route: GET ?cursor=null
    Route->>Plugin: invoke("listIssues", { cursor, pageSize, filters })
    Plugin->>Shared: detectTokenScopes(deps)
    Shared->>Shared: cache lookup; miss
    Shared->>GH: GET /user (via host.fetch)
    GH-->>Shared: 200 + X-OAuth-Scopes: repo, security_events
    Shared-->>Plugin: { kind: "known", scopes: [...] }
    Plugin->>Shared: fetch issues page (existing path)
    Shared->>GH: GET /repos/o/r/issues?page=1
    GH-->>Shared: 200 + items
    par per-category fan-out
        Plugin->>Shared: fetchCodeScanningAlerts
        Shared->>GH: GET /repos/o/r/code-scanning/alerts?state=open
        GH-->>Shared: 200 + alerts
    and
        Plugin->>Shared: fetchSecretScanningAlerts
        Shared->>GH: GET /repos/o/r/secret-scanning/alerts?state=open
        GH-->>Shared: 451 (GHAS off on private repo)
    and
        Plugin->>Shared: fetchDependabotAlerts
        Shared->>GH: GET /repos/o/r/dependabot/alerts?state=open
        GH-->>Shared: 200 + alerts
    end
    Plugin->>Plugin: redact + normalize + merge<br/>build warnings[] for secret-scanning
    Plugin-->>Route: { items, nextCursor, warnings: [{ secret-scanning, ghas-not-enabled }] }
    Route-->>UI: same envelope; cached by React Query
```

#### OAuth re-consent flow triggered by a warning chip click

```mermaid
sequenceDiagram
    participant Dialog as PluginConfigureDialog
    participant Hook as useGitHubAuth
    participant API as /api/auth/github/*
    participant Browser as External browser
    participant Electron as Electron deep-link handler
    participant Plugin as github-com plugin
    participant Shared as _shared-github scope cache

    Dialog->>Hook: chip.onClick() -> startReconsent()
    Hook->>API: GET /api/auth/github/authorize?scopes=...,security_events
    API->>Plugin: invoke("buildAuthorizeUrl", { scopes })
    Plugin-->>API: { url, state }
    API-->>Hook: { url }
    Hook->>Browser: open(url)
    Hook->>Hook: chip state -> "Waiting for browser..."
    Hook->>API: poll GET /api/auth/github/status (refetchInterval 2s)
    Browser->>Electron: roubo://oauth/github/callback?code=...&state=...
    Electron->>API: POST /api/auth/github/exchange { code, state }
    API->>Plugin: invoke("exchangeOAuthCode", { code, state })
    Plugin->>Shared: invalidateScopeCache(oldFingerprint)
    Plugin->>Shared: detectTokenScopes(newToken) (warm cache)
    Plugin-->>API: { ok: true, scopes }
    API-->>Hook: status flips to "connected"
    Hook->>Hook: chip state -> "Connection upgraded."
    Hook->>Hook: queryClient.invalidateQueries(["issues", projectId, ...])
    Note over Dialog: dialog stayed open throughout; <br/>chip lives in dialog-local state
```

#### Test connection with per-category probes

```mermaid
sequenceDiagram
    participant Dialog as PluginConfigureDialog
    participant Route as /api/projects/.../integration/test
    participant Plugin as github-com plugin
    participant GH as api.github.com

    Dialog->>Route: POST { config }
    Route->>Plugin: invoke("validateConfig", { config })
    Plugin->>GH: GET /user (getCurrentUser; serial)
    GH-->>Plugin: 200 + viewer
    par per-category probes (parallel, Promise.allSettled, 5s per-probe cap)
        Plugin->>GH: GET /repos/o/r/code-scanning/alerts?per_page=1
        GH-->>Plugin: 200
    and
        Plugin->>GH: GET /repos/o/r/secret-scanning/alerts?per_page=1
        GH-->>Plugin: 451
    and
        Plugin->>GH: GET /repos/o/r/dependabot/alerts?per_page=1
        GH-->>Plugin: 200
    end
    Plugin-->>Route: { ok, identity, categoryProbes: [...] }
    Route-->>Dialog: same envelope; render screen 20
```

### Integration points (addendum)

File-level changes by path:

- **`plugins/_shared-github/`** — NEW npm workspace. Wire into root `package.json` workspaces array alongside existing `plugins/github-com`, `plugins/ghe`, `plugin-sdk`.
- **`plugins/github-com/roubo-plugin.yaml:14`** — `configSchema.properties.sources.items.properties` gains three optional booleans (`includeCodeScanningAlerts`, `includeSecretScanningAlerts`, `includeDependabotAlerts`, each `default: false`).
- **`plugins/ghe/roubo-plugin.yaml:36`** — same three booleans on the GHE per-source item schema.
- **`plugins/github-com/src/active-config.ts:47`** — extend `parseConfig` to read and validate the three booleans.
- **`plugins/github-com/src/types.ts`** and **`plugins/ghe/src/types.ts`** — extend `ConfiguredSource` with the three booleans.
- **`plugins/github-com/src/external-id.ts:10`** — `parseExternalId` becomes a wrapper over the shared parser; recognises alert-format ids and returns a discriminated union. Existing call sites narrow to `kind: "issue"`.
- **`plugins/github-com/src/github-fetchers.ts`** — no change (issue fetchers stay where they are); the three new alert fetchers live in the shared workspace and are imported by `methods/list-issues.ts`.
- **`plugins/github-com/src/methods/list-issues.ts:112`** — `listIssues` becomes a merge: scope probe via the shared detector, fan out to enabled alert fetchers per configured source, accumulate warnings, return `{ items, nextCursor, warnings }`. Cursor decoding stays a single integer for the simplest case; multi-category cursoring is handled by per-category pagination state encoded in the cursor blob (a base64-encoded JSON `{ issues?: number, codeScanning?: number, secretScanning?: number, dependabot?: number }` per the feasibility recommendation).
- **`plugins/github-com/src/methods/list-issue-types.ts:1`** — append `security-code-scanning` / `security-secret-scanning` / `security-dependabot` to the returned types when at least one configured source has the matching boolean on.
- **`plugins/github-com/src/methods/validate-config.ts`** — extend with the per-category `per_page=1` probe path described above. Returns the new `categoryProbes` field on success.
- **`plugins/github-com/src/normalize.ts`** — gains three `*AlertToNormalizedIssue` adapters in a new sub-module under `plugins/_shared-github/src/normalize/` (the redaction-aware path).
- **`server/services/github-auth.ts:19`** — `REQUIRED_SCOPES` constant. NOTE: per the broader migration, this file moves into `plugins/github-com/src/oauth/scopes.ts`. The addendum edit happens at the post-migration location and adds a derived helper: `function requiredScopesFor(config) { return anyAlertCategoryEnabled(config) ? [...BASE_SCOPES, "security_events"] : BASE_SCOPES }`. The constant `BASE_SCOPES = ["repo", "read:org", "read:project"]` is unchanged. The `areScopesOutdated` helper at `server/services/github-auth.ts:22` (also moved to the post-migration location) is split into `areBaseScopesOutdated(scopes)` and `hasSecurityEventsScope(scopes)`.
- **`server/routes/issues.ts:27`** — already proxies through the plugin manager; the new optional `warnings` field rides through the response envelope unchanged.
- **`server/routes/integration.ts`** — the `POST /api/projects/:projectId/integration/test` handler returns the new optional `categoryProbes` field on the result envelope unchanged.
- **`plugin-sdk/src/types.ts:40`** — `ListIssuesResult` gains optional `warnings?: SourceWarning[]`. `ValidateConfigResult` gains optional `categoryProbes?: [...]`. Both additive.
- **`client/src/components/PluginConfigureDialog.tsx`** — render the `Security & quality alerts` per-source section (mockup screen 4-extended), the warning chips with re-consent action (mockup screen 19), and the per-category Test connection rows (mockup screen 20).
- **`client/src/components/IssueQueuePanel.tsx:47`** and **`client/src/components/IssuePickerModal.tsx:131`** — render `IssueCategoryChip` to the left of issue titles when `issueType.startsWith("security-")`.
- **`client/src/components/IssueCategoryChip.tsx`** — NEW. Three label/style variants per mockup screen 18.
- **`client/src/components/IssueTransitionDropdown.tsx`** — early-return + explanatory line when issue is an alert.
- **`client/src/components/AssignIssueControl.tsx`** — disabled + tooltip when issue is an alert.
- **`client/src/components/BenchDetail.tsx`** — renders the category chip alongside the bench title for alert-backed benches.
- **`client/src/hooks/useGitHubAuth.ts:1`** — gains a `startReconsent()` action that triggers an authorize-URL fetch with the upgraded scope set; existing `disconnectGitHub` / `connectGitHub` mutations are reused.
- **Electron `electron/src/main.ts:87`** — UNCHANGED. Same callback URL, same handler. The github.com plugin's authorize-URL builder is the only thing that conditionally adds `security_events` to the requested scopes.

### Observability (addendum)

- **Per-category fetch counters and timings (per-plugin log file)**: each invocation of a category fetcher emits one log line at `info` level with shape `{ kind: "alert-fetch", category, repoFullName, page, perPage, durationMs, status: "ok" | "warning", warningCode?: string, itemCount }`. Sufficient to compute a histogram from log scraping; no out-of-process telemetry.
- **Warning surface emission count by `code` (per-plugin log file)**: each emitted `SourceWarning` is logged at `warn` level with shape `{ kind: "warning-emitted", sourceExternalId, category, code }`. The `cause` field is intentionally NOT logged here (it is a UI rendering string, not a metric dimension). No PII.
- **Token-scope cache events (per-plugin log file)**: every cache miss, hit, refresh, and explicit invalidation emits a log line at `debug` level with shape `{ kind: "scope-cache", event: "hit" | "miss" | "refresh" | "invalidate", reason?: string }`. The `fingerprint` is NEVER logged (it would defeat the purpose); only the event type and reason.
- **OAuth re-consent invocation (host-side log, NOT the plugin log)**: the host route at `POST /api/auth/github/authorize` already logs the authorize URL build event; the addendum adds one extra structured field `{ scopesRequested: ["repo", "read:org", "read:project", "security_events"] }` to surface that the upgraded scope set was requested. The authorize URL itself is logged at `info` for parity with existing OAuth observability; the URL contains client id and state but no token. On exchange success, an `info` line records `{ kind: "oauth-exchange", scopesGranted: [...], reconsentForCategories: ["code-scanning", "dependabot"] }` so a user can correlate a "Connection upgraded" UI flip with the log.
- **No new metric names, no new alarm thresholds.** Roubo is a local dev tool; metrics live in support volume and incident reports, not Prometheus.

### Security considerations (addendum)

- **Redaction contract (NFR-012)**: implemented in `plugins/_shared-github/src/redact.ts` per the per-category schedule under "Data model". The redactor is total: it constructs a fresh output object and never returns the original payload reference. The matched-secret bytes from Secret Scanning are reduced to `<first 4 chars> + ... + REDACTED`; the matched code excerpts from Code Scanning are dropped entirely (only `path`, `start_line`, `end_line` survive). Unit tests against recorded REST fixtures per category verify the redactor leaves no PII or secret material. The bundled plugin's `console.log` paths are forbidden from receiving the un-redacted payload; the github-com and GHE plugins' linting setup MUST flag any direct `console.log(alertPayload)` call.
- **Token-scope cache MUST NOT persist scopes to disk**: enforced by design — the cache is a `Map<string, ScopeCacheEntry>` in the plugin's child process, with no FS writes. The cache is also keyed by SHA-256 fingerprint of the token, not the token itself, so a process memory dump does not reveal the token. Plugin restart wipes the cache.
- **OAuth re-consent dialog MUST NOT log the token or the authorize URL with sensitive state**: the existing OAuth flow already pulls the `state` parameter from process memory (`pendingStates` Map in `github-auth.ts:31`), not from logs. The addendum does not change this. The authorize URL is logged at `info` level for observability (per "OAuth re-consent invocation" above); this URL contains the client id and the `state` token, NOT a user secret. The exchanged access token is NEVER logged (existing constraint; the addendum reinforces it via a code review checklist item on the `exchangeOAuthCode` handler).
- **The opaque `raw` field**: the broader architecture's NFR-004 constraint stands ("plugin-scoped opaque payload, never persisted beyond active bench"). Alert benches inherit this constraint; the `raw` payload (severity, CVE id, file path, etc.) lives in memory while the bench is active and is stripped on persistence to `state.json`. The bench's `state.json` writer is unchanged from the broader design.
- **`security_events` scope is requested CONDITIONALLY**: the authorize-URL builder appends `security_events` to the requested scope list ONLY when at least one configured source has at least one alert category enabled. Users who never enable an alert category never see a re-consent prompt and never grant the new scope. This matches the 2026-05-24 decision and is the security-friendliest path.

### Forward compatibility check (addendum)

The addendum is strictly additive and requires NO host-API change. Verified by walking the host-API surface:

- **No new host RPC method.** `host.fetch`, `host.credentials.get/set`, `host.logger` are unchanged.
- **No new plugin-to-host RPC method.** All work goes through the existing `listIssues`, `listIssueTypes`, `validateConfig`. The two additive SDK type changes (`ListIssuesResult.warnings`, `ValidateConfigResult.categoryProbes`) are wire-compatible optional fields per the JSON-RPC + `vscode-jsonrpc` framing; older host code that does not look for these fields ignores them.
- **No new permission category.** `network.hosts: ["api.github.com"]` already covers the three alert endpoints (same host). For GHE, the existing `network.hosts: ["**"]` already covers any instance URL the user configures. No `roubo-plugin.yaml` `permissions` changes.
- **No new credential slot.** The github.com plugin's existing `github-token` slot stores the OAuth token; the GHE plugin's existing `token` slot stores the PAT. The new `security_events` scope is a property of the token, not a separate credential.
- **No new manifest-schema field beyond the three configSchema booleans.** Those are user-config, not manifest-permission, additions and validate through the existing JSON Schema path on the manifest's `configSchema`.

`hostApiVersion` stays at 1.0.0. The SDK package version bumps to a minor (e.g. 1.1.0) on the day the addendum lands, with the two optional fields documented as additive.

### Risks and alternatives (addendum)

- **GHE fine-grained PAT scope detection (NFR-015 implementation).** Fine-grained PATs do not return `X-OAuth-Scopes`; they return `X-Accepted-GitHub-Permissions` or nothing at all. The scope detector returns `{ kind: "unknown", reason: "no-scope-header" }` for this case; the warning chip renders `Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.` (NFR-015 copy). The plugin STILL attempts the per-category probe; a successful 200 means the user is good even though scope verification was inconclusive. **Risk**: a user with a fine-grained PAT that lacks the security alerts permission will see the `scope-unverifiable` warning AND the per-category `ghas-not-enabled` / `insufficient-permission` warning on the next pull. The chip will display the more specific warning preferentially (the per-category warning takes precedence over the generic scope-unverifiable warning when both are emitted; the rendering rule is encoded in `client/src/components/PluginConfigureDialog.tsx`).
- **Polling cost amplification on noisy Dependabot repos.** Per the feasibility addendum: a single source with 500 open Dependabot alerts at `per_page=100` is 5 extra REST calls; 5 sources × 3 categories × 5 pages = 75 calls worst case. **Mitigation**: (a) the existing ETag/304 short-circuit inside `plugins/github-com/src/github-request.ts:208` makes unchanged pages near-free; (b) `useInfiniteQuery` lazy-loads pages only as the user scrolls, so the worst case is paid only when the user explicitly pages through all results; (c) primary rate-limit backoff is already in place. **Residual risk**: a manual Refresh on a busy day with a flapping ETag store could burn a chunk of the user's REST quota. Surfaced via the existing plugin error path (Retry-After + next-reset timestamp) per the re-interview decision.
- **External-id collision detection in BenchManager (FR-044 wiring).** Verified above: no existing dedup logic chokes on the new format. **Residual risk**: a future code path that parses the integer after `#` (which currently does not exist in the codebase, per Grep) would break. **Mitigation**: the shared `parseExternalId` is the single point of parsing; bench-snapshot consumers treat `externalId` as opaque. A grep regression test in `plugin-sdk/__tests__/external-id-format.test.ts` (new) asserts that no production code parses the suffix with `Number(...)`.
- **OAuth re-consent UX during in-progress configure-dialog edits (dialog state during browser round-trip).** Specified above: the dialog stays open; the chip lives in dialog-local React state; `useGitHubAuth` polls `/api/auth/github/status` ONLY while the chip is in `Waiting for browser...` state and unsubscribes on dialog close or chip dismissal. **Residual risk**: if the user closes the dialog mid-round-trip and the OAuth callback fires later, the github.com plugin's token is updated in the background but the user does not see the chip clear. **Mitigation**: the next time the user opens the dialog OR triggers a list refresh, the `["issues", projectId]` cache is fresh and the warning auto-clears per FR-046. The user does not have to re-click anything.
- **Per-source per-category cache invalidation on OAuth re-consent.** Scope cache invalidation is described above. **Risk**: the ETag cache inside `githubRequest` for the alert endpoints contains entries keyed by the prior token's auth context. On a successful re-consent, those cached entries are technically still valid (ETag is per-resource, not per-token), but a defensive plugin author might wonder. **Decision**: the ETag cache is NOT wiped on re-consent. ETags are resource-scoped on GitHub's side; the prior cache stays valid and the next conditional GET correctly returns 304 or fresh data. This is intentional behaviour and is documented in `plugins/_shared-github/src/scope-cache.ts` next to the `invalidateScopeCache` function.
- **GHAS HTTP code → cause string mapping table.** Per category:

  | Endpoint          | HTTP status                              | `code`                    | `cause`                                                                                                                 |
  | ----------------- | ---------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | `code-scanning`   | 401                                      | `missing-scope`           | `Code Scanning unavailable: token lacks security_events permission. Click to upgrade.`                                  |
  | `code-scanning`   | 403 (Forbidden)                          | `insufficient-permission` | `Code Scanning unavailable: token lacks security_events or read access to alerts.`                                      |
  | `code-scanning`   | 404                                      | `feature-disabled`        | `Code Scanning unavailable: not enabled on this repo.`                                                                  |
  | `code-scanning`   | 451                                      | `ghas-not-enabled`        | `Code Scanning unavailable: requires GitHub Advanced Security on this repo.`                                            |
  | `code-scanning`   | 429 / 403+rate-limit-header              | `rate-limited`            | `Code Scanning rate-limited: retry after <timestamp>.`                                                                  |
  | `secret-scanning` | 401                                      | `missing-scope`           | `Secret Scanning unavailable: token lacks security_events permission. Click to upgrade.`                                |
  | `secret-scanning` | 403                                      | `insufficient-permission` | `Secret Scanning unavailable: token lacks repo admin access.`                                                           |
  | `secret-scanning` | 404                                      | `not-found`               | `Secret Scanning unavailable: not enabled on this repo.`                                                                |
  | `secret-scanning` | 451                                      | `ghas-not-enabled`        | `Secret Scanning unavailable: requires GitHub Advanced Security on private repos.`                                      |
  | `dependabot`      | 401                                      | `missing-scope`           | `Dependabot unavailable: token lacks security_events permission. Click to upgrade.`                                     |
  | `dependabot`      | 403                                      | `insufficient-permission` | `Dependabot unavailable: not a repo admin.`                                                                             |
  | `dependabot`      | 404                                      | `feature-disabled`        | `Dependabot unavailable: not enabled on this repo.`                                                                     |
  | any               | 5xx                                      | `unknown`                 | `<Category> unavailable: GitHub returned a server error. Roubo will retry on the next pull.`                            |
  | any               | client timeout                           | `timed-out`               | `<Category> probe timed out.`                                                                                           |
  | any               | `X-OAuth-Scopes` absent and probe failed | `scope-unverifiable`      | `Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.` |

  The table lives in code at `plugins/_shared-github/src/warnings.ts` as the `httpStatusToCauseString` function. **Risk**: GitHub may add new status codes for new GHAS gating modes; the table will require maintenance. **Mitigation**: the `unknown` row is the safe fallback; new status codes degrade gracefully to a generic message until a follow-up updates the table.

- **Shared package NOT exposed via the public SDK.** The 2026-05-24 decision keeps `plugins/_shared-github/` an internal workspace dependency of `plugins/github-com/` and `plugins/ghe/`. Third-party plugins cannot depend on it. **Rationale**: avoids committing to its API surface as part of the host-API contract; the package can evolve freely as a 0.x internal dep. **Re-evaluation trigger**: if a third-party plugin asks to reuse the redactor or the scope detector, lift the relevant function into `@roubo/plugin-sdk` as a 1.x minor.

### Addendum closing notes

- **Component count delta**: +6 logical components within the existing 18 (the shared workspace, the warning surface, the scope cache, the OAuth re-consent integration, the test-connection extension, the issue-category chip + bench suppression). None are new top-level concerns.
- **Integration-point delta**: +14 file-level changes spread across the existing 11 integration points. No new integration-point category; this addendum lights up new code on the same surfaces.
- **No host-API change**, no new RPC method, no new permission category, no new credential slot. `hostApiVersion` stays at 1.0.0.
- **Open architectural questions still gated on user input**: none that block the tests stage. Every prototype-note open question has a concrete decision above. The GHE fine-grained PAT case (NFR-015) and the polling cost amplification (NFR-013 ceiling) are documented risks rather than open architectural decisions.
- **`unknown - flag for refinement` markers added by this addendum**: none. The OAuth re-consent placement, frozen-snapshot semantics, test-connection coverage, code-sharing boundary, external-id format, and HTTP code mapping are all decided above. The two true unknowns (GHE fine-grained PAT prevalence and polling-cost amplification thresholds) are surfaced as risks with defined mitigations, not as architectural markers.

## Re-interview architecture - 2026-05-25 (covers 2026-05-24 alerts + 2026-05-25 polish/consolidation/e2e)

> Scope: layered on top of the shipped runtime, three bundled plugins, three-layer config merge, and migration. This section formalises the architecture for (a) the 2026-05-24 alerts addition (already prose-detailed in the prior addendum above; this section only pins anything still ambiguous), and (b) the full 2026-05-25 scope (connection-status surfacing, plugin grid + full-width Settings, default-disabled bundled plugins + project-load Enable prompt, three-layer `excludedStatuses` with a per-source post-merge pass, plugin-declared filter facets, optional `facetValues` on `NormalizedIssue`, chip taxonomy, GitHub settings push-down into the active-plugin tab, plugin-driven tab title with sidebar/breadcrumb propagation, single context-aware Connect/Configure button, Playwright e2e harness with stubbed plugin process and env-gated reset route). Host-API bumps from 1.0.0 to 1.1.0. All five open questions from `prototype-notes.md` are resolved inline below.

### 1. Summary table of proposed components

| Path | Change | Responsibility | Subsystem |
| --- | --- | --- | --- |
| `plugin-sdk/src/types.ts` | modified | Add `ConnectionStatus`, `FilterFacet`, optional `facetValues` on `NormalizedIssue`, optional `getConnectionStatus` and `filterFacets` on `PluginContract`. | plugin-sdk |
| `plugin-sdk/src/define-plugin.ts` | modified | Bind two additional optional handlers (`getConnectionStatus`, `filterFacets`) into the JSON-RPC dispatch table. | plugin-sdk |
| `shared/config-schema.ts` | modified | Add `excludedStatuses?: string[]` to `IntegrationConfigSchema` (root) and inside `sources[<id>]` (the per-source override layer). | shared |
| `shared/plugin-enable-state-schema.ts` | new | Zod schema for the new `~/.roubo/plugins-state.json` file (one-file shape: `{ schemaVersion: 1, plugins: Record<pluginId, "enabled" \| "disabled">, installInitialized: boolean }`). | shared |
| `shared/connection-status-types.ts` | new | Shared `ConnectionStatus`, `FilterFacet`, `FilterFacetOption` types re-exported from `plugin-sdk`. | shared |
| `server/services/plugin-enable-state.ts` | new | Load/save `~/.roubo/plugins-state.json` via `atomicWrite`. Pure persistence module, no RPC. | server |
| `server/services/plugin-manager.ts` | modified | Read `plugin-enable-state.ts` at `initialize()`; only spawn entries whose persisted state is `"enabled"`. `enable(id)` / `disable(id)` write through. Add `getConnectionStatus(pluginId)` host method with a 30s server-side cache and per-plugin in-flight de-dup. Bump `HOST_API_VERSION` constant to `"1.1.0"`. | server |
| `server/services/connection-status-cache.ts` | new | Module-level `Map<pluginId, { value: ConnectionStatus; capturedAt: number; inFlight: Promise<ConnectionStatus> \| null }>`. Owns the 30s TTL + in-flight de-dup. Cleared on `disable(id)`, `enable(id)`, `restart(id)`, plugin process exit, and successful `validateConfig`. | server |
| `server/services/integration-overrides.ts` | modified | Add `applyPerSourceExcludedStatuses(effective)` post-merge pass that walks `effective.sources[<sourceId>]` entries and pulls `excludedStatuses` from each, falling back to the integration-block-root value when absent. Idempotent. | server |
| `server/services/active-plugin.ts` | modified | Expose `getActiveIntegrationDisplay(projectId)` returning `{ pluginId, displayName }` derived from the effective config and the plugin manifest's `name`. | server |
| `server/services/migrate.ts` | modified | At the same atomic `state.json` commit, seed `~/.roubo/plugins-state.json` according to greenfield detection. Greenfield rule: `state.schemaVersion === undefined && !auth.json && projects.length === 0` → seed all bundled plugins as `disabled`, `installInitialized: true`. Existing installs (auth.json present OR projects.length > 0 OR prior `schemaVersion`): seed each known plugin id as `enabled` to preserve current behaviour. | server |
| `server/routes/plugins.ts` | modified | Add `GET /api/plugins/:pluginId/connection-status` (proxies via cache) and `GET /api/projects/:projectId/integration/connection-status` (same, scoped to project's active plugin). | server |
| `server/routes/integration.ts` | modified | Existing `POST /api/projects/:projectId/integration/test` invalidates the connection-status cache on success. New `GET /api/projects/:projectId/integration/filter-facets` proxies `filterFacets()` to the active plugin. | server |
| `server/routes/test.ts` | new | Env-gated `POST /test/__reset` route. Gated on `process.env.ROUBO_E2E === "1"`. Calls `pluginManager.shutdown()` + `pluginManager.initialize()`, clears the connection-status cache, clears the integration-config in-memory caches, resets `migrate.__test.reset()`. Returns `{ ok: true }`. | server |
| `server/index.ts` | modified | Register `server/routes/test.ts` only when `process.env.ROUBO_E2E === "1"`. | server |
| `client/src/lib/api.ts` | modified | Add typed wrappers for the four new endpoints (per-plugin status, per-project status, per-plugin filter-facets, `POST /test/__reset` for e2e helpers under a `__e2e` namespace). | client |
| `client/src/hooks/usePluginConnectionStatus.ts` | new | React Query hook that reads cached status, gates `refetchOnMount` to UI events (Settings tab open, Configure modal open, cut-list load), does NOT use `refetchInterval`. | client |
| `client/src/hooks/usePluginFilterFacets.ts` | new | React Query hook that fetches `filterFacets()` once per (project, pluginId) and caches indefinitely (invalidated only on plugin restart or config save). | client |
| `client/src/hooks/usePluginEnablePrompt.ts` | new | Detects project-load against a disabled bundled plugin and surfaces the Enable modal. | client |
| `client/src/components/settings/plugins/ConnectionStatusPill.tsx` | new | Five-variant chip (`connected`, `disconnected`, `auth-problem`, `errored`, `disabled`) with colour + icon + shape. Used in three placements. Sibling to `StatusPill.tsx`; the host-process `StatusPill` stays for `enabled` / `disabled` / `errored` / `incompatible` / `invalid`. | client |
| `client/src/components/settings/plugins/PluginsTab.tsx` | modified | Switch the two bundled/third-party lists from `space-y-3` stacks to `grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-3`. | client |
| `client/src/components/settings/plugins/PluginCard.tsx` | modified | Render `ConnectionStatusPill` alongside the existing host-process `StatusPill`; render single context-aware `Connect`/`Configure` button. | client |
| `client/src/components/ProjectSettings.tsx` | modified | Drop `max-w-3xl`; switch to `w-full`. | client |
| `client/src/components/EnableDisabledPluginDialog.tsx` | new | The project-load modal that confirms enabling a disabled bundled plugin (FR-061, NFR-022, NFR-024). | client |
| `client/src/components/IssueSourceTile.tsx` | modified | Collapse three buttons (`Switch integration` + `Configure` + `Choose sources`) into two (`Switch integration` + context-aware `Connect`/`Configure`). Add `ConnectionStatusPill`. | client |
| `client/src/components/ProjectSettingsTab.tsx` | modified | Read `activeIntegrationDisplayName` from the project state and use it as the section heading; propagate to sidebar list at the same source. | client |
| `client/src/lib/cut-list-filters.ts` | modified | Extend `FilterState` with `excludedStatuses: Set<string>`, `includeHidden: Set<string>` (session-scoped opt-back-in), and `facetValues: Record<string, Set<string>>`. Extend `applyFilters` with status-exclusion and generic facet matching. | client |
| `client/src/components/CutListFilters.tsx` | modified (file may not exist yet under this exact name; the host filter row component on the cut-list page) | Render the plugin-declared facets as additional dropdowns; the Status dropdown displays the default-exclusion transparency line + "Hidden by default" tagged items. | client |
| `client/src/components/chips/Chip.tsx` | new | Base chip primitive (colour + icon prefix + shape). | client |
| `client/src/components/chips/StatusChip.tsx`, `LabelChip.tsx`, `IssueTypeChip.tsx`, `MetadataChip.tsx` | new (four) | Four taxonomy categories per FR-068 / mockup section 28. | client |
| `e2e/fixtures/stubbed-plugin/index.mjs` | new | Deterministic plugin process accepting `--scenario=<name>` and `--now=<ISO-8601>` startup args. Implements the full `PluginContract`. | repo root (fixtures) |
| `e2e/fixtures/stubbed-plugin/roubo-plugin.yaml` | new | Manifest matching the stub. Declares `network.hosts: ["stub.invalid"]` so the stub cannot accidentally reach real hosts. | repo root (fixtures) |
| `e2e/fixtures/stubbed-plugin/scenarios/*.json` | new | One file per scenario family (happy-path, disconnected, auth-problem, errored, categorized-multi-list, alerts-enabled, etc.). | repo root (fixtures) |
| `e2e/*.spec.ts` | new | Playwright specs covering FR-080's enumerated surfaces. | repo root |
| `playwright.config.ts` | modified | Add a second `webServer` entry that boots `server/index.ts` with `ROUBO_E2E=1`, `ROUBO_BUNDLED_PLUGINS_DIR=$PWD/e2e/fixtures`, `ROUBO_USER_PLUGINS_DIR=$TMPDIR/roubo-e2e-user-plugins`, and an isolated `HOME` pointing at a per-run temp dir. | repo root |

Total: **31 new files / modified call-sites**, with **24 distinct file paths** modified or created.

### 2. Data model changes

#### `pluginEnableState` persistence (resolves open question 1)

**Decision: separate file `~/.roubo/plugins-state.json`.** Rationale: keeps the existing `state.json` schema stable (it just shipped `schemaVersion: 1` for the plugin migration; piling onto it risks another version bump and a more delicate migration path). A separate file also matches the existing per-concern split (`projects.json`, `state.json`, `permissions/<id>.json`, `integrations/<id>.yaml`). The file lives next to those and follows the same `atomicWrite` discipline. The greenfield seed is committed inside `migrate.run()` so detection and seeding share a single atomic flow.

```ts
// shared/plugin-enable-state-schema.ts (new)
import { z } from "zod";

export const PluginEnableStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    plugins: z.record(z.string(), z.enum(["enabled", "disabled"])),
    // Sentinel that this install has been through the greenfield seeding pass.
    // Prevents re-seeding a fresh-cloned alpha install that happens to look
    // greenfield. Set to true at the same atomic write that seeds `plugins`.
    installInitialized: z.boolean(),
  })
  .strict();
export type PluginEnableState = z.infer<typeof PluginEnableStateSchema>;
```

File shape on disk:

```json
{
  "schemaVersion": 1,
  "installInitialized": true,
  "plugins": {
    "github-com": "disabled",
    "ghe": "disabled",
    "jira-self-hosted": "disabled"
  }
}
```

A missing file at host start means "this install predates the default-disabled feature." The plugin manager treats every discovered plugin id with no entry in `plugins` as implicitly `enabled` (preserves existing-install behaviour). On the very next enable/disable action, the file is written with the full known set; from then on, an absent entry is impossible.

#### `ConnectionStatus` shape on the plugin contract

```ts
// plugin-sdk/src/types.ts (additive)
export type ConnectionStatusKind = "connected" | "disconnected" | "auth-problem" | "errored";

export interface ConnectionStatus {
  kind: ConnectionStatusKind;
  // ISO-8601. The plugin sets this from its own clock; the stubbed e2e plugin
  // sets it from the `--now=` startup arg so specs are byte-deterministic.
  checkedAt: string;
  // Optional human-readable detail. Renders in the chip tooltip. NEVER contains
  // a token, a URL with a token, or PII.
  detail?: string;
}
```

Wire-level addition to `PluginContract`:

```ts
export interface PluginContract {
  // ... existing methods unchanged ...
  getConnectionStatus?: () => Promise<ConnectionStatus> | ConnectionStatus;
  filterFacets?: () => Promise<FilterFacet[]> | FilterFacet[];
}
```

`MethodNotFound` fallback: when `plugin-manager.invoke(pluginId, "getConnectionStatus", {})` resolves with `code: "MethodNotFound"` (existing mapping at `server/services/plugin-manager.ts:874-879`), the cache stores `{ kind: "errored", checkedAt: now, detail: "Plugin does not report connection status" }` and the chip falls back to the `errored` variant with the tooltip explaining the gap. The host does NOT silently substitute `validateConfig` for `getConnectionStatus`; reusing `validateConfig` would conflate "credentials are valid for the integration" with "we can reach the integration right now" and would mean every status check potentially burns a write-back-capable round-trip. Plugins that want connection status MUST implement it explicitly.

#### `FilterFacet` shape on the plugin contract

```ts
// plugin-sdk/src/types.ts (additive)
export type FilterFacetType = "enum" | "enum-async" | "multi-enum";

export interface FilterFacetOption {
  value: string;
  label: string;
}

export interface FilterFacet {
  id: string; // matches the key under `NormalizedIssue.facetValues`
  label: string; // user-visible facet name (e.g. "Milestone", "Epic")
  type: FilterFacetType;
  // Present iff type === "enum" or "multi-enum" AND the facet's option set is
  // small and stable enough to ship inline. Absent for `enum-async` and for
  // large "enum" facets whose options are populated lazily (see open question 2).
  options?: FilterFacetOption[];
}
```

`MethodNotFound` fallback: when `filterFacets()` returns `MethodNotFound`, core falls back to the built-in common-facet set (`Status`, `Label`, `Assignee`, `Type`) populated from the plugin's normalized issue stream (existing fields).

#### Optional `facetValues` on `NormalizedIssue`

```ts
// plugin-sdk/src/types.ts (additive; existing fields unchanged)
export interface NormalizedIssue {
  // ... existing fields ...
  // Optional plugin-populated facet bucket. Keys match `FilterFacet.id`.
  // A facet value MAY be a single string (`enum`) or an array (`multi-enum`).
  // Plugins that do not declare facets omit this field entirely.
  facetValues?: Record<string, string | string[]>;
}
```

Core filters on `issue.facetValues?.[facet.id]`; the legacy "look inside `raw`" coupling is explicitly avoided. Plugins that declare facets MUST populate `facetValues` for the facets they declared. Plugins that omit `facetValues` get only the common-facet fallback set.

#### `excludedStatuses` at three config layers

```ts
// shared/config-schema.ts (modified; additive only)
const ExcludedStatusesSchema = z.array(z.string().min(1)).optional();

// Per-source entry under sources[<id>] gains an optional excludedStatuses field
// alongside any other plugin-defined per-source settings. Because the existing
// per-source schema is plugin-configSchema-driven (each bundled plugin's
// `roubo-plugin.yaml` declares the shape of a source entry), `excludedStatuses`
// is a Roubo-core-reserved field added at the merge layer; bundled plugins
// MUST NOT use the key `excludedStatuses` for plugin-specific settings.

export const IntegrationConfigSchema = z
  .object({
    plugin: z.string().optional(),
    instance: z.string().optional(),
    sources: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional(),
    // NEW: integration-block-root excludedStatuses (per-project layer).
    excludedStatuses: ExcludedStatusesSchema,
    // ... existing fields ...
  })
  .strict();
```

**Three layers (effective precedence: later wins per field):**

1. **Plugin-global default**, declared in each plugin's `roubo-plugin.yaml` under `defaultIntegrationConfig.excludedStatuses` (a new optional manifest field). github.com / GHE / Jira plugins ship `["Closed", "Done", "Resolved", "In review", "PR open", "Waiting on reviewer"]` (or the Jira-localised equivalents in the Jira manifest).
2. **Per-project**, in the project's integration override (`~/.roubo/integrations/<projectId>.yaml`) at the integration block root.
3. **Per-source**, under `sources[<sourceId>].excludedStatuses` in the same override file (or in the committed `roubo.yaml` integration block).

The existing `deepMergeIntegration` walker (`server/services/integration-overrides.ts:176-186`) merges the integration-block root correctly because `excludedStatuses` is a plain array (arrays REPLACE per shared/deep-merge semantics). The per-source layer is NOT covered by the root-level walker because `sources` is itself an array-replace key. A post-merge pass solves this; see component design below.

#### Alerts (2026-05-24) data shape

Already pinned in the prior architecture addendum (sections "Per-source category booleans," "Warning surface," "External-id format"). Recap for the architecture index:

- `ListIssuesResult.warnings?: SourceWarning[]` (additive, in `plugin-sdk/src/types.ts`).
- `ValidateConfigResult.categoryProbes?: [...]` (additive).
- `NormalizedIssue.issueType` candidate set expands to include `security-code-scanning` / `security-secret-scanning` / `security-dependabot`.
- Alert external-id format `<owner>/<repo>#<category>-<n>`.
- Three new optional per-source booleans on the github-com / GHE configSchema: `includeCodeScanningAlerts`, `includeSecretScanningAlerts`, `includeDependabotAlerts`. Defaults `false`.

No further data-model changes are needed in this section for the alerts addition; the prior addendum's design stands.

### 3. Component design

#### Plugin manager extensions (`server/services/plugin-manager.ts`)

- **`getConnectionStatus(pluginId)` host method (server-side, NOT a host-RPC).** Reads from `connection-status-cache.ts`; on miss, calls `invoke(pluginId, "getConnectionStatus", {}, { timeoutMs: 5000 })`. The 5-second per-call timeout is tighter than the default 30s because status checks are user-blocking on UI mount. Per-plugin in-flight de-dup is non-negotiable: if a status request is already in flight, subsequent callers await the same promise.
- **Concurrency policy for opportunistic re-check (resolves open question 3).** Decision: per-plugin in-flight de-dup is the only required throttle; no host-wide concurrency cap is enforced. Rationale: (a) status checks are cheap (one HTTP round-trip via the plugin's `host.fetch`), (b) the network host allowlist already bounds where the calls go, (c) the 30-second cache TTL collapses repeated UI mounts onto one network call, (d) capping host-wide concurrency would force a queue (and the queue itself becomes a coordination surface that needs tests). The plugin process is single-threaded and serialises its own work; the underlying undici dispatcher already pools sockets. We trust those layers. A future host-API minor can introduce a `concurrency: number` knob if real-world load surfaces a problem.
- **Persistence wiring for enable state.** `initialize()` reads `plugin-enable-state.ts` once at boot. The existing loop at `server/services/plugin-manager.ts:679-685` (spawn loop) gains a guard: `if (enableState.plugins[entry.record.manifestId] !== "enabled") { skip spawn; record stays in "disabled" }`. `enable(pluginId)` and `disable(pluginId)` write through to `plugin-enable-state.ts` via `atomicWrite` before mutating the in-memory record. `restart(pluginId)` does NOT change the persisted state (a restart is a process-level action, not an enable/disable). `uninstall(pluginId)` deletes the plugin id from `enableState.plugins` and writes through.
- **`HOST_API_VERSION` bump.** Constant at `server/services/plugin-manager.ts:25` changes from `"1.0.0"` to `"1.1.0"`. Plugins built against `^1.0.0` continue to satisfy the host's range (semver caret is inclusive of the same major). The two new optional methods are additive; older plugins remain compatible via the existing `MethodNotFound` mapping.

#### Plugin contract additions (`plugin-sdk/src/types.ts` + zod) and `MethodNotFound` fallback

- `getConnectionStatus?`, `filterFacets?`, optional `facetValues` on `NormalizedIssue` — schemas in section 2. The SDK's `definePlugin` already binds optional handlers; the addition is two lines per method in the dispatch table.
- **`MethodNotFound` fallback for `getConnectionStatus`**: host caches `{ kind: "errored", detail: "Plugin does not report connection status" }`. Distinct from a "connected" or "disconnected" inference; users see "Errored" with the tooltip explanation.
- **`MethodNotFound` fallback for `filterFacets`**: host falls back to the built-in common-facet set (`Status`, `Label`, `Assignee`, `Type`) sourced from the existing `NormalizedIssue` fields. Core never errors a 1.0.0 plugin on the cut-list page.

#### Integration-overrides post-merge pass (`server/services/integration-overrides.ts`)

New function `applyPerSourceExcludedStatuses(effective: IntegrationConfig): IntegrationConfig`. Walks `effective.sources` (which is `Record<string, Array<string | number>>` per the existing schema), and for each source entry attaches a resolved `excludedStatuses` value computed as `sourceLevel ?? rootLevel ?? pluginGlobalDefault`. The pass is wrapped around `getEffectiveWithGlobal` so callers continue to receive an `IntegrationConfig` with per-source values applied. Idempotent: re-running the pass produces the same shape.

A new sibling `sourceExcludedStatuses(effective, sourceExternalId)` accessor exposes the resolved value to the cut-list filter pipeline without forcing every consumer to walk the same path. The accessor is the single source of truth used by both the server (to forward into RPC params if needed) and the client (via the existing `useProjectIntegration` hook surface).

Because `sources[<id>].excludedStatuses` is a Roubo-core-reserved key, the per-source value lives alongside any plugin-defined per-source fields without conflict. Plugins are documented (SDK README) to not use the key `excludedStatuses` in their per-source configSchema.

#### `pluginEnableState` storage (resolves open question 1)

Decided above: **separate file `~/.roubo/plugins-state.json`**. The module `server/services/plugin-enable-state.ts` exposes:

```ts
export function loadEnableState(): PluginEnableState;
export function saveEnableState(state: PluginEnableState): void;
export function setPluginEnabled(pluginId: string, enabled: boolean): void;
```

`setPluginEnabled` is the atomic load-modify-write helper used by `plugin-manager.enable/disable`. The file is excluded from any state-snapshot endpoint by virtue of living outside `state.json` (NFR-019). No telemetry path reads from it.

#### Test harness reset route (`server/routes/test.ts`, new)

Env-gated `POST /test/__reset`. Active only when `process.env.ROUBO_E2E === "1"`; `server/index.ts` skips the route registration entirely otherwise so the route file is unreachable in production builds.

**Resolves open question 4 — blast radius:** the route resets everything a Playwright spec could observe between runs that does NOT survive a server restart anyway:

- `pluginManager.shutdown()` then `pluginManager.initialize()` (clears in-memory plugin map, restart-window history, re-discovers plugins from `ROUBO_BUNDLED_PLUGINS_DIR`).
- `connection-status-cache.clear()` (clears the 30s per-plugin status cache).
- `migrate.__test.reset()` (clears the singleton last-outcome marker; existing test hook).
- `projectRegistry.__test.reset()` (existing hook; clears the in-memory project list).
- `integration-overrides` in-memory caches (the file-backed values stay because Playwright resets `HOME` per test run; the in-memory layer is a thin wrapper and the reset is defensive).
- `OAuth pendingStates` map in the github-com plugin's auth module (existing test hook).

Notably NOT touched: the on-disk `~/.roubo/` for the test run (the spec owns that via `HOME=`tmp`), the bundled-plugin source files, or any client state (Playwright resets the page).

Implementation calls each subsystem's existing `__test.reset()` hook (where available) plus the new shutdown/initialize sweep on the plugin manager. The route handler is ~30 lines; the blast radius is documented in the file's top comment so future authors don't expand it.

#### GitHub settings push-down (the active integration plugin tab inside `ProjectSettings.tsx`)

**State that moves**:

- `project.repo` (committed `roubo.yaml`) — STAYS in committed `roubo.yaml` because non-GitHub plugins (Jira) also need a per-source equivalent; the field's home is `roubo.yaml`. UI surface moves to the renamed integration tab. The Identity tab no longer renders an input for `repo`. The committed file format is unchanged; only the UI changes location.
- `project.github.project` (committed `roubo.yaml`) — STAYS in committed `roubo.yaml`. Same UI move into the renamed integration tab.
- `layout.submodules` (committed `roubo.yaml`) — STAYS in committed `roubo.yaml`. Rendered as a read-only table inside the integration tab when the project is a meta-repo.

So this is **a UI move, not a schema move**. The renamed integration tab is a render-layer consolidation; the committed schema is untouched. This avoids a schema migration and keeps `roubo.yaml` field-level optional precisely as designed in the original architecture. (Earlier explorations contemplated moving fields into the github-com plugin's per-source configSchema; rejected because it (a) creates a parallel surface for the same data, (b) forces every team to migrate their committed `roubo.yaml`, (c) makes Jira parity awkward when Jira projects also need a `repo` field for cross-repo links.)

**Default branch** stays on Identity (FR-071). Git concept, not GitHub concept.

**Derived `activeIntegrationDisplayName` on the project state (resolves open question 5).** Decision: **yes, derive once in `server/services/active-plugin.ts` and expose via the existing `useProjectIntegration(projectId)` hook as `state.activePluginDisplayName: string | null`**. Rationale: three consumers (tab title, sidebar, breadcrumb) all need the same string; computing it three times invites drift (e.g. one place picks up the manifest `name`, another picks up the plugin id when the manifest is briefly unavailable mid-restart, yielding inconsistent UI). The derived value is computed as `pluginManager.listInstalled().find(p => p.id === effective.plugin)?.manifest?.name ?? null`. When `null`, consumers render the `Source` fallback label.

#### Per-project Settings tab rename

The tab list at `client/src/components/ProjectSettings.tsx:523` is currently hardcoded. The renamed tab requires reading `useProjectIntegration(projectId).data.activePluginDisplayName` and substituting it for the static `Issue source` label. When `activePluginDisplayName` is `null` (no plugin configured), the tab label is `Source` (per FR-069's explicit fallback). The tab `id` stays a fixed string (`integration` or the existing `plugins`) so deep-links continue to work; only the label is dynamic. Sidebar and breadcrumb consume the same derived value.

#### Cut-list filter UI

- **Plugin-declared facets flow.** On cut-list mount, `usePluginFilterFacets(projectId, activePluginId)` issues `GET /api/projects/:projectId/integration/filter-facets`. The route proxies to `pluginManager.invoke(activePluginId, "filterFacets", {})`. The response (`FilterFacet[]`) is cached by React Query keyed `["plugin-filter-facets", projectId, activePluginId]` indefinitely; invalidated only by plugin restart (via the existing plugin-restart notification SSE in `server/routes/notifications.ts` if present, or by user-initiated config save). Each facet renders as one dropdown in the existing filter row. The Status dropdown is the built-in one (not plugin-declared); plugins that declare a `status`-id facet are accepted but core's built-in status filter takes precedence visually (one dropdown labelled `Status`).
- **`excludedStatuses` surface inline in the Status filter dropdown.** The dropdown's top region renders a single-line body-copy explanation: "By default, X, Y, Z are hidden. Toggle them above to include." Below that line, items in the dropdown corresponding to excluded statuses render with a "Hidden by default" tag and unchecked state. Toggling on an excluded status is session-scoped (held in `FilterState.includeHidden: Set<string>`) and does NOT mutate the persisted config. A separate `Including hidden: Closed, Done` chip below the filter row makes the override visible and dismissable.
- **`applyFilters` extension.** The function gains:

  ```ts
  // pseudo-code
  if (filters.excludedStatuses.size > 0 && !filters.includeHidden.has(issue.currentState)) {
    if (filters.excludedStatuses.has(issue.currentState)) return false;
  }
  for (const [facetId, selectedValues] of Object.entries(filters.facetValues)) {
    if (selectedValues.size === 0) continue;
    const issueValue = issue.facetValues?.[facetId];
    if (issueValue === undefined) return false;
    if (Array.isArray(issueValue)) {
      if (!issueValue.some((v) => selectedValues.has(v))) return false;
    } else if (!selectedValues.has(issueValue)) return false;
  }
  ```

  Pure client-side recompute. NFR-021 (50ms p95 for ≤500 issues) is comfortably met by a single linear pass; the existing label-filter loop is the same shape.

#### `filterFacets()` value population strategy (resolves open question 2)

**Decision: hybrid eager-with-lazy-escape-hatch.** The `FilterFacet` shape supports both:

- `type: "enum"` with `options: [...]` — eager. Plugin returns small, stable enums (e.g. github.com's `Milestone` for a single repo, where the typical count is < 50).
- `type: "enum-async"` with `options: undefined` — lazy. Plugin commits to populating options on demand. Host renders the dropdown initially empty with a "Loading…" affordance; when the user opens the dropdown, the host calls a separate `getFacetOptions(facetId, params?: { search?: string }): Promise<FilterFacetOption[]>` RPC. This RPC is added in the same 1.1.0 bump (additive; `MethodNotFound` returns an empty option list and the UI surfaces "Search not supported on this plugin").
- `type: "multi-enum"` — same as `enum`, but the consumer selects multiple values.

**Why hybrid.** Plugin-API defensibility against very large enums is the gating concern (e.g. all assignees in a giant repo, all sprints in a Jira instance with hundreds). A purely eager API would force every plugin to fetch the world up front; a purely lazy API would force github-com's small Milestone facet to pay a second RPC round-trip for no benefit. Hybrid lets each facet pick its trade-off. The github-com plugin returns `Milestone` as `enum` with options inlined. A future plugin that wants `Assignee` declares it as `enum-async` and the host handles it lazily.

This is strictly additive against `MethodNotFound`-tolerant 1.0.0 plugins. Adding the `getFacetOptions` RPC alongside `filterFacets` keeps the contract coherent without an additional minor bump later.

#### Status chip component (`ConnectionStatusPill.tsx`)

Five variants. Each combines a colour with an icon + shape signal (NFR-016: not colour alone).

| Variant | Colour family | Icon (Lucide) | Shape |
| --- | --- | --- | --- |
| `connected` | `emerald-500` | `<Check>` | Pill (rounded-full) |
| `disconnected` | `stone-400` | `<PlugZap>` | Pill, outlined |
| `auth-problem` | `amber-500` | `<KeyRound>` | Pill, filled background |
| `errored` | `red-500` | `<AlertCircle>` | Pill, filled background |
| `disabled` | `stone-300` | `<MinusCircle>` | Pill, outlined, muted |

A sixth ephemeral state (`rechecking`) renders as the cached variant overlaid with a small spinner ring around the icon; it is not a separate `kind`, it's a render-layer presentation when `usePluginConnectionStatus().isFetching && data` (cached value present, re-fetch in flight). The chip reads from React Query cache `["plugin-connection-status", pluginId]`; the cached value is the canonical render. When `data` is undefined and `isLoading` is true, the chip shows the `disconnected` variant with a "Never checked" tooltip.

`ConnectionStatusPill` is a sibling component to `StatusPill.tsx`; the host-process chip stays for `enabled` / `disabled` / `errored` / `incompatible` / `invalid` (process-state). Both chips render on the plugin card (process state on the left, connection state on the right).

#### Plugin grid layout (`PluginsTab.tsx`)

Two-line edit: replace each `<div className="space-y-3">` (lines 79 and 102) with `<div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-3">`. The existing `PluginCard` is a self-contained `<article>` that fits a grid tile without restructuring. Tailwind 4 arbitrary-value support is already enabled (`client/package.json:51`).

Full-width Settings wrapper: at `client/src/components/ProjectSettings.tsx:511`, replace `className="p-8 max-w-3xl"` with `className="p-8 w-full"`. The change widens every Settings tab. Visual review during build confirms the existing `space-y-*`-based tabs (Bench Defaults, Appearance, Jigs, Claude Code) render cleanly at the wider width; no inner-content max-width constraints are added because the existing card-of-cards layouts already self-constrain.

#### Enable-plugin prompt modal

Owned by `client/src/hooks/usePluginEnablePrompt.ts`, mounted at the project-page boundary. The hook reads the project's effective integration plugin id and cross-references `usePlugins()` (the existing plugin-list query) plus the persisted enable state (`GET /api/plugins` already returns each plugin's status; the hook tests for `record.status === "disabled" && record.source === "bundled"`).

When the test passes, the hook surfaces a stateful modal (`EnableDisabledPluginDialog`) blocking the project view until the user clicks Enable or Cancel. Enable calls `POST /api/plugins/:pluginId/enable`; on success, the modal closes and the project view continues to render normally. Cancel returns the user to the project list (NFR-024: re-render within 500ms; the existing route transition is well under that).

**Server-side state touched**: `POST /api/plugins/:pluginId/enable` triggers `pluginManager.enable(pluginId)`, which spawns the plugin process AND writes through `plugin-enable-state.ts`. No silent state mutation: every change is the result of an explicit user action.

Focus management (NFR-022): React Aria `<Dialog>` traps focus, restores to the originating button (the project-list row's open action), exposes title/description via `aria-labelledby` / `aria-describedby`. `Esc` cancels; `Enter` confirms when Enable has focus.

#### Stubbed plugin fixture (`e2e/fixtures/stubbed-plugin/`)

The scenario-pack model. One stubbed-plugin process implements the full contract; a `--scenario=<name>` startup arg selects the JSON file under `e2e/fixtures/stubbed-plugin/scenarios/` that drives the response set for the run. `--now=<ISO-8601>` pins the clock; the stub uses that value for every timestamp (`checkedAt`, `updatedAt`, etc.) so output is byte-deterministic across runs.

A scenario file is a flat JSON map from method name to canned response:

```json
{
  "$schema": "../scenario.schema.json",
  "name": "happy-path-github-com",
  "manifest": { "id": "stub-github", "kind": "integration", "...": "..." },
  "responses": {
    "getConnectionStatus": { "kind": "connected", "checkedAt": "{{NOW}}" },
    "listSourceCandidates": {
      "shape": "multi-list",
      "items": [{ "externalId": "acme/web", "label": "acme/web", "icon": "repo" }]
    },
    "listIssues": {
      "items": [
        {
          "integrationId": "stub-github",
          "externalId": "acme/web#1",
          "externalUrl": "https://stub.invalid/acme/web/issues/1",
          "title": "Stubbed issue 1",
          "currentState": "Open",
          "allowedTransitions": ["Closed"],
          "labels": ["bug"],
          "facetValues": { "milestone": "v1.0" },
          "blocks": [],
          "blockedBy": [],
          "issueType": null,
          "updatedAt": "{{NOW}}",
          "assignees": [],
          "body": null,
          "raw": null
        }
      ],
      "nextCursor": null
    },
    "filterFacets": [
      {
        "id": "milestone",
        "label": "Milestone",
        "type": "enum",
        "options": [{ "value": "v1.0", "label": "v1.0" }]
      }
    ],
    "validateConfig": { "ok": true },
    "getCurrentUser": { "externalId": "stub-user", "displayName": "Stub User" }
  }
}
```

`{{NOW}}` is the only template placeholder; the stub substitutes it from `--now=`. Specs that need to exercise state transitions over time (e.g. "status flips from connected to auth-problem after token expiry") run the plugin with two consecutive scenario files swapped between RPC calls via the `POST /test/__reset` route. Restart the plugin manager, point the stub at the second scenario; the next status check observes the new state.

How time is pinned: the stub never reads `Date.now()`. Every timestamp in its responses is the `--now` arg verbatim. The vscode-jsonrpc framing and the host's RPC timeout are not time-pinned (real wall clock), but those values do not appear in test assertions because Playwright matches on response payloads, not on internal timing.

### 4. Sequence diagrams

#### Fresh-install: bundled plugins disabled, user enables github.com via Connect

```mermaid
sequenceDiagram
    participant Boot as server/index.ts
    participant Mig as migrate.run()
    participant ES as plugin-enable-state
    participant PM as plugin-manager
    participant UI as Settings > Plugins
    participant Card as PluginCard
    participant Modal as PluginConfigureDialog

    Boot->>Mig: run() (first launch)
    Mig->>Mig: detect greenfield (no auth.json, no projects)
    Mig->>ES: saveEnableState({ plugins: { github-com: "disabled", ghe: "disabled", jira-self-hosted: "disabled" }, installInitialized: true })
    Mig->>Boot: { status: "noop", schemaVersion bumped }
    Boot->>PM: initialize()
    PM->>ES: loadEnableState()
    ES-->>PM: all disabled
    Note over PM: spawn loop skips every entry; <br/>all records have status="disabled"
    PM-->>Boot: ready (no processes running)

    UI->>Card: render tile (status="disabled", Disabled chip)
    Card->>Card: user clicks "Connect"
    Card->>PM: POST /api/plugins/github-com/enable
    PM->>ES: setPluginEnabled("github-com", true)
    PM->>PM: spawnPlugin(entry) → child process
    PM-->>Card: { status: "enabled" }
    Card->>Modal: open with focus on credentials
    Modal->>Modal: user completes OAuth flow
    Modal->>PM: POST .../integration/test
    PM->>Modal: { ok: true, identity }
    Note over Card: ConnectionStatusPill flips connected
```

#### Project-load when bundled plugin is disabled (Enable prompt)

```mermaid
sequenceDiagram
    participant Route as React Router
    participant ProjectPage as Project page
    participant Hook as usePluginEnablePrompt
    participant Plugins as usePlugins (GET /api/plugins)
    participant Integration as useProjectIntegration
    participant Dialog as EnableDisabledPluginDialog
    participant PM as plugin-manager

    Route->>ProjectPage: navigate to /projects/:id
    ProjectPage->>Integration: fetch effective integration config
    Integration-->>ProjectPage: { plugin: "github-com", ... }
    ProjectPage->>Plugins: fetch plugin list
    Plugins-->>ProjectPage: github-com record (status="disabled", source="bundled")
    Hook->>Hook: detect disabled + bundled + project references it
    Hook->>Dialog: open modal (focus-trapped, Enter=Enable, Esc=Cancel)
    alt User clicks Enable
        Dialog->>PM: POST /api/plugins/github-com/enable
        PM->>PM: spawnPlugin + persist enable state
        PM-->>Dialog: { status: "enabled" }
        Dialog->>ProjectPage: close; project continues to render
    else User clicks Cancel
        Dialog->>Route: navigate back to project list
    end
```

#### Opportunistic status re-check on cut-list open

```mermaid
sequenceDiagram
    participant Cut as Cut-list page
    participant Hook as usePluginConnectionStatus
    participant Cache as connection-status-cache
    participant PM as plugin-manager
    participant Plugin as bundled plugin
    participant Host as host.fetch
    participant Remote as GitHub/Jira

    Cut->>Hook: mount (queryClient.invalidateQueries on mount)
    Hook->>Cache: GET /api/plugins/github-com/connection-status
    Cache->>Cache: check entry { capturedAt, value }
    alt cache fresh (< 30s old)
        Cache-->>Hook: cached value
        Hook-->>Cut: render chip
    else cache stale or missing
        alt in-flight promise present
            Cache->>Cache: await existing promise
        else no in-flight
            Cache->>PM: invoke("getConnectionStatus", {}, { timeoutMs: 5000 })
            PM->>Plugin: JSON-RPC
            Plugin->>Host: host.fetch GET /user (allowlist enforced)
            Host->>Remote: undici fetch
            Remote-->>Host: 200 + headers
            Host-->>Plugin: { status, headers, body }
            Plugin-->>PM: { kind: "connected", checkedAt: "..." }
            PM-->>Cache: store + resolve in-flight promise
        end
        Cache-->>Hook: ConnectionStatus
        Hook-->>Cut: chip updates (React Query invalidates dependents)
    end
```

#### Cut-list filter recompute with plugin-declared facet

```mermaid
sequenceDiagram
    participant Cut as Cut-list page
    participant Facets as usePluginFilterFacets
    participant API as /api/projects/:id/integration/filter-facets
    participant PM as plugin-manager
    participant Plugin as active plugin
    participant FilterRow as CutListFilters
    participant Apply as applyFilters

    Cut->>Facets: mount
    Facets->>API: GET (cached if already fetched this session)
    API->>PM: invoke("filterFacets", {})
    PM->>Plugin: JSON-RPC
    Plugin-->>PM: [{ id: "milestone", label: "Milestone", type: "enum", options: [...] }]
    PM-->>API: FilterFacet[]
    API-->>Facets: FilterFacet[]
    Facets-->>FilterRow: render extra dropdown

    FilterRow->>FilterRow: user picks Milestone "v1.2"
    FilterRow->>Apply: updated FilterState (facetValues.milestone += "v1.2")
    Apply->>Apply: synchronous filter (single pass over issues)
    Apply-->>Cut: filtered list (≤ 50ms for 500 issues)
```

#### Per-source `excludedStatuses` override path through `integration-overrides.ts`

```mermaid
sequenceDiagram
    participant Caller as Cut-list page (or server route)
    participant Active as resolveActivePlugin / useProjectIntegration
    participant Overrides as integration-overrides.ts
    participant Merge as deepMergeIntegration
    participant PostPass as applyPerSourceExcludedStatuses

    Caller->>Active: getEffective(projectId)
    Active->>Overrides: getEffectiveWithGlobal(committed, projectOverride)
    Overrides->>Merge: committed ⊕ globalOverride ⊕ projectOverride (root level)
    Merge-->>Overrides: rootMerged
    Overrides->>PostPass: applyPerSourceExcludedStatuses(rootMerged)
    PostPass->>PostPass: walk rootMerged.sources entries; <br/>resolve per-source excludedStatuses<br/>(sourceLevel ?? rootLevel ?? pluginGlobalDefault)
    PostPass-->>Overrides: effective config with per-source values
    Overrides-->>Active: IntegrationConfig
    Active-->>Caller: { excludedStatuses by source }
    Caller->>Caller: applyFilters uses resolved set per source
```

#### `POST /test/__reset` between Playwright specs

```mermaid
sequenceDiagram
    participant Spec1 as Playwright spec A
    participant Spec2 as Playwright spec B
    participant TestRoute as POST /test/__reset
    participant PM as plugin-manager
    participant Cache as connection-status-cache
    participant Reg as project-registry
    participant Mig as migrate

    Spec1->>TestRoute: (afterEach) POST /test/__reset
    Note over TestRoute: env-gated: ROUBO_E2E === "1"
    TestRoute->>PM: shutdown()
    PM->>PM: SIGTERM all children, await exit
    TestRoute->>Cache: clear()
    TestRoute->>Reg: __test.reset()
    TestRoute->>Mig: __test.reset()
    TestRoute->>PM: initialize()
    PM->>PM: rediscover plugins from ROUBO_BUNDLED_PLUGINS_DIR
    PM-->>TestRoute: ready
    TestRoute-->>Spec1: { ok: true }
    Spec2->>Spec2: starts from a clean state
```

### 5. Integration points

Existing modules touched, with the smallest viable change at each site.

- `server/services/plugin-manager.ts:25` — `HOST_API_VERSION` bumps from `"1.0.0"` to `"1.1.0"`. One-line change.
- `server/services/plugin-manager.ts:46-47` — module-level state map gains no new entry, but `initialized` boolean is no longer the only init guard; `loadEnableState()` runs once at `initialize()` entry.
- `server/services/plugin-manager.ts:679-686` — spawn loop guards on `enableState.plugins[manifestId] === "enabled"` (or missing entry, which defaults to "enabled" for existing-install back-compat).
- `server/services/plugin-manager.ts:718-742` — `enable()` and `disable()` write through `plugin-enable-state.setPluginEnabled` before mutating the in-memory record.
- `server/services/plugin-manager.ts:829-886` — `invoke()` gains a 5-second default for the two new methods via the existing `opts.timeoutMs` parameter; no signature change.
- `server/services/integration-overrides.ts:176-208` — `getEffectiveIntegrationConfig` and `getEffectiveWithGlobal` are unchanged in signature; a new exported `applyPerSourceExcludedStatuses` is invoked by the cut-list pipeline after the existing merge returns.
- `server/services/migrate.ts:159` — the atomic `state.json` commit gains a sibling `plugin-enable-state.json` `atomicWrite` at the same commit moment. Both files written before the post-commit `auth.json` unlink. Migration determines greenfield via `(state.schemaVersion === undefined && !auth && plans.length === 0)`.
- `server/routes/plugins.ts` — append two new endpoints (`GET /api/plugins/:pluginId/connection-status` and the cache-aware proxy). Existing endpoints unchanged.
- `server/routes/integration.ts` — append `GET /api/projects/:projectId/integration/filter-facets`; the existing `POST .../integration/test` handler gets a one-line cache-invalidate at success.
- `server/index.ts` — register `server/routes/test.ts` only when `process.env.ROUBO_E2E === "1"`. One-line conditional.
- `shared/config-schema.ts:13-33,216-227` — add optional `excludedStatuses` on `IntegrationConfigSchema`. The `sources` field's value shape stays `Record<string, Array<string | number>>` because per-source extra fields go through the post-merge pass; bundled plugins MUST NOT use `excludedStatuses` as a per-source config key.
- `plugin-sdk/src/types.ts:134-160` — additive contract methods (`getConnectionStatus`, `filterFacets`) and additive `facetValues` on `NormalizedIssue`. Wire-compatible.
- `client/src/components/ProjectSettings.tsx:511,523` — `max-w-3xl` → `w-full`. The hardcoded tab list at `:523` reads `activeIntegrationDisplayName` from `useProjectIntegration` when rendering the `integration` tab's label.
- `client/src/components/settings/plugins/PluginsTab.tsx:79,102` — replace `<div className="space-y-3">` with the grid template.
- `client/src/components/IssueSourceTile.tsx:103-128` — collapse three buttons to two; add `ConnectionStatusPill`.
- `client/src/components/settings/plugins/StatusPill.tsx:11-32` — unchanged. `ConnectionStatusPill` is a sibling component, not a rewrite.
- `client/src/lib/cut-list-filters.ts:3-42` — extend `FilterState` and `applyFilters` per the component design above. Backwards compatible because consumers that don't populate the new fields get the existing behaviour.
- `playwright.config.ts` — add a second `webServer` entry for the server, set `fullyParallel: false` (already the case), point at fixture dirs via env vars.
- `e2e/source-picker.spec.ts` — unchanged; this existing fixture-only spec stays as the lower-level component test.

Total: **18 distinct existing modules** receive smallest-viable edits.

### 6. Observability

- **Logs (NFR-023).** Connection-status transitions are logged through the plugin's `host.logger.info` channel with the shape `{ kind: "connection-status-transition", pluginId, previous: <ConnectionStatusKind | null>, next: <ConnectionStatusKind>, trigger: "ui-event-settings-mount" | "ui-event-configure-open" | "ui-event-cutlist-open" | "manual-test-connection" | "post-config-save", at: ISO-8601 }`. The plugin manager emits the log line on every cache write where the new `kind` differs from the previous cached `kind`; identical-to-cached re-checks do NOT emit a log line (would dominate the log file otherwise). Log level: `info` for `connected`, `warn` for `disconnected` / `auth-problem`, `error` for `errored`. The host-side `connection-status-cache.ts` is the single emission point so a plugin that misbehaves cannot mute or duplicate the signal.
- **Metrics.** Roubo is a local dev tool; no Prometheus or OTLP. Filter recompute timings, if observability is needed later, would land in the same per-plugin log file at `debug` level with shape `{ kind: "filter-recompute", facetCount, issueCount, durationMs }`. Not emitted by default this slug.
- **Traces.** No new spans. The existing `<pluginId>.<methodName>` correlation identifier covers `getConnectionStatus` and `filterFacets` automatically because they ride the existing `pluginManager.invoke` path.

### 7. Security considerations

- **NFR-019 — plugin enable state is local-only.** `~/.roubo/plugins-state.json` is read by the host only on `plugin-manager.initialize()` and on each enable/disable. No code path serialises the file's contents into a telemetry payload (Roubo has no telemetry pipeline; the file's existence outside `state.json` also means it is structurally outside any future state-snapshot endpoint). The file mode is 0600 by virtue of `atomicWrite`'s rename-from-tmp pattern, matching `projects.json` and `state.json`.
- **NFR-020 — status re-check routes through `host.fetch`.** The plugin's `getConnectionStatus` implementation MUST issue any remote probe via `host.fetch(url, init)`. The network host allowlist is enforced in-host BEFORE the undici dispatcher runs (per the existing `server/services/plugin-fetch.ts` design); a plugin that attempts to reach a host outside its `permissions.network.hosts` glob set receives the same `{ error: "permission-denied" }` envelope as any other call, regardless of whether the call originated in `listIssues` or `getConnectionStatus`. The self-signed-TLS opt-in is per-`host.fetch`-call (`FetchInit.allowSelfSignedTls`), which means the toggle's effect is bounded to the requesting call; no global TLS state mutation. **Host-API contract for `getConnectionStatus()`**: the host RPC dispatch does NOT exempt this method from the allowlist or TLS rules. Plugins cannot bypass the allowlist by labelling a request as a status probe. The host's `plugin-fetch.ts` is the single enforcement boundary for every plugin-to-network call.
- **OAuth scope handling for the alerts addition** carries forward from the prior addendum: `security_events` is conditionally appended to the requested scope set only when at least one source has an alert category enabled; users who do not enable alerts never see a re-consent prompt.
- **`/test/__reset` security gating.** The route registration is conditional on `process.env.ROUBO_E2E === "1"` at `server/index.ts` boot. Production builds set `NODE_ENV=production` and never set `ROUBO_E2E`; the route file is reachable only when the Playwright harness explicitly opts in. The Electron-packaged Roubo build does not set `ROUBO_E2E`; the route is unregistered, requests to `POST /test/__reset` return 404 because the path is not bound. The conditional registration is enforced via a unit test that boots the server without `ROUBO_E2E` and asserts a 404 on `POST /test/__reset`.
- **Stubbed plugin cannot reach real hosts.** The fixture manifest declares `permissions.network.hosts: ["stub.invalid"]`; the plugin host enforces the allowlist, so even if a stub responder is misconfigured to issue a real fetch, it would be denied. Combined with the per-run `HOME=$TMPDIR` and `ROUBO_BUNDLED_PLUGINS_DIR=$PWD/e2e/fixtures`, the e2e harness has no path to real-network or real-credential effects.

### 8. Risks and alternatives

- **Lazy-vs-eager `filterFacets()` value model.** Chose **hybrid** (`enum` for inline options; `enum-async` for lazy). Alternative considered: pure eager (rejected: forces large plugins to ship potentially-huge enums; users complain when typing a search filter in a dropdown that already has 5000 inline options). Alternative considered: pure lazy with a single `getFacetOptions` RPC (rejected: forces a second RPC round-trip for every small enum, including github-com's `Milestone` which is the most common facet on the most common plugin). Risk of the chosen hybrid: plugins must self-classify facets correctly; a plugin that ships `enum` with 5000 inline options creates a 5000-item dropdown. Mitigation: SDK author docs recommend `enum-async` for any facet whose option set is expected to exceed ~100 items.
- **Separate `plugins-state.json` vs extending `state.json`.** Chose separate file. Risk: a second file means a second `atomicWrite` to coordinate during migration; mitigated by issuing both writes inside `migrate.run()` before the `state.json` `schemaVersion` bump, treating the new file as part of the same commit. Alternative considered: extend `state.json` with a `pluginEnableState` field (rejected: forces a `schemaVersion` bump on a state file that just shipped one; bigger blast radius for any persistence bug).
- **Server-side reset route vs server restart between specs.** Chose env-gated route. Risk: an additional code path that runs only in e2e mode and could drift from production behaviour; mitigated by keeping the route's blast radius narrow (resets only what specs care about) and asserting via a unit test that the route is unregistered when `ROUBO_E2E` is unset. Alternative considered: restart the server process per spec (rejected: Playwright's `webServer` does not support graceful per-spec restarts cleanly, and the cost of process boot would dominate suite runtime).
- **Derived `activeIntegrationDisplayName` on the project state model vs per-consumer derivation.** Chose derived on the state object. Risk: a single derivation source means a bug in the derivation logic affects all three consumers; mitigated because it is one short function and tested once. Alternative considered: each consumer derives independently (rejected: invites drift; three call sites for a small string is a recipe for "the tab says GitHub but the sidebar says github-com" bugs during transition states).
- **`excludedStatuses` is a Roubo-core-reserved per-source key.** Risk: a plugin author might want `excludedStatuses` as a plugin-specific per-source setting in their `roubo-plugin.yaml` `configSchema`; the post-merge pass would then collide. Mitigation: SDK author docs flag the reserved keys (currently just `excludedStatuses`; future Roubo-core-reserved per-source keys will be added to the same list). The host could enforce the reservation by rejecting plugins whose `configSchema.properties.sources.items.properties.excludedStatuses` exists, but that adds a validator we'd rather avoid; cooperative documentation is sufficient.
- **`ConnectionStatusPill` separate from host-process `StatusPill`.** Risk: two chip components increase visual surface area on the plugin card; mitigated by clear semantic split (process state on left, connection state on right). Alternative considered: collapse both into a single chip (rejected: conflates "the plugin process is running" with "the plugin can reach its remote system"; they fail independently and need to be communicated independently).
- **Status chip "Never checked" rendered as `errored`.** Risk: confusing to users who interpret "Errored" as "actively broken" when the truth is "not yet probed." Mitigation: the tooltip explicitly explains "Never checked — open Settings or load the cut list to probe." Alternative considered: a sixth `never-checked` variant (rejected: adds a chip state for a transient condition that resolves on first UI mount; the cache TTL means most users never see it).
- **30-second connection-status cache TTL.** Risk: a user who fixes their token expects the chip to update faster than 30s; mitigated by the explicit cache invalidation on successful `validateConfig` (Test connection clears the cache for that plugin and forces a re-probe). Alternative considered: a shorter TTL (rejected: would burst probe calls during rapid UI mounts; cut-list open, Settings open, dialog open in quick succession).

### 9. `/test/__reset` route security

Explicitly: the route is **gated on `process.env.ROUBO_E2E === "1"`** at server startup. The conditional sits in `server/index.ts` next to other route registrations; when the env var is unset (production, dev, packaged builds), the route file is not imported and the path returns 404. A unit test under `server/routes/test.test.ts` boots the server without `ROUBO_E2E`, issues `POST /test/__reset`, and asserts a 404 response. This both verifies the gating and documents the intent for future authors. The Electron build pipeline explicitly does not set `ROUBO_E2E`. CI runs the e2e workflow with `ROUBO_E2E=1` set only for the dedicated `e2e` job; the `pr-check` workflow's other jobs (`lint`, `typecheck`, `coverage`) do not.

### 10. Open questions remaining

None remain open at the architecture stage. The five prototype-stage open questions resolve as:

1. **`pluginEnableState` storage location** — separate file `~/.roubo/plugins-state.json`.
2. **`filterFacets()` value population** — hybrid: `enum` for inline options, `enum-async` for lazy via an additional `getFacetOptions` RPC.
3. **Status re-check concurrency** — per-plugin in-flight de-dup only; no host-wide throttle.
4. **`/test/__reset` blast radius** — plugin manager (shutdown + reinit), connection-status cache, project-registry, migrate singleton, integration-overrides caches, OAuth pendingStates. Plus the unit-test gate that asserts 404 in production.
5. **Project state model carries `activeIntegrationDisplayName`** — yes, derived once in `server/services/active-plugin.ts`, exposed through `useProjectIntegration`, consumed by tab/sidebar/breadcrumb.

`unknown — flag for refinement` markers: none new. The prior architecture's markers (Spike A on Ubuntu headless, paper sketch outcome for forward-compat permission categories, Jira source picker pagination thresholds) carry forward unchanged; this section does not need to revisit them.

### Closing notes for this section

- **Proposed-component count**: 31 new files / modified call-sites across 24 distinct file paths.
- **Integration-point count**: 18 distinct existing modules receive smallest-viable edits.
- **Host-API**: bumps from 1.0.0 to 1.1.0. Additive only (two optional contract methods, one optional `NormalizedIssue` field, one new RPC `getFacetOptions` paired with `filterFacets`). `MethodNotFound` tolerance covers 1.0.0 plugins for every new method.
- **No new permission categories**, no new credential slots, no new manifest sections. The reserved per-source key `excludedStatuses` is documented in SDK author docs.
- **Top risks** carried into the build stage: (a) the hybrid `filterFacets` contract requires plugins to self-classify; SDK docs must steer authors correctly. (b) The `ConnectionStatusPill` vs `StatusPill` separation introduces two chips on each plugin card; visual review during prototype confirms the layout. (c) The Playwright harness's stubbed-plugin determinism is load-bearing for NFR-018; the scenario-pack model is byte-deterministic by construction, but every new scenario needs a paired unit test that asserts the canned responses round-trip through the SDK without time leakage.
