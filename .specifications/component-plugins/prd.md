# PRD: Component Plugins

|                 |                   |
| --------------- | ----------------- |
| **Slug**        | component-plugins |
| **Status**      | draft             |
| **Brief**       | ./brief.md        |
| **Feasibility** | ./feasibility.md  |

## Problem statement

Roubo builds a running version of an application on a bench out of **components**, but there are exactly two component types (`database`, `process`) and both are hardcoded into core. The type knowledge lives in `bench-manager.ts` (the `launchComponent` / `stopComponent` / `reconcile` / `assignContainer` branches) and in the single `ComponentConfig` schema in `shared/config-schema.ts`. Adding any new component type (a redis cache, a worker queue, a future Google Cloud / Clasp deploy target) requires editing Roubo core and shipping a release. That is a hard ceiling on what a bench can be, and it blocks an ecosystem. Roubo already proved the plugin path with **integration plugins** (a `roubo-plugin.yaml` manifest with a `kind` discriminator, a `PluginContract`, JSON-RPC-over-stdio, supervised by `plugin-manager.ts`); components are the deliberate next plugin kind. The distinguishing difficulty: a component plugin must **launch and supervise real processes and containers**, not merely answer RPC queries.

## Goals & non-goals

- **Goals:**
  - Make `component` a first-class plugin kind so a new component type can be added without forking Roubo core.
  - Dogfood the abstraction by re-implementing both built-in types as first-party bundled plugins, leaving core with zero component-type knowledge.
  - Keep every existing bench behaviour identical through the migration (parity is non-negotiable).
  - Spec the full three-phase program now (v1 foundation, v2 enforced sandboxing, v3 marketplace) so later phases are pre-designed, and build it in sequence.
  - Keep the architecture general enough to host a future deploy capability without redesign.
- **Non-goals:**
  - Building enforced sandboxing in v1 (specced, built in v2).
  - Building the marketplace in v1/v2 (specced, built in v3).
  - Shipping a Google Cloud / Clasp deploy plugin (design-for only, never built in this work).
  - Preserving the old `roubo.yaml` component config shape byte-for-byte (the two live configs are migrated instead).
  - Distributing third-party (non-first-party) plugins through the official marketplace at this time (the official catalog is first-party-curated; third-party plugins remain locally installable).

## In scope

**v1 (foundation):** the `component` plugin kind, a `ComponentContract` in the SDK, a redesigned `roubo.yaml` component-to-plugin binding, first-party bundled `database` and `process` plugins at full parity, removal of all core type-dispatch, a host-RPC broker for the privileged ops plugins need (process + docker + ports), local install + permission **declaration** + a consumer consent UI, crash/teardown cleanup with graceful degradation and auto-recovery, and migration of the roubo + responda configs.

**v2 (sandboxing):** enforced isolation so a plugin cannot exceed its declared permissions, plus an audit log of privileged calls.

**v3 (marketplace):** an in-app, registry-backed catalog to browse / install / update plugins, integrity-verified, hosting first-party-curated plugins only at this time.

## Out of scope

- Enforced sandboxing in v1 (deferred to v2; v1 enforcement is advisory with explicit consent).
- The marketplace before v3.
- Third-party submission to the official marketplace, and the associated developer agreement / liability / takedown-of-untrusted-authors machinery (the catalog is first-party-curated at this time; revisit when third-party distribution is opened).
- A built Clasp / Google Cloud deploy plugin (design-for stress-test only; see FR-022).
- Per-bench (rather than per-plugin) component-plugin process model (plugins are spawned once per plugin, as integration plugins are today).

## User stories

