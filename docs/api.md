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

### Execute a tool

```
POST /api/projects/:projectId/benches/:id/tools/:index/execute
Content-Type: application/json

{ "userName": "optional, only required by tools that pick a user" }
```

`:index` is the zero-based index of the tool in the project's `tools` array.

Returns `ToolResult` (`{ success, error?, login? }`). `400` if execution failed (response body is still a `ToolResult`).

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

Jigs are sets of agent instructions Roubo can write into the bench workspace. Today the consumer is Claude Code; the format is generic Markdown so other tools can read it too.

### List jigs available to a project

```
GET /api/projects/:projectId/jigs
```

### Inject a jig into a bench's workspace

```
POST /api/projects/:projectId/benches/:benchId/inject-jig
Content-Type: application/json

{ "jigId": "standard", "sessionId": "optional-claude-session" }
```

Resolves template variables (`{{ports.*}}`, `{{workspace}}`, etc.) against the bench, optionally hydrates an `IssueContext` if the bench is assigned to a GitHub issue, and writes the resolved Markdown into the workspace so the AI coding tool picks it up on its next read.

- `400` if `jigId` is missing or invalid
- `404` if project, bench, or jig is not found

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

This document covers the integration surface. The full set of routes, including admin-only and UI-helper endpoints, is enumerated in [CLAUDE.md](../CLAUDE.md#api-endpoints) and implemented under [`server/routes/`](../server/routes/). When in doubt about a request body or response shape, the route handler is the authoritative source; the TypeScript request interfaces in [`shared/types.ts`](../shared/types.ts) are the contract.
