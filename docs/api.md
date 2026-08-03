# API Reference

Roubo exposes every bench operation as a JSON REST API. The same routes power the in-app UI, GitHub-bot automation, and any external tool (AI coding agent, script, IDE plugin) that wants to drive a bench programmatically.

This document is the authoritative reference for the integration surface. Routes not listed here exist for internal use and may change without notice.

> **Stability.** Roubo is pre-1.0. Endpoint paths and JSON shapes documented here are stable enough to build against, but expect additions and the occasional breaking rename before 1.0. Watch [releases](https://github.com/davidpoxon/roubo/releases) for migration notes.

## Connection

Roubo runs as a local Electron app or a local Node server. In both modes the API listens on **`127.0.0.1`** only (it does not bind a network interface), so it is reachable from the same machine and only the same machine.

| Mode             | Base URL                |
| ---------------- | ----------------------- |
| Production / app | `http://localhost:3333` |
| `npm run dev`    | `http://localhost:3335` |

CORS is open (`Access-Control-Allow-Origin: *`); any browser-based tool on the same machine can call the API directly. Request bodies must be JSON with `Content-Type: application/json`. The JSON body limit is **210 KB**.

## Authentication

There is **no authentication on bench, project, component, tool, or inspection routes**. The security model is "localhost is trusted." If you are running Roubo on a multi-user machine, treat the API as you would any other unauthenticated local service.

The only endpoints that involve a credential are GitHub-backed routes (issues, GitHub Projects, PR sync). These read a `GITHUB_TOKEN` from the environment or a token persisted by the in-app OAuth flow at `~/.roubo/auth.json` (mode `0600`). External callers using `curl` typically do not need to touch these.

## Error model

Errors are JSON. A typical error response looks like:

```json
{
  "error": "Project 'roubo' is already registered",
  "code": "DUPLICATE"
}
```

The `code` field is present for known, classified errors. The status code is set as follows:

| Status | Meaning                                                      | Common `code` values                                                                      |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `400`  | Validation failure or invalid state for the requested action | `INVALID_CONFIG`, `NO_CONFIG`, untyped errors                                             |
| `404`  | Referenced resource does not exist                           | `NOT_FOUND`, `PROJECT_NOT_FOUND`, `CONTAINER_NOT_FOUND`                                   |
| `409`  | Conflict that the client can resolve                         | `DUPLICATE`, `PORT_CONFLICT`, `HAS_BENCHES`, `NO_BENCHES`, `INVALID_STATE`, `bench-dirty` |
| `500`  | Unhandled server error                                       | (no code)                                                                                 |

Some endpoints return additional fields alongside `error` and `code`:

- `bench-dirty` (`DELETE /api/projects/:id/benches/:id?removeWorkspace=true` against a worktree with uncommitted work) includes `reasons: DirtyReason[]`. Pass `&force=true` to override.
- `validate-config` returns `{ valid, errors, portConflicts }` with structured `fieldErrors` and `portConflicts` arrays.

## Core types

The full TypeScript definitions live in [`shared/types.ts`](../shared/types.ts) (consumed by both server and client as `@roubo/shared`). The most relevant shapes for an integrator:

### `Bench`

```ts
{
  id: number;                            // 1..benches.max
  projectId: string;                     // the registered project's name
  branch: string;                        // git branch the worktree is pinned to
  workspacePath: string;                 // absolute path to the worktree on disk
  status: "idle" | "preparing" | "active" | "error" | "clearing";
  ports: Record<string, number>;         // component name -> allocated port
  components: Record<string, ComponentStatus>;
  createdAt: string;                     // ISO timestamp
  error?: string;
  provisioningSteps: ProvisioningStep[];
  teardownSteps: ProvisioningStep[];
  // ... optional fields for jig tracking, etc.
}
```

### `ComponentStatus`

```ts
{
  name: string;
  status: "stopped" | "starting" | "running" | "error" | "stopping";
  pid?: number;
  containerId?: string;
  error?: string;
  startedAt?: string;
  setupComplete: boolean;
}
```

### `RegisteredProject`

```ts
{
  id: string;                            // project.name from roubo.yaml
  repoPath: string;                      // absolute path to the project repo
  config?: RouboConfig;                  // parsed and validated roubo.yaml
  configValid: boolean;
  configError?: string;
  settings: ProjectSettings;
}
```

---

## Projects

### List projects

```
GET /api/projects
```

Returns `RegisteredProject[]`.

```bash
curl http://localhost:3333/api/projects
```

### Register a project

```
POST /api/projects
Content-Type: application/json

{ "repoPath": "/absolute/path/to/repo" }
```

Reads `.roubo/roubo.yaml` from `repoPath`, validates it, checks for port conflicts with other registered projects, and adds the project to the registry.

- `201 Created` with `RegisteredProject`
- `400` if `repoPath` is missing or the config is invalid (`code: INVALID_CONFIG` or `NO_CONFIG`)
- `409 DUPLICATE` if a project with the same `project.name` is already registered
- `409 PORT_CONFLICT` if any port base collides with an existing project

```bash
curl -X POST http://localhost:3333/api/projects \
  -H "Content-Type: application/json" \
  -d '{"repoPath": "/Users/me/code/my-app"}'
```

### Unregister a project

```
DELETE /api/projects/:projectId
DELETE /api/projects/:projectId?force=true
```

- `204 No Content` on success
- `404 NOT_FOUND` if no such project
- `409 HAS_BENCHES` if any bench still exists for the project (clear them first)
- Pass `?force=true` (or `?force=1`) to drop bench state records without clearing benches first. Use this when the project folder is no longer accessible or its `roubo.yaml` can't be loaded, so the normal "clear benches first" flow is unreachable. No filesystem cleanup is performed; leftover worktree files on disk are left alone.

### Get parsed config

```
GET /api/projects/:projectId/config
```

Returns `{ config: RouboConfig, configValid: true }`, or `400` with `{ error, configValid: false }` if the config file failed to parse.

### Inspect a repo without registering

```
POST /api/projects/check-config
{ "repoPath": "..." }
```

Returns a preview object including whether the repo has a `roubo.yaml`, whether it parses, whether it is already registered, and a small `preview` of name/ports/bench cap. Does not modify state. Useful for "is this directory a registerable Roubo project?" UI flows.

### Validate a config object in-memory

```
POST /api/projects/validate-config
{ "config": { ... }, "currentProjectId": "optional-existing-id" }
```

Returns `{ valid, errors, portConflicts }`. Useful for "preview before save" flows.

---

## Benches

### List benches

```
GET /api/benches                                  # across all projects
GET /api/projects/:projectId/benches              # one project only
```

Either accepts an optional `?issue=N` query that filters to benches assigned to GitHub issue `N`.

Returns `Bench[]`.

### Set up a bench

```
POST /api/projects/:projectId/benches
Content-Type: application/json

{
  "branch": "feat/something",            // optional
  "issueNumber": 123,                    // optional, mutually exclusive with branch-only flow
  "branchConflictResolution": "resume"   // optional, "resume" | "new", used with issueNumber
}
```

Claims the next available bench number, allocates ports, creates the git worktree, initialises submodules (for meta-repos), and runs `benches.setup` if defined. **Does not start the bench.**

`branch` is validated against `/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/`. Omitting `branch` cuts the worktree from the project's default branch.

- `201 Created` with the freshly created `Bench`
- `400` for invalid `branch`
- `404 PROJECT_NOT_FOUND` if `:projectId` is unknown
- `409 NO_BENCHES` if `benches.max` is already reached

```bash
curl -X POST http://localhost:3333/api/projects/my-app/benches \
  -H "Content-Type: application/json" \
  -d '{"branch": "feat/new-thing"}'
```

### Get bench detail

```
GET /api/projects/:projectId/benches/:id
```

Returns the full `Bench`, optionally enriched with GitHub `blockedBy` data if the bench is assigned to an issue and the project has issue-dependency enforcement enabled.

### Clear a bench

```
DELETE /api/projects/:projectId/benches/:id?removeWorkspace=true&force=true
```

- `removeWorkspace=true` (default `false`) deletes the git worktree from disk in addition to freeing the bench number.
- `force=true` overrides the dirty-worktree safety check that otherwise blocks workspace removal when uncommitted work is present.

Returns `202 Accepted` with the `Bench` (teardown is async; poll for `status: "idle"` after deletion).

- `404` if no such bench
- `409 bench-dirty` with `reasons: DirtyReason[]` if the worktree has uncommitted work and `force` was not set

### Start all components

```
POST /api/projects/:projectId/benches/:id/start
```

Starts every component in dependency order. Synchronous: returns once the start sequence is initiated.

Returns the updated `Bench`. Poll the bench (or subscribe to SSE) to observe component status transitions.

### Stop all components

```
POST /api/projects/:projectId/benches/:id/stop
```

Stops every component (reverse dependency order). Awaits clean shutdown. Returns the updated `Bench`.

---

## Components

### Start one component

```
POST /api/projects/:projectId/benches/:id/components/:name/start
```

Useful when one component crashed and you do not want to restart the whole bench.

### Stop one component

```
POST /api/projects/:projectId/benches/:id/components/:name/stop
```

### Stream-like logs (polling)

```
GET /api/projects/:projectId/benches/:id/components/:name/logs?tail=N
```

Returns `{ logs: string[] }`. `tail` defaults to **200**. Each entry is a line of captured stdout/stderr. There is no SSE stream for logs today; poll if you need a live feed.

### Audit log

```
GET /api/projects/:projectId/benches/:id/audit-log?pluginId=PLUGIN_ID
```

Returns `AuditEntry[]`: the privileged HostComponentBroker calls recorded for this bench, in chronological order. The optional `pluginId` query narrows the result to a single plugin. Each entry is `{ ts, pluginId, benchId, method, params, outcome }`, where `outcome` is `"allowed"` or `"denied"`. The store is in-memory only (it is not persisted to `state.json`), so a bench's log is empty after a server restart and is dropped when the bench is cleared.

---

## Tools

### List tools for a bench

```
GET /api/projects/:projectId/benches/:id/tools
```

Returns `ResolvedTool[]`, with `url`/`command` already template-substituted for the bench. Each tool has an `enabled` flag: `false` while the tool's `requires` component is not yet running.

A tool of type `agent` is a launch preset, not a quick-open action. It carries a resolved `preset` instead of a `url` or `command`, and its `enabled` flag is `false` when that preset could not be resolved.

### Execute a tool

```
POST /api/projects/:projectId/benches/:id/tools/:index/execute
Content-Type: application/json

{ "userName": "optional, only required by tools that pick a user" }
```

`:index` is the zero-based index of the tool in the project's `tools` array.

Returns `ToolResult` (`{ success, error?, login? }`). `400` if execution failed (response body is still a `ToolResult`).

Agent tools are refused here with a `400`: they launch through terminal session creation, not through this fire-and-forget path.

### List agent tool presets

```
GET /api/projects/:projectId/agent-presets
```

Returns `{ presets: ResolvedAgentPreset[] }`: the built-in presets Roubo ships, then the app-level presets saved under **Settings > Jigs > Agent tools**, then the project's own `type: agent` entries from `roubo.yaml tools:`.

Each preset is resolved on read, never stored resolved. A preset bound to `default` carries `bindsDefaultAgent: true` and resolves to whichever agent is the current default, so changing the default changes this response with nothing to invalidate. A preset that cannot launch carries `unresolved: { reason, message }`, where `reason` is one of `agent-unavailable` (the bound plugin is not installed, consented, compatible, or running), `no-default-agent`, or `invalid-params` (the preset's `params` are not accepted by the bound agent's `configSchema`). A parameter counts as not accepted whether the schema refuses it outright (a bad value, or an unknown key under `additionalProperties: false`) or simply never declares it, since an agent silently ignores a key its schema omits. The message names the preset and, for a bad parameter, the parameter.

A built-in preset does not report `invalid-params` for a parameter it can drop, because it cannot be edited to fix one: it degrades instead, dropping the rejected keys, so its resolved `params` may omit keys the stored preset sets and is not always a faithful copy of them. A violation that names no parameter at all (a whole-object schema rule) leaves nothing to drop, so such a built-in does still report `invalid-params`.

A parameter the agent's schema never **declares** degrades on a wider rule: any preset carrying `bindsDefaultAgent: true` drops such a key rather than reporting `invalid-params`, whatever its source. That mismatch is produced by changing the default agent, not by the preset's author, so a `roubo.yaml` tool that launches today is not disabled by a default it does not control. A preset pinned to a named agent keeps the hard rejection, and a parameter the schema refuses outright (a bad value, or an unknown key under `additionalProperties: false`) keeps the built-in-only rule above.

A preset that degraded either way carries `degraded: { droppedParams, message }`, so a client can detect the drop from the response rather than by diffing the resolved `params` against the stored preset. `droppedParams` lists the dropped keys; `message` names the preset, the resolved agent, and those keys. The field is advisory and separate from `unresolved`: a degraded preset is still launchable, so it never makes a tool `enabled: false`, and the two fields are mutually exclusive.

### List agent tool presets without a project

```
GET /api/agents/presets
```

The app-scoped sibling of the route above, for app-level Settings, which has no project in scope. Same `{ presets: ResolvedAgentPreset[] }` envelope and the same resolution, minus the project layer: built-ins then app-level presets, never a `source: "project"` entry. It exists so an app-level surface can read `degraded` and `unresolved` from the server's resolution instead of re-deriving either.

---

## Inspection

Inspection runs the project's configured test/QA command (`inspection.command`) inside the bench workspace and captures the output.

### Start an inspection run

```
POST /api/projects/:projectId/benches/:id/inspection
Content-Type: application/json

{ "filter": "optional substring filter" }
```

Returns `201 Created` with `InspectionRun`:

```ts
{
  id: string;
  projectId: string;
  benchId: number;
  status: "running" | "passed" | "failed" | "error" | "aborted";
  filter?: string;
  output: string[];
  exitCode: number | null;
  startedAt: string;
  completedAt?: string;
}
```

### Get current inspection run

```
GET /api/projects/:projectId/benches/:id/inspection?since=N
```

Returns the current or most recent `InspectionRun`. The optional `since=N` parameter is a byte offset into `output` and is useful for incremental polling.

`404` if no inspection has ever been started for this bench.

### Abort a running inspection

```
DELETE /api/projects/:projectId/benches/:id/inspection
```

`204` if a run was aborted, `404` if no run is in progress.

---

## Jigs

Jigs are sets of agent instructions Roubo can write into the bench workspace. The consumer is whichever AI coding agent the launch resolves to; the format is generic Markdown so any tool can read it.

### List jigs available to a project

```
GET /api/projects/:projectId/jigs
```

Each jig in the payload may carry an `agentPluginId`: the `agent`-kind plugin that jig launches with. It is optional, and absent means the jig follows the application-level default agent (`jigs.defaultAgentPluginId` on `PUT /api/settings`). Jig create and update accept the same field, and an update may send `agentPluginId: null` to clear the binding. It is stored in the jig's Markdown frontmatter, so both app-level and repo-level jigs carry it.

At launch, `POST /api/projects/:projectId/benches/:id/terminals` resolves the agent in that order: an explicit `agentPluginId` in the request first, then the driving jig's binding, then the default agent, and finally the single configured agent when exactly one is available. Every layer is availability-gated, so a binding or a default whose plugin is no longer resolvable falls through to the next layer rather than failing the launch. When no layer names an agent that resolves, the launch is refused with a `409` naming the way out (install an agent plugin from Settings, then AI Agents): there is no built-in agent behind the plugin runtime to fall back to, and no silent downgrade to a plain shell.

A request counts as an agent launch when it carries any of `agentPluginId`, `jigId`, or `command`. The legacy `command` field is retained only as that carrier: it no longer selects a binary, so a request sending it resolves an agent through the order above and is refused with the same `409` when none resolves, rather than opening the shell it used to. Only a request carrying none of the three opens a plain login shell.

How the jig then reaches that agent is the agent's own declared capability (`initialPrompt` on its launch descriptor), not something the host assumes. With `jigs.autoExecute` on, the resolved jig is passed as the agent's initial prompt so it submits on start and the response carries `jigInjected: true`; with it off the jig is written into the session 1500ms after launch without submitting, and the response carries `jigScheduled: true`. An agent that declares no injection capability gets neither: it launches normally, nothing is injected, no post-startup write is scheduled, and the response reports neither flag. `sizeWarning` is about the jig rather than the agent, so it is still reported either way.

The 201 also carries `compatibility` when the pre-launch version probe had something to say: the detected CLI version, the declared window, and a `status` of `above-tested-ceiling` or `probe-failed`. An in-range launch is silent, so the field is absent in the normal case. A launch below the declared floor never reaches a 201 at all: it is refused with a `409` whose body carries a `launchFailure` describing the detected version, the required floor, and the recovery actions.

### Inject a jig into a bench's workspace

```
POST /api/projects/:projectId/benches/:benchId/inject-jig
Content-Type: application/json

{ "jigId": "standard", "sessionId": "optional-agent-session" }
```

Resolves template variables (`{{ports.*}}`, `{{workspace}}`, etc.) against the bench, optionally hydrates an `IssueContext` if the bench is assigned to a GitHub issue, and writes the resolved Markdown into the workspace so the AI coding tool picks it up on its next read.

- `400` if `jigId` is missing or invalid
- `404` if project, bench, or jig is not found

---

## Agent permissions

One per-project permissions model, shared by every AI coding agent. It has two axes:

- **Posture**: how much the agent may do on its own. One universal vocabulary (`read-only`, `guarded`, `auto-edit`, `full-auto`) that each agent plugin maps to its own native mechanism.
- **Rules**: fine-grained `allow` / `ask` / `deny` pattern strings. Roubo stores, unions, and injects them, and never parses their vocabulary; only an agent that declares the rules capability carries them anywhere.

Both are per project, not per bench, and are applied to a bench workspace when a session starts. Rule injection is **additive**: a rule removed from the project is never removed from an existing bench, and only stops applying when that bench is cleared.

### Read the stored permissions

```
GET /api/projects/:projectId/permissions
```

```json
{
  "allow": ["Bash(npm run *)", "Read(**)"],
  "ask": ["WebFetch"],
  "deny": ["Bash(rm -rf *)"],
  "posture": "auto-edit"
}
```

`posture` is optional and absent means the agent keeps whatever its own configuration selected. `ask` is optional for state files written before ask support existed.

### Replace the stored permissions

```
PUT /api/projects/:projectId/permissions
Content-Type: application/json

{ "allow": ["Bash(npm run *)"], "ask": [], "deny": [], "posture": "guarded" }
```

Replaces the whole set (there is no PATCH). Omitted arrays default to `[]`; an omitted `posture` clears it.

- `400` when `allow`, `deny`, or `ask` is not an array of strings, exceeds 100 entries, or contains an entry longer than 512 characters
- `400` when `posture` is not one of the four values
- `400` when an `allow` or `ask` rule names a path outside the bench workspace. The check is deliberately vocabulary-free: a rule is rejected when it contains a `..` path segment or an absolute / home-rooted path root, whatever agent syntax surrounds it. It covers the access-granting groups only, since a `deny` rule naming an outside path forbids reach rather than granting it, so `deny` is stored as written. The response body carries the offending pattern:

  ```json
  {
    "error": "Permission rule \"Read(../../etc/**)\" in \"allow\" was rejected because it contains a \"..\" path segment, which can reach outside the bench workspace.",
    "rule": "Read(../../etc/**)"
  }
  ```

- `404` when the project is not registered

### Ask what the project's agent honours

```
GET /api/projects/:projectId/permissions/capabilities
```

```json
{
  "agentPluginId": "claude-code",
  "agentName": "Claude Code",
  "postures": ["read-only", "guarded", "auto-edit", "full-auto"],
  "rules": true,
  "resync": true
}
```

Resolves the project's agent plugin and reads the `capabilities.permissions` its launch descriptor declares, so a client can hide the axes that agent ignores (an agent declaring no `rules` capability gets no rules editor and no re-sync control). Nothing is written. When no agent plugin resolves, or the probe fails, there is no carrier at all: `agentPluginId: null`, no postures, `rules: true` (the model is Roubo's own and stays editable, ready for whichever agent plugin gets installed) and `resync: false` (there is nothing to re-inject through yet).

