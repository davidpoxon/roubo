# Feasibility: Component Plugins

> **Recommendation: DE-RISK**: the feature is buildable on the existing plugin host with no infeasible dimension, but four independent lenses converge on one unresolved keystone (host-owns vs plugin-owns the component lifecycle) and on a genuinely hard v2 sandboxing question (no off-the-shelf OS sandbox for a headless Node process on macOS). Resolve both with spikes before committing the contract.

**Brief:** ./brief.md

## Per-dimension summary

| Dimension | Verdict | Confidence | Top risk | Mitigation |
|-----------|---------|------------|----------|------------|
| Technical | feasible-with-conditions | high | Host-owns vs plugin-owns lifecycle is unresolved and gates the entire contract + `bench-manager` refactor + SDK design | Spike host-owns first: it reuses `process-manager`/`docker` with zero structural change; adopt plugin-owns only if dogfood surfaces a capability gap |
| Effort / delivery | feasible-with-conditions | medium | That same lifecycle decision blocks all v1 work; lifecycle-parity edge cases; v2 sandboxing likely 2-3x | ADR before any implementation (3-5 day spike both models against docker-init/migration/reconcile); write the parity test matrix before extraction |
| Operational / robustness | feasible-with-conditions | medium | Two-level process tree: a plugin crash can orphan containers/grandchildren the host has no handle to (`treeKill` + `composeDown` miss them) | Host-owns model keeps all handles in host Maps; add a pre-restart cleanup hook; add a startup reconcile/cleanup pass over known compose project names |
| Security / supply-chain | feasible-with-conditions | medium | "Safe by default" is an over-promise: v1 enforcement is advisory, and macOS has no supported OS sandbox for a headless Node process, so v2 can only approximate it | Explicit consent UI labeling v1 plugins unsandboxed; prototype an enforcement mechanism before speccing v2; design the v3 trust pipeline now so v1 install format is forward-compatible |

**Recommendation-rule outcome:** no dimension is `infeasible`, so not a NO-GO. All four are `feasible-with-conditions` and several high-severity risks are not yet mitigated by a proven mechanism (the lifecycle decision is genuinely open; macOS sandbox availability is unknown). Rule result: **DE-RISK**.

## Dimension detail

### Technical (high confidence, feasible-with-conditions)

The stack already contains every primitive the feature needs; this is a large refactor, not speculative new technology.

- **The `kind` seam is real and pre-planned.** The manifest discriminator is `kind: z.literal("integration")` (`shared/plugin-manifest-schema.ts:94`); extending to a `component` kind is a small schema change plus a `HOST_API_VERSION` bump. `PluginPermissionsSchema` is already `.passthrough()` (`shared/plugin-manifest-schema.ts:51`) specifically so new categories (`ports`, `docker`) can be added in a minor without breaking older hosts.
- **The plugin host is transport-agnostic.** `spawnPlugin` (`server/services/plugin-manager.ts:569`) spawns any entry JS over `child_process.spawn` with stdio pipes, wires `vscode-jsonrpc`, registers host handlers, and runs a 3/5-min restart budget. Nothing in it is integration-specific; a `ComponentContract`'s methods would register in `registerHostHandlers` (`plugin-host-api.ts`) alongside the integration methods.
- **All "core type knowledge" is four branch sites in one file.** `bench-manager.ts` `launchComponent` (~1347), `stopComponent` (~1453), `reconcile` (~224), `assignContainer` (~1839, the lone `type === "database"` data-path guard). `process-manager.ts` and `docker.ts` are already type-agnostic facades keyed by opaque ids.
- **Host-owns is clearly more feasible for v1.** A plugin calling `host.process.start(...)` / `host.docker.composeUp(...)` over RPC reuses the existing supervision, log ring-buffer, and reconcile path with no structural change to `bench-manager`. Plugin-owns is also transport-compatible but duplicates lifecycle tracking, breaks log integration, and defeats host reconcile.
- **Hardest parity item:** the docker phase state machine in `startDockerComponent` (`bench-manager.ts:1564-1664`) (composeUp → waitForHealthy → optional initService → optional migration, writing `componentStatus.phases`) has no current RPC analogue. It must be expressed either as a declarative provision descriptor the host drives, or as a new coarse host-RPC surface (`host.docker.startService` blocking until healthy).

### Effort / delivery (medium confidence, feasible-with-conditions)

