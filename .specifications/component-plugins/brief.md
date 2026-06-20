# Brief: Component Plugins

> One-line pitch: Turn Roubo's baked-in bench components (database, process) into a first-class plugin kind, so anyone can add a new component type without forking Roubo core.

## Problem

Roubo builds a running version of an application on a bench out of **components**: a `database` component (docker-compose backed) and a `process` component (runs a command). Today there are exactly two component types and both are hardcoded into core. The type knowledge lives in `bench-manager.ts` (the `launchComponent` / `stopComponent` / `reconcile` / `assignContainer` branches on `componentConfig.docker` / `type === "process"` / `type === "database"`) and in the single `ComponentConfig` Zod schema in `shared/config-schema.ts`. Adding any new component type (a redis cache, a worker queue, a Google Cloud / Clasp deploy target) means editing Roubo core and shipping a new Roubo release. That is a hard ceiling on what a bench can be, and it blocks an ecosystem.

Roubo already started down the plugin road with **integration plugins** (e.g. `github-com`): a `roubo-plugin.yaml` manifest with a `kind` discriminator (currently the literal `"integration"`, designed as an extension point), a `PluginContract` implemented via `definePlugin()`, each plugin running as a separate OS process over JSON-RPC stdio, discovered and supervised by `plugin-manager.ts`. Components are the deliberate **next plugin kind**. The pain is concrete and present: the coupling exists in the codebase today, and the integration-plugin work already proves the pattern that would remove it.

## Target users

- **Primary: consumers (teams).** Developers who assemble a bench by declaring components in `roubo.yaml`, drawing on first-party plus community-authored component plugins. We optimize their experience: a clear config surface, reliable bench behaviour identical to today, legible errors, and confidence that a plugin only does what it declares. They should never have to fork Roubo to get the component type they need.
- **Secondary: plugin authors.** Developers building and publishing a new component type as a plugin (against the `plugin-sdk`). Their ergonomics matter, but v1 is optimized for the consuming team first; authoring is a deliberate close-second.
- **Not the user:** end users of the _applications_ a bench runs. This is tooling for the developers operating Roubo, not for the apps' own users.

## Jobs to be done

- **As a consumer:** stand up a complete running bench (database + backend + frontend, or any mix) from component plugins, including third-party ones, configured entirely in `roubo.yaml`, with the assurance that each plugin is constrained to its declared permissions, and without ever forking Roubo.
- **As an author:** publish a new component type (e.g. redis, a worker, a deploy target) as a self-contained plugin that Roubo can discover, validate, run, and supervise, without a change to Roubo core.
- **As the Roubo team (dogfooding):** prove the abstraction is real by re-implementing the two existing built-in types as first-party plugins, leaving core with zero hardcoded component-type knowledge.

## Current alternatives & their gaps

- **Fork Roubo and edit core** (`bench-manager.ts` dispatch + `config-schema.ts` schema): the only way to add a component type today. Gaps: requires a Roubo source change and release for every new type; no isolation (new code runs with full core privileges); no distribution path; does not compose with other people's component types.
- **Abuse the existing `process` type**: shoe-horn a non-process capability into a shell command. Gaps: loses first-class lifecycle, health, and config; no structured supervision; brittle.
- **Integration-plugin system as-is**: proves the plugin pattern but is bespoke to the integration domain (its `PluginContract` is issue/source/auth-shaped, the manifest `kind` literal is `"integration"` only). It cannot host a component, which must _launch and supervise real processes and containers_, not just answer RPC queries.

## Core capabilities

The spec covers all capabilities below; the **build is phased** (see Out of scope). v1 builds 1, 2, 3, 4, 7 and local install; v2 adds 5; v3 adds 6.