### Re-sync existing benches

```
POST /api/projects/:projectId/permissions/resync
```

```json
{ "resynced": 2, "skipped": 1, "errors": [{ "benchId": 4, "message": "..." }] }
```

Re-injects the project's rules into every live bench workspace by dispatching through the agent plugin's declared carrier. A bench with no workspace path, one mid-teardown (`clearing`), one whose agent declares no rules capability (or declares rules that opt out of re-sync with `resync: false`), or any bench at all when no agent plugin is installed, is counted in `skipped` rather than raising an error. A per-bench failure lands in `errors` and never fails the request.

- `404` when the project is not registered

---

## Notifications

### Subscribe to real-time bench events (SSE)

```
GET /api/notifications/stream
Accept: text/event-stream
```

Opens a Server-Sent Events stream. Each `data:` line is a JSON object with a `type` discriminator:

```jsonc
// type: "bench-status": emitted on every bench status transition
{ "type": "bench-status", "projectId": "my-app", "benchId": 1, "status": "active" }

// type: "notifications": emitted when a bench's notification list changes
{
  "type": "notifications",
  "projectId": "my-app",
  "benchId": 1,
  "notifications": [
    { "id": "...", "type": "bench-ready", "message": "...", ... }
  ]
}
```

Reconnect on close; the server does not currently send `retry:` or `id:` directives.

