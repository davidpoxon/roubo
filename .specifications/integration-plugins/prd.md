# PRD: Integration plugins (extensible plugin system, first use case: issue-source integrations)

> Slug: `integration-plugins` · Last updated: 2026-05-21

## Problem

Roubo today only knows how to pull issues from GitHub.com via the Roubo OAuth app. That cuts the tool off from the largest cohort of enterprise developers who would otherwise adopt it: people whose company runs GitHub Enterprise on-prem, or whose product team tracks work in self-hosted Jira. We lose those users at evaluation; the ones who push through end up mirroring tickets into a personal GitHub repo or creating benches without an attached issue, which breaks the workflows Roubo is good at (blocks/blocked-by enforcement, jig-by-issue-type, PR sync). The fix is not to bolt on a second hardcoded integration. We need an extensible plugin system so users can install official or community integrations without waiting for Roubo to ship them. The first shipment of that system delivers a runtime, three bundled integration plugins (GitHub.com, GitHub Enterprise, self-hosted Jira), and a documented SDK so power users can write their own. The runtime is designed intentionally so the planned AI-agent and project-component plugin slugs can be hosted later without a host-API major-version bump.

## In scope

- Plugin runtime: child Node process per plugin instance supervised by the host, JSON-RPC over stdio transport.
- A `roubo-plugin.yaml` manifest format with a zod schema in `shared/` and a JSON Schema artifact for IDE tooling.
- A host-enforced permission model with four categories: network host allowlist, credential slot names + scopes, filesystem access beyond the plugin's own directory, and child-process spawning.
- An OS-keyring-backed credential store accessed by plugins only via a host-provided helper. Implementation shells out to platform CLIs (`security` on macOS, `secret-tool` on Linux, PowerShell on Windows) to honour the no-native-modules constraint.
- A host-provided HTTP client (`host.fetch`) that performs the actual network I/O. Plugins cannot bring their own. The client enforces the manifest network allowlist, respects system proxy environment variables, supports an optional per-plugin self-signed-TLS toggle, and surfaces raw response headers (notably `ETag`, `Retry-After`, rate-limit headers) to the plugin so caching and backoff are implementable inside the plugin.
- A `Plugins` settings page (new top-level entry) listing installed plugins with status, configure, enable, disable, install, and uninstall actions.
- An "Issue source" tile on each project detail page where the project owner picks the active integration plugin and configures its sources for that project.
- A declarative source picker. Plugins return a shape (`multi-list` for GitHub.com / GHE, `categorized-multi-list` for Jira). Roubo core renders. No plugin React.
- Three bundled integration plugins:
  - **GitHub.com**: keep the Roubo OAuth app and the `roubo://oauth/github/callback` deep link.
  - **GitHub Enterprise**: PAT + instance URL.
  - **Self-hosted Jira (Data Center 8.14+)**: PAT only.
