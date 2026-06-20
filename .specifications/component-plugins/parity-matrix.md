# Lifecycle-parity test matrix

## Purpose

This matrix is the parity baseline the dogfood extraction is checked against, authored before any built-in component type is moved into a plugin. It makes the CP-NFR-002 guarantee (a plugin-backed component behaves identically to the built-in one) mechanically checkable at extraction time.

Each row pins one built-in component behaviour named in CP-FR-007 to two things: the existing built-in test that proves the behaviour today (the evidence anchor), and the plugin-backed parity assertion (a CP-TC case from `test-cases.json`) that must hold once the behaviour lives in a plugin. The matrix is derived from two sources, exactly as the issue requires:

1. The existing built-in coverage in `server/services/bench-manager.test.ts` (the "Built-in test (evidence)" column). Line anchors below were read from that file at authoring time; treat the test title as authoritative and the line number as a hint, since line numbers drift.
2. The dogfood-parity test cases in `.specifications/component-plugins/test-cases.json` (the "Parity test case(s)" column).

This baseline is what the plugin-build slices are verified against:

- **F1.9** (issue #611, build the bundled database component plugin at full parity)
- **F1.10** (issue #610, build the bundled process component plugin at full parity)
- **F1.11** (issue #614, migrate the roubo and responda `roubo.yaml` configs to plugin components, the dogfood cut-over)

A slice is parity-complete only when every parity test case in the rows it touches is green. The CI guard for zero-core-knowledge (CP-NFR-006, issue #617) is out of scope for this matrix; that guard proves core retains zero component-type and docker knowledge (the dispatch removal it follows is issue #612), this matrix proves the behaviour survived the move.

## How to read a row

| Column                         | Meaning                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Behaviour                      | The built-in component behaviour from CP-FR-007 that must survive extraction.                   |
| Built-in semantics             | What the host does today for a built-in component, in one line.                                 |
| Built-in test (evidence)       | The existing `bench-manager.test.ts` test that proves the behaviour today.                      |
| Plugin-backed parity assertion | What the plugin-backed equivalent must do to be at parity.                                      |
| Parity test case(s)            | The CP-TC case(s) in `test-cases.json` that assert the parity, run against the bundled plugins. |

## Behaviour parity rows (CP-FR-007)

### 1. dependsOn ordering

|                                    |                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Behaviour**                      | dependsOn ordering                                                                                                                                                                                                                                     |
| **Built-in semantics**             | The host starts components in dependency order: a process component declaring `dependsOn` waits for the database component to be healthy before it spawns.                                                                                             |
| **Built-in test (evidence)**       | `startAllComponents / stopAllComponents` > "respects dependsOn ordering" (`bench-manager.test.ts` ~L4101).                                                                                                                                             |
| **Plugin-backed parity assertion** | With ordering decided by the engine from descriptor-declared `dependsOn`, a plugin-backed process component still starts only after its plugin-backed database dependency reports healthy; a cycle is rejected at bench start rather than deadlocking. |
| **Parity test case(s)**            | CP-TC-039 (process components wait for the database component before starting); CP-TC-050 (a dependsOn cycle between two process components is detected and rejected at bench start).                                                                  |

### 2. port allocation

|                                    |                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Behaviour**                      | port allocation                                                                                                                                                                                                                            |
| **Built-in semantics**             | The host allocates a host port and exposes it to the container under the configured `portEnvVar` (defaulting to `HOST_PORT`).                                                                                                              |
| **Built-in test (evidence)**       | `startComponent` > "uses custom portEnvVar from docker config" (~L3568) and "defaults to HOST_PORT when portEnvVar not specified" (~L3600).                                                                                                |
| **Plugin-backed parity assertion** | The allocated host port reaches the spawned database container under the plugin-config `portEnvVar`, allocated via the host-RPC ports surface (not by the plugin), so the value the plugin describes and the value the host injects match. |
| **Parity test case(s)**            | CP-TC-060 (L4: `portEnvVar` from the database plugin config is present in the spawned database container environment).                                                                                                                     |

### 3. env / envFile injection

|                                    |                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Behaviour**                      | env / envFile injection                                                                                                                                                                                                                                                           |
| **Built-in semantics**             | The host writes an env file for a process component and passes service `env` through to both docker compose and migration commands.                                                                                                                                               |
| **Built-in test (evidence)**       | `startComponent` > "passes service env to docker compose and migration commands" (~L3238); "writes env file for process component with envFile config" (~L3100); "writes env file relative to workspace root, not service directory" (~L3124).                                    |
| **Plugin-backed parity assertion** | `env` and `envFile` values from the plugin config land in the spawned process environment exactly as today, and the database plugin's translated descriptor carries the same env through to compose and migration.                                                                |
| **Parity test case(s)**            | CP-TC-059 (L4: `env` and `envFile` values from the process plugin config are injected into the spawned process environment); CP-TC-036 (`BundledProcessPlugin.translate` produces a valid process ProvisionDescriptor for all process `roubo.yaml` fields, env/envFile included). |

### 4. connection-string templating

|                                    |                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Behaviour**                      | connection-string templating                                                                                                                                                                                                                                  |
| **Built-in semantics**             | The host resolves template variables (ports, connection strings) in a process component's command and config from the started database.                                                                                                                       |
| **Built-in test (evidence)**       | `startComponent` > "resolves template variables in process command" (~L3148); port resolution paths exercised by "uses custom portEnvVar from docker config" (~L3568).                                                                                        |
| **Plugin-backed parity assertion** | Template resolution is preserved end to end: the database plugin's `translate` emits a descriptor whose published port/connection values feed the process plugin's descriptor so the templated command resolves to the same string a built-in bench produces. |
| **Parity test case(s)**            | CP-TC-035 (`BundledDatabasePlugin.translate` produces a valid docker ProvisionDescriptor for all database `roubo.yaml` fields); CP-TC-033 (E2E: the responda bench runs the full plugin-backed lifecycle including the connection template).                  |

### 5. one-time setup (initService / setupComplete)

|                                    |                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Behaviour**                      | one-time setup                                                                                                                                                                                                                                                                                                                                                    |
| **Built-in semantics**             | The host runs a component's setup once (first Start persists `setupComplete: true`, later Starts skip it) and runs a docker `initService` after the health check passes.                                                                                                                                                                                          |
| **Built-in test (evidence)**       | `startComponent` > "runs init service after health check passes" (~L3330) and "does not call composeRunInit when no initService configured" (~L3362); `startAllComponents (Start endpoint setup gating)` > "first Start runs setup, persists setupComplete: true, then launches" (~L5300) and "second Start (after stop) skips setup and only launches" (~L5332). |
| **Plugin-backed parity assertion** | The engine drives the one-time-setup phase through the broker so a process plugin's setup runs exactly once and is skipped on restart, and a database component with no setup/initService starts cleanly (optional fields absent).                                                                                                                                |
| **Parity test case(s)**            | CP-TC-038 (LifecycleEngine runs the process phase machine including one-time setup); CP-TC-052 (a one-time setup that has already run does not re-run on bench restart); CP-TC-051 (a database component with no migration or initService starts correctly, optional fields absent).                                                                              |

### 6. external container assignment

|                                    |                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Behaviour**                      | external container assignment                                                                                                                                                                                                                                    |
| **Built-in semantics**             | The host can assign an externally-running container to a database component, adopting its published port and setting status, and can unassign it.                                                                                                                |
| **Built-in test (evidence)**       | `assignContainer` > "assigns container, sets port, and updates service status" (~L5004), "throws CONTAINER_NOT_FOUND when container ID not in docker list" (~L4972), "throws NO_PORT when container has no published port" (~L4984).                             |
| **Plugin-backed parity assertion** | Assignment goes through the `host.docker.assignContainer` broker method (gated on the `docker` permission) and is recorded in the ResourceOwnershipLedger, so an adopted container is tracked and released across start/stop cycles exactly as a host-owned one. |
| **Parity test case(s)**            | CP-TC-056 (ResourceOwnershipLedger records and clears compose projects and process IDs across start/stop cycles).                                                                                                                                                |

### 7. docker initService + migration

|                                    |                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Behaviour**                      | docker initService and migration                                                                                                                                                                                         |
| **Built-in semantics**             | After the docker service starts, the host runs migrations, splitting a multi-word migration command into executable and args, and runs the configured `initService`.                                                     |
| **Built-in test (evidence)**       | `startComponent` > "runs migrations after docker service starts" (~L3175), "splits multi-word migration command into executable and args" (~L3205), "runs init service after health check passes" (~L3330).              |
| **Plugin-backed parity assertion** | The engine sequences the docker phase machine (compose up, wait healthy, init, migrate) through the broker for a plugin-backed database component, and a missing `composeFile` fails gracefully rather than crashing.    |
| **Parity test case(s)**            | CP-TC-037 (LifecycleEngine runs the docker phase machine through the broker for a database component); CP-TC-047 (Negative: migration fails gracefully when the `composeFile` path is absent from a database component). |

### 8. log capture

|                                    |                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Behaviour**                      | log capture                                                                                                                                        |
| **Built-in semantics**             | The host serves per-component logs via `getComponentLogs`, delegating to the process manager with the correct process id.                          |
| **Built-in test (evidence)**       | `getComponentLogs` > "delegates to processManager.getProcessLogs with correct process id" (~L4221).                                                |
| **Plugin-backed parity assertion** | Logs from plugin-backed database and process components reach the same `GET /components/:name/logs` surface with no loss of fidelity (CP-NFR-004). |
| **Parity test case(s)**            | CP-TC-057 (logs from plugin-backed database and process components are accessible via the existing logs endpoint).                                 |

### 9. live-state reconcile

|                                    |                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Behaviour**                      | live-state reconcile                                                                                                                                                                                                                                                                                         |
| **Built-in semantics**             | The host reconciles component status from live container/process state (`refreshComponentStatuses`): it updates docker status from container status, marks a process stopped when it dies, and does not override stopping/error/provisioning or actively-managed states.                                     |
| **Built-in test (evidence)**       | `refreshComponentStatuses` > "updates docker service status from container status" (~L4235), "updates process service status when process dies" (~L4267), "respects stopping status (does not override to running)" (~L4291); `reconcile` > "uses batched getContainerStatuses for docker services" (~L512). |
| **Plugin-backed parity assertion** | Reconcile reads status pushed by the plugin through the broker (event-driven, not polled) and resolves it against the ResourceOwnershipLedger, so a plugin-backed component's live status tracks the same transitions without adding polling IPC.                                                            |
| **Parity test case(s)**            | CP-TC-037 (the docker phase machine and its reported status through the broker); CP-TC-056 (the ledger records and clears compose projects and process IDs across start/stop cycles).                                                                                                                        |

## Performance and no-polling parity (CP-NFR-002)

CP-NFR-002 requires that plugin indirection adds no meaningful start or supervision overhead and that the reconcile loop adds no polling IPC (status is pushed by event, not polled). These rows have no single built-in behaviour test; the baseline is "today's start time and today's reconcile cost," measured against the dogfood plugins.

| Parity assertion                                                                                                               | Parity test case(s) |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| A plugin-backed database component starts within +500 ms (p95) of the built-in baseline.                                       | CP-TC-043           |
| A plugin-backed process component starts within +500 ms (p95) of the built-in baseline.                                        | CP-TC-044           |
| Plugin start-latency overhead over the built-in component is within +500 ms (p95), measured across roubo and responda benches. | CP-TC-021           |

The no-polling guarantee (status pushed by event) is asserted structurally by the reconcile rows above (CP-TC-037, CP-TC-056) plus the reconcile-overhead assertion folded into the start-latency budget (CP-TC-021): if reconcile reintroduced polling IPC, the supervision overhead would exceed the budget those cases enforce.

## End-to-end parity (smoke and e2e)

These rows assert the whole-bench guarantee that all per-behaviour rows roll up to: a real roubo or responda bench starts, runs, and reconciles identically on plugin-backed components. They are the dogfood acceptance gate for F1.11 (issue #614).

| Parity assertion                                                                                                                   | Parity test case(s) |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Smoke: the responda bench starts entirely on plugin-backed components without error.                                               | CP-TC-032           |
| E2E: the responda bench runs the full plugin-backed lifecycle (database migration + connection template + two process components). | CP-TC-033           |
| E2E: the roubo bench starts identically on plugin-backed components (database + process).                                          | CP-TC-034           |

## Coverage check

Every CP-TC id in the issue's "Verified by" list appears in at least one row above:

CP-TC-021 (perf), CP-TC-032 (smoke), CP-TC-033 (e2e + connection template), CP-TC-034 (e2e), CP-TC-035 (connection template / database translate), CP-TC-036 (env / process translate), CP-TC-037 (docker phase machine / reconcile), CP-TC-038 (process phase machine / one-time setup), CP-TC-039 (dependsOn ordering), CP-TC-043 (perf database), CP-TC-044 (perf process), CP-TC-047 (negative, missing composeFile migration), CP-TC-050 (dependsOn cycle), CP-TC-051 (optional fields absent), CP-TC-052 (setup not re-run on restart), CP-TC-056 (ledger / container assignment / reconcile), CP-TC-057 (logs parity), CP-TC-059 (env / envFile injection), CP-TC-060 (portEnvVar injection).

Every CP-FR-007 behaviour has a row: dependsOn ordering (1), port allocation (2), env/envFile injection (3), connection templating (4), one-time setup (5), external container assignment (6), docker initService and migration (7), log capture (8), live-state reconcile (9).

## Traceability

<!-- product-dev:trace -->

- Implements: CP-FR-007, CP-NFR-002, CP-US-002
- Verified by: CP-TC-021, CP-TC-032, CP-TC-033, CP-TC-034, CP-TC-035, CP-TC-036, CP-TC-037, CP-TC-038, CP-TC-039, CP-TC-043, CP-TC-044, CP-TC-047, CP-TC-050, CP-TC-051, CP-TC-052, CP-TC-056, CP-TC-057, CP-TC-059, CP-TC-060
<!-- /product-dev:trace -->
