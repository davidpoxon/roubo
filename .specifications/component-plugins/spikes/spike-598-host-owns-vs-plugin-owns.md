# Spike 598: Does the host or the plugin own a component's process and container lifecycle?

**Status:** Resolved · **Issue:** #598 · **Class:** decision · **Resolves:** prd.md FR-008/FR-006/FR-009, NFR-001/NFR-003, US-007/US-008; architecture.md:11 (Decision summary, "both host-owns-lifecycle"), architecture.md:21 (autonomous-runtime rejected), architecture.md:145 (the structural reason host-owns was required) · **Implements:** FR-008, FR-006, FR-009, US-007, US-008 · **Verified by:** none (research spike) · **Gates:** the HostComponentBroker, LifecycleEngine, and bench-manager-refactor slices (v1 phase, architecture.md:178) · **Recommendation:** adopt host-owns

## Objective and method

The keystone decision for component plugins is who owns a component's running process and container handles: the **host** (the plugin describes its lifecycle and dispatches privileged operations over JSON-RPC, and the host's existing `process-manager` / `docker` / `port-allocator` services hold every handle) or the **plugin** (the plugin spawns its own children and the host supervises only the plugin process). Feasibility returned DE-RISK with all four lenses converging on this keystone (prd.md:129), and every downstream v1 slice (the `HostComponentBroker`, the `LifecycleEngine`, and the `bench-manager` refactor) inherits whichever model wins. The cost of getting it wrong is structural and expensive to unwind, so it is resolved before any production code is written.

The decision is **pre-committed** by the architecture, and this spike confirms rather than discovers it:

- architecture.md:11 (Decision summary): the chosen lens is a blend of the declarative descriptor and the imperative broker, "both **host-owns-lifecycle**." In both paths "the host owns every process and container handle through the existing `process-manager`, `docker`, and `port-allocator` services; the plugin never spawns anything itself."
- architecture.md:21 (Considered and rejected, "Autonomous plugin runtime"): the plugin-owns model is rejected because it "knowingly violates NFR-001 (no enforcement path: the plugin spawns natively, bypassing any broker), NFR-003/FR-015 (daemonised containers escape the plugin's process tree and are orphaned), and FR-009's broker intent (the host goes blind)."
- architecture.md:145 (Security & compliance): because both host paths funnel every privileged operation through the single `HostComponentBroker`, "enforcement and audit attach at exactly one layer. This is the structural reason host-owns was required and autonomous-runtime was rejected."

So the spike's job, exactly like the sibling spike `.specifications/testbench/spikes/spike-407-staleness-hash-reconcile.md`, is not to re-open the choice but to make it **precise** and **prove it against the hardest flow**: the docker database component's full lifecycle (`composeUp` -> `waitForHealthy` -> `composeRunInit` / init service -> migration -> connection-string templating) plus `reconcile`. The method is a paper / worked prototype: both models are traced by hand against the **existing host phase machine** `startDockerComponent` (server/services/bench-manager.ts:1564) and the host services it drives, not against new runnable prototype code. This mirrors spike-407's paper-spec method, and it honours the issue's Technical Notes and AC4, which are explicit that the deliverable "produces a findings doc, not shipped code." Both models are nonetheless prototyped against a **real** lifecycle: the phase machine, the services it calls, and the failure flows are the ones already in the codebase, so the comparison is grounded in real behaviour rather than a hypothetical sketch.