- **US-001** As a consumer, I want to declare a bench's components by referencing plugins in `roubo.yaml`, so I can assemble a running environment without forking Roubo. _(P0; v1)_
- **US-002** As a consumer, I want the first-party `database` and `process` plugins to behave exactly like today's built-in components, so migrating to plugins introduces no regressions. _(P0; v1)_
- **US-003** As a consumer, I want to install a third-party component plugin from local disk and use it in a bench, so I can extend my environment with community types without forking. _(P0; v1)_
- **US-004** As a consumer, I want to see what permissions a component plugin declares before I run it, so I can make an informed trust decision. _(P0; v1)_
- **US-005** As a plugin author, I want an SDK contract for the component lifecycle, so I can publish a new component type as a self-contained plugin. _(P1; v1)_
- **US-006** As a consumer, I want clear status and logs for a plugin-backed component, so I can diagnose failures the same way I do for built-in components today. _(P0; v1)_
- **US-007** As the Roubo team, I want core to carry zero hardcoded component-type knowledge, so a new component type never requires a core change. _(P0; v1)_
- **US-008** As a consumer, I want a crashed or misbehaving component plugin to be cleaned up and recovered, so my machine stays healthy and my bench keeps working. _(P0; v1)_
- **US-009** As a consumer, I want enforced sandboxing so a component plugin cannot exceed its declared permissions, so a malicious or buggy plugin cannot harm my machine. _(P0; v2)_
- **US-010** As a consumer, I want to browse, install, and update component plugins from a marketplace, so I can discover and adopt curated plugins easily. _(P1; v3)_
- **US-011** As the Roubo team, I want marketplace plugins to be served with verified integrity and revocable, so consumers can trust what they install. _(P1; v3)_
- **US-012** As an architect, I want the plugin architecture to accommodate a future deploy capability (e.g. Google Cloud via Clasp), so deploy can be added later without redesign. _(P2; design-for)_

## Functional requirements

### v1: the component plugin kind, dogfood, local install, declaration

