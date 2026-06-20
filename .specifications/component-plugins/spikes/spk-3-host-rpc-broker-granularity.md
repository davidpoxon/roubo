# Spike 600: What broker-method granularity, host-capability versioning scheme, and external-container assignment contract does T1.4 freeze?

**Status:** Resolved · **Issue:** #600 · **Class:** decision · **Resolves:** architecture.md:159-165 Open questions (docker granularity, capability versioning, external container assignment); prd.md FR-008/FR-017/NFR-005 · **Implements:** FR-008, FR-017, NFR-005 · **Verified by:** none (research spike) · **Gates:** T1.4 (HostComponentBroker) · **Recommendation:** adopt

## Objective and method

Pin down, before any broker code is written, the three contract decisions T1.4 (the `HostComponentBroker`, architecture.md components table) must build against:

1. docker-operation granularity: a single coarse `host.docker.startService` that blocks until healthy, versus the separate fine-grained `composeUp` / `waitForHealthy` / `composeRunInit` / `composeStop` / `composeDown` calls (architecture.md:161, FR-008, NFR-002),
2. the host-capability versioning mechanism: a runtime `host.capability.query({ method })` probe versus gating on the plugin's roubo semver range, and how the inverse direction (the host detecting a plugin missing a hook) is handled (architecture.md:165, FR-017, NFR-005), and
3. external container assignment: a `DockerDescriptor` field, a broker method gated on the `docker` permission, or a manifest capability flag (architecture.md:162, FR-008).