- Read-only pull (`listSourceCandidates`, `listIssues`, `getIssue`, `getAvailableTransitions`) plus a narrow set of write-back operations: `applyTransition` (status transition) and `assignIssue` / `unassignIssue`. Plus `getCurrentUser` (called once at integration-config time so Roubo captures the user's external identity for write-back) and `validateConfig` (called by the Test connection button).
- A normalized issue contract: `integrationId`, `externalId` (string), `externalUrl`, `title`, `body`, `currentState` (string), `allowedTransitions` (string array), `assignees`, `labels`, `issueType`, `blocks` (externalId array), `blockedBy` (externalId array), `updatedAt`, opaque plugin-scoped `raw`. Sprint, fixVersion, custom fields, attachments, comments, epics, parents, and subtasks are deferred.
- Soft enforcement of blocks/blocked-by: a banner is shown when an issue's blockers are still open, but bench creation is NOT refused. Deliberate relaxation of today's hard-block behaviour.
- Polling: on-demand and on UI events. No background timer.
- Paginated `listIssues`. Default page size 50; plugin exposes page size as a config setting. The UI pages through results.
- Automatic, atomic, all-or-nothing migration of existing GitHub.com projects on first launch of a Roubo build with the plugin runtime. Migration writes the user's selected sources to a per-user override file (not the committed `roubo.yaml`), moves the OAuth token from `auth.json` into the bundled github.com plugin's keyring slot, bumps `state.json` `schemaVersion` as the commit point, then deletes `auth.json`. Idempotent on re-run. One-time banner explains the change.
- Per-project, per-user integration override file (new) layered on top of the committed `roubo.yaml` `integration` block. Effective config = deep-merge per field, with **arrays replaced, not concatenated**.
- Bench-issue snapshot fields `integrationId` and `externalId` so active benches survive when a project switches integrations. Pre-migration benches default to `integrationId: "github-com"` and `externalId` derived from the legacy numeric `number`.
- Plugin SDK package (`@roubo/plugin-sdk`) that plugin authors import for RPC binding and host helpers. Versioned alongside `hostApiVersion`. Published with author docs.
- A `Test connection` button on the per-project configure flow that calls `plugin.validateConfig(config)` and surfaces success or error inline before the user saves.
- Plugin auto-restart on unexpected exit, up to 3 attempts within any 5-minute window per plugin. Beyond that, the plugin is marked `errored` and the last-good issue snapshot continues to be served.
- Forward-compat verification: a one-page paper sketch of what AI-agent and project-component plugin manifests + method sets would look like, reviewed before `hostApiVersion` 1.0.0 freeze.
- Per-plugin observability: stdout / stderr written to `~/.roubo/plugins/<plugin-id>/logs/` with size-based rotation. An in-app log surface on the Plugins page lets the user view recent log content without leaving Roubo.

## Out of scope

- AI coding agent plugins (Claude Code, Codex, Gemini CLI stay built-in). Explicit follow-on slug.
- Project-component plugins (database, process components stay built-in). Explicit follow-on slug.
- In-app plugin marketplace or curated discovery. Discovery is via docs, blog posts, word of mouth.
- Plugin signing or Roubo-issued trust roots. Trust roots in user-accepted permissions plus the Git URL or local path the user chose.
- Webhook or push-based updates. Polling only.
- Plugin-supplied React UI. Declarative shapes only.
- Jira Cloud as a validated target. Slug targets self-hosted / Data Center; Cloud may incidentally work but is not validated.
- Cross-plugin issue dedup. A Roubo project has exactly one active integration; we never dedup across plugins.
- Issue fields beyond the narrow normalized set above.
- Write-back beyond status transitions and assign / unassign. No commenting on issues from Roubo. No PR-to-issue link-back (GitHub does this natively; Jira does not, and we are not adding it this slug).
- Hierarchical issue links: epics, parents, subtasks are deferred.
- A Roubo-hosted OAuth callback for arbitrary GHE or Jira instances.
- A tarball / zip plugin install format.
- An exact-version or semver-range version pin in `roubo.yaml`. The user's locally installed plugin version is what runs.
- Meta-repo PR sync against non-GitHub integrations. Jira projects do not get PR-driven auto-clear in this slug.
- A documented end-to-end `listIssues` time budget. Replaced by paginated retrieval.

## User stories

### US-001 — GHE developer connects their corporate instance

As a developer at a company using GitHub Enterprise, I want to install Roubo, pick the bundled GHE plugin, paste my instance URL and PAT, select the repos and Projects I care about, and start using benches, so that I do not have to wait for official Roubo support or mirror issues into a personal account.

### US-002 — Jira developer connects their self-hosted instance

As a developer at a company using self-hosted Jira (Data Center 8.14+), I want to pick the bundled Jira plugin, paste my instance URL and PAT, choose one or more boards, epics, or filters, and have my tickets show up in Roubo with blocks / blocked-by honoured, so that the Roubo bench workflow works with my team's system of record.

### US-003 — Existing GitHub.com user is migrated invisibly

As an existing Roubo user with projects pointed at a GitHub.com Project, I want my projects to keep working without re-authenticating, re-selecting sources, or losing assignment state, so that the introduction of plugins is not an upgrade penalty.

### US-004 — Power user writes a custom integration plugin

As a developer who wants to use Roubo against an issue tracker we do not officially support (for example Linear or an in-house tool), I want to write a plugin against a documented SDK, drop it in `~/.roubo/plugins/`, configure it, and use it like a bundled plugin, so that I am not blocked by Roubo's roadmap.

### US-005 — Teammate clones a repo that uses an integration plugin they do not have installed

As a teammate cloning a project whose `roubo.yaml` declares a plugin I do not have installed, I want Roubo to prompt me to install the plugin (with the permissions dialog), so that I can get to a working state in one click rather than reading docs to figure out what I need.

### US-006 — Project owner switches integrations without losing active work

As a project owner with running benches, I want to switch my project's integration without my active benches breaking, so that I can migrate at my own pace. Active benches keep their stored issue snapshot, show an `Issue from previous integration` badge, and disable source-sync; new benches use the new integration.

### US-007 — User installs a third-party plugin from a Git URL

As a Roubo user, I want to install a third-party integration plugin by pasting a Git URL (or pointing at a local directory), review the permissions it requests, and confirm install, so that I have an explicit moment to decide whether I trust the plugin before it gets credentials or network access.

### US-008 — User transitions an issue from Roubo

As a user working in a bench, I want a "Transition to" control that shows only the next states the source workflow actually allows from the issue's current state, so that I can move tickets through Jira's or GitHub's workflow without leaving Roubo and without being shown invalid transitions.

### US-009 — User gets clear status when a plugin fails

As a Roubo user, I want a clear in-app indication when a plugin has crashed or is failing repeatedly, including a last-good issue snapshot served in the meantime and an in-app surface to view recent plugin logs, so that a flaky integration does not make Roubo itself feel broken.

### US-010 — User configures sources independently of the team's committed defaults

As a developer on a large multi-team monorepo, I want to pick the boards / epics / filters I personally care about, so that I see my team's slice of issues even when the committed `roubo.yaml` has no `integration` block (or has only the plugin choice). My override does not affect teammates.

## Functional requirements

### FR-001 — Plugin manifest format and loader

The system MUST recognise plugin directories that contain a top-level `roubo-plugin.yaml` manifest. The loader MUST parse the manifest, validate it against a zod schema in `shared/`, and reject plugins with missing or invalid required fields. Invalid plugins MUST NOT be auto-loaded; the error MUST be surfaced on the Plugins page with the offending field and reason.

### FR-002 — Plugin discovery locations

The system MUST discover plugins in exactly two locations: a bundled `plugins/` directory shipped inside the Roubo app (for first-party plugins), and `~/.roubo/plugins/<plugin-id>/` (for user-installed plugins). It MUST NOT scan any other location for plugins.

### FR-003 — Plugin process isolation

Each enabled plugin instance MUST run in its own Node child process supervised by the host. Plugins MUST NOT execute inside the Roubo server process. A plugin crash MUST NOT crash the Roubo host or any other plugin.

### FR-004 — JSON-RPC over stdio transport

The host MUST communicate with each plugin process over a JSON-RPC channel framed over stdio. The host owns the framing implementation. Plugins MUST NOT implement their own RPC; the SDK provides the binding.

### FR-005 — `hostApiVersion` semver compatibility

Each plugin manifest MUST declare a compatible Roubo host API range in its `roubo` field (semver). The host MUST refuse to enable plugins whose declared range does not satisfy the current `hostApiVersion`, and MUST surface this on the Plugins page as `incompatible`. The host ships `hostApiVersion` 1.0.0 in this slug. Subsequent 1.x bumps MUST stay backwards compatible. A host-API major bump MUST be deferred until the AI-agent and project-component plugin slugs have validated the design.

### FR-006 — Manifest-declared permission model (four categories)

Plugin manifests MUST declare every permission they require across four categories: (a) network host allowlist (glob patterns), (b) credential slot names and scopes, (c) filesystem paths beyond the plugin's own directory, (d) child-process spawning. The host MUST enforce these permissions at runtime; plugins MUST have no other way to reach network, credentials, filesystem outside their directory, or child processes.

### FR-007 — Install-time permission acknowledgement (third-party)

Installing a third-party plugin (Git URL or local directory) MUST present the user with a permissions dialog listing every permission the manifest requests, plus the source (Git URL or absolute local path). The plugin MUST NOT be enabled until the user accepts. The dialog MUST be keyboard-operable and follow Roubo accessibility conventions.

### FR-008 — Host-provided HTTP client (`host.fetch`)

Plugins MUST perform all HTTP requests via a host-provided `host.fetch(url, init)` helper. The host process performs the actual network I/O. The helper MUST enforce the plugin's manifest `network.hosts` allowlist, respect system proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`), apply per-plugin self-signed-TLS opt-in when set, and surface raw response headers (notably `ETag`, `Retry-After`, and rate-limit headers) to the plugin so plugin-internal caching and backoff remain implementable.

### FR-009 — Self-signed TLS opt-in is per-plugin

Allowing self-signed TLS MUST be a per-plugin-instance toggle, default off. Enabling it MUST show a warning that explains the risk. The toggle's enabled state MUST be visible on the plugin's configure page whenever it is enabled.

### FR-010 — OS-keyring credential storage via pure-JS shellout

Plugin credentials MUST be stored in the OS keyring via a host-provided `credentials.get(slot)` / `credentials.set(slot, value)` helper. The host MUST implement the helper without native modules, by shelling out to platform CLIs (`security` on macOS, `secret-tool` on Linux, PowerShell wrapping Windows Credential Manager on Windows). Credentials MUST NOT be written to disk in plaintext by the host or by any bundled plugin. The legacy `~/.roubo/auth.json` plaintext token store MUST be migrated and deleted as part of FR-027.

### FR-011 — Plugin lifecycle: enable, disable

Plugins MUST be enable-able and disable-able from the Plugins page without restarting the Roubo host. Disabling a plugin MUST gracefully terminate its child process; re-enabling MUST start a fresh process. Existing benches that depend on a now-disabled plugin MUST continue to display their last-good issue snapshot.

### FR-012 — Per-call RPC timeout

Every RPC call from host to plugin MUST be bounded by a per-call timeout (default 30 seconds, overridable per method on the plugin contract). On timeout, the host MUST cancel the call without orphaning the child process and surface the timeout as a structured error to the caller.

### FR-013 — Auto-restart with bounded budget

A plugin that exits unexpectedly MUST be auto-restarted by the host with exponential backoff, up to a maximum of 3 restarts in any 5-minute rolling window per plugin. After exceeding the budget, the plugin MUST be marked `errored` on the Plugins page until the user manually restarts or fixes its configuration.

### FR-014 — Last-good snapshot served while plugin is errored

While a plugin is in `errored` or `disabled` state, the host MUST continue to serve the last successful issue snapshot to UI consumers and surface an in-app banner indicating that the data is stale.

### FR-015 — Per-plugin log files + in-app log surface

The host MUST write each plugin's stdout and stderr to `~/.roubo/plugins/<plugin-id>/logs/`. Log files MUST be rotated by size (one rotation: `current.log` and `previous.log`). The Plugins page MUST include a per-plugin "View logs" surface that displays recent log content without requiring the user to open files outside Roubo.

### FR-016 — Plugins page actions

A new top-level Plugins settings page MUST list installed plugins with status (`enabled`, `disabled`, `errored`, `incompatible`) and provide actions: install (Git URL or local directory), configure, enable, disable, view logs, uninstall (third-party only). Bundled plugins MUST NOT be uninstallable through the UI.

### FR-017 — Third-party install: Git URL and local directory

The system MUST support installing third-party plugins by Git clone URL or by pointing at a local directory path. For Git URLs, the host MUST shell out to `git clone` into `~/.roubo/plugins/<plugin-id>/`. For local directories, the host MUST validate the directory contains a `roubo-plugin.yaml`. In both cases, the host MUST validate the manifest and surface failures (invalid manifest, clone failure, incompatible host range) clearly without leaving partial state.

### FR-018 — Single active integration per project

A Roubo project MUST have exactly one active integration as its issue source at any time. The choice MUST be expressible in the project's `roubo.yaml` `integration.plugin` field, in the per-user override `integration.plugin` field, or both (the override wins). Switching plugins MUST require user confirmation.

### FR-019 — Declarative source picker shapes

Integration plugins MUST return a source picker shape from `listSourceCandidates`. The host MUST render the picker based on the shape; plugins MUST NOT supply React components. Two shapes ship in this slug: `multi-list` (used by GitHub.com and GHE for combined repo + project selection) and `categorized-multi-list` (used by Jira for boards, epics, and filters with category tabs).

### FR-020 — Cross-source dedup within one integration

When a single integration's selected sources surface the same issue (e.g. a GitHub issue appearing in both a selected Project and a selected repo, or a Jira ticket matching multiple selected filters), Roubo MUST display the issue once. The dedup key is `(integrationId, externalId)`.

### FR-021 — Normalized issue contract

The system MUST normalise issues from every integration into the shape consumed by Roubo core: `integrationId`, `externalId`, `externalUrl`, `title`, `body`, `currentState`, `allowedTransitions`, `assignees`, `labels`, `issueType`, `blocks`, `blockedBy`, `updatedAt`, opaque `raw`. The contract MUST NOT include sprint, fixVersion, custom fields, attachments, comments, or hierarchical links in this slug.

### FR-022 — Paginated `listIssues`

`listIssues` MUST be paginated. The plugin's manifest configuration schema MUST expose a `pageSize` setting with a default of 50. The host MUST pass the user's chosen `pageSize` and a `cursor` to each call; the plugin MUST return `{ items: NormalizedIssue[], nextCursor: string | null }`. The client UI MUST page through results using React Query's `useInfiniteQuery` (or equivalent), and MUST NOT block on any single page.

### FR-023 — `roubo.yaml` integration block + per-user override

The `roubo.yaml` schema MUST gain a new optional top-level `integration` block. Every field inside the block (`plugin`, `instance`, `sources`, ...) MUST be independently optional. Roubo MUST also read a per-user, per-project override file in `~/.roubo/` (location to be finalised in architecture). The effective integration config MUST be computed by deep-merging the committed `roubo.yaml` integration block with the user override per field. Array-typed fields (e.g. `sources.boards`, `sources.repos`) MUST be **replaced** by the override, not concatenated. Existing `roubo.yaml` files without an `integration` block MUST continue to validate and load.

### FR-024 — Missing-plugin prompt on project load

When a teammate loads a project whose effective integration config references a plugin id not installed locally, Roubo MUST present a one-click install prompt with the plugin id, the install source (if the source can be derived from project-local hints, e.g. a sibling `roubo.lock` or a previous successful install on another teammate's machine; otherwise the user pastes a Git URL or local path), and the permissions dialog from FR-007. The project MUST become usable in one click + acceptance.

### FR-025 — Jira `blocks` / `is blocked by` mapping

The Jira plugin MUST map the Jira link types `blocks` and `is blocked by` (or user-configurable equivalents on renamed Jira instances) to the normalized `blocks` and `blockedBy` arrays. Other Jira link types MUST be ignored. Link-type names MUST be plugin-configurable per project via the plugin's configure dialog.

### FR-026 — Jira incremental polling via JQL

The Jira plugin MUST use a JQL `updated >=` filter for incremental polls keyed off a per-source last-poll timestamp, so as to avoid full re-fetches on every poll. The plugin MUST persist the last-poll timestamp per source in its own plugin-scoped state.

### FR-027 — Migration of existing GitHub.com projects

On first launch of a Roubo version that includes the plugin runtime, the host MUST migrate every existing project that has a configured GitHub.com source. Migration MUST: (1) enable the bundled github.com plugin, (2) move the OAuth token from `~/.roubo/auth.json` into the github.com plugin's credential slot in the OS keyring, (3) write the existing GitHub Project as a selected source to the user's per-project override (NOT to `roubo.yaml`), (4) bump the `state.json` `schemaVersion` as the single commit point, (5) delete the legacy `auth.json` AFTER the `schemaVersion` bump, (6) be idempotent on re-run. All file writes MUST use the existing `atomicWrite` primitive. A one-time banner MUST explain the change after migration completes successfully.

### FR-028 — Bench-issue snapshot carries `integrationId`

The bench-issue snapshot persisted to state MUST carry `integrationId` and `externalId` (string). Pre-migration benches without these fields default to `integrationId: "github-com"` and `externalId` derived from the legacy numeric `number`. Active benches MUST keep working after a project switches integrations; their UI MUST show an `Issue from previous integration` badge and source-sync MUST be disabled for them.

### FR-029 — Issue type mappings continue to function

The existing `/issue-type-mappings` endpoints MUST continue to operate. The source of `issueType` strings MUST be the active integration plugin's `listIssueTypes` (or whatever value flows through `getIssue`), not a hardcoded GitHub call. The mappings persistence shape MUST remain `Record<string, string>` (issueType → jigId).

### FR-030 — Soft blocks/blocked-by enforcement

When a user attempts to create a bench for an issue that has open blockers (per the normalized `blockedBy` array), Roubo MUST display a banner naming the open blocker(s) but MUST allow bench creation to proceed. This is a deliberate change from current behaviour, which hard-blocks at `server/services/issue-assignment.ts:102`. The PRD-aligned implementation MUST update the corresponding UI counterpart at `client/src/components/IssuePickerModal.tsx:91` in lockstep.

### FR-031 — Plugin SDK package

The system MUST ship a plugin SDK module (proposed `@roubo/plugin-sdk`) that plugin authors import to register their plugin and call host helpers (`host.fetch`, `host.credentials.get`, `host.logger`, etc.). The SDK MUST encapsulate the RPC binding so plugin code does not deal with stdio framing or message ids. The SDK MUST be published with author documentation.

### FR-032 — Manifest JSON Schema artifact for IDEs

The system MUST publish a JSON Schema artifact under `schema/roubo-plugin.schema.json` that mirrors the runtime zod schema, for IDE tooling and editor validation of `roubo-plugin.yaml` files.

### FR-033 — Plugin failure to load does not block host startup

Roubo MUST start successfully even if zero plugins load. A plugin that fails to load (invalid manifest, incompatible host range, clone integrity error, missing entry point) MUST NOT prevent any other plugin or the host itself from initialising. Failures MUST be surfaced on the Plugins page.

### FR-034 — Test connection button (`validateConfig`)

The per-project configure flow MUST include a `Test connection` button that calls `plugin.validateConfig(config)` and surfaces the result inline (success message including the resolved external identity from `getCurrentUser`, or a structured error including the failing condition) before the user saves the config. The button MUST be operable from the keyboard.

### FR-035 — Identity capture at config time (`getCurrentUser`)

On successful `validateConfig`, the host MUST call `plugin.getCurrentUser(config)` once, capture the returned external user id, and persist it per project. All subsequent `assignIssue` operations targeting "me" MUST use the captured identity. The plugin contract MUST expose `getCurrentUser` as a required method for plugins that declare any write-back capability.

### FR-036 — Status transitions via user-selected `allowedTransitions`

Roubo MUST surface a "Transition to" control in each bench's issue view, populated from the issue's `allowedTransitions` array. The control MUST list only the next states the source workflow allows from the issue's current state. On selection, Roubo MUST call `plugin.applyTransition(externalId, transitionName)`. Roubo MUST NOT auto-fire transitions on bench lifecycle events (creation, start, clear, PR merge).

### FR-037 — Assign / unassign via captured identity

Roubo MUST expose an in-bench "Assign to me" / "Unassign" control that calls `plugin.assignIssue(externalId, capturedUserId)` or `plugin.unassignIssue(externalId)`. The control MUST surface a structured error (e.g. "Your token lacks transition permission on this workflow") from the plugin without disabling other Roubo functionality.

### FR-038 — Forward-compat paper sketch

Before `hostApiVersion` 1.0.0 is frozen, the engineering team MUST produce and review a one-page sketch of what AI-agent and project-component plugin manifests + method sets would look like, to verify the runtime can host them without a major-version bump. The sketch lives in `.specifications/integration-plugins/` and is referenced from the architecture doc.

### FR-039 — GitHub.com plugin behavioural parity

The bundled GitHub.com plugin MUST preserve the behaviours of the existing implementation: ETag / If-None-Match short-circuiting, primary and secondary rate-limit backoff (including `Retry-After` handling), 30-second TTL caches, GraphQL batching for blocking relationships, GitHub Projects v2 pagination, issue-type fetch, and the existing OAuth deep-link callback at `roubo://oauth/github/callback`. The `githubRequest` helper currently at `server/services/github.ts:255` MUST be preserved verbatim inside the plugin (re-derivation is a documented risk).

## Non-functional requirements

### NFR-001 — Manifest-permissions enforcement

Category: security
The host MUST enforce manifest-declared permissions at runtime across all four categories (network hosts, credential slots, filesystem, child-process spawning). A plugin that attempts an out-of-scope operation MUST be denied with an error, and the denial MUST be logged to the plugin's log file. No code path in the host MUST short-circuit these checks.

### NFR-002 — Credentials never on disk in plaintext

Category: security
All plugin credentials MUST live in the OS keyring. Neither host code nor any bundled plugin MUST write credential material to any file under `~/.roubo/` or the bundled `plugins/` tree in plaintext. The legacy `~/.roubo/auth.json` plaintext token store MUST be removed by the migration in FR-027.

### NFR-003 — Third-party install consent

Category: security
Third-party plugin install MUST present an explicit permissions dialog with the install source (Git URL or absolute local path) and the full requested-permissions list. Install MUST NOT proceed without user acceptance.

### NFR-004 — Plugin-scoped opaque `raw`

Category: security
The opaque `raw` field on normalized issues is plugin-scoped and ephemeral by default. Plugins MUST NOT include personally identifying information in `raw` unless functionally required. Roubo MUST NOT persist `raw` to `~/.roubo/state.json` beyond the active bench's `assignedIssue`. The field's continued value will be re-evaluated in a follow-on slug.

### NFR-005 — Paginated retrieval as the performance model

Category: performance
`listIssues` MUST be paginated with default page size 50, plugin-configurable. The UI MUST never block on plugin RPC: page fetches MUST run asynchronously via React Query (`useInfiniteQuery` or equivalent) and MUST present a loading state per page. There is no documented end-to-end "fetch everything" time budget in this slug; the paginated UI is the user-facing performance contract.

### NFR-006 — `host.fetch` cache-header pass-through

Category: performance
The host-provided HTTP client MUST surface raw response headers (notably `ETag`, `Retry-After`, and standard rate-limit headers) to the plugin so plugin-internal caching and backoff remain implementable across the JSON-RPC boundary. Without this, the GitHub.com plugin's existing ETag store and rate-limit backoff become unusable inside the plugin process.

### NFR-007 — Plugins UI accessibility

Category: accessibility
The Plugins settings page, configure dialogs, per-project Issue source tile, source picker, install permissions dialog, and Test connection feedback MUST follow Roubo accessibility conventions: React Aria Components, keyboard navigation through every action, focus management on dialog open and close, visible focus rings, screen-reader-friendly labels. The permissions dialog at install time MUST meet the same bar.

### NFR-008 — Plugin failure isolation and bounded restart

Category: reliability
A plugin crash MUST NOT terminate the Roubo host process or any other plugin. The supervisor MUST auto-restart up to 3 times within any 5-minute rolling window per plugin (FR-013) and serve the last successful snapshot per FR-014. A faulty plugin MUST NOT cause data loss in `~/.roubo/state.json` or `~/.roubo/projects.json`. Plugin processes MUST be torn down as part of the existing host shutdown sequence; no zombie processes outliving the host.

### NFR-009 — Migration safety

Category: reliability
The first-launch migration of existing GitHub.com projects MUST write all touched files atomically via `atomicWrite`. The `state.json` `schemaVersion` bump MUST be the single commit point; the legacy `auth.json` MUST be deleted AFTER the bump (not before). On any failure prior to the bump, the migration MUST roll back to pre-migration state. Re-running migration on an already-migrated `~/.roubo` MUST be a no-op. An integration test MUST boot Roubo on a fixture pre-plugin `~/.roubo` and assert the post-boot shape; the test MUST run in CI.

### NFR-010 — Per-plugin observability

Category: observability
The host MUST write per-plugin stdout and stderr to a dedicated log directory per FR-015 with size-based rotation. Plugin errors surfaced to the user MUST include a stable identifier (plugin id, method name) so the user can correlate banner text with log file content. The in-app log viewer MUST show timestamps and the last N (e.g. 500) lines per plugin.

### NFR-011 — Forward compatibility with future plugin kinds

Category: scalability
The host runtime, manifest schema, permission vocabulary, and SDK API surface MUST be designed so the planned AI-agent and project-component plugin kinds can be hosted in their respective follow-on slugs without a host-API major-version bump. The one-page paper sketch in FR-038 is the verification gate.

## Leading indicators of success

- The project owner uses the bundled GHE plugin against a real GHE instance and the bundled Jira plugin against a real self-hosted Jira instance, end-to-end, for at least two weeks before public release, with zero crashes of the Roubo host attributable to plugin failure.
- Migration of existing GitHub.com projects produces zero user-visible errors across the alpha cohort and zero `auth.json` rollbacks.
- Spike A (OS keyring across macOS / Ubuntu desktop / Ubuntu headless / Windows 11) and Spike B (`host.fetch` cache-header surfacing + `githubRequest` rewrite fidelity) each pass before `hostApiVersion` 1.0.0 freeze.

## Lagging indicators of success

- Zero P0 security incidents tied to plugin permissions in the first 6 months post-release.
- Integration-config support volume stays under 10% of total support load through the first 6 months.

_(Adoption percentage of non-GitHub.com integrations and community-built plugin count were considered as lagging indicators during the interview and explicitly were not selected as gates. They remain interesting to measure post-telemetry but do not define release success.)_

## Addendum - 2026-05-24: Security & quality issues option

> Triggered by a 2026-05-24 re-interview. Adds a per-source option on the bundled GitHub.com and GitHub Enterprise plugins to also pull GitHub "Security & quality" alerts (Code Scanning, Secret Scanning, Dependabot) alongside regular Issues. Layered on the runtime defined above. Re-interview Q&A is in `qa-log.md` under `## Re-interview - 2026-05-24`. Feasibility addendum is in `feasibility.md` under `## Addendum - 2026-05-24`.

### Addendum scope (delta to In scope)

- Three independent per-source booleans on the bundled github.com plugin (and the bundled GHE plugin) for Code Scanning, Secret Scanning, and Dependabot. Default off.
- Alerts merged into the existing `listIssues` return, distinguished by `issueType` values `security-code-scanning`, `security-secret-scanning`, `security-dependabot`. Alert-specific metadata (severity, CVE, package, advisory URL, file path) lives in the opaque `raw` field; the secret value and code snippet are redacted before populating `raw`.
- External-id namespacing prevents collisions with regular Issues that share an alert number.
- A new shared workspace package `plugins/_shared-github/` carrying the three alert fetchers + a scope detector reused by github.com and GHE.
- `security_events` added to the Roubo GitHub OAuth app's scope set; existing tokens stay valid for regular Issues; re-consent triggered only when a category is first enabled on a source.
- Per-category graceful skip with a warning chip on the source row in the Configure dialog when the category is unavailable (missing scope, GHAS disabled, Dependabot off, etc.). The chip is itself the action surface for the OAuth re-consent flow.
- `Test connection` extended to probe each enabled alert endpoint with `per_page=1` and surface a per-category status alongside the existing connection result.
- Bench creation parity with regular Issues for alerts: blueprint-by-issue-type matches the three new issue types; blocks/blocked-by stays empty; bench snapshot is frozen at create-time (toggling the source category off later does NOT mutate or clear existing benches).
- Alerts are read-only with respect to write-back: `allowedTransitions: []`, `assignees: []`, Transition dropdown hidden, Assign disabled.

### Addendum out-of-scope (delta to Out of scope)

- Jira self-hosted plugin parity (Jira has no equivalent surface).
- Writing back to alerts from Roubo: dismiss, resolve, re-open. Explicit follow-on slug if there is pull.
- Webhook / push delivery of new alerts. Polling-only, same as the rest of the plugin runtime.
- Auto-creating benches when a high-severity alert fires. Bench creation stays user-initiated.
- Severity / state / age filter UI in the Configure dialog. Booleans only this slug.
- Promoting alert-specific fields (severity, CVE, package) to first-class normalized issue contract fields. Stays in `raw`.
- Pre-emptive API rate-limit headroom display in the Configure UI.
- Sorting or grouping the merged Issues list by alert-specific fields beyond the existing list capability.

### Addendum user stories

#### US-011 - User enables Security & quality alerts on a github.com source

As a developer using the bundled github.com plugin, I want to opt my source into pulling Code Scanning, Secret Scanning, and Dependabot alerts so I can see security work in the same Issues list as feature work, choosing per-category which ones matter for that repo.

Acceptance criteria:

- Configure dialog renders three independent checkboxes per source under a "Security & quality alerts" section.
- Saving with any category enabled triggers (if the token lacks `security_events`) an OAuth re-consent flow before the next pull, surfaced as an inline banner in the source row's warning chip.
- Once enabled and consented, the next `listIssues` pull includes the enabled categories' open alerts merged with regular Issues.

#### US-012 - User on a partially-supported repo sees per-category warning and continues

As a developer on a repo where Code Scanning is disabled, I want the other enabled categories to keep working and the unavailable category to surface a clear, dismissible warning so I am not blocked from seeing my Dependabot alerts.

Acceptance criteria:

- Categories that fail (missing scope, GHAS off, Dependabot off) do NOT prevent the listIssues pull from returning.
- Each failing category surfaces a warning chip on the source row in the Configure dialog with a human-readable cause.
- A successful subsequent pull for that category dismisses its warning automatically.

#### US-013 - User opens Test connection and sees per-category status

As a developer configuring a github.com source for the first time with security categories enabled, I want Test connection to tell me which categories will actually return data so I do not save a misconfigured source.

Acceptance criteria:

- Clicking Test connection probes each enabled alert endpoint with `per_page=1`.
- The result panel shows Issues status plus one row per enabled category with ok / unavailable + cause.
- Test connection completes within the existing connection-test time budget.

### Addendum functional requirements

#### FR-040 - Per-source security & quality alert booleans

The bundled GitHub.com plugin and bundled GHE plugin MUST expose three independent boolean settings per configured source: `includeCodeScanningAlerts`, `includeSecretScanningAlerts`, `includeDependabotAlerts`. Each MUST default to `false`. The settings MUST be settable in the Configure dialog and MUST be representable in the committed `roubo.yaml` integration block as well as the per-user override, following the existing field-level-optional merge semantics.

#### FR-041 - Alert fetchers and merging into `listIssues`

When at least one alert category is enabled for a source, the plugin's `listIssues` implementation MUST, on each pull, fetch the enabled categories' open alerts (`state=open`) from the GitHub REST endpoints (`/repos/{o}/{r}/code-scanning/alerts`, `/repos/{o}/{r}/secret-scanning/alerts`, `/repos/{o}/{r}/dependabot/alerts`) using the same pagination loop and page-size config as the existing Issues fetch. Results MUST be merged into the single normalized `listIssues` return.

#### FR-042 - Shared GitHub helpers workspace

The three alert fetchers and the token-scope detector MUST live in a new shared workspace package `plugins/_shared-github/` consumed by both bundled github.com and bundled GHE plugins. The package MUST NOT be exposed via the public Plugin SDK in this slug.

#### FR-043 - Alert-to-normalized mapping with raw redaction

Each alert MUST be mapped to a normalized issue with `issueType` set to one of `security-code-scanning`, `security-secret-scanning`, `security-dependabot`. The opaque `raw` field MAY carry severity, CVE id, package name, advisory URL, file path, line number, rule id (Code Scanning), and secret_type (Secret Scanning). Before placing the alert in `raw`, the plugin MUST strip the matched secret token (retain only the first 4 characters + redaction marker) and MUST strip embedded code snippets (retain only file path + line number). Plugin stdout / stderr MUST NOT contain alert `raw` fields.

#### FR-044 - External-id namespacing for alerts

The plugin MUST produce alert external ids that do not collide with regular Issue external ids from the same repo. The required format is `<owner>/<repo>#<category>-<alert_number>` where `<category>` is one of `code-scanning`, `secret-scanning`, `dependabot` (e.g. `wday-planning/roubo#code-scanning-17`). The format MUST be stable across pulls.

#### FR-045 - `security_events` OAuth scope and re-consent

The Roubo GitHub OAuth app MUST include `security_events` in its scope set. Existing tokens MUST continue to work for regular Issues without re-consent. When a user enables any of the three alert categories on a source AND the host's stored token lacks `security_events`, the plugin MUST detect this via the `X-OAuth-Scopes` response header on the next authenticated call and the host MUST surface an inline OAuth re-consent action inside the source row's warning chip. Successful re-consent MUST replace the keyring-stored token in place. Users who never enable any category MUST NOT see a re-consent prompt as a side effect of the scope-set change.

#### FR-046 - Per-category graceful skip with warning chip

If an enabled category fails to fetch for a source on a given pull (HTTP 401/403 indicating missing scope, HTTP 404/410 indicating the feature is disabled on the repo, HTTP 451 indicating GHAS not enabled for private repos, or any structured error from the endpoint), the plugin MUST silently skip that category for that source on that pull, MUST continue to fetch other enabled categories and regular Issues, and MUST surface a per-source per-category warning to the host with a human-readable cause string. The host MUST render the warning as a chip on the source row in the Configure dialog. The warning MUST be cleared automatically on the next successful pull of that category.

#### FR-047 - Test connection per-category status

When Test connection is invoked on a source with at least one alert category enabled, the host MUST probe each enabled category endpoint with `per_page=1` in addition to the existing connection check. The result panel MUST render the existing connection-test rows plus one row per enabled category showing ok / unavailable + cause. The Test connection action MUST complete within the existing connection-test time budget; if a probe times out, that category row MUST surface "Timed out" without failing the overall connection test.

#### FR-048 - Alerts are read-only write-back

The plugin MUST set `allowedTransitions: []` and `assignees: []` on every alert it returns. The host MUST hide the Transition dropdown and MUST disable the Assign control on benches whose `assignedIssue.issueType` matches one of the three security categories.

#### FR-049 - Blueprint-by-issue-type for security categories

The existing blueprint-by-issue-type resolver MUST treat `security-code-scanning`, `security-secret-scanning`, and `security-dependabot` as valid issue type identifiers selectable in the existing mappings UI. No new resolver behavior is required beyond extending the candidate type set.

#### FR-050 - Bench snapshot frozen at create-time for alert benches

When the user disables a previously-enabled alert category on a source, any existing bench whose `assignedIssue.issueType` belongs to that category MUST continue to function with its snapshot unchanged. The host MUST NOT clear, mutate, or relabel such benches as a side effect of the toggle change. New pulls simply stop returning alerts in that category.

### Addendum non-functional requirements

#### NFR-012 - Alert payload redaction

Category: security

The bundled github.com and GHE plugins MUST redact the secret value (retain only first 4 characters + redaction marker) and embedded code snippets (retain only file path + line number) before populating any alert's normalized `raw` field. Plugin stdout / stderr MUST NOT log the alert `raw` field. Verified by unit test against a recorded REST fixture per category. The documented contract is: "Roubo never sees the leaked secret itself."

#### NFR-013 - Worst-case `listIssues` latency with alerts enabled

Category: performance

The merged `listIssues` round-trip MUST complete with p95 under 8 seconds for a configured source set of up to 5 sources, each with up to 200 open items across regular Issues + enabled alert categories, measured warm (with ETag/304 short-circuit available). Cold-pull latency is not bounded by this NFR. Regression target: the existing Issues-only p95 baseline MUST NOT regress by more than 10% when all three alert categories are disabled across all sources.

#### NFR-014 - Accessibility for new surfaces

Category: accessibility

The per-category warning chip on the source row, the inline OAuth re-consent action inside the chip, and the per-category Test connection result rows MUST comply with WCAG 2.1 AA. Implementation MUST use React Aria Components (Button, Dialog as required), MUST be keyboard-reachable in tab order, MUST expose accessible names for category status (e.g. "Code Scanning: unavailable - GHAS not enabled"), and state changes (chip appears, chip cleared, re-consent flow opened) MUST be announced via React Aria live regions.

#### NFR-015 - Token-scope detection robustness

Category: reliability

Token-scope detection MUST gracefully handle the case where the user's token does NOT expose granted scopes (e.g. GHE fine-grained PATs do not return `X-OAuth-Scopes`). In that case the Configure warning MUST say "Unable to verify token scopes; if category data is missing, regenerate the token with the security alert permission" rather than asserting "token lacks `security_events`." Plugin MUST still attempt the call and report the resulting HTTP error code through the per-category warning surface.

### Addendum traceability

| User story | Functional requirements                                        | Non-functional requirements | Test-case bucket (forward ref) |
| ---------- | -------------------------------------------------------------- | --------------------------- | ------------------------------ |
| US-011     | FR-040, FR-041, FR-042, FR-043, FR-044, FR-045, FR-048, FR-049 | NFR-013, NFR-014            | TC-addendum-enable             |
| US-012     | FR-046, FR-050                                                 | NFR-015, NFR-014            | TC-addendum-degradation        |
| US-013     | FR-047                                                         | NFR-013, NFR-014            | TC-addendum-test-connection    |

Cross-cutting NFR-012 (raw redaction) applies to FR-041, FR-043, FR-046 regardless of story.

### Addendum size

**M (medium): 2-3 sprints / 4-6 person-weeks** as a delta on top of the integration-plugins core. Rationale:

- Touches both bundled plugins (github.com, GHE) but they share the new `plugins/_shared-github/` package, so the implementation cost is ~1.3x of a single plugin rather than 2x.
- OAuth app config change is real (production OAuth app + a re-consent flow) but the re-consent flow itself reuses the existing OAuth deep-link handler.
- Configure-dialog UI grows three new sections per source (category checkboxes, warning chips, Test connection rows) but reuses existing React Aria patterns.
- Normalized issue contract is unchanged; only the `issueType` candidate set expands by 3.
- Three new REST integrations + redaction + namespacing + scope detector + per-category warning surface + Test connection extension + frozen-snapshot guarantee + accessibility on new surfaces.
- Tests: per-category fixtures + redaction unit tests + scope-detection edge cases (fine-grained PAT) + Test connection probe path.

Risks that could push this to L if they materialize: OAuth app re-consent UX surprises (deep-link, callback rendering inside an existing dialog), and the GHE fine-grained PAT scope-detection gap forcing additional UI states.

### Addendum leading indicator

- The project owner enables all three security categories on the dogfood github.com project and runs Roubo for one continuous week without an issue-list regression on the pre-existing Issues flow (no missed items, no list-ordering regression, no Configure-dialog crash).

(No lagging indicators were selected for this addendum specifically; it inherits the broader integration-plugins lagging indicator on zero P0 security incidents.)

---

## Re-interview PRD - 2026-05-25 (UI/UX polish, GitHub settings consolidation, e2e coverage, plus the 2026-05-24 alerts addition that has not yet been broken down)

> This addendum extends the PRD with the 2026-05-25 scope expansion captured in `context.md` and the 2026-05-24 alerts addition. New FR-/NFR-/US- ids continue the existing sequence. The existing PRD (sections 0..N) is unchanged and remains the canonical capture of the runtime + bundled plugins + alerts contract; this addendum adds requirements, not retractions.

### Problem (incremental)

The plugin runtime and three bundled integration plugins have shipped, and users report a cluster of UI/UX paper-cuts plus one structural settings inconsistency that together undermine the daily flow. Status of an integration is invisible until the user clicks `Test Connection`. Bundled plugins are all enabled by default, so users who don't use GHE or Jira see clutter and inadvertently create projects pointing at the wrong source. The cut list shows every issue from every source including closed and in-review work the user cannot action, and lacks a milestone/epic filter that users on github.com and Jira both need. Chip categories collide visually (status vs label render the same colour). GitHub-shaped settings live in two places: project Identity (repo path, linked GH Project, meta-repo submodules) and inside the github.com / GHE plugin Configure modals (credentials, sources). Configure + Choose-sources are two buttons that overlap. Separately, no end-to-end coverage exists for the feature; current automated tests are unit + integration only, leaving regressions in user-visible flows undetected. The 2026-05-24 alerts addition (per-source security and quality alerts on github.com / GHE plugins) is captured in context.md but its FRs / NFRs / user stories were never written into the PRD - this addendum closes that gap so the work-breakdown stage can pull from a single source of truth.

### In scope

**Connection-status surfacing**

- Status chips render in three placements: plugin card on Settings > Plugins, Configure modal header, project Settings page tile for the active integration.
- Four canonical states: `connected`, `disconnected`, `auth-problem` (token expired or 401), `errored` (covers rate-limited, unreachable, plugin crashed, never-checked).
- Disabled bundled plugins show a fifth `disabled` chip and do not run status checks.
- Freshness model: cached last-known value with timestamp ("as of HH:MM"), opportunistic re-check on UI events (Settings tab open, Configure modal open, cut-list load). No background polling timer.

**Plugin grid + Settings page width**

- Settings > Plugins changes from vertical stack to a CSS Grid auto-fit layout. Tile minimum width 360px. 1 column on narrow viewports, 2 at default app width, 3+ on wide displays.
- Each tile renders: plugin name, one-line description, status chip (or `Disabled` chip), enabled/disabled toggle, Configure button (label is `Connect` when not yet configured, `Configure` once connected).
- Settings page container changes from constrained width to full container width across every Settings tab (Plugins, Project setup, etc).

**Bundled plugins default-disabled + project-load prompt**

- Greenfield installs ship all bundled plugins in disabled state. Existing installs are untouched - already-enabled plugins stay enabled across the upgrade.
- Greenfield detection: a fresh `~/.roubo/state.json` (no `version` marker yet) is the greenfield signal. Existing installs have a `version` marker set by the prior migration.
- Persistence: plugin enable state is stored in `~/.roubo/plugins-state.json` (or as a new `pluginEnableState` field on the existing state file - architecture stage to pin). Survives restart. Never sent to telemetry.
- When the user opens a project whose `roubo.yaml` references a disabled bundled plugin: project load is paused on a friendly modal "Enable github.com plugin to load this project?" with one-click Enable. The user explicitly confirms; no silent state mutation.

**Cut-list filtering (status exclusion + plugin-declared facets)**

- Three-layer config merge for status exclusions: plugin-global default + per-project override + per-source override. Deep-merged. Per-source override lives under `sources[<id>]` and is applied via a post-merge pass (the existing root-level walker does not traverse into source entries today).
- Default exclusions: `Closed`, `Done`, `Resolved`, `In review`, `PR open`, `Waiting on reviewer`. Users opt back in per exclusion at any layer.
- Plugin-declared filter facets via new `filterFacets()` RPC on the plugin contract. Each plugin returns a descriptor list: `{ id, label, type, options? }`. Core renders generic filter UI from the descriptor. github.com plugin declares `Milestone`. Jira plugin declares `Epic`. GHE plugin declares `Milestone` identically to github.com.
- Optional `facetValues?: Record<string, string | string[]>` field on `NormalizedIssue`. Plugins populate this when they declare facets; core filters on it.
- Host-API minor bump to 1.1.0. Plugins built against 1.0.0 that omit `filterFacets()` are tolerated via `MethodNotFound` (existing pattern) - core falls back to a fixed common-facet set (Status, Label, Assignee, Type) for those plugins.

**Cut-list chip visual taxonomy**

- Each chip category gets a distinct visual treatment combining colour AND a non-colour signal (shape, icon prefix, or border style) so the chips remain distinguishable to colour-blind users.
- Categories with distinct treatment: `Status`, `Label`, `Issue type`, and a `metadata` cluster covering `Milestone`/`Epic`, `Priority`, `Assignee`, and `Security-alert`. Specific tokens deferred to the prototype stage.

**GitHub settings consolidation + plugin-driven tab title**

- Project Settings page gets a tab whose title is driven by the active integration plugin name. github.com -> "GitHub". GHE -> "GitHub Enterprise". Jira -> "Jira". The title falls back to `Source` if no integration is configured.
- The renamed tab holds (moved from Project Settings > Identity): repository path / GitHub repo URL, linked GitHub Project (Project v2 board), meta-repo submodule list, the source picker, the Configure / Connect button.
- Default branch STAYS on Project Settings > Identity (it's a git concept, used by Roubo independently of which integration plugin is active).
- Identity tab keeps only Roubo-native fields (project name, default branch, Roubo-managed paths).
- Configure + Choose-sources buttons collapse to a single context-aware button. Label is `Connect` when the plugin has no credentials configured; `Configure` once connected. The modal opened by both labels is the same; it shows credentials section + sources section + Test Connection.
- GHE plugin consolidates identically to github.com: same fields, same modal layout, same single-button collapse.

**E2E coverage of the entire integration-plugins feature**

- Playwright UI tests against the running Roubo app (real client + real server). Stubbed plugin process in CI and locally - deterministic, no real network, no rate-limit risk.
- The stubbed plugin implements the full plugin RPC contract (lifecycle, validate, list sources, list issues, transitions, assign/unassign, filterFacets, getConnectionStatus). Stub is byte-deterministic given the same inputs.
- An env-gated `POST /test/__reset` route is added to the server to reset module-level singletons in `plugin-manager.ts` between specs. Route is disabled in production builds.
- Coverage spans (this is the e2e target list - the tests stage enumerates individual cases):
  - Plugin lifecycle: install (git URL + local path), enable, disable, uninstall, auto-restart, crashed state.
  - Configure flows for all three bundled plugins (github.com OAuth, GHE PAT, Jira PAT).
  - Source picker: multi-list (github.com / GHE) and categorized-multi-list (Jira).
  - Cut-list filtering: status exclusion at all three layers, plugin-declared facets render and filter, chip categories render distinctly.
  - Migration of a legacy github.com user on first launch.
  - 2026-05-24 security-and-quality alerts re-consent flow.
  - Connection-status surfacing across all three placements + opportunistic re-check.
  - GitHub settings consolidation: fields render in the renamed tab, Configure/Connect button switches label on connection state.
  - Bench creation from each source type.
  - Write-back: status transition + assign/unassign.
  - Permission gates at host: network host allowlist, credential slot, fs path, child-process spawn.

**2026-05-24 alerts addition (now formally PRD'd)**

- Bundled github.com and GHE plugins gain three optional per-source booleans: `includeCodeQLAlerts`, `includeSecretScanningAlerts`, `includeDependabotAlerts`. Default `false`.
- Alerts appear in the cut list interleaved with regular issues. They render with a distinct issue-type chip (`CodeQL`, `Secret scanning`, `Dependabot`). Severity / category metadata lives in the opaque `raw` field; not a first-class normalized field this slug.
- Alerts are read-only - no transitions, no assign/unassign actions. Existing list operations apply (filter, search, sort).
- Enabling an alert category re-asks for OAuth consent inline inside the per-source warning chip; existing OAuth scopes are extended with `security_events`. PAT users (GHE) get an inline reminder to recheck token scopes.
- Jira plugin gets nothing this slug (Jira has no equivalent surface).

### Out of scope

- Real-network e2e runs against github.com or a GHE sandbox in CI. Stubbed plugin only.
- Live-ping or background-interval connection status. Cached + opportunistic re-check only.
- Migration of existing installations to default-disabled. Existing installs keep current enabled state.
- Silent auto-enable of disabled bundled plugins when a project needs one. Explicit Enable prompt only.
- Project-level read-only display of repo URL "for discoverability" after consolidation. Once moved, repo URL lives only in the plugin Configure modal.
- Keeping Choose-sources as a fast path. Retired.
- Per-source filterable facet declarations (facets are plugin-level, not source-level, this slug).
- User-configurable chip colours. Visual taxonomy is fixed by design tokens.
- Webhook / push delivery of alerts. Polling-only continues, same as the rest of the runtime.
- Auto-creating benches when a high-severity alert fires. User-initiated only.
- Write-back to alerts (dismiss / resolve / re-open).
- Severity / state filter UI for alerts in the Configure modal. Booleans only.
- Surfacing alert metadata (severity, CVE, package) as first-class normalized fields.

### Sizing

- **T-shirt size:** Medium
- **Effort:** 8 sprints / 16 person-weeks
- **Rationale:** 12 user stories, ~30 FRs, 10 NFRs. Big-ticket items are the new persistence layer for plugin enable state, the host-API 1.1.0 bump for `filterFacets()` and the optional `facetValues` field, the Playwright harness from scratch with stubbed plugin process and `/test/__reset` route, the GitHub settings push-down touching both Project Settings and plugin Configure on github.com + GHE, the three-layer merge extension with the post-merge pass for per-source overrides, and the 2026-05-24 alerts addition. Mostly additive against the shipped runtime, no architectural rewrites, but the surface area is broad.

### User stories

#### US-014 — See integration connection status at a glance
As a Roubo user with one or more integration plugins configured, I want each plugin's connection state visible without clicking Test Connection, so that I know whether my cut list is current and which plugin needs my attention.

#### US-015 — Browse plugins as a grid, not a stack
As a Roubo user with multiple integration plugins installed, I want the Settings > Plugins page to render as a responsive grid filling the full Settings surface, so that I can scan all plugins at once instead of scrolling a tall vertical stack.

#### US-016 — Install Roubo with bundled plugins disabled by default
As a new Roubo user who only uses github.com, I want bundled plugins (GHE, Jira) to land disabled on a fresh install, so that my Settings surface is uncluttered and I never accidentally route to the wrong source.

#### US-017 — Be prompted to enable a disabled bundled plugin when I open a project that needs it
As a Roubo user opening a colleague's project whose `roubo.yaml` points at a bundled plugin I have not enabled, I want a one-click Enable prompt instead of a silent failure or silent enable, so that I'm in control and understand what just got enabled.

#### US-018 — Hide closed and in-review issues from the cut list by default
As a Roubo user planning my next bench, I want my cut list to exclude closed/done/resolved and in-review/PR-open issues by default, so that the list shows only work I can pick up right now.

#### US-019 — Configure status exclusions per source when one source is noisier than others
As a Roubo user with multiple sources in one plugin (e.g. several github.com repos), I want to override the status exclusion at the source level when one source has unusual workflow states, so that I'm not forced into a one-size-fits-all rule.

#### US-020 — Filter the cut list by Milestone (github.com) or Epic (Jira)
As a Roubo user picking work for a release, I want to filter the cut list by Milestone (github.com) or Epic (Jira), so that I can see only the issues that count toward my current release.

#### US-021 — Distinguish chip categories at a glance
As a Roubo user (including colour-blind users), I want status, label, type, and metadata chips on cut-list rows to be visually distinct in shape AND colour, so that I can read a row without parsing legend text or relying on colour alone.

#### US-022 — Configure all my GitHub settings in one place
As a Roubo user whose source-of-truth is GitHub, I want repo path, linked GitHub Project, and meta-repo submodules configured inside the GitHub plugin tab on my project Settings page (next to credentials and sources), so that GitHub-shaped config doesn't live in two places.

#### US-023 — Use one Connect / Configure button for the active integration
As a Roubo user opening my project's Settings, I want a single button on the integration tab whose label says `Connect` before I have credentials and `Configure` after, so that I'm not faced with two overlapping buttons (Configure + Choose sources) doing similar things.

#### US-024 — See security and quality alerts in my cut list (github.com / GHE)
As a Roubo user whose source-of-truth is github.com or GHE, I want to opt each source into CodeQL, Secret Scanning, and Dependabot alerts so they appear in my cut list interleaved with regular issues, so that I can triage security work alongside feature work without leaving Roubo.

#### US-025 — Trust that integration changes don't regress with every release
As a Roubo maintainer, I want every user-facing integration flow covered by a deterministic Playwright e2e suite running against a stubbed plugin, so that I can ship plugin runtime / UI changes with confidence and catch regressions before they reach users.

### Functional requirements

#### FR-051 — Status chip on Settings > Plugins tile
Each plugin tile on Settings > Plugins displays a status chip showing one of: `Connected`, `Disconnected`, `Auth problem`, `Errored`, `Disabled`. The chip surfaces the cached last-known status with a relative timestamp ("as of HH:MM"). Disabled plugins always show the `Disabled` chip and skip status checks.

#### FR-052 — Status chip in Configure modal header
The Configure (or Connect) modal renders a status chip in its header for the current plugin. The chip uses the same component as the tile chip and reflects the same cached value.

#### FR-053 — Status chip on project Settings page integration tile
The active integration plugin's tile inside the per-project Settings page renders a status chip identical in shape and palette to the chips on Settings > Plugins.

#### FR-054 — Opportunistic status re-check on UI events
Opening the Settings > Plugins tab, opening the Configure modal, or loading the cut list re-checks status in the background for every enabled plugin. The cached value renders synchronously; the re-check updates the chip when it returns. No background timer fires when no UI event has triggered.

#### FR-055 — `getConnectionStatus()` plugin RPC
The plugin contract gains an optional `getConnectionStatus(): Promise<ConnectionStatus>` method where `ConnectionStatus = { state: 'connected' | 'disconnected' | 'auth-problem' | 'errored', detail?: string, checkedAt: string }`. Plugins built against host-API 1.0.0 that omit this method are tolerated via `MethodNotFound`; the host falls back to invoking `validateConfig()` and inferring state from its result.

#### FR-056 — Settings > Plugins renders as a responsive auto-fit grid
The Settings > Plugins layout switches from a vertical stack to a CSS Grid with `auto-fit minmax(360px, 1fr)`. Tiles wrap to 1 / 2 / 3 columns based on the available width, with no fixed breakpoint values in JS.

#### FR-057 — Plugin tile content
Each tile renders, in order: plugin name (heading), one-line description, status chip, enabled/disabled toggle, action button (`Connect` if no credentials, `Configure` otherwise). Tile minimum width is 360px and tile height is consistent within a row.

#### FR-058 — Settings page full container width
The Settings page wrapper changes from `max-w-*` constrained to `w-full`/full-container-width across every tab (Plugins, Project setup, others). Child layouts are responsible for any inner content constraints.

#### FR-059 — Bundled plugins ship in disabled state on greenfield installs
On a fresh install (no `~/.roubo/state.json` version marker), all bundled plugins (github.com, GHE, Jira) are recorded with `enabled: false` in the persistent plugin state. Existing installs (state file with a prior `version` marker) are not modified.

#### FR-060 — Persistent plugin enable state
The server persists per-plugin enable state across restarts in a state file under `~/.roubo/` (architecture pins the exact filename and field). Enable / disable RPC calls update both the in-memory plugin manager record AND the persistent state. Plugin enable state is local to the user's installation and never transmitted to telemetry.

#### FR-061 — Project-load prompt when a disabled bundled plugin is needed
When the user opens a project whose `roubo.yaml` references a disabled bundled plugin, the UI shows a modal "Enable [plugin name] to load this project?" with `Enable` and `Cancel` buttons. `Enable` flips the plugin to enabled and continues project load. `Cancel` returns to the project list with no state change.

#### FR-062 — `excludedStatuses` config setting (three-layer)
A new `excludedStatuses: string[]` setting is supported at three layers: plugin-global (in plugin defaults), per-project (in the project's integration override block), and per-source (under `sources[<id>]`). Effective value is the deep-merged result across the three layers, with later layers overriding earlier ones.

#### FR-063 — Per-source `excludedStatuses` post-merge pass
The existing config merge walker does not descend into `sources[<id>]` entries; a post-merge pass applies per-source overrides to each resolved source's `excludedStatuses`. The pass is idempotent and runs in `server/services/integration-overrides.ts`.

#### FR-064 — Default `excludedStatuses` for bundled plugins
github.com / GHE / Jira bundled plugins ship with default `excludedStatuses: ['Closed', 'Done', 'Resolved', 'In review', 'PR open', 'Waiting on reviewer']` at the plugin-global layer (mapped to each provider's actual state strings).

#### FR-065 — `filterFacets()` plugin RPC
The plugin contract gains an optional `filterFacets(): Promise<FilterFacet[]>` method where `FilterFacet = { id: string, label: string, type: 'enum' | 'enum-async' | 'multi-enum', options?: string[] }`. github.com plugin returns at minimum a `Milestone` facet. Jira returns at minimum an `Epic` facet. Plugins built against 1.0.0 that omit this method fall back to a fixed common-facet set (`Status`, `Label`, `Assignee`, `Type`).

#### FR-066 — Optional `facetValues` field on NormalizedIssue
`NormalizedIssue` gains an optional `facetValues?: Record<string, string | string[]>` field. Plugins populate this when they declare facets; the keys match facet ids returned by `filterFacets()`. Core uses this map to filter the cut list.

#### FR-067 — Host-API minor bump to 1.1.0
The host-API version increments from 1.0.0 to 1.1.0 to cover `getConnectionStatus()`, `filterFacets()`, and the optional `facetValues` field. The SDK package version follows. Plugins built against 1.0.0 keep working via existing `MethodNotFound` tolerance.

#### FR-068 — Cut-list chip taxonomy
Cut-list rows render chips for Status, Label, Issue type, and metadata (Milestone/Epic, Priority, Assignee, Security-alert) as four visually-distinct buckets. Each bucket uses a distinct colour AND a non-colour signal (shape or icon prefix), so the four categories remain distinguishable in greyscale or under colour-blind palettes.

#### FR-069 — Per-project Settings tab title driven by active plugin
The per-project Settings page renders a tab whose title is the active integration plugin's display name (github.com -> "GitHub", GHE -> "GitHub Enterprise", Jira -> "Jira"). When no integration is configured, the tab title is `Source`.

#### FR-070 — Repo path / linked Project / submodules move into the plugin tab
The repository path, linked GitHub Project (Project v2 board), and meta-repo submodule list move from Project Settings > Identity into the new plugin-driven tab. Identity tab loses those fields and retains project name, default branch, and Roubo-managed paths only.

#### FR-071 — Default branch stays on Identity
Default branch remains on Project Settings > Identity. It is a git concept used by Roubo independently of which integration plugin is active.

#### FR-072 — Single context-aware Connect / Configure button
The integration tab's primary action button renders the label `Connect` when the plugin has no credentials configured, and `Configure` otherwise. Clicking opens the same modal in both cases. The legacy `Choose sources` button is removed; source selection lives inside the Configure modal.

#### FR-073 — GHE consolidation parity
GitHub Enterprise plugin's UI consolidates identically to github.com: same fields, same modal layout, same single-button collapse. No GHE-specific divergence in field set.

#### FR-074 — Per-source security/quality alert booleans (2026-05-24)
Bundled github.com and GHE plugins expose three optional per-source booleans on each source: `includeCodeQLAlerts`, `includeSecretScanningAlerts`, `includeDependabotAlerts`. All three default to `false`.

#### FR-075 — Alert rendering in the cut list
When a category is enabled for a source, alerts of that category appear in the cut list interleaved with regular issues, rendered with the matching issue-type chip (`CodeQL`, `Secret scanning`, `Dependabot`). Alerts are read-only - the row does not show transition or assign actions.

#### FR-076 — Inline OAuth re-consent on enabling an alert category
For github.com (OAuth), enabling an alert category surfaces an inline re-consent affordance inside the per-source warning chip; clicking re-runs the OAuth flow with extended `security_events` scope. For GHE (PAT), the affordance surfaces an inline reminder to verify the PAT's `security_events` scope.

#### FR-077 — Playwright e2e harness
The repo gains a Playwright test suite running against the built Roubo app (real client + real server + stubbed plugin process). Suite runs headless, deterministically, with no network access. CI runs the suite under the existing `pr-check` workflow.

#### FR-078 — Deterministic stubbed plugin
The harness provides a fake plugin process implementing the full plugin RPC contract: lifecycle, validateConfig, listSources, listIssues, transitionIssue, assignIssue, unassignIssue, filterFacets, getConnectionStatus. Output is byte-deterministic given the same test inputs; time is pinned by the harness.

#### FR-079 — Env-gated `/test/__reset` route
The server exposes a `POST /test/__reset` route that resets module-level singletons (plugin-manager, project-registry, state cache) between Playwright specs. The route is gated behind `process.env.ROUBO_E2E === '1'` and is not exposed in production builds.

#### FR-080 — E2E coverage surface (feature-wide)
The Playwright suite covers, at minimum: plugin lifecycle (install/enable/disable/uninstall/auto-restart), Configure flow per bundled plugin, source picker shapes, cut-list filtering (status exclusion x three layers, plugin-declared facets, chip categories), legacy github.com migration, alerts re-consent flow, status surfacing across all three placements, GitHub settings consolidation, bench creation per source type, write-back ops, host permission gates. The tests stage enumerates individual cases.

### Non-functional requirements

#### NFR-016 — Accessibility: WCAG 2.1 AA + keyboard-only + colour-blind safe
Category: accessibility
Every new and modified surface (plugin grid, status chips, Configure modal, integration tab, cut-list chips, project-load Enable prompt) meets WCAG 2.1 AA contrast against the surrounding background. Plugin grid is keyboard-navigable (Tab order through tiles, Enter to open Configure, Space to toggle enable/disable). Chip discrimination does not rely on colour alone; every category combines colour with a non-colour signal (shape, icon prefix, or border style).

#### NFR-017 — Performance: status chip render and re-check budgets
Category: performance
Cached status chips render synchronously within 50ms of the parent surface mounting. Opportunistic background re-check completes within 2 seconds p95 for healthy plugins (excluding intentional `errored` cases). Plugin grid first paint completes within 100ms of the Settings > Plugins tab opening.

#### NFR-018 — Reliability: e2e suite is deterministic in CI
Category: reliability
The Playwright suite must pass 10 consecutive runs in CI with zero flaky reruns. The stubbed plugin produces byte-identical output across runs given the same inputs; the harness pins time via fake timers in the Playwright fixture.

#### NFR-019 — Security: plugin enable state is local-only
Category: security
Plugin enable state is persisted to `~/.roubo/` (filename pinned by architecture). It is never transmitted to telemetry, never written into committed `roubo.yaml`, and is excluded from any state-snapshot endpoint. Telemetry events that reference plugins use the plugin id only; enable state never appears in any event payload.

#### NFR-020 — Security: status re-check honours network-host allowlist
Category: security
The opportunistic status re-check flows through the host-provided `host.fetch` helper. Plugins cannot bypass the allowlist or the self-signed-TLS opt-in. Any re-check call to a host not on the plugin's manifest-declared allowlist is rejected by the host before the plugin code runs.

#### NFR-021 — Performance: cut-list filter recompute under 50ms p95
Category: performance
Applying or removing a filter facet on the cut list completes the client-side recompute and re-render within 50ms p95 for a cut list of up to 500 issues. Filter changes do not trigger a fresh server fetch unless the user explicitly refreshes.

#### NFR-022 — Accessibility: project-load Enable prompt is focus-trapped
Category: accessibility
The "Enable [plugin name] to load this project?" modal traps focus, restores focus to the originating UI on close, and exposes its title and description via aria-labelledby / aria-describedby. Esc cancels, Enter confirms when the Enable button has focus.

#### NFR-023 — Observability: connection status changes are logged
Category: observability
Connection status transitions (e.g. `connected` -> `auth-problem`) are written to the plugin's host-provided structured logger with the plugin id, the previous state, the new state, and the trigger (UI-event source). Logs go to the existing log destination; no new logging infrastructure introduced.

#### NFR-024 — Reliability: project-load prompt never deadlocks
Category: reliability
If the user cancels the project-load Enable prompt, the project list view re-renders within 500ms with no plugin in a partially-enabled state. If the Enable click fails (plugin process refuses to start), the modal displays the error inline and the plugin remains in its previous disabled state.

#### NFR-025 — Localization-readiness: all new copy uses string keys
Category: localization
All user-facing copy introduced by this scope (status chip labels, modal titles, button labels, error strings, alert category names) uses the existing string-key pattern so a future localization pass can swap them without touching component code. No inline English strings in new components.

### Traceability

| User story | Functional requirements | Non-functional requirements |
|---|---|---|
| US-014 — See integration connection status at a glance | FR-051, FR-052, FR-053, FR-054, FR-055 | NFR-016, NFR-017, NFR-020, NFR-023, NFR-025 |
| US-015 — Browse plugins as a grid, not a stack | FR-056, FR-057, FR-058 | NFR-016, NFR-017, NFR-025 |
| US-016 — Install Roubo with bundled plugins disabled by default | FR-059, FR-060 | NFR-019, NFR-025 |
| US-017 — Be prompted to enable a disabled bundled plugin when I open a project that needs it | FR-061 | NFR-016, NFR-022, NFR-024, NFR-025 |
| US-018 — Hide closed and in-review issues from the cut list by default | FR-062, FR-063, FR-064 | NFR-021, NFR-025 |
| US-019 — Configure status exclusions per source when one source is noisier than others | FR-062, FR-063 | NFR-021, NFR-025 |
| US-020 — Filter the cut list by Milestone (github.com) or Epic (Jira) | FR-065, FR-066, FR-067 | NFR-021, NFR-025 |
| US-021 — Distinguish chip categories at a glance | FR-068 | NFR-016, NFR-025 |
| US-022 — Configure all my GitHub settings in one place | FR-069, FR-070, FR-071, FR-073 | NFR-016, NFR-025 |
| US-023 — Use one Connect / Configure button for the active integration | FR-072, FR-073 | NFR-016, NFR-025 |
| US-024 — See security and quality alerts in my cut list (github.com / GHE) | FR-074, FR-075, FR-076 | NFR-020, NFR-025 |
| US-025 — Trust that integration changes don't regress with every release | FR-077, FR-078, FR-079, FR-080 | NFR-018 |

### Leading indicators of success

- Every flow in the Playwright e2e suite passes deterministically in CI for 10 consecutive runs (NFR-018 met).
- Plugin grid renders at 1 / 2 / 3 columns at narrow / default / wide viewport widths (FR-056 verified).
- Status chip renders the correct state across all four states x three placements with no manual `Test Connection` click (FR-051..FR-054 verified).
- Every new user-facing copy string passes the project's no-em-dash lint and is keyed for localization (NFR-025 verified at PR review).

### Lagging indicators of success

- Zero support reports of the form "I had to click Test Connection to see if I was still connected" in the 30 days after rollout.
- Zero project-load failures attributable to a disabled bundled plugin in the 30 days after rollout (the Enable prompt catches them all).
- Within 60 days of rollout, at least one community or internal author adds a filter facet to a bundled plugin (e.g. a `Sprint` facet on the Jira plugin) without modifying core code, validating the host-API 1.1.0 extension point.

### Open questions (deferred downstream)

- Exact chip colour tokens / icon prefixes per category - deferred to the prototype stage.
- E2E case enumeration across source-shape combinations - deferred to the tests stage.
- `filterFacets()` async value population strategy (immediate vs lazy on filter open) - deferred to the architecture stage.
- Whether the renamed integration tab title appears in the project sidebar / breadcrumb in addition to the tab itself - deferred to the prototype stage.
- Whether `pluginEnableState` lives in `~/.roubo/state.json` (extend existing) or a new `~/.roubo/plugins-state.json` - deferred to the architecture stage.