### Dismiss notifications

```
DELETE /api/projects/:projectId/benches/:id/notifications
DELETE /api/projects/:projectId/benches/:id/notifications/:notificationId
```

The first clears all bench-level notifications; the second dismisses one. Both return the remaining `BenchNotification[]`.

### Report that a session is waiting (agent hook)

```
POST /api/hooks/claude-notification
Content-Type: application/json

{ "session_id": "550e8400-e29b-41d4-a716-446655440000" }
```

The endpoint an AI coding agent calls to say it is waiting on the user, raising a waiting notification on the bench that owns the session. It is meant to be called by the agent process, not by an integrator: Roubo configures the agent to call it at launch, substituting the real session id and its own bound port. Extra fields (`notification_type`, `message`, `title`) are accepted and ignored.

`session_id` is the correlation key and must be the id Roubo minted for the session. It is honoured only when that session is still live and its agent declared hook wiring in its launch descriptor. Everything else is rejected and logged, raising no notification: an id for a session that never existed, one whose session has since exited or was restored after a server restart (its token is spent), and one for a session with no hook wiring. The endpoint keeps its historical path because shipped plugin manifests already point at it; nothing about the handler is agent-specific.

Returns `{ "status": "ok" }`. Repeat calls for one session are safe: they collapse into a single waiting notification.