- **`bench-manager.ts` is ~1969 lines** and the type-dispatch surface is concentrated but interwoven with inlined CodeQL prototype-pollution guards (~lines 1804-1817) that cannot be trivially extracted to helpers, so the refactor must keep CodeQL (a required check) green as a first-class constraint.
- **Rough sizes:** v1 (contract + dogfood both types + config redesign + local install + permission declaration) = **L**; v2 (enforced sandboxing) = **M-L and high-uncertainty**; v3 (marketplace) = **L, a product of its own**. Overall: large multi-release program, but the existing plugin host/SDK/transport/supervision means v1 is an extension, not a from-scratch build.
- **Critical path:** the host-owns/plugin-owns ADR blocks contract design, the `bench-manager` refactor, and SDK authoring simultaneously. It is the single highest-impact sequencing gate.
- **What makes it 3x longer:** missed lifecycle-parity edge cases discovered late; a v2 sandboxing rabbit-hole on macOS; the marketplace expanding into its own product; and the 80% coverage gate, where test authoring may be 40-60% of implementation time on this surface.
- **Cheapest viable v1:** host-owns model, dogfood both types to prove parity, local install only, permission declaration (no enforcement), minimal `ComponentContract` (health-check could defer to v1.1).

### Operational / robustness (medium confidence, feasible-with-conditions)

Reframed for a local desktop tool (Electron + local server spawning child processes and docker containers per bench, up to `benches.max` = 6 concurrent).

- **The orphan risk is structural and the strongest operational finding.** `stopProcess` does SIGTERM→`treeKill(SIGKILL)` (`process-manager.ts:78-111`), but docker compose daemonises containers out of the process tree, so `treeKill` alone never reaps them. If a plugin (level 1) crashes while owning running containers/processes (level 2), the host has no direct handle to the grandchildren. `handleChildExit` (`plugin-manager.ts:669-733`) restarts on budget but issues **no cleanup** first, risking duplicate containers / port conflicts on restart. `shutdown` (`plugin-manager.ts:813-838`) never calls `composeDown` for plugin-started containers. A hard host kill (SIGKILL / reboot / Electron crash) bypasses graceful shutdown entirely.
- **Host-owns resolves this directly:** containers tracked under the host's `roubo-<projectId>-bench-<N>` compose project naming can be discovered and stopped via `reconcile` plus a startup cleanup pass (the same pattern `reconcile` (`bench-manager.ts:188-283`) already uses); on plugin crash the host cleans up via the existing teardown paths (`runTeardownBackground`, `bench-manager.ts:1082-1113`).
- **Needed supervision additions:** a pre-restart cleanup hook; a startup cleanup pass; plugin-declared port binding routed through `port-allocator` (`getPortConflicts`) so out-of-band ports do not silently collide across benches.
- **Observability is already substantial:** per-plugin rotating logs (`plugin-manager.ts:552-567`), `ComponentStatus`, SSE. Under host-owns the existing `GET /components/:name/logs` keeps working; under plugin-owns the plugin must stream logs back or the route returns nothing.

### Security / supply-chain / legal (medium confidence, feasible-with-conditions)

Reframed: little regulated PII, but the feature **runs arbitrary third-party executable code** on the consumer's machine and (v3) distributes it.

- **"Safe by default" is an over-promise for v1 and only approximable in v2.** v1 ships advisory permissions while component plugins can spawn processes/containers; today plugins run via bare `child_process.spawn` with only env filtering (`plugin-manager.ts:596`), no OS sandbox. Host-API enforcement (`plugin-fs.ts`, `plugin-spawn.ts`) only covers calls made *through* host RPC; a plugin owning its own children with native Node APIs bypasses it entirely. So host-layer enforcement is meaningful **only** under the host-owns model.
- **No supported macOS OS sandbox for a headless Node server process.** `sandbox-exec` is deprecated; App Sandbox targets App-Store GUI apps; the Node 24 permission model does not cleanly propagate to Docker/shell children. The realistic v2 path is a **capability broker** (host is the sole privileged actor) or **container-per-plugin**, both of which must be prototyped before "safe by default" is committed. (Sources: nodejs.org Node 24 permissions docs; reports on macOS sandbox-exec deprecation.)
- **v3 supply chain is greenfield and high-value-target.** `plugin-installer.ts` installs from a git URL or local path (~lines 184-235) with no signing, hash pinning, or provenance. Documented 2024-2026 VS Code / npm marketplace attacks (typosquatting, compromised publisher tokens, malicious-but-provenanced builds) confirm the threat is active. MVP trust pipeline: author identity (GitHub OAuth already exists), content hash pinning, Sigstore/SLSA provenance, and a takedown mechanism, designed so v1 installs are forward-compatible.
- **Legal:** adopt the industry-norm developer agreement (author bears liability, host liability capped, per the JetBrains pattern) before accepting any non-first-party plugin. A moderate legal-draft task, not a technical blocker.

## Top risks (ranked, cross-dimension)

