# Architecture: Component Plugins

## Context

**PRD:** ./prd.md

Roubo's two bench component types (`database`, `process`) are hardcoded in core; this feature makes `component` a plugin kind so new types ship without forking Roubo, and dogfoods the abstraction by re-implementing both built-ins as first-party plugins. The choice is non-trivial because a component plugin must **launch and supervise real processes and containers**, not merely answer RPC queries like the existing integration plugins. The design is bound by the PRD's NFRs verbatim: declare-then-enforce permissions (**NFR-001**: declaration + consent in v1, OS-isolation-per-plugin enforcement + audit in v2), start/supervision overhead within +500 ms p95 with push (not polled) status (**NFR-002**), zero orphaned processes/containers with graceful degradation and auto-recovery within the restart budget (**NFR-003**), logs/status parity now plus a v2 privileged-call audit log (**NFR-004**), no config back-compat but integration plugins unaffected and version mismatches that fail gracefully via a host-capability gate (**NFR-005**), a CI-enforced invariant that core carries zero component-type literals and zero docker/compose field knowledge (**NFR-006**), and WCAG 2.1 AA React Aria UI (**NFR-007**). The work is phased: v1 foundation, v2 sandboxing, v3 first-party marketplace, with FR-022 (a future Clasp deploy) as a design stress-test, not a build.

## Decision summary

**Lens:** Blend of #2 (declarative provision descriptor, the primary path) + #1 (imperative host-RPC broker, the escape hatch), both **host-owns-lifecycle**.

A `component` kind is added to the existing plugin host. A component plugin describes its lifecycle in one of two ways. The **preferred declarative path**: the plugin is a pure function `translate(config) -> ProvisionDescriptor` (a typed `docker | process | oneshot` union), and a single generic host **LifecycleEngine** executes any descriptor. The **escape-hatch imperative path**: the plugin implements lifecycle hooks (`start`/`stop`/`health`/`cleanup`) and, inside them, drives a versioned **host-RPC broker** (`host.process.*`, `host.docker.*`, `host.ports.*`). In **both** paths the host owns every process and container handle through the existing `process-manager`, `docker`, and `port-allocator` services; the plugin never spawns anything itself. New: the descriptor model, the engine, the broker, the SDK component contract, the two bundled plugins, the consent UI, the CI guard, and (later) the v2 enforcement/audit/isolation layer and the v3 marketplace. Extended: the manifest schema, `plugin-manager`, `bench-manager` (type-dispatch removed), and the `roubo.yaml` config schema. Reused unchanged: `process-manager`, `docker`, `port-allocator`, the vscode-jsonrpc/stdio transport, and the restart supervision.

Why this won: declarative-first makes v2 sandboxing and the NFR-006 zero-knowledge guard nearly free (a pure translator runs no privileged code) and is the smallest delta from today's `startDockerComponent`, which is already a host-driven phase machine; the broker escape hatch preserves the flexibility a real FR-022 Clasp deploy needs **without** surrendering host ownership, so cleanup (NFR-003), enforcement (NFR-001), and audit (FR-019) attach at one layer regardless of which path a plugin takes. The tradeoff that tipped it: a pure declarative descriptor risks a god-schema that cannot express a novel deploy lifecycle, and a pure broker forces the two built-in types to write imperative orchestration the declarative path expresses as data; the blend takes the clean path for the 80% and the flexible path for the 20%.

### Considered and rejected