| Status | Reason                                                                      |
| ------ | --------------------------------------------------------------------------- |
| `200`  | Notification raised (or already present)                                    |
| `400`  | `session_id` missing or not a string; or the session is not live hook-wired |
| `404`  | No such session, or its bench no longer exists                              |

Waiting notifications clear themselves when the session produces fresh output or receives input, so there is no matching "no longer waiting" call.

### Report a turn complete (agent notifier)

```
POST /api/hooks/agent-notification
Content-Type: application/json

{ "token": "550e8400-e29b-41d4-a716-446655440000" }
```

The other half of the same idea, for an agent that cannot POST anywhere itself. Such an agent spawns a configured program when its turn ends, so Roubo installs one (`~/.roubo/bin/roubo-notify`), tells the agent to spawn it with a correlation token, and this is where that program reports in. Like the endpoint above it is meant for the agent's own machinery, not for an integrator. A `payload` field carrying the event JSON the agent appended is accepted and ignored.

`token` is the correlation key, and it is whatever the agent plugin's launch descriptor declared as its `correlation.template` resolved to at launch: usually the session id, but it need not be. Roubo registers the token against the session at launch and trades it back here, so the same rules apply as above: the token is honoured only while its session is live, and an unregistered or expired token raises nothing. A token is registered to one session at a time, so a plugin that declares a constant rather than a session-derived template gets one owner and not two: the second session to claim a token a live session already holds is refused it at launch and falls back on quiescence, and any call quoting that token, including one from the refused session's own notifier, is attributed to the session that owns it.