- **FR-001** The plugin manifest supports a `component` kind by extending the `kind` discriminator beyond `integration`. _(serves US-001, US-005; P0)_
- **FR-002** The plugin SDK defines a `ComponentContract` with two modes: a declarative `translate(config) -> ProvisionDescriptor` (the primary path) and imperative lifecycle hooks (`start`, `stop`, `health`, `cleanup`) as the escape hatch. The lifecycle phases (provision, start, stop, health/status, logs) map onto the imperative mode; declarative plugins implement `translate` instead. _(serves US-005; P0)_ _(see architecture.md "Supersedes / PRD deltas")_
- **FR-003** `roubo.yaml` declares each bench component by binding it to a component plugin (a plugin reference plus a plugin-owned config block validated by the plugin's own `configSchema`). _(serves US-001; P0)_
- **FR-004** A first-party bundled `database` component plugin reproduces the existing database behaviour: docker compose (composeFile, service, initService, portEnvVar), migration, connection-string templating, and env injection. _(serves US-002; P0)_
- **FR-005** A first-party bundled `process` component plugin reproduces the existing process behaviour: command, one-time setup, env/envFile, working directory, and dependsOn. _(serves US-002; P0)_
- **FR-006** All component-type dispatch is removed from `bench-manager` (the `launchComponent` / `stopComponent` / `reconcile` / `assignContainer` branches); components are launched, stopped, reconciled, and assigned containers through their plugin. _(serves US-007; P0)_
- **FR-007** Component lifecycle parity holds for plugin-backed components: dependsOn ordering, port allocation, env/envFile injection, connection templating, one-time setup, external container assignment, log capture, and live-state reconcile all function as they do for built-in components today. _(serves US-002, US-006; P0)_
- **FR-008** The host exposes a versioned host-RPC surface for the privileged operations a component plugin needs (process spawn/stop/status/logs, docker compose up/stop/down/init/health, port allocation), so the plugin describes-and-dispatches and the host owns the actual process/container lifecycle. _(serves US-005, US-008; P0)_
- **FR-009** Core retains no docker/compose field knowledge: every container operation a component plugin performs is brokered through the host-RPC docker surface (FR-008), with no docker-field branching left in core. _(serves US-007; P0)_
- **FR-010** A component plugin can be installed locally (bundled root plus `~/.roubo/plugins` drop-in) and is discovered, validated (manifest + `HOST_API_VERSION` semver), spawned, and supervised exactly as integration plugins are. _(serves US-003; P0)_
- **FR-011** A component plugin's manifest declares the permission categories it uses: network, credentials, filesystem, processes, plus the new `ports` and `docker` categories. _(serves US-004; P0)_
- **FR-012** Before a component plugin runs for the first time (or at install), the consumer is shown every declared permission category in plain language and must explicitly acknowledge them; a non-first-party plugin is labeled as unsandboxed until v2. _(serves US-004; P0)_
- **FR-013** The `roubo.yaml` configs for roubo and responda are migrated to the plugin-based component declaration and run identically to today. _(serves US-002, US-007; P0)_
- **FR-014** Plugin-backed component status and logs are exposed through the existing surfaces (`ComponentStatus`, `GET /components/:name/logs`, the notifications SSE stream) with no loss of fidelity versus built-in components. The status surface includes a `completed` terminal state (distinct from stopped and error) for a successful one-shot lifecycle (see FR-022). _(serves US-006; P0)_
- **FR-015** On a component-plugin crash or bench teardown, the host cleans up every process and container the component owns (no orphans), via a pre-restart cleanup hook and a startup reconcile/cleanup pass over known bench compose-project names. _(serves US-008; P0)_
- **FR-016** A single component-plugin crash degrades gracefully: other components in the same bench keep running, and the host auto-recovers the crashed component back to running within the existing restart budget. _(serves US-008; P0)_
- **FR-017** A component plugin gates on host-method availability (a host-capability query) so invoking a host-RPC method an older host lacks fails with a clear, actionable error rather than crashing the bench. _(serves US-005, US-008; P0)_

### v2: enforced sandboxing

- **FR-018** A component plugin is constrained so it cannot exceed its declared permissions, enforced via OS-level isolation per plugin. The isolation backend is selected by the sandboxing spike (Apple container framework, macOS Virtualization.framework, Docker, or Linux namespaces) and is not hardwired to Docker. _(serves US-009; P0; v2)_
- **FR-019** Every privileged host-RPC call a component plugin makes is recorded in an audit log, queryable per plugin and per bench. _(serves US-009; P0; v2)_

### v3: marketplace (first-party-curated)

- **FR-020** Consumers can browse, search, install, and update component (and integration) plugins from an in-app marketplace backed by a registry; the catalog hosts first-party / Roubo-curated plugins only at this time. _(serves US-010; P1; v3)_
- **FR-021** Marketplace install and update verify the integrity and authenticity of the fetched plugin (signed catalog / provenance), and a plugin can be revoked or taken down from the catalog. _(serves US-010, US-011; P1; v3)_

### Design-for (specced, not built)

- **FR-022** The component lifecycle contract accommodates a non-long-running ("one-shot") lifecycle (where start runs to completion rather than staying resident) so a future deploy capability (Google Cloud via Clasp) can be added as a plugin without redesigning the contract or the kind boundary; a successful one-shot run reports a `completed` terminal `ComponentStatus` state, distinct from stopped and error. This is validated as a design stress-test against the architecture, not implemented in this work. _(serves US-012; P2; design-for)_ _(see architecture.md "Supersedes / PRD deltas")_

## Non-functional requirements

Each NFR has a measurable target and a verification method.

- **NFR-001** _(Security)_ Component plugins run under a declare-then-enforce trust model. **Target:** v1 ships permission declaration plus an explicit per-category consent UI with plugins labeled unsandboxed and enforcement advisory; v2 enforces isolation per plugin so a plugin cannot perform an undeclared network / filesystem / process / port / docker action, with the threat model scoped to containing accidental damage, honest plugins, and casual abuse (resistance to a determined attacker requires the OS-isolation backend chosen by the sandboxing spike, see FR-018). **Verify:** v1, a UI test asserting the consent dialog enumerates every declared category and blocks run until acknowledged; v2, a red-team test that a plugin attempting an action outside its declared permissions is blocked and audit-logged (security-type test).
- **NFR-002** _(Performance)_ Plugin indirection adds no meaningful start or supervision overhead. **Target:** a plugin-backed component starts within +500 ms (p95) of the equivalent built-in component, measured on the dogfood `database` and `process` plugins across roubo and responda benches; the reconcile loop adds no polling IPC (component status is pushed by event, not polled), keeping reconcile p95 at or below today's. **Verify:** a benchmark comparing built-in versus plugin component start time, and a reconcile-overhead assertion (performance-type test).
- **NFR-003** _(Reliability)_ A plugin-backed bench is at least as robust as a built-in one. **Target:** zero orphaned processes or containers after a plugin crash, a host crash/restart, or a bench teardown; a single component-plugin crash never takes down other components in the bench; the crashed component auto-recovers within the existing 3-restarts / 5-minute budget. **Verify:** a chaos test that kills a plugin mid-lifecycle and asserts (a) cleanup left no `roubo-*` containers or tracked PIDs, (b) sibling components stayed running, and (c) the component returned to running within budget (reliability-type test).
- **NFR-004** _(Observability)_ Plugin-backed components are as diagnosable as built-in ones. **Target:** component-level logs and status reach the same surfaces as today (`ComponentStatus`, `GET /components/:name/logs`, SSE) with no loss of fidelity in v1; v2 adds an audit log of every privileged host-RPC call, queryable per plugin and per bench. **Verify:** a logs/status parity test on the dogfood plugins (v1) and an audit-log assertion test (v2).
- **NFR-005** _(Compatibility / versioning)_ Existing integrations are unaffected and version mismatches fail gracefully. **Target:** config backward-compatibility is not required (the two live configs are migrated); existing integration plugins keep working unchanged; introducing the `component` kind bumps `HOST_API_VERSION` per semver; a component plugin gates on host-method availability so calling a host-RPC method an older host lacks fails with a clear error, not a crash. **Verify:** the integration-plugin regression suite stays green, and a version-mismatch test asserts a graceful (not crashing) error (compatibility-type test).
- **NFR-006** _(Maintainability)_ The dogfood invariant is mechanically enforced. **Target:** after v1, core (`server/`, `shared/`) contains zero component-type literals or type-branching outside the bundled plugins (no `=== "database"` / `=== "process"` dispatch) and zero docker/compose field knowledge (all container access goes through the host-RPC broker). **Verify:** a CI guard (grep/AST) that fails the build if a component-type literal or a core docker-field branch reappears, plus an intentional-violation test proving the guard catches it; the existing 80% coverage gate remains in force.
- **NFR-007** _(Accessibility)_ All new UI is accessible. **Target:** the v1 permission-consent dialog and the v3 marketplace meet WCAG 2.1 AA, are keyboard and screen-reader navigable, and are built with React Aria Components per the project convention. **Verify:** an automated axe check in component tests plus a manual keyboard-navigation pass (accessibility-type test).

## Success indicators

### Leading

| Indicator                                     | Baseline                                                                    | Target                                                                                                            | Source                                | Validates                                      |
| --------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| Dogfood parity pass rate                      | n/a (new)                                                                   | 100% of the parity suite green; roubo + responda benches start/stop/reconcile identically on plugin components    | parity test suite + manual bench runs | US-002, US-007, FR-004, FR-005, FR-007, FR-013 |
| Core type-knowledge                           | 4 dispatch sites in `bench-manager.ts` + 2-value enum in `config-schema.ts` | 0 component-type literals / docker-field branches in core (CI guard green)                                        | the NFR-006 CI guard                  | US-007, FR-006, FR-009                         |
| Third-party plugin runs without a core change | 0 (impossible today)                                                        | >= 1 non-first-party component plugin (e.g. redis or a Clasp-deploy stub) authored and run on an unmodified Roubo | manual / example plugin               | US-003, US-005, FR-001, FR-002, FR-010         |
| Time-to-first-plugin                          | n/a                                                                         | an author scaffolds and runs a hello-world component plugin in < 30 min using the SDK + docs                      | author-onboarding dry run             | US-005, FR-002                                 |

### Lagging

| Indicator                                           | Baseline                | Target                                                          | Source                                                 | Validates           |
| --------------------------------------------------- | ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ------------------- |
| Core PRs required to add a component type           | 1+ per new type (today) | 0 (new types ship as plugins, no core change)                   | git history of `bench-manager.ts` / `config-schema.ts` | US-007, the feature |
| Permission-escape incidents (post-v2)               | n/a                     | 0 reported cases of a plugin exceeding its declared permissions | issue tracker / incident reports                       | US-009, FR-018      |
| Curated plugins installed via marketplace (post-v3) | 0                       | installs / active component plugins per project trending up     | marketplace registry telemetry                         | US-010, FR-020      |

## Dependencies & assumptions

- **Keystone architecture decision (host-owns vs plugin-owns the component lifecycle) is pre-implementation work.** Feasibility found all four lenses converge on this; the PRD assumes the **host-owns** model (plugin describes/dispatches; host owns `process-manager` and `docker` via the FR-008 broker), which is the lower-risk path that also makes NFR-001 enforcement and NFR-003 cleanup achievable. This is architecture's call to confirm; FR-008/FR-009 and the maintainability NFR are written for host-owns.
- **Pre-implementation spikes (from the feasibility de-risking plan; `breakdown` files these as `spike` issues, sequenced before the extraction slices):**
  - Host-owns vs plugin-owns lifecycle ADR (prototype both against the docker-init / migration / connection-string / reconcile flow).
  - v2 sandboxing mechanism on macOS/Node (evaluate Apple container framework, Virtualization.framework, Docker, Linux namespaces, and a capability-broker; state what "cannot exceed declared permissions" can guarantee vs only approximate).
  - Lifecycle-parity test matrix authored before extraction begins.
  - v1 consent/trust UX plus a v3 channel-integrity sketch the v1 install format must stay compatible with.
  - The host-RPC surface design plus host-capability versioning (FR-008, FR-017).
- The existing plugin host, SDK, transport (vscode-jsonrpc over stdio), discovery, restart supervision, and permission-declaration model are reused and extended, not rebuilt (`plugin-manager.ts`, `plugin-sdk/`, `shared/plugin-manifest-schema.ts`).
- `PluginPermissionsSchema` is `.passthrough()` by design, so adding the `ports` and `docker` permission categories (FR-011) is a non-breaking minor.
- Component plugins are long-lived, spawned once per plugin (like integration plugins), not per bench.
- The official marketplace is first-party-curated at this time; third-party plugins are locally installable but not marketplace-distributed, so no developer-agreement / third-party-supply-chain pipeline is in scope now.
- The 80% coverage gate, required CodeQL check, and DCO sign-off remain in force throughout; the `bench-manager` refactor must keep CodeQL green (its inlined prototype-pollution guards are a design constraint).

## Open questions

- [ ] Coarse vs fine-grained component lifecycle contract: a single blocking `host.docker.startService` (returns when healthy) versus separate `composeUp` / `waitForHealthy` calls. Coarse is simpler; fine-grained composes better for novel types like a Clasp deploy (FR-022). Architecture to decide.
- [ ] Does `assignContainer` (today guarded by `type === "database"`) become a manifest capability flag, or is it inferred from a declared `docker` permission category? (Affects FR-006, FR-011.)
- [ ] Does the SDK split into `integration-sdk` / `component-sdk` workspaces, or does one `plugin-sdk` host both contracts behind a kind-aware `defineComponentPlugin()`? (Affects FR-002.)
- [ ] For FR-022, does a one-shot lifecycle flag on `ComponentContract.start` suffice for deploy, or does deploy ultimately need its own plugin kind? The architecture should answer via the design stress-test, even though deploy is not built.
- [ ] Trust tiers: should bundled first-party component plugins and locally-installed third-party ones differ in the v1 permission-display UX and the v2 enforcement default? (Affects FR-012, FR-018.)
- [ ] Does the v2 isolation backend need Docker present, or can the Apple container framework / Virtualization.framework satisfy NFR-001/FR-018 on macOS without a Docker dependency? (The sandboxing spike resolves this.)