- **Pure declarative descriptor (#2)**: god-schema bottleneck, every novel non-docker/non-process lifecycle (FR-022) needs a host-engine + schema change.
- **Pure imperative broker (#1)**: a broader host-RPC surface to design and version, a round-trip per lifecycle phase, and the built-in types end up writing imperative orchestration the declarative path captures as data.
- **Autonomous plugin runtime (#3)**: knowingly violates NFR-001 (no enforcement path: the plugin spawns natively, bypassing any broker), NFR-003/FR-015 (daemonised containers escape the plugin's process tree and are orphaned), and FR-009's broker intent (the host goes blind). Its one win, FR-022 flexibility, is captured by the broker escape hatch without giving up host ownership.

## Components

| Name | Kind | New / existing / extended | Responsibility |
|------|------|---------------------------|----------------|
| ComponentKind | module | extended | Extends the plugin manifest: `kind: "component"`, the new `ports` and `docker` permission categories (via the existing `.passthrough()` seam), and `contractVersion` / `descriptorSchemaVersion`. |
| ComponentContract | library | new | The SDK contract a component plugin implements: the declarative `translate(config) -> ProvisionDescriptor` and/or the imperative `start`/`stop`/`health`/`cleanup` hooks, plus status/log reporting. |
| defineComponentPlugin | library | new | SDK entry that registers a component plugin's contract over the existing JSON-RPC/stdio transport, parallel to today's `definePlugin()`. |
| ProvisionDescriptor | library | new | Typed discriminated union (`docker` / `process` / `oneshot`) fully describing what the host must run; lives in `shared/` so host and SDK both import it. |
| LifecycleEngine | module | new | Generic host-side executor that validates and drives any `ProvisionDescriptor` through its phases via the host services; owns the per-bench descriptor cache and writes `ComponentStatus`. |
| HostComponentBroker | module | new | The versioned host-RPC surface (`host.process.*`, `host.docker.*`, `host.ports.*`, `host.component.report*`, `host.capability.query`) that both the engine and the imperative hooks funnel every privileged op through; the single enforcement/audit choke-point. |
| ComponentPluginRegistry | module | new | Resolves `roubo.yaml` component-to-plugin bindings at bench start and caches the active JSON-RPC connection per plugin id. |
| ResourceOwnershipLedger | data-store | new | Persistent map of `(pluginId, benchId) -> {processIds, composeProjects}` so the host can reap orphans after a plugin or host crash. |
| BundledDatabasePlugin | module | new | First-party declarative plugin: `translate` maps the docker/migration/connection config to a `docker` descriptor. |
| BundledProcessPlugin | module | new | First-party declarative plugin: `translate` maps the command/setup/env/directory config to a `process` descriptor. |
| bench-manager | module | extended | All type-dispatch removed (`launchComponent` / `stopComponent` / `reconcile` / `refreshComponentStatuses` / `assignContainer` / teardown branches); component lifecycle delegated to the registry + engine. |
| plugin-manager | module | extended | Discovers, validates, spawns, and supervises `kind: "component"` exactly as integration plugins; adds a pre-restart cleanup hook and post-restart re-provision (auto-recovery). |
| RouboComponentConfig | module | extended | The `roubo.yaml` components map: each entry binds to a plugin plus an opaque, plugin-validated config block. |
| PermissionConsentUI | client | new | React Aria dialog enumerating every declared permission category in plain language; blocks first run until acknowledged; labels non-first-party plugins as unsandboxed. |
| ComponentTypeKnowledgeGuard | other | new | CI check (grep/AST) that fails the build if a component-type literal or a core docker/compose field branch reappears outside the bundled plugins. |
| process-manager | module | existing | Managed-process map, opaque ids, log ring buffer; now reached only via the broker. |
| docker | module | existing | Compose facade (`composeUp`/`waitForHealthy`/`composeRunInit`/`composeStop`/`composeDown`/status); now reached only via the broker. |
| port-allocator | module | existing | Per-bench port allocation; host resolves ports into `BenchContext` before lifecycle, exposed to plugins read-only via the broker. |
| PermissionEnforcer | module | new (v2) | Intercepts every broker call, denies any outside the plugin's declared categories, and writes the audit entry. |
| AuditLog | data-store | new (v2) | Per-plugin, per-bench record of every privileged broker call (FR-019). |
| PluginIsolationSandbox | module | new (v2) | OS-level isolation per plugin; backend chosen by the sandboxing spike (Apple container framework, macOS Virtualization.framework, Docker, or Linux namespaces), not Docker-locked. |
| Marketplace | service | new (v3) | Registry-backed browse/search/install/update of first-party-curated plugins, integrity-verified, with revocation. |

## Data model

| Entity | Owner | Shape |
|--------|-------|-------|
| ProvisionDescriptor | ProvisionDescriptor (shared) | `{ schemaVersion: number } & ( { kind: "docker", composeFile: string, service: string, initService?: string, portEnvVar?: string, migration?: { command: string, args?: string[] }, connection?: { template: string }, assignedContainerId?: string, healthcheck?: boolean } \| { kind: "process", command: string, env?: Record<string,string>, cwd?: string, setup?: string, dependsOn?: string[] } \| { kind: "oneshot", command: string, env?: Record<string,string>, cwd?: string, dependsOn?: string[], timeoutMs?: number } )` |
| ComponentBinding | RouboComponentConfig | `{ plugin: { id: string, source?: string }, config: Record<string,unknown>, dependsOn?: string[] }` (replaces today's `type: "database" \| "process"` + inline docker/migration/connection fields) |
| BenchContext | HostComponentBroker | `{ projectId: string, benchId: number, componentName: string, workspacePath: string, ports: Record<string,number>, env: Record<string,string> }` |
| ComponentStatus | bench-manager (shared/types) | existing shape **plus a new `completed` terminal state**: `status: stopped \| starting \| running \| error \| stopping \| completed, pid?, containerId?, phases?, setupComplete, error?, statusDetail?, startedAt?` |
| ResourceOwnership | ResourceOwnershipLedger | `(pluginId: string, benchId: number) -> { processIds: string[], composeProjects: string[] }`, persisted in `~/.roubo/state.json` |
| PluginManifest (component) | ComponentKind | existing manifest + `{ kind: "component", permissions: { network?, credentials?, filesystem?, processes?, ports?, docker? }, contractVersion: number, descriptorSchemaVersion?: number }` |
| AuditEntry (v2) | AuditLog | `{ ts: string, pluginId: string, benchId: number, method: string, params: unknown, outcome: "allowed" \| "denied" }` |
| ConsentRecord | plugin-enable-state | `{ pluginId: string, acknowledgedCategories: string[], consentedAt: string }` |

PRD-supplied invariants: zero orphaned resources (NFR-003), held by the ledger plus a startup sweep; zero component-type literals / core docker-field branches (NFR-006), held by the CI guard; component plugins are spawned **once per plugin** (not per bench), so a single process multiplexes benches via `BenchContext.benchId`.

## Interfaces / contracts

Most boundaries are intra-host JSON-RPC (vscode-jsonrpc over stdio) or function calls into existing services, plus a small HTTP surface. Method name + payload shape is the contract.

### bench-manager → ComponentPluginRegistry (function-call)

- `resolveBinding(projectId, componentName) -> { pluginId, connection } | NotBound` (resolves the `roubo.yaml` binding and returns the live per-plugin JSON-RPC connection).

### LifecycleEngine ⇄ component plugin (JSON-RPC over stdio)

- **Declarative (preferred):** `component.translate({ config, context: BenchContext }) -> ProvisionDescriptor`. Pure; called once per bench provision; the result is validated against the host's supported `schemaVersion` and cached.
- **Imperative (escape hatch):** `component.start(BenchContext) -> void`, `component.stop(BenchContext) -> void`, `component.health(BenchContext) -> ComponentStatus`, `component.cleanup(BenchContext) -> void`. Inside these the plugin calls the broker. A plugin declares its mode via `contractVersion` + which methods it registers (a plugin implements `translate` **or** the imperative hooks, not silently both).

### component plugin → HostComponentBroker (JSON-RPC over stdio)

- `host.process.start({ id, command, args?, env, cwd }) -> { pid }` (long-lived)
- `host.process.run({ id, command, args?, env, cwd, timeoutMs }) -> { exitCode }` (blocking run-to-completion; the FR-022 one-shot primitive; `timeoutMs` bounds a hung deploy)
- `host.process.stop({ id }) -> void`
- `host.process.status({ id }) -> { alive: boolean, exitCode?: number }`
- `host.process.logs({ id }) -> string[]`
- `host.docker.composeUp({ projectName, composeFile, cwd, service, env }) -> { containerId }`
- `host.docker.waitForHealthy({ projectName, service, timeoutMs }) -> { healthy: boolean }`
- `host.docker.composeRunInit({ projectName, composeFile, cwd, initService }) -> void`
- `host.docker.composeStop({ projectName, composeFile, cwd, service? }) -> void` / `host.docker.composeDown({ projectName, composeFile, cwd }) -> void`
- `host.docker.assignContainer({ componentName, containerId }) -> void` (gated on the `docker` permission category)
- `host.ports.get({ componentName }) -> number` (allocation is host-side, pre-resolved into `BenchContext.ports`; this is a read)
- `host.component.reportStatus(ComponentStatus) -> void` (push, so reconcile never polls the plugin: NFR-002)
- `host.component.reportLog({ source: "stdout" | "stderr", text, ts }) -> void`
- `host.capability.query({ method }) -> { available: boolean, introducedIn?: string }` (FR-017 graceful version gate)

### HostComponentBroker → existing services (function-call)

- → `process-manager`: `startProcess` / `stopProcess` / `getProcessStatus` / `getProcessLogs` / `storeCommandLogs`.
- → `docker`: `composeUp` / `waitForHealthy` / `composeRunInit` / `composeStop` / `composeDown` / `getContainerStatuses` / `getComposeProjectName`.
- → `port-allocator`: `allocatePorts` / `getPortConflicts`.

### plugin-manager → bench-manager (function-call)

- `onComponentPluginPreRestart(pluginId) -> void`: bench-manager reads the ledger and stops every owned process/container **before** the plugin is restarted (no orphans).
- `onComponentPluginRestarted(pluginId) -> void`: bench-manager re-provisions the affected components (auto-recovery, FR-016).

### Client → server (HTTP)

- `GET /api/plugins/:pluginId/consent -> { declared: PluginPermissions, firstParty: boolean, consentedAt?: string }`
- `POST /api/plugins/:pluginId/consent { acknowledgedCategories: string[] } -> 200` (persists a `ConsentRecord`, unblocks the plugin) / `400` if a declared category is unacknowledged.
- Existing `GET /api/projects/:projectId/benches/:id/components/:name/logs` and the notifications SSE stream are unchanged in shape, now fed by `reportStatus` / `reportLog`.
- (v3) `GET /api/marketplace/plugins` (browse/search), `POST /api/marketplace/plugins/:id/install`, `POST /api/marketplace/plugins/:id/update`, integrity-verified.

## Sequence flows

### Happy path: start a declarative (database) component

1. The consumer starts a bench; `bench-manager` resolves each component's plugin via `ComponentPluginRegistry`.
2. `bench-manager` allocates ports (`port-allocator`) and builds the `BenchContext`.
3. `LifecycleEngine` calls `component.translate({ config, context })` on the database plugin, receiving a `docker` `ProvisionDescriptor`.
4. The engine validates the descriptor against the host's supported `schemaVersion` and records ownership in the `ResourceOwnershipLedger`.
5. The engine runs the docker phase machine through the broker (`composeUp` -> `waitForHealthy` -> optional `composeRunInit` -> optional migration -> resolve the connection template), driving `process-manager` / `docker`.
6. The engine sets `ComponentStatus` phases; status is pushed; the consumer sees the component running via SSE. Overhead stays within +500 ms p95 of the built-in baseline (NFR-002).

### Escape-hatch path: a novel / imperative component (and the FR-022 deploy stress-test)

1-2. As above.
3. The plugin implements the imperative hooks; `LifecycleEngine` calls `component.start(BenchContext)`.
4. Inside `start`, the plugin orchestrates via broker calls (for a Clasp deploy: `host.process.run({ command: "clasp push", timeoutMs })`, possibly preceded by an OAuth/project-selection step). The host owns the spawned process/container; the ledger records it.
5. For a one-shot deploy, `host.process.run` resolves with an exit code and the plugin reports `ComponentStatus.status = "completed"`. The blend resolves the god-schema risk: a simple deploy fits a `oneshot` descriptor; a complex one uses the broker escape hatch.

### Failure: a component plugin crashes mid-lifecycle

1. `plugin-manager` detects the child exit and fires `onComponentPluginPreRestart`.
2. `bench-manager` reads the ledger and stops every owned process/container via the broker (`composeDown` / `stopProcess`), so nothing is orphaned (NFR-003 / FR-015).
3. `plugin-manager` restarts the plugin within the existing 3-restarts / 5-minute budget; `onComponentPluginRestarted` re-provisions the affected components (auto-recovery, FR-016). Sibling components in the bench keep running (graceful degradation).
4. On a host restart, a startup sweep replays the ledger and runs a label-filtered reconcile to reap any escaped compose projects (`roubo-<projectId>-bench-<N>`).

## Operational concerns

- **Deployment:** no hosting change for v1/v2 (local Electron app + local server). Bundled plugins ship in `plugins/`; user plugins live in `~/.roubo/plugins`. v3 adds a registry backend and an integrity-verified client install path.
- **Observability:** `ComponentStatus` + the component logs route + the notifications SSE stream, fed by `reportStatus` / `reportLog`, give parity with built-in components (NFR-004). v2 adds the per-plugin/per-bench audit log (FR-019).
- **Scaling:** up to `benches.max` (6) concurrent benches; each component plugin is spawned once and multiplexes benches via `BenchContext.benchId`. The broker is the serialization point for privileged ops; the engine prefers coarse docker operations to stay within the NFR-002 budget, and reconcile is push/event-based, never polling the plugin.
- **Failure modes:** plugin crash (ledger cleanup + auto-recover); hung one-shot (bounded by `timeoutMs`); descriptor schema mismatch (the host rejects with a clear capability error, FR-017); a plugin invoking a host method an older host lacks (`host.capability.query` gate, NFR-005). The `bench-manager` refactor must preserve the inlined CodeQL prototype-pollution guards at every site that indexes `bench.components` / `bench.ports` / `bench.assignedContainers` by a user-controlled name (the CodeQL check is required CI).

## Security & compliance

- **NFR-001 (declare-then-enforce):** v1 ships declared permissions (`network` / `credentials` / `filesystem` / `processes` / `ports` / `docker`) plus the `PermissionConsentUI` per-category acknowledgement, with non-first-party plugins labeled unsandboxed. v2 adds the `PermissionEnforcer` (denies any broker call outside the declared categories) and the `PluginIsolationSandbox` (OS-level isolation per plugin; backend chosen by the sandboxing spike, not Docker-locked). The threat model is scoped per NFR-001 to containing accidental damage, honest plugins, and casual abuse; resistance to a determined attacker is contingent on the chosen isolation backend.
- **The broker is the single privileged choke-point.** Because both the declarative engine and the imperative hooks funnel every privileged operation through `HostComponentBroker`, enforcement and audit attach at exactly one layer. This is the structural reason host-owns was required and autonomous-runtime was rejected.
- **NFR-006:** the `ComponentTypeKnowledgeGuard` CI check forbids component-type literals and core docker/compose field branches; all container access goes through the broker/engine.
- **v3 marketplace:** first-party-curated only at this time; install/update are integrity-verified (signed catalog / provenance) with revocation (FR-021). No third-party submission pipeline or developer-agreement is in scope now (PRD out-of-scope).
- **Preserved:** required CodeQL, DCO sign-off, and the 80% coverage gate all stay in force.

## Supersedes / PRD deltas

Two additive refinements the downstream stages must treat as first-class (not drift):

| Supersedes (NFR-/FR- ID) | What changes | Why |
|--------------------------|--------------|-----|
| FR-002 | The `ComponentContract` supports **two** modes: the declarative `translate(config) -> ProvisionDescriptor` (primary) and the imperative `start`/`stop`/`health`/`cleanup` hooks (escape hatch). The PRD's `provision/start/stop/health/logs` list maps onto the imperative mode; declarative plugins implement `translate` instead. | The blend makes the declarative path primary; `translate` is in-spec, not an extra capability, and breakdown/test-cases should cover both modes. |
| FR-014 / FR-022 | `ComponentStatus` gains a `completed` terminal state, distinct from `stopped` / `error`, to represent a successful one-shot lifecycle (the FR-022 deploy stress-test). | A one-shot deploy that exits 0 is neither "stopped" (idle) nor "error"; a distinct terminal state keeps the status surface (FR-014) honest. Additive to the enum. |

## Open questions

- [ ] Coarse vs fine broker granularity for docker (a single `host.docker.startService` that runs the whole phase machine vs separate `composeUp` / `waitForHealthy` calls): the engine uses coarse internally for NFR-002; the broker exposes the fine-grained calls for the escape hatch. Confirm in the host-RPC spike.
- [ ] External container assignment: a `assignedContainerId` field on `DockerDescriptor` (declarative) and/or a `host.docker.assignContainer` broker method gated on the `docker` permission (imperative). Leaning both, per path.
- [ ] The v2 isolation backend (Apple container framework vs Virtualization.framework vs Docker vs Linux namespaces): resolved by the sandboxing spike; it also answers whether Docker must be present.
- [ ] One SDK package exposing `defineComponentPlugin()` alongside `definePlugin()`, vs splitting into separate workspaces.
- [ ] `host.capability.query` covers a plugin probing the host; the inverse (the host detecting which contract methods a plugin implements before calling them) is handled by `contractVersion` + registered-method introspection: confirm a plugin missing `stop` is rejected at validation, not at stop-time.

## Out of scope

- v2 sandboxing implementation (`PermissionEnforcer` / `AuditLog` / `PluginIsolationSandbox` are specced but built in v2).
- v3 marketplace implementation.
- A built Clasp / Google Cloud deploy plugin (design-for only; the `oneshot` descriptor + broker escape hatch demonstrate it fits without a redesign).
- Config back-compat (NFR-005): the roubo and responda configs are migrated, not kept compatible.

## Phase mapping

| Phase | Components delivered | Interfaces live |
|-------|----------------------|-----------------|
| v1 | ComponentKind, ComponentContract, defineComponentPlugin, ProvisionDescriptor, LifecycleEngine, HostComponentBroker, ComponentPluginRegistry, ResourceOwnershipLedger, BundledDatabasePlugin, BundledProcessPlugin, bench-manager refactor, plugin-manager extension, RouboComponentConfig, PermissionConsentUI, ComponentTypeKnowledgeGuard | `translate`, the imperative hooks, the broker RPC surface, the consent HTTP routes, status/log push, the plugin-manager↔bench-manager cleanup/recover callbacks |
| v2 | PermissionEnforcer, AuditLog, PluginIsolationSandbox | broker-call interception, audit query, the isolation backend |
| v3 | Marketplace | marketplace HTTP + registry, signed/integrity-verified install/update, revocation |
