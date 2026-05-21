# PRD: Integration plugins (extensible plugin system, first use case: issue-source integrations)

> Slug: `integration-plugins` · Last updated: 2026-05-21

## Problem

Roubo today only knows how to pull issues from GitHub.com via the Roubo OAuth app. That cuts the tool off from the largest cohort of enterprise developers who would otherwise adopt it: people whose company runs GitHub Enterprise on-prem, or whose product team tracks work in self-hosted Jira. We lose those users at evaluation; the ones who push through end up mirroring tickets into a personal GitHub repo or creating benches without an attached issue, which breaks the workflows Roubo is good at (blocks/blocked-by enforcement, blueprint-by-issue-type, PR sync). The fix is not to bolt on a second hardcoded integration. We need an extensible plugin system so users can install official or community integrations without waiting for Roubo to ship them. The first shipment of that system delivers a runtime, three bundled integration plugins (GitHub.com, GitHub Enterprise, self-hosted Jira), and a documented SDK so power users can write their own. The runtime is designed intentionally so the planned AI-agent and project-component plugin slugs can be hosted later without a host-API major-version bump.

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
The existing `/issue-type-mappings` endpoints MUST continue to operate. The source of `issueType` strings MUST be the active integration plugin's `listIssueTypes` (or whatever value flows through `getIssue`), not a hardcoded GitHub call. The mappings persistence shape MUST remain `Record<string, string>` (issueType → blueprintId).

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