1. **Host-owns vs plugin-owns lifecycle is unresolved** (severity: high). Converged on by **all four** dimensions. It gates the contract, the `bench-manager` refactor, the SDK, the orphan-cleanup story, and whether v2 enforcement is even meaningful. Owner: **architecture** (spike both models).
2. **macOS/Node has no off-the-shelf OS sandbox for a headless process; "safe by default" is only approximable** (severity: high). Owner: a dedicated **v2 sandboxing spike** + architecture (capability-broker as the natural answer under host-owns).
3. **Orphaned processes/containers on plugin or host crash** (severity: high). Owner: architecture (host-owns) + supervision additions (pre-restart cleanup hook, startup cleanup pass).
4. **Lifecycle-parity regression during the dogfood extraction** (severity: high). Owner: a **parity test matrix written before extraction**, expanding `bench-manager.test.ts` to cover every `startDockerComponent` / `startProcessComponent` branch.
5. **v3 marketplace supply-chain (signing / provenance / takedown / typosquatting)** (severity: high, v3-scoped). Owner: v3 design, **sketched now** so the v1 install format is forward-compatible.
6. **80% coverage gate + required CodeQL on a large `bench-manager` refactor** (severity: medium). Owner: budget test authoring as a first-class line item; keep CodeQL green as a design constraint.

## De-risking plan

These become `spike` issues when `breakdown` runs.

- [ ] **Spike: host-owns vs plugin-owns lifecycle ADR.** Prototype both models against the docker-init / migration / connection-string / reconcile flow; confirm host-owns reuses `process-manager`/`docker` with no structural change and resolves the orphan + enforcement risks. Resolves risks 1, 3, and (transitively) 2's enforceability. Cap 3-5 days.
- [ ] **Spike: v2 sandboxing mechanism on macOS/Node.** Evaluate the Node 24 permission model (+ flag propagation), container-per-plugin, macOS Virtualization.framework, and the capability-broker model; state honestly what "cannot exceed declared permissions" can guarantee vs only approximate. Resolves risk 2 and the "safe by default" over-promise.
- [ ] **Design: lifecycle-parity test matrix.** Enumerate every existing component feature (dependsOn, docker init/portEnvVar, migration, connection templates, env/envFile, directory, setup, port allocation, container assignment, logs, reconcile) as a baseline parity test **before** extraction begins. Resolves risk 4.
- [ ] **Design: v1 consent/trust UX + v3 trust-pipeline sketch.** An explicit consent UI that names the missing sandbox and labels v1 plugins as unsandboxed; a v3 signing/provenance/takedown sketch the v1 install format must stay compatible with. Resolves risk 5 and the "normalizing unsandboxed third-party code" concern.
- [ ] **Design: host-RPC surface + host-capability versioning.** Define the new `host.docker.*` / `host.process.*` surface and how a component plugin gates on host-method availability (a `host.capabilities()` RPC vs the plugin's `roubo` semver range). Resolves the "new versioned host surface with no current analogue" gap.

## Recommendation

**DE-RISK**: proceed to `/product-dev:prd`, but treat the de-risking plan above as gating. The keystone is the host-owns/plugin-owns decision: resolving it in favour of **host-owns** (the strong cross-dimension lean) simultaneously de-risks technical, operational, and security. The PRD and architecture should carry these spikes as explicit pre-implementation work, and `breakdown` should file them as `spike` issues sequenced before the extraction slices.

## Assumptions to validate

- **Host-owns lifecycle is adopted for v1** (plugin describes/dispatches; host owns `process-manager` and `docker`). This is the lower-risk path that maximizes reuse and is the basis for resolving 3 of the 4 top risks. If the user/architecture instead wants plugin-owns, the operational orphan risk and the v2 enforcement story both get materially harder.
- **v2 sandboxing is accepted as a capability-broker / cooperative model** (consistent with how plugins run today), unless the sandboxing spike finds a viable container-per-plugin path. "Safe by default" is then scoped to "contains accidental damage and honest plugins," not "resists a determined attacker," and that scoping is stated to consumers.
- **Config back-compat is explicitly not required**; roubo and responda are the only two migration targets, done in the same PR that removes core type knowledge.
- **Component plugins are long-lived, spawned once per plugin** (like integration plugins today), not spawned per-bench; a per-bench spawn model would multiply the child-process count.
- **`HOST_API_VERSION` bumps** (minor or major) when the component kind lands, and existing integration plugins keep working unchanged.

## Open questions

- [ ] Coarse vs fine-grained component lifecycle contract (single blocking `host.docker.startService` vs separate `composeUp` / `waitForHealthy` calls): coarse is simpler, fine-grained composes better for novel types like a Clasp deploy.
- [ ] Does `assignContainer` (today `type === "database"`) become a manifest capability flag, or is it inferred from a declared `docker` permission category?
- [ ] How does the host-RPC surface version independently of `HOST_API_VERSION` so a plugin calling a newer host method on an older host fails gracefully?
- [ ] Deploy stress-test: a Clasp deploy is start-and-complete, not start-and-stay-running. Does `ComponentContract.start` need a `oneShot: true` flag (so a zero exit is not an error), or does deploy need its own plugin kind?
- [ ] Trust tiers: bundled first-party vs user-installed component plugins, and whether that distinction should change the v1 permission-display UX and the v2 enforcement default.
- [ ] Does the SDK split into `integration-sdk` / `component-sdk` workspaces, or does one `plugin-sdk` host both contracts behind a kind-aware `defineComponentPlugin()`?