- **1. A `component` plugin kind + lifecycle contract.** Extend the existing plugin system's `kind` discriminator to `"component"`, with a contract covering a component's full lifecycle (provision / start / stop / health / status / logs), the analogue of `PluginContract` for the component domain.
- **2. Dogfood: extract both built-in types into bundled component plugins.** Re-implement `database` and `process` as first-party bundled component plugins so core ends with **zero** hardcoded component-type knowledge (the `bench-manager.ts` type branches are removed in favour of dispatch through the plugin).
- **3. `roubo.yaml` config redesign.** Redesign how a bench's components are declared so each component binds to a plugin (the type-to-plugin binding), with the type-specific fields (docker, migration, connection, env) moving into plugin-owned config. The config shape may change from today's inline `type:` form.
- **4. Permission declaration model for component plugins.** Component plugins declare the resources they touch (network, filesystem, processes, credentials, and likely new categories for spawning containers / binding ports), surfaced to the consumer at install / run, parity in spirit with integration plugins' declared permissions.
- **5. Enforced sandboxing [v2].** Actually constrain a component plugin to its declared permissions so a malicious or buggy plugin cannot exceed them (OS-level isolation / a capability broker; mechanism is an open question).
- **6. Marketplace [v3].** Browse, search, install, and update component (and presumably integration) plugins in-app, backed by a registry.
- **7. Lifecycle-supervision parity.** Plugin-based components must reproduce today's behaviour exactly: `dependsOn` ordering, docker compose (`composeFile` / `service` / `initService` / `portEnvVar`), migration runs, connection-string templating, `env` / `envFile` injection, working `directory`, one-time `setup`, port allocation, external container assignment, log capture, and `reconcile` of live state.
- **8. Design accommodates a future deploy capability.** The architecture must be general enough that a future Google Cloud / Clasp deploy capability can be added as a plugin (a component, or a new kind) **without a redesign**. Not built in this work; used as a design stress-test.

## Out of scope (v1)

- **Enforced sandboxing** — specced now, **built in v2**. v1 ships permission _declaration_ and display only; enforcement is advisory in v1.
- **Marketplace** — specced now, **built in v3**. v1 distribution is local: bundled plugins plus `~/.roubo/plugins`, the existing integration-plugin discovery path, with local install.
- **Google Cloud / Clasp deploy** — **design-for only**, never built in this work. The plugin architecture must not preclude it, and we validate the design against it, but no deploy plugin ships.
- **Backward compatibility of the old config shape** — not a goal. The config shape may change; the two live projects (roubo, responda) will be **migrated** as part of this work rather than kept byte-compatible.

## Constraints

- **Platform/tech:** Node.js >= 24.14.0; monorepo (npm workspaces: `shared/`, `server/`, `client/`); Express 5 server, React 19 + Vite client; macOS-primary development environment. Plugins run as separate OS processes over JSON-RPC (vscode-jsonrpc) stdio, the existing transport.
- **Architecture to follow:** the established integration-plugin system. Reuse / extend, do not reinvent: the `roubo-plugin.yaml` manifest and its `kind` discriminator, `plugin-manager.ts` discovery / validation / spawn / supervision (restart budget, enable state), `HOST_API_VERSION` semver compatibility, the `plugin-sdk` `definePlugin()` contract pattern, the `HostClient` (`host.fetch` / `host.credentials` / `host.logger`), and the permissions model.
- **Config:** redesign is permitted (no byte-for-byte back-compat), but roubo and responda are the dogfood migration targets and must run identically on the new plugin-based components.
- **Feature parity (hard):** every existing component feature listed in capability 7 must survive the port. A regression in bench behaviour is a failure.
- **Phasing (hard):** spec all three phases now; build v1 first, then v2 (sandboxing), then v3 (marketplace). Each phase must be independently shippable.

## Differentiation

Roubo's wedge is not "a plugin system" in the abstract; it is a plugin system for the **whole bench lifecycle**, where a third party can contribute a component type that _launches and supervises real processes and containers_ and have it compose safely with everyone else's. The integration-plugin work proved the host/plugin seam; extending it to components, with declared-then-enforced permissions, is what turns Roubo from a fixed two-type tool into an extensible platform.

## Success definition

All four indicators matter; they land across the phases:

- **Dogfood parity, no regressions (v1):** roubo and responda run entirely on plugin-based components, core carries zero hardcoded component types, and every bench behaves identically to today. This is the proof the abstraction is real.
- **Third-party plugins exist (v1/v2):** real external / community component plugins (e.g. redis, a worker queue, a Clasp deploy) get authored and installed without anyone forking Roubo core.
- **Marketplace activity (v3):** plugins are discovered and installed through the marketplace, measured by installs / active plugins per project.
- **Safe by default (v2):** a malicious or buggy component plugin cannot exceed its declared permissions; sandboxing demonstrably contains it.

## Open questions & risks

- [ ] **Runtime/lifecycle ownership (central tension, deferred to architecture).** Component plugins must launch and supervise real processes and containers, unlike integration plugins which only answer RPC queries. Does the **host** keep owning the process-manager / docker services while the plugin only _describes and dispatches_ what to spawn and how to health-check (maximal reuse of the current transport), or does the **plugin** own its children's lifecycle directly (more power, larger trust surface)? Architecture must explore both.
- [ ] **Sandboxing mechanism on macOS/Node (v2).** How to actually enforce declared permissions for a process-spawning plugin on a macOS-primary, Node runtime: OS sandbox (`sandbox-exec`, containers, namespaces) vs a capability broker where the host is the sole privileged actor. Genuinely hard; feasibility risk.
- [ ] **Marketplace infrastructure & trust (v3).** Registry/backend hosting, plugin signing, update channels, versioning, and curation/trust model. Where is it hosted and who curates?
- [ ] **Config-schema binding shape.** Exactly how a component declares its plugin and passes plugin-owned config (a per-component `plugin:` reference plus an opaque, plugin-validated config block?), and how today's type-specific fields (docker / migration / connection) relocate into plugin-owned schemas while keeping the consumer config legible.
- [ ] **Permission-category adequacy.** Integration plugins declare network / credentials / filesystem / processes. Component plugins that spawn containers and bind ports likely need new categories (docker/compose access, port binding, child-process spawn allow-lists). What is the full set?
- [ ] **Deploy fit (design stress-test).** Will the component lifecycle (start / stop / health) actually stretch to a deploy capability (push code to Google Cloud via Clasp, a fundamentally different lifecycle than "run a long-lived process"), or does deploy need its own plugin kind? The answer shapes whether the `kind` boundary or the component contract is the extension point for capability 8.
- [ ] **Versioning & coexistence.** The component-plugin API version vs `HOST_API_VERSION`, and how `kind: "component"` coexists with `kind: "integration"` in one `plugin-manager` without special-casing.

## Source notes

- Raw input: "Currently, components (e.g. database, process) are baked into the Roubo product; we want to turn them into plugins. We started on the plugin journey with integration plugins, and this is the next step. Components are used to create a running version of the software application using the code in the current bench (e.g. a database, backend, and frontend component could define a web app). One goal to keep in mind during design (not necessarily implemented as part of this work): supporting deploying code to Google Cloud using Google Clasp." Reference configs: `roubo/.roubo/roubo.yaml`, `intentional/responda/.roubo/roubo.yaml`.
- Interview changelog (2026-06-20):
  - Primary driver = **third-party extensibility** (over internal decoupling or simply unblocking new capabilities).
  - Built-in types = **dogfood, extract both** database and process; core ends type-agnostic.
  - Deploy (Clasp/Google Cloud) = **design-for, not built**.
  - Runtime model = **deferred to architecture** (logged as the central risk).
  - Primary user = **consumers (teams)**; authors secondary.
  - Distribution / sandboxing / config = the user initially chose full marketplace, enforced sandboxing, and a free config redesign; on surfacing the v1-size tension, this resolved to **explicit phases**: v1 = contract + dogfood + local install + permission declaration; **v2 = sandboxing**; **v3 = marketplace**; with the **whole scope specced now** and built in sequence.
  - Success = **all four** indicators (dogfood parity, third-party exists, marketplace activity, safe-by-default), mapped across the phases.