This is a decide-and-document spike. No broker code is written here; implementing the broker is explicitly out of scope (issue #600 Out of Scope, owned by T1.4). The deliverable is this findings doc, against which T1.4 implements the frozen signatures listed in the closing "What T1.4 freezes" section.

Method: take the broker surface already drafted in `architecture.md` (the `component plugin -> HostComponentBroker` interface block at lines 78-93, the `HostComponentBroker -> existing services` block at lines 95-99, and the three relevant Open questions at lines 161-165), reconcile each open question against the PRD requirements it traces to (FR-008, FR-017, NFR-005) and the NFR-002 latency budget that constrains the docker decision, then fix each decision verbatim with its rejected alternative and tradeoff recorded so the note is a real decision record. The decisions are grounded in the architecture's stated invariants: the broker is the single privileged choke-point both the `LifecycleEngine` and the imperative hooks funnel through (architecture.md:145), the host owns every process and container handle through `process-manager` / `docker` / `port-allocator` (architecture.md:13), and core carries zero docker-field knowledge so every container op is brokered (NFR-006, FR-009).

## Findings per acceptance criterion

### AC1: docker-operation granularity is fixed

**Decision: the broker exposes the fine-grained `composeUp` / `waitForHealthy` / `composeRunInit` / `composeStop` / `composeDown` calls. The `LifecycleEngine` drives them coarsely internally to stay within the NFR-002 +500 ms p95 budget. There is NO separate `host.docker.startService` RPC: the engine is the coarse consumer, not the broker surface.**

The architecture's docker facade already exposes the fine-grained phase primitives (`composeUp` / `waitForHealthy` / `composeRunInit` / `composeStop` / `composeDown` / status, architecture.md:43), and today's `startDockerComponent` is already a host-driven phase machine over them (architecture.md:15). The broker mirrors those primitives one-to-one (architecture.md:85-88) rather than collapsing them behind a single coarse `startService` call. Coarseness is a property of how the engine sequences the calls, not of the broker's method count.

Why fine-grained on the broker surface. The imperative escape hatch (architecture.md:76, the `start`/`stop`/`health`/`cleanup` hooks) exists for the 20% of lifecycles a single coarse call cannot express: a plugin that must interleave a custom step between `composeUp` and `waitForHealthy`, run an init service conditionally, or compose its own ordering for an FR-022-style deploy needs the individual phases as separate, addressable calls. A coarse `host.docker.startService` that runs the whole phase machine would re-impose exactly the god-schema rigidity the blend lens was chosen to avoid (architecture.md:15, "the blend takes the clean path for the 80% and the flexible path for the 20%"): the escape hatch would have no finer handle than the declarative path it is meant to escape.

Why the engine stays coarse internally. NFR-002 budgets a plugin-backed component to start within +500 ms p95 of the built-in baseline, with reconcile adding no polling IPC (prd.md NFR-002). The engine satisfies this by sequencing the fine-grained broker calls itself, in-host, as one tight phase machine (`composeUp` -> `waitForHealthy` -> optional `composeRunInit` -> optional migration -> resolve connection, architecture.md:121), so the declarative happy path pays no extra round-trips and reconcile is push/event-based, never polling the plugin (architecture.md:91, 139). "Coarse" here means the engine batches the phases without crossing the plugin boundary between them, not that the broker offers a coarse method.

**Rejected alternative: a coarse `host.docker.startService` RPC on the broker surface (blocks until healthy, runs the whole phase machine).**
Tradeoff: it would shave a few in-host function calls off the declarative path (already negligible against the NFR-002 budget, since those calls do not cross the plugin IPC boundary) at the cost of making the imperative escape hatch unable to interleave or reorder phases, which is the entire reason the escape hatch exists. The escape hatch would inherit the declarative path's coarseness and stop being an escape. The latency win is captured anyway by the engine sequencing the fine-grained calls in-host, so the coarse RPC buys nothing the engine does not already provide and forfeits the flexibility FR-022 needs. Rejected.

### AC2: the host-capability versioning mechanism is specified

**Decision: a dual, complementary (not either/or) mechanism.**

1. **`host.capability.query({ method }) -> { available, introducedIn? }`** for a plugin probing the live host per-method at runtime. This is the FR-017 graceful gate: before invoking a host-RPC method, a plugin asks whether this host implements it; if `available` is false the plugin degrades with a clear, actionable error rather than crashing the bench (architecture.md:93, 140; FR-017). `introducedIn?` (a semver string) tells the plugin which host version first carried the method, so its error message can name the upgrade the user needs.
2. **`HOST_API_VERSION` bumped per semver when the surface changes**, which a plugin's roubo semver range gates on at load time (NFR-005). Introducing the `component` kind bumps `HOST_API_VERSION`; every later additive change to the broker surface bumps it again per semver (prd.md NFR-005). A plugin declares a compatible host range and the host refuses to load a plugin whose declared range excludes the running `HOST_API_VERSION`, before any bench starts.

These are complementary, not redundant. `HOST_API_VERSION` is the **coarse, load-time** gate: it stops a categorically incompatible plugin from ever running, with one version check, before a bench is touched. `host.capability.query` is the **fine, call-time** gate: within a compatible major it lets a plugin that is willing to degrade probe for an individual newer method and adapt, instead of being refused outright for wanting one optional capability. A plugin built against a newer surface can still run usefully on an older host by querying for the methods it can live without; the semver range alone could not express that per-method tolerance, and the per-method probe alone could not cheaply reject a wholesale-incompatible plugin at load. Each covers the gap the other leaves.

**The inverse direction (the host detecting a plugin missing a hook like `stop`) is NOT a call-time concern.** It is handled by `contractVersion` plus registered-method introspection at validation time (architecture.md:76, 165). A plugin declares its mode via `contractVersion` and which methods it registers over the JSON-RPC transport; the host validates at plugin-validation time that the registered method set is complete for the declared mode (a plugin implements `translate` or the full imperative hook set, not silently a partial set). A plugin missing `stop` is rejected at validation, not discovered at stop-time (architecture.md:165). So capability flows in two directions handled by two distinct mechanisms: plugin-probes-host is `host.capability.query` + `HOST_API_VERSION` (this AC), host-inspects-plugin is `contractVersion` + registered-method introspection at validation.

**Rejected alternative: gate on the plugin's roubo semver range ALONE (drop `host.capability.query`).**
Tradeoff: a single load-time semver gate is simpler (one check, no per-call probe) but is all-or-nothing within a major version. A plugin that wants one method newer than the host has must either declare a host range that excludes the running host (and be refused entirely, even though it could run fine without that one method) or declare a permissive range and then crash at call-time when the method is absent, which is precisely the bench-crash FR-017 exists to prevent. The semver range cannot express "I need these methods and can degrade without those." Keeping only `host.capability.query` was the symmetric rejection: a per-method probe with no coarse load-time gate would let a wholesale-incompatible plugin spawn and fail method-by-method instead of being cleanly refused once. Both-not-either is the decision; each single mechanism leaves a real gap. Rejected (each in isolation).

### AC3: external container assignment is decided, per path

**Decision: both, one mechanism per path.**

1. **An `assignedContainerId` field on the `DockerDescriptor`** for the declarative path. It is already drafted in the descriptor union (architecture.md:54, `assignedContainerId?: string` on the `docker` variant). A declarative plugin that wants the host to adopt an externally-created container expresses it as descriptor data: `translate` returns a descriptor carrying `assignedContainerId`, and the `LifecycleEngine` adopts that container instead of running `composeUp`. This keeps the declarative path pure (the plugin returns data, runs no privileged code), consistent with why declarative-first makes the NFR-006 zero-knowledge guard and v2 sandboxing nearly free (architecture.md:15).
2. **A `host.docker.assignContainer({ componentName, containerId }) -> void` broker method, gated on the `docker` permission category**, for the imperative path. It is already drafted on the broker surface (architecture.md:89, "gated on the `docker` permission category"). An imperative plugin that discovers or creates a container mid-lifecycle (inside `start`) tells the host to adopt it through this brokered, permission-gated call, so the host takes ownership and records it in the `ResourceOwnershipLedger` for cleanup (NFR-003). Routing it through the broker keeps assignment inside the single privileged choke-point where enforcement and audit attach (architecture.md:145), so an imperative assignment is gated and (in v2) audited exactly like every other privileged op.

Both, per path, mirrors the AC1/AC3 symmetry of the chosen blend lens: the declarative path expresses the act as data, the imperative path expresses it as a brokered call, and both converge on the host owning the container handle. This matches the architecture's stated lean (architecture.md:162, "Leaning both, per path").

**Rejected alternative: a manifest capability flag (a static `canAssignContainer` declaration in the plugin manifest).**
Reason (one line): assignment is a per-bench runtime act (this bench adopts this container id now), not a static manifest capability, so a manifest boolean cannot carry the runtime `containerId` payload and would still need a descriptor field or broker call to actually perform the assignment, making the flag redundant overhead.
Tradeoff: a manifest flag would surface "this plugin assigns containers" at install/consent time, which has minor discoverability value, but that intent is already covered by the plugin declaring the `docker` permission category (which the `PermissionConsentUI` enumerates, architecture.md:40, 144). The flag adds a third place to declare the same capability without performing the act, and a static flag cannot model a per-bench, per-container-id runtime decision. Rejected.

## What T1.4 freezes

The frozen broker method signatures T1.4 (`HostComponentBroker`) must implement, lifted verbatim from `architecture.md` (the `component plugin -> HostComponentBroker` interface block, lines 78-93). This is the contract the engine and the imperative hooks both depend on; the three decisions above resolve the open questions over it without changing the signatures already drafted.

The `host.docker.*` surface (AC1: fine-grained on the broker, driven coarsely by the engine; AC3 imperative path):

- `host.docker.composeUp({ projectName, composeFile, cwd, service, env }) -> { containerId }`
- `host.docker.waitForHealthy({ projectName, service, timeoutMs }) -> { healthy: boolean }`
- `host.docker.composeRunInit({ projectName, composeFile, cwd, initService }) -> void`
- `host.docker.composeStop({ projectName, composeFile, cwd, service? }) -> void`
- `host.docker.composeDown({ projectName, composeFile, cwd }) -> void`
- `host.docker.assignContainer({ componentName, containerId }) -> void` (gated on the `docker` permission category)

The capability gate (AC2, plugin-probes-host direction):

- `host.capability.query({ method }) -> { available: boolean, introducedIn?: string }`

The status/log report surface (the `host.component.report*` calls that keep reconcile push-based, NFR-002):

- `host.component.reportStatus(ComponentStatus) -> void` (push, so reconcile never polls the plugin)
- `host.component.reportLog({ source: "stdout" | "stderr", text, ts }) -> void`

Not on the broker surface (AC1 rejection), recorded so T1.4 does not add it: there is NO `host.docker.startService` coarse RPC. Coarse sequencing lives in the `LifecycleEngine`, which calls the fine-grained methods above in-host.

Not a call-time broker concern (AC2), recorded so T1.4 does not conflate it with `host.capability.query`: `HOST_API_VERSION` (load-time semver gate against the plugin's declared roubo range) and `contractVersion` + registered-method introspection (host-inspects-plugin, at validation time) are the other two version mechanisms; only `host.capability.query` is a broker method.

For completeness, the rest of the drafted broker surface T1.4 implements alongside the above (architecture.md:80-92), unchanged by this spike:

- `host.process.start({ id, command, args?, env, cwd }) -> { pid }`
- `host.process.run({ id, command, args?, env, cwd, timeoutMs }) -> { exitCode }`
- `host.process.stop({ id }) -> void`
- `host.process.status({ id }) -> { alive: boolean, exitCode?: number }`
- `host.process.logs({ id }) -> string[]`
- `host.ports.get({ componentName }) -> number` (read; allocation is host-side, pre-resolved into `BenchContext.ports`)

## Recommendation

**Adopt.** The three decisions are fixed and internally consistent, and they trace cleanly to FR-008 (the versioned host-RPC surface), FR-017 (the graceful host-method-availability gate), and NFR-005 (version mismatches fail gracefully). They resolve the three architecture.md Open questions the broker depends on (docker granularity at line 161, external container assignment at line 162, and the capability-direction note at line 165) without altering any signature already drafted on the broker surface. T1.4 has a frozen contract to build against. Carry these forward into the broker build:

1. Implement the fine-grained `host.docker.*` calls on the broker; do not add a coarse `host.docker.startService`. Put the coarse sequencing in the `LifecycleEngine`, in-host, to hold the NFR-002 budget.
2. Implement `host.capability.query({ method }) -> { available, introducedIn? }` as the call-time per-method gate, AND bump `HOST_API_VERSION` per semver as the load-time gate; treat them as complementary, not as a choice. Keep the host-inspects-plugin direction (`contractVersion` + registered-method introspection) at validation time, separate from `host.capability.query`.
3. Implement external container assignment both ways: honour `assignedContainerId` on the `DockerDescriptor` in the engine's declarative path, and implement `host.docker.assignContainer({ componentName, containerId })` on the broker, gated on the `docker` permission, for the imperative path. Do not add a manifest capability flag.

## Open questions / follow-ups

These are scoping seams the architecture already tracks as Open questions; this spike resolves the three the broker depends on and does not touch the others, pointing the relevant work at them rather than inventing placeholders:

- **The v2 isolation backend** (architecture.md:163, Apple container framework vs Virtualization.framework vs Docker vs Linux namespaces): owned by the sandboxing spike (SPK-2), not this spike, and it gates Phase 2, not the broker. This spike does not touch it.
- **One SDK package exposing `defineComponentPlugin()` alongside `definePlugin()` vs splitting workspaces** (architecture.md:164): an SDK-packaging question, not a broker-contract question; out of scope for SPK-3 and unaffected by the decisions here.

(No deferred work is named here that lacks a tracked home: the items above are the architecture's own enumerated Open questions, owned by SPK-2 and the SDK-packaging work, not new follow-ups invented by this spike. Should T1.4 surface genuinely new deferred work, file it as a GitHub issue and reference the number inline per the repo's follow-up-references rule before relying on it.)

## Lineage / traceability

- **Implements:** FR-008 (the versioned host-RPC surface and its method granularity), FR-017 (the host-method-availability gate that fails gracefully), NFR-005 (version mismatches fail gracefully via the capability gate plus `HOST_API_VERSION` semver).
- **Verified by:** none (research spike; the broker T1.4 builds carries the version-mismatch test asserted by NFR-005 and the NFR-002 start-overhead benchmark).
- **Resolves:** architecture.md:161 (docker coarse-vs-fine granularity), architecture.md:162 (external container assignment), architecture.md:165 (the capability-direction note), all under architecture.md "Open questions".
- **Gates:** T1.4 (`HostComponentBroker`), which now has a frozen contract to build the `host.docker.*` / `host.capability.query` / `host.component.report*` surface against.
- **Grounded in:** `architecture.md:78-93` (the drafted `component plugin -> HostComponentBroker` interface), `architecture.md:95-99` (the `HostComponentBroker -> existing services` mapping the broker calls into), `architecture.md:43` (the `docker` facade's fine-grained phase primitives the broker mirrors), `architecture.md:54` (the `DockerDescriptor` with `assignedContainerId`), `architecture.md:76` (`contractVersion` + registered-method mode declaration), `architecture.md:145` (the broker as single privileged choke-point), and prd.md FR-008 / FR-017 / NFR-002 / NFR-005.