Returns `{ "status": "ok" }`, and repeat calls collapse into one notification.

| Status | Reason                                                             |
| ------ | ------------------------------------------------------------------ |
| `200`  | Notification raised (or already present)                           |
| `400`  | `token` missing or not a string; or its session is no longer live  |
| `404`  | No session registered for the token, or its bench no longer exists |

---

## Terminal (WebSocket)

```
WS /ws/terminal/:sessionId
```

Bidirectional terminal session for a bench's workspace. Outside the scope of typical AI-coding-tool integrations; documented separately when the terminal API stabilises.

---

## A worked end-to-end example

Spin up a bench, run inspection, tear it down. Assumes Roubo is running locally on port 3333 and a project repo at `/Users/me/code/my-app` already contains a valid `.roubo/roubo.yaml`.

```bash
BASE=http://localhost:3333

# 1. Register the project (first time only)
curl -s -X POST $BASE/api/projects \
  -H "Content-Type: application/json" \
  -d '{"repoPath": "/Users/me/code/my-app"}'
# -> { "id": "my-app", "repoPath": "...", "config": {...}, "configValid": true, ... }

# 2. Set up bench 1 from a feature branch
BENCH=$(curl -s -X POST $BASE/api/projects/my-app/benches \
  -H "Content-Type: application/json" \
  -d '{"branch": "feat/new-thing"}')
ID=$(echo "$BENCH" | jq -r .id)
echo "Bench $ID created at $(echo "$BENCH" | jq -r .workspacePath)"

# 3. Start all components and wait until status is "active"
curl -s -X POST $BASE/api/projects/my-app/benches/$ID/start > /dev/null
while [ "$(curl -s $BASE/api/projects/my-app/benches/$ID | jq -r .status)" != "active" ]; do
  sleep 1
done

# 4. (Optional) Have your AI coding tool work in the worktree
# The path is $(echo "$BENCH" | jq -r .workspacePath)

# 5. Run inspection and poll for completion
RUN=$(curl -s -X POST $BASE/api/projects/my-app/benches/$ID/inspection \
  -H "Content-Type: application/json" -d '{}')
while [ "$(curl -s $BASE/api/projects/my-app/benches/$ID/inspection | jq -r .status)" = "running" ]; do
  sleep 1
done
curl -s $BASE/api/projects/my-app/benches/$ID/inspection | jq '{status, exitCode}'

# 6. Clear the bench (and remove the worktree)
curl -s -X DELETE "$BASE/api/projects/my-app/benches/$ID?removeWorkspace=true" > /dev/null
```

The same flow expressed as SSE-driven instead of polling: open `GET /api/notifications/stream`, set up the bench, and react to `bench-status` events.

---

## Reading the source

This document covers the integration surface. The full set of routes, including admin-only and UI-helper endpoints, is listed in [docs/routes.md](./routes.md), generated from the router mount table in [`server/index.ts`](../server/index.ts) and the handlers under [`server/routes/`](../server/routes/) and gated against drift in CI. When in doubt about a request body or response shape, the route handler is the authoritative source; the TypeScript request interfaces in [`shared/types.ts`](../shared/types.ts) are the contract.