The two models, stated precisely (from the issue's Technical Notes and architecture.md:11/architecture.md:21):

- **Host-owns.** A component plugin either (preferred) translates its config to a typed `ProvisionDescriptor` that a generic host `LifecycleEngine` executes, or (escape hatch) implements imperative `start`/`stop`/`health`/`cleanup` hooks that call the host over JSON-RPC: `host.process.*` / `host.docker.*` / `host.ports.*`. In both cases the host invokes `process-manager` / `docker` / `port-allocator` and holds every PID and compose-project handle. The plugin never spawns a process or a container itself.
- **Plugin-owns (the rejected "autonomous plugin runtime", architecture.md:21).** The plugin spawns its own children directly (its own `docker compose up`, its own `spawn`) inside its own process. The host's only handle is the plugin process; it supervises that and nothing the plugin started.

The reference shapes (`ProvisionDescriptor`, `BenchContext`, the broker RPC surface, `ResourceOwnershipLedger`, the failure sequence flow) are taken verbatim from architecture.md (the Components table architecture.md:23-48, the Data model architecture.md:50-61, the Interfaces architecture.md:65-111, and the Sequence flows architecture.md:113-133). The code anchors (`startDockerComponent` at bench-manager.ts:1564, `reconcile` at bench-manager.ts:188, and the host services) are read from the current tree so the walkthrough matches real behaviour.

## AC1: Both models prototyped against the real docker database lifecycle and reconcile

### The real host phase machine that both models must reproduce

`startDockerComponent` (bench-manager.ts:1564) is already a **host-driven phase machine**. It is the hardest flow because it touches every privileged surface: container start, health gating, a throwaway init container, a host-side migration subprocess, and connection-string templating. Traced against the current code, its phases are:

| Phase                                | What the host does today                                                                                                                                                            | Host service call               | Anchor                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------- |
| 0. clear logs                        | `processManager.clearProcessLogs(processId(...))`                                                                                                                                   | process-manager                 | bench-manager.ts:1575                        |
| 0b. assigned-container short-circuit | if `bench.assignedContainers[name]` is set, verify that external container is `running` and return (no compose)                                                                     | docker `getContainerStatusById` | bench-manager.ts:1579                        |
| 0c. resolve project name + ports     | `getComposeProjectName(projectId, benchId)`; fold `ctx.ports[name]` into the `portEnvVar` (default `HOST_PORT`)                                                                     | docker / port-allocator         | bench-manager.ts:1588, bench-manager.ts:1593 |
| 1. start container                   | `dockerService.composeUp({ composeFile, service, projectName, portOverrides, cwd })` -> `docker compose -f … -p <projectName> up -d <service>` (detached)                           | docker `composeUp`              | bench-manager.ts:1599, docker.ts:15          |
| 1b. capture logs                     | `processManager.storeCommandLogs(processId(...), stdout, stderr)`                                                                                                                   | process-manager                 | bench-manager.ts:1607                        |
| 2. wait healthy                      | `dockerService.waitForHealthy(projectName, service)`; throw if it never becomes healthy                                                                                             | docker `waitForHealthy`         | bench-manager.ts:1617, docker.ts:171         |
| 3. init service (optional)           | `dockerService.composeRunInit({ composeFile, initService, projectName, portOverrides, cwd, timeoutMs: 120_000 })` -> `docker compose … run --rm <initService>`                      | docker `composeRunInit`         | bench-manager.ts:1625, docker.ts:68          |
| 4. migration (optional)              | parse `migration.command`, resolve `migration.args` templates against `ctx`, `runCommand(migCmd, args, workspacePath, env, 300_000)` (host subprocess)                              | exec `runCommand`               | bench-manager.ts:1646                        |
| 5. connection templating             | the connection string is produced by resolving the config template against `ctx` (the `ResolvedTemplateContext`, including `ctx.ports[name]`) and consumed by downstream components | template resolution             | bench-manager.ts:1590, bench-manager.ts:1652 |

Every handle here is the host's: the compose project name is the host's deterministic `roubo-<projectId>-bench-<N>` (docker.ts:236), the init and migration subprocesses run under the host's `runCommand`, and the connection template resolves against the host-owned `ctx`. There is no plugin process anywhere in this machine today; the feature's job is to introduce one **without** moving any of these handles off the host.

### Model A (host-owns): the plugin describes, the host's phase machine still owns every handle

In host-owns, the database plugin contributes exactly one thing: a translation of its opaque config block into a typed `docker` `ProvisionDescriptor` (architecture.md:54):

```
{ schemaVersion, kind: "docker", composeFile, service, initService?, portEnvVar?,
  migration?: { command, args? }, connection?: { template }, assignedContainerId?, healthcheck? }
```

`component.translate({ config, context: BenchContext }) -> ProvisionDescriptor` is **pure** (architecture.md:75): it runs no privileged code, opens no socket, spawns nothing. The host's generic `LifecycleEngine` then drives the descriptor through the **same phases** as `startDockerComponent`, but each privileged step is a broker call that lands on the existing service (architecture.md:95-99):

| Descriptor phase      | Engine -> broker                                                                   | Broker -> existing service                                        | Maps to today's                             |
| --------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| ports                 | pre-resolved by host into `BenchContext.ports`; `host.ports.get` is a read         | `port-allocator.allocatePorts` (host-side, before lifecycle)      | bench-manager.ts:1593, port-allocator.ts:3  |
| start container       | `host.docker.composeUp({ projectName, composeFile, cwd, service, env })`           | `docker.composeUp`                                                | composeUp, docker.ts:15                     |
| wait healthy          | `host.docker.waitForHealthy({ projectName, service, timeoutMs })`                  | `docker.waitForHealthy`                                           | waitForHealthy, docker.ts:171               |
| init service          | `host.docker.composeRunInit({ projectName, composeFile, cwd, initService })`       | `docker.composeRunInit`                                           | composeRunInit, docker.ts:68                |
| migration             | `host.process.run({ id, command, args, env, cwd, timeoutMs })` (run-to-completion) | `process-manager` run-to-completion (the `runCommand` equivalent) | migration runCommand, bench-manager.ts:1646 |
| connection templating | resolved host-side from `descriptor.connection.template` against `BenchContext`    | host template resolution                                          | bench-manager.ts:1652                       |

The engine records ownership in the `ResourceOwnershipLedger` `(pluginId, benchId) -> { processIds, composeProjects }` (architecture.md:34, architecture.md:58, architecture.md:120) **before** running the phases, then pushes `ComponentStatus` via `host.component.reportStatus` (architecture.md:91). This is the happy-path flow at architecture.md:115-122. The structural point: the diff from today is small. `startDockerComponent` is already a host phase machine; host-owns keeps that machine on the host and replaces only the _source of the parameters_ (a plugin `translate` instead of inline config), so the existing `process-manager` / `docker` / `port-allocator` are reused unchanged (architecture.md:13, architecture.md:42-44).

The escape hatch is identical in ownership: an imperative plugin implements `component.start(BenchContext)` and, inside it, calls the same broker methods (architecture.md:76, architecture.md:124-126). It can express a novel lifecycle (the FR-022 Clasp deploy via `host.process.run({ command: "clasp push", timeoutMs })`), but the spawned process is still the host's, recorded in the ledger. Whether a plugin takes the declarative or the imperative path, the handle ownership is the same: **host**.

`reconcile` (bench-manager.ts:188) under host-owns is essentially unchanged in spirit. Today it batches `dockerService.getContainerStatuses(queries)` keyed by `(projectName, service)` (bench-manager.ts:226, bench-manager.ts:247) and `processManager.getProcessStatus(pid)` (bench-manager.ts:265), and writes each component's status. Because the host still owns the project name and the PIDs, the same batched host-side status query keeps working: the engine reconciles from the ledger's `composeProjects` / `processIds` and the host's container/PID truth, and pushes status (NFR-002, never polling the plugin, architecture.md:91, architecture.md:139). No reconcile information has to be requested from the plugin, because the host already holds it.

### Model B (plugin-owns): the plugin spawns its own children, the host can only see the plugin

In plugin-owns, the database plugin does not translate to a descriptor and does not call a broker. It runs the lifecycle itself, inside its own process:

1. The plugin computes its own project name and ports and runs its **own** `docker compose -f … up -d <service>` as a child of the plugin process.
2. The plugin runs its **own** `waitForHealthy` polling loop.
3. The plugin runs its **own** `docker compose run --rm <initService>` and its **own** migration subprocess.
4. The plugin builds the connection string internally and reports it back to the host as opaque data.

The host's only handle is the plugin process (the one `plugin-manager` spawns and supervises). The crucial asymmetry surfaces immediately at step 1: `docker compose up -d` is **detached** (docker.ts:21, `up -d`). A detached container is a child of the Docker daemon, not of the plugin process. So even though the plugin "started" it, the container is **not** in the plugin's process tree, and killing the plugin process does not stop the container. The host, which only supervises the plugin process, has no record of the container's project name (the plugin chose it internally) and therefore cannot reconcile, stop, or reap it. The migration subprocess (step 3) _is_ a child of the plugin and would die with it, but a migration killed mid-run can leave the database in a partially migrated state with no host-side record that it ran.

For `reconcile`, plugin-owns is strictly worse: the host cannot run the current batched `getContainerStatuses` keyed by `(projectName, service)` because the host does not know the project name or service the plugin chose. Reconcile would have to **ask the plugin** for status over RPC, which (a) reintroduces polling the plugin (violating the push-status intent behind NFR-002, architecture.md:91), and (b) returns nothing useful if the plugin has crashed, which is exactly when reconcile matters most.

### AC1 finding

Both models reproduce the same five-phase docker lifecycle, but they differ in **where the handles live**, and that single difference is decisive. Host-owns is the smaller delta from the existing `startDockerComponent` phase machine (the machine stays on the host; only its parameter source moves to a plugin `translate`), it keeps `reconcile` working off host-owned truth, and it reuses `process-manager` / `docker` / `port-allocator` unchanged. Plugin-owns moves the spawn into the plugin but, because `docker compose up -d` is detached, the most important handle (the container) escapes the plugin's process tree anyway, so the host neither owns the container nor can reconcile it. The hardest flow confirms host-owns.

## AC2: Orphaned-resource cleanup implications (zero orphans on plugin OR host crash)

NFR-003 requires zero orphaned processes or containers after a plugin crash, a host crash/restart, or a bench teardown (prd.md:102), and FR-015 makes the host responsible for that cleanup (prd.md:78). The two models differ in whether that guarantee is even reachable.

### Host-owns guarantees zero orphans, by construction

Two host-side mechanisms compose to give the guarantee (architecture.md:34, architecture.md:128-133):

1. **The `ResourceOwnershipLedger`.** A persistent map `(pluginId, benchId) -> { processIds, composeProjects }` stored in `~/.roubo/state.json` (architecture.md:58). The engine records every started PID and compose project in the ledger **before** it starts them, so the host's record of what to reap never depends on the plugin being alive.

2. **The failure sequence flow** (architecture.md:128-133):
   - On a **plugin crash**, `plugin-manager` detects the child exit and fires `onComponentPluginPreRestart(pluginId)` (architecture.md:103, architecture.md:130). `bench-manager` reads the ledger and stops every owned process and container via the broker (`composeDown` / `stopProcess`) **before** the plugin is restarted, so nothing is orphaned (architecture.md:131). This works because the host owns the handles: `composeDown` runs `docker compose -p <projectName> down -v` (docker.ts:53) against the host-known project name, and `stopProcess` `treeKill`s the host-known PID (process-manager.ts:78, process-manager.ts:108). The plugin being dead is irrelevant; the host never needed it to clean up.
   - On a **host crash/restart**, a startup sweep replays the ledger and runs a **label-filtered** reconcile to reap any escaped compose projects matching `roubo-<projectId>-bench-<N>` (architecture.md:133, prd.md:78). The compose project label is deterministic and host-owned (docker.ts:236), so the sweep finds every container the host ever started even if the ledger entry was lost, because the label encodes the bench identity. This is the mechanism behind NFR-003's "zero orphaned containers after a host crash/restart."

Because the cleanup authority (the ledger plus the label-filtered sweep) is entirely host-side and never calls into the plugin, a dead plugin cannot block or corrupt cleanup. Zero orphans holds on plugin crash, host crash, and bench teardown.

### Plugin-owns leaks daemonised containers on crash

Under plugin-owns the guarantee is **not reachable**:

- The plugin started its container with `docker compose up -d` (detached), so the container is a child of the Docker daemon, not of the plugin process. When the plugin crashes, the host kills the plugin process (the only thing it supervises), but the **container keeps running** as an orphan (architecture.md:21, "daemonised containers escape the plugin's process tree and are orphaned"). This is the precise failure NFR-003 and FR-015 exist to prevent.
- The host has no ledger of the plugin's container, because the plugin chose its own project name internally and never told the host. So there is no host-side record to drive a sweep, and the startup label-filter cannot match a project name the host never knew. Even a best-effort `roubo-*` sweep is unreliable if a plugin is free to name its compose project anything.
- A migration subprocess that _is_ a child of the plugin dies with it, but a mid-flight migration killed without host coordination can leave the database half-migrated with no host record that it ran, which the host-owns `host.process.run` (run-to-completion with a host-held handle and exit code, architecture.md:81) avoids.

### AC2 finding

Only **host-owns** can guarantee zero orphans on plugin or host crash, and it does so by construction: the `ResourceOwnershipLedger` plus the label-filtered startup sweep are host-side and never depend on a live plugin. Plugin-owns structurally leaks the most important resource (the daemonised container), because a detached container escapes the plugin's process tree and the host has no record of it. This is the NFR-003 / FR-015 reason the architecture rejected the autonomous-runtime model (architecture.md:21).

## AC3: v2-enforcement implications (is host-layer permission enforcement meaningful?)

NFR-001 is a declare-then-enforce trust model: v1 ships per-category permission declaration plus a consent UI, and v2 enforces that a plugin cannot perform an undeclared `network` / `credentials` / `filesystem` / `processes` / `ports` / `docker` action, with every privileged call audit-logged (prd.md:100, FR-019 at prd.md:85). The question is whether that v2 enforcement layer is even **meaningful** under each model.

### Host-owns funnels every privileged op through one choke-point

Under host-owns, every privileged operation (every process spawn, every compose call, every port read) is a broker call: the declarative engine and the imperative hooks **both** go through `HostComponentBroker` (architecture.md:32, architecture.md:78-93). That single funnel is the structural enabler of v2:

- The v2 `PermissionEnforcer` "intercepts every broker call, denies any outside the plugin's declared categories, and writes the audit entry" (architecture.md:45). Because there is exactly one layer through which privileged ops pass, the enforcer attaches at exactly one place and cannot be bypassed by a plugin that wants to do real work: doing real work _is_ calling the broker.
- The v2 `AuditLog` records every privileged call per plugin and per bench (architecture.md:46, architecture.md:60, FR-019) at the same choke-point, so the audit is complete by construction.
- architecture.md:145 states this directly: "Because both the declarative engine and the imperative hooks funnel every privileged operation through `HostComponentBroker`, enforcement and audit attach at exactly one layer. This is the structural reason host-owns was required."

So under host-owns, host-layer enforcement is not only meaningful, it is **complete**: there is no privileged path that avoids the broker, so there is no enforcement gap.

### Plugin-owns bypasses any broker, so host-layer enforcement is not meaningful

Under plugin-owns the plugin spawns natively: it calls `spawn` / `docker compose` directly inside its own process, never crossing a host-RPC boundary for the privileged op. There is no broker call to intercept, so:

- The v2 `PermissionEnforcer` has nothing to gate. A plugin that wants to open a socket, write a file, or start a container simply does so; the only thing the host can intercept is the RPC the plugin chooses to make, and a plugin doing its work natively makes none for the privileged action. architecture.md:21 names this as the NFR-001 violation: "no enforcement path: the plugin spawns natively, bypassing any broker."
- The audit log would record only the RPCs the plugin volunteers, not the privileged operations it performs directly, so FR-019's "every privileged call is recorded" is unachievable.
- The only enforcement left would be OS-level sandboxing of the whole plugin process (the v2 `PluginIsolationSandbox`), but that is a blunt, all-or-nothing boundary, not the per-category declare-then-enforce model NFR-001 specifies, and it is contingent on the sandboxing backend (out of scope here per the issue and SPK-2).

### AC3 finding

Host-layer permission enforcement is **meaningful only under host-owns**, where the single `HostComponentBroker` choke-point lets the v2 `PermissionEnforcer` and `AuditLog` attach at one layer with no bypass (architecture.md:45, architecture.md:145). Under plugin-owns the plugin spawns natively and never crosses the broker, so there is nothing for the host layer to enforce or audit; NFR-001's per-category declare-then-enforce model and FR-019's complete audit are both unreachable. This is the NFR-001 reason the autonomous-runtime model was rejected (architecture.md:21).

## AC4 and AC5: Recommendation, and downstream slices proceed without re-litigating

**Adopt host-owns** (the model already pre-committed at architecture.md:11), in the blended form the architecture specifies: the declarative `translate(config) -> ProvisionDescriptor` as the primary path and the imperative `start`/`stop`/`health`/`cleanup` hooks driving the broker as the escape hatch, with the host owning every process and container handle through the existing `process-manager` / `docker` / `port-allocator` services. The rationale, drawn from the three acceptance criteria above and confirmed against the real `startDockerComponent` phase machine:

- **Smallest correct delta (AC1).** `startDockerComponent` (bench-manager.ts:1564) is already a host-driven phase machine. Host-owns keeps that machine on the host and changes only where its parameters come from (a plugin `translate` instead of inline config), reusing `process-manager` / `docker` / `port-allocator` unchanged. Plugin-owns would move the spawn into the plugin but, because `docker compose up -d` is detached, the container escapes the plugin's process tree anyway, so plugin-owns pays the cost of a second supervisor and still does not own the resource that matters.
- **Zero orphans is reachable only here (AC2).** The host-side `ResourceOwnershipLedger` plus the label-filtered startup sweep guarantee zero orphans on plugin or host crash without ever depending on a live plugin; plugin-owns structurally leaks daemonised containers (NFR-003, FR-015).
- **v2 enforcement is meaningful only here (AC3).** The single `HostComponentBroker` choke-point lets the v2 `PermissionEnforcer` and `AuditLog` attach at one un-bypassable layer; plugin-owns spawns natively and defeats host-layer enforcement and audit (NFR-001, FR-019).

The comparison is one-sided because the architecture already committed to host-owns and the PRD's FR-008 / FR-009 and the maintainability NFR were written for it (prd.md:71, prd.md:72, prd.md:129); this spike confirms that commitment is sound by proving it against the hardest flow, not by re-opening it.

**Downstream slices inherit this decision and proceed without re-litigating it.** The three v1 slices gated by this ADR are settled by it:

- **`HostComponentBroker`** is built as the single versioned host-RPC surface (`host.process.*` / `host.docker.*` / `host.ports.*` / `host.component.report*` / `host.capability.query`, architecture.md:78-93) through which every privileged op passes. It does not need to re-decide whether a broker should exist; host-owns requires it, and it is the enforcement/audit choke-point.
- **`LifecycleEngine`** is the generic host-side executor that drives any `ProvisionDescriptor` through its phases via the broker (architecture.md:31), reproducing the `startDockerComponent` phase machine generically. It does not need to re-decide who owns the handles; the host does.
- **The `bench-manager` refactor** removes the type-dispatch branches (`launchComponent` / `stopComponent` / `reconcile` / `assignContainer`, FR-006 at prd.md:69, architecture.md:37) and delegates component lifecycle to the registry plus engine, while preserving the inlined CodeQL prototype-pollution guards at every site that indexes `bench.components` / `bench.ports` / `bench.assignedContainers` by a user-controlled name (architecture.md:140). It does not need to re-decide whether the host keeps the `process-manager` / `docker` / `port-allocator` handles; it does.

Each of these can cite this ADR rather than re-debate host-vs-plugin ownership, which satisfies AC5.

## Open questions and follow-ups

These are scoped to the downstream slices, not blockers for this decision (each is already tracked in architecture.md's Open questions, architecture.md:159-165, so no new issue is filed):

- **Broker granularity for docker (architecture.md:161).** Coarse (`host.docker.startService` runs the whole phase machine) vs fine-grained (`composeUp` / `waitForHealthy` / `composeRunInit` as separate calls). The engine prefers coarse internally for the NFR-002 +500 ms budget; the broker exposes the fine-grained calls for the escape hatch. This is the granularity / capability-versioning spike's call (SPK-3, gates the broker T1.4), not this one.
- **External container assignment (architecture.md:162, prd.md:145).** Whether `assignContainer` (today guarded by `type === "database"`, today's behaviour at bench-manager.ts:1579) becomes a manifest capability flag or is inferred from the declared `docker` permission category. Leaning both, per path (an `assignedContainerId` field on the descriptor and a `host.docker.assignContainer` broker method gated on the `docker` permission). Resolve at the broker slice.
- **v2 isolation backend (architecture.md:163, prd.md:149).** Whether the OS-isolation backend for the `PluginIsolationSandbox` needs Docker present. Explicitly out of scope here (the issue's Out of Scope names SPK-2 as the owner); this ADR only establishes that host-owns makes the per-category enforcement layer attachable at all.
- **Host-side contract-method introspection (architecture.md:165).** Confirming a plugin missing a required hook (e.g. `stop`) is rejected at validation time, not at stop-time. A contract-shape detail for the SDK / plugin-manager slice.

## Lineage

- **prd.md:** FR-008 (the versioned host-RPC surface for process / docker / port operations, "the host owns the actual process/container lifecycle", prd.md:71), FR-006 (remove all component-type dispatch from `bench-manager`, prd.md:69), FR-009 (core retains no docker/compose field knowledge; every container op is brokered, prd.md:72), FR-015 (host cleans up every owned process and container on crash or teardown, prd.md:78), NFR-001 (declare-then-enforce; v2 per-category enforcement plus audit, prd.md:100), NFR-003 (zero orphaned processes or containers after a plugin crash, a host crash/restart, or a teardown, prd.md:102), US-007 (core carries zero hardcoded component-type knowledge, prd.md:53), US-008 (a crashed component plugin is cleaned up and recovered, prd.md:54). The keystone open question prd.md:129 ("host-owns vs plugin-owns the component lifecycle is pre-implementation work; the PRD assumes host-owns") is the question this spike resolves: host-owns, confirmed.
- **architecture.md:** the Decision summary (architecture.md:11, "both **host-owns-lifecycle**"; architecture.md:13, the host owns every handle through the existing services), the Considered-and-rejected autonomous-runtime entry (architecture.md:21, the NFR-001 / NFR-003 / FR-015 / FR-009 reasons plugin-owns was rejected), the Components table (`LifecycleEngine` architecture.md:31, `HostComponentBroker` architecture.md:32, `ResourceOwnershipLedger` architecture.md:34, `PermissionEnforcer` / `AuditLog` architecture.md:45-46), the Data model (`ProvisionDescriptor` architecture.md:54, `ResourceOwnership` architecture.md:58), the Interfaces (the broker RPC surface architecture.md:78-93, the broker-to-services mapping architecture.md:95-99, the plugin-manager cleanup/recover callbacks architecture.md:103-104), the Sequence flows (happy path architecture.md:115-122, escape hatch architecture.md:124-126, the failure / cleanup flow architecture.md:128-133), and the Security & compliance note that the broker is the single choke-point and "the structural reason host-owns was required" (architecture.md:145).
- **Code anchors (read-only, current tree):** the host phase machine `startDockerComponent` (server/services/bench-manager.ts:1564) and `reconcile` (server/services/bench-manager.ts:188); the host services it drives: `composeUp` / `composeStop` / `composeDown` / `composeRunInit` / `waitForHealthy` / `getComposeProjectName` (server/services/docker.ts:15, :37, :53, :68, :171, :236), `startProcess` / `stopProcess` / `getProcessStatus` (server/services/process-manager.ts:17, :78, :114), and `allocatePorts` / `getPortConflicts` (server/services/port-allocator.ts:3, :23).
- **Sibling spike (format precedent):** `.specifications/testbench/spikes/spike-407-staleness-hash-reconcile.md`, whose paper-spec method (confirm a pre-committed architecture decision and prove it against the hardest flow, no runnable code) this spike mirrors.
