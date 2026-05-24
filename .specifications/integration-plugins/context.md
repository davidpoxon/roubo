# Context: Integration plugins (extensible plugin system, first use case: issue-source integrations)

> Slug: `integration-plugins` · Interview completed: 2026-05-21
>
> This document is the canonical capture of what was said during the product interview. Every decision below corresponds to a question the user explicitly answered. Items the user did not pick are noted as `out`. Open questions are listed at the end with their blockers.

## Problem

Roubo today only knows how to pull issues from GitHub.com via the Roubo OAuth app. That cuts off the largest cohort of enterprise developers who would otherwise use the tool: people whose company runs GitHub Enterprise on-prem, or whose product team tracks work in self-hosted Jira. We lose those users at evaluation. The ones who push through end up mirroring tickets into a personal GitHub repo or creating benches without an attached issue, which breaks the workflows Roubo is good at (blocks/blocked-by enforcement, jig-by-issue-type, PR sync). Bolting on a second hardcoded integration is not the fix. We need an extensible plugin system so users can install official or community integrations without waiting for Roubo to ship them. The first shipment of that system delivers a runtime, three bundled integration plugins (GitHub.com, GitHub Enterprise, self-hosted Jira), and a documented SDK so power users can write their own.

## Users

Roubo users whose system of record is not GitHub.com. The largest concrete cohort is enterprise developers on GHE and/or self-hosted Jira. Real adoption numbers are flagged for refinement, pending a product telemetry workstream that is not yet staffed.

## Today's workaround

Three patterns observed:

1. They do not use Roubo at all. Most common; we lose them at evaluation.
2. They mirror a subset of Jira tickets into a personal GitHub repo and point Roubo at that. Fragile, out of sync.
3. They create benches manually without an attached issue and paste the Jira ticket URL into the bench name. Loses the issue-linked workflow.

## Goal

A developer at a company using GHE or self-hosted Jira installs Roubo, opens settings, enables the appropriate bundled integration plugin, pastes their instance URL and credentials, picks the sources they care about, and gets the full Roubo bench workflow with no behavioural difference from a GitHub.com user. Separately, a power user can write their own integration plugin against a documented SDK, drop it in `~/.roubo/plugins/`, configure it, and use it the same way as a bundled plugin. The runtime is designed intentionally for two follow-on plugin kinds (AI coding agents, project components) and is verified with a paper sketch before host-API freeze.

## Scope

### In scope

- A plugin runtime: process supervisor, JSON-RPC over stdio transport, lifecycle management.
- A `roubo-plugin.yaml` manifest format with a zod schema in `shared/` and a JSON Schema artifact for IDEs.
- A host-enforced permission model with four categories: network hosts, credential slots, filesystem paths beyond the plugin's own directory, and child-process spawning.
- An OS-keyring-backed credential store accessed by plugins only via a host-provided helper. Implementation shells out to platform CLIs (`security` on macOS, `secret-tool` on Linux, PowerShell on Windows) to honour the no-native-modules constraint.
- A host-provided HTTP client (`host.fetch`) that performs the actual network I/O so plugins cannot bypass the allowlist or the self-signed-TLS toggle.
- A Plugins settings page (top-level) listing installed plugins with install, configure, enable, disable, and uninstall actions.
- An "Issue source" tile on each project detail page where the user configures the active integration plugin and its sources for that project.
- A declarative source picker. Plugins return a shape (`multi-list` for GitHub.com / GHE, `categorized-multi-list` for Jira). Roubo core renders. No plugin React.
- Three bundled integration plugins:
  - **GitHub.com**: keep the Roubo OAuth app and the `roubo://oauth/github/callback` deep link. Full re-implementation as the bundled plugin; no legacy code path retained after migration.
  - **GitHub Enterprise**: PAT + instance URL.
  - **Self-hosted Jira (Data Center 8.14+)**: PAT only.
- Read-only pull plus a narrow set of write-back operations: **status transitions** and **assign / unassign**. Commenting and PR linking are NOT in scope.
- A normalized issue contract: `integrationId`, `externalId`, `externalUrl`, `title`, `body`, `currentState`, `allowedTransitions`, `assignees`, `labels`, `issueType`, `blocks`, `blockedBy`, `updatedAt`, opaque plugin-scoped `raw`.
- Soft enforcement of blocks/blocked-by: Roubo shows a banner when an issue's blockers are still open, but does not refuse bench creation. This is a deliberate relaxation of today's hard-block behaviour for the new plugin world.
- Polling: on-demand and on UI events, no background timer.
- Paginated `listIssues` retrieval. Default page size 50; plugin exposes page size as a config setting. The UI pages through results.
- Automatic, atomic, all-or-nothing migration of existing GitHub.com projects on first launch of a Roubo build with the plugin runtime. Migration writes the user's selected sources to a per-user override (not the committed `roubo.yaml`), moves the OAuth token into the keyring slot, deletes `auth.json`, bumps a state-file version marker. Idempotent on re-run. One-time banner explains the change.
- Roubo project bench snapshot fields (`integrationId`, `externalId`) so active benches survive a project switching integrations. Pre-migration benches default to `integrationId: github-com` and `externalId` derived from the legacy numeric `number`.
- Plugin SDK package that plugin authors import for RPC binding and host helpers (`host.fetch`, `host.credentials.get`, `host.logger`, etc.). Published with author docs.
- Plugin auto-restart: up to 3 attempts within any 5-minute window per plugin. Beyond that, plugin is marked `errored` and the last-good issue snapshot is served until the user manually restarts.
- A "Test connection" button on the per-project configure flow that calls `plugin.validateConfig()` and surfaces errors inline before save.
- Forward-compat verification: a one-page paper sketch of what AI-agent and project-component plugin manifests + methods would look like, reviewed before host-API 1.0.0 freeze.

### Out of scope

- AI coding agent plugins (Claude Code, Codex, Gemini CLI stay built-in for now). Explicit follow-on slug.
- Project-component plugins (database, process components stay built-in for now). Explicit follow-on slug.
- In-app plugin marketplace or curated discovery. Discovery is via docs, blog posts, word of mouth.
- Plugin signing or Roubo-issued trust roots. Trust is rooted in user-accepted permissions plus the Git URL the user chose to clone from.
- Webhook or push-based updates. Polling only.
- Plugin-supplied React UI. Declarative shapes only.
- Jira Cloud as a validated target. The slug targets self-hosted / Data Center; Cloud may incidentally work but is not validated.
- Cross-plugin issue dedup. A Roubo project has exactly one active integration; we never dedup across plugins.
- Issue fields beyond the narrow normalized set: sprints, fixVersions, priorities, milestones, custom fields, attachments, comments are deferred.
- Write-back beyond status transitions and assign / unassign. No commenting on issues from Roubo. No PR-to-issue link-back (GitHub does this natively; Jira does not, and we are not adding it this slug).
- Hierarchical issue links: epics, parents, subtasks are deferred. The normalized contract carries only `blocks` and `blockedBy`.
- A Roubo-hosted OAuth callback for arbitrary GHE or Jira instances.
- A tarball / zip plugin install format. Bundled, Git URL, and local directory path are the three supported install sources.
- An exact-version or semver-range version pin in `roubo.yaml`. The user's locally installed plugin version is what runs.
- Meta-repo PR sync against non-GitHub integrations. Jira projects do not get PR-driven auto-clear in this slug.
- A documented `listIssues` time budget for "fetch everything." Replaced by paginated retrieval.

## Constraints

- Plugins run on the same Node runtime as Roubo. No native modules anywhere (host or bundled plugins). Hard constraint.
- **Roubo does not support Windows as a host platform** (licensing constraint surfaced 2026-05-21). All design and testing targets macOS and Linux only. Skip Windows-specific CLIs (PowerShell, `cmdkey`, DPAPI), Windows-only paths, and Windows CI runners.
- Credentials never written to disk in plaintext. OS keyring only, accessed via a host helper.
- Plugins cannot bring their own HTTP client. They must call `host.fetch`; the host performs the I/O and enforces the allowlist, system proxy, and self-signed-TLS opt-in.
- The host enforces manifest-declared permissions at runtime: network host allowlist, credential slot scopes, filesystem confinement to the plugin's own directory plus declared exceptions, and child-process spawning permission. No permission is checked by convention; the host owns enforcement.
- A Roubo project has exactly one active integration as its issue source at any time. The setting is checked-in to `roubo.yaml`, with field-level optionality and a per-user override merged on top.
- `roubo.yaml` `integration` block is field-level-optional. Examples: a small focused project commits `plugin` + `instance` + `sources` and every teammate shares them. A medium project commits only `plugin` + `instance`; sources are per-user. A large multi-team monorepo commits nothing under `integration`; every user configures their own. The effective config = committed `roubo.yaml` deep-merged with the user override.
- Plugin discovery locations are `plugins/` inside the Roubo app (bundled) and `~/.roubo/plugins/<plugin-id>/` (third-party). No other locations.
- Plugin runtime, manifest schema, permission vocabulary, and SDK API must be designed so AI-agent and project-component plugin kinds can be hosted in their respective follow-on slugs without a host-API major-version bump. Verified by a paper sketch before host-API 1.0.0 freeze.
- Migration is atomic all-or-nothing. Idempotent on re-run. Writes to per-user override, never the committed `roubo.yaml`.

## Non-functional expectations

- **Security:** Manifest-declared permissions enforced by host across four categories (network hosts, credential slots, filesystem, child-process spawning). OS-keyring credential storage. Self-signed TLS is per-plugin opt-in, off by default, warning shown when enabled. Third-party install presents a permissions dialog listing every requested permission plus the Git source URL; install does not proceed without user acceptance. Plugins cannot include personally identifying information in the opaque `raw` field unless functionally required; Roubo does not persist `raw` beyond an active bench's `assignedIssue`.
- **Performance:** `listIssues` is paginated with default page size 50 and a plugin-exposed config setting for page size. The UI pages through results without blocking. Per-call RPC timeout bounds slow plugin responses. No documented end-to-end "fetch everything" time budget for this slug.
- **Accessibility:** The Plugins settings page, the per-project Issue source tile, configure dialogs, source picker, and install permissions dialog all follow Roubo accessibility conventions: React Aria Components, keyboard navigation, focus management on open and close, visible focus rings.
- **Reliability:** Plugin crashes never crash the Roubo host or any other plugin. Supervisor auto-restarts up to 3 times within any 5-minute window per plugin; on exceeding the budget, plugin is marked `errored` and last-good issue snapshot is served. Host startup is independent of any plugin loading successfully. Migration writes all touched files atomically via `atomicWrite`; on any failure, roll back via the state-file version marker. Re-running migration on already-migrated state is a no-op.
- **Observability:** Per-plugin stdout / stderr are written to `~/.roubo/plugins/<plugin-id>/logs/` with size-based rotation. Plugin errors surfaced to the user include a stable identifier (plugin id, method name) so the user can correlate banner text with log file content.
- **Forward compatibility:** A one-page paper sketch of AI-agent and project-component plugin manifests + method sets is produced during host design and reviewed before host-API 1.0.0 freeze.

## Auth shapes per integration

- **GitHub.com (bundled):** keep the Roubo OAuth app. `roubo://oauth/github/callback` deep link retained. Migration moves the existing token from `auth.json` into the keyring slot.
- **GitHub Enterprise (bundled):** PAT + instance URL. No OAuth.
- **Self-hosted Jira (bundled, Data Center 8.14+):** PAT only. No username/password, no basic auth, no cookie-session.
- **Identity for write-back (all integrations):** the plugin implements `getCurrentUser()` and the host calls it once at config time, captures the user's external id, and stores it per project. All assign / unassign operations use that captured identity. The user never types their source-system username.

## Source picker shapes (declarative)

- **`multi-list`** (GitHub.com / GHE): one combined list of repositories + GitHub Projects with type labels. User selects any combination. Dedup uses `(integrationId, externalId)`.
- **`categorized-multi-list`** (Jira): tabbed sections for Boards, Epics, Filters. User selects any combination across categories. Dedup uses `(integrationId, externalId)`.
- Roubo core renders both shapes. Plugins return the shape descriptor + the candidate items via `listSourceCandidates`. Plugins do not return React.

## Write-back UX

- **Status transitions:** never auto-fire. Roubo shows a "Transition to" dropdown driven by the issue's `allowedTransitions` array (returned by the plugin in the normalized issue or via a separate `getAvailableTransitions(externalId)` RPC). The dropdown options are the actual next states the source workflow allows from the current state; Roubo reasons about the next stage rather than always offering "Done."
- **Assign / unassign:** an in-bench control that calls `plugin.assignIssue(externalId, userId)` with the user's captured identity (or `unassignIssue(externalId)` for unassign).
- Commenting and PR-to-issue link-back are NOT supported in this slug.

## Plugin lifecycle and management

- **Where the user manages installed plugins:** a new top-level "Plugins" settings page.
- **Where the user configures which integration is active for a project:** an "Issue source" tile on the project detail page.
- **What happens when a teammate clones a repo that declares a plugin in `roubo.yaml`:** Roubo prompts to install on project load, showing the plugin id and source (bundled / Git URL / local path) with the permissions dialog. One-click install + acceptance + project loads.
- **Install sources:** bundled (in-app), Git URL clone into `~/.roubo/plugins/<plugin-id>/`, local directory path. No tarball / zip.
- **Versioning:** `roubo.yaml` records plugin id only. No version pin or range. Each user runs whatever version they have installed locally. Plugins are responsible for backwards compat with their declared `hostApiVersion` range.
- **Configure-time validation:** a "Test connection" button calls `plugin.validateConfig()` and surfaces inline success / error before the user saves.

## Issue model details

- **State:** `currentState` (string, source-system name) plus `allowedTransitions` (array of strings, next-state names the source workflow allows). Plugins are responsible for surfacing the workflow position; Roubo is generic.
- **Blocks / blocked-by:** soft warning only. UI banner when an issue has open blockers; bench creation is NOT refused. Note: this is a deliberate relaxation of current Roubo behaviour, which hard-blocks. The PRD must surface this and the test plan must cover it.
- **Hierarchy:** out of scope this slug. No epics, parents, or subtasks in the normalized model.
- **Polling:** on-demand and on UI events. No background timer.

## Migration semantics

- **Trigger:** first launch of a Roubo build with the plugin runtime that detects a legacy GitHub.com project.
- **Atomicity:** all file writes via `atomicWrite`. On any failure, roll back via a state-file version marker. Idempotent on re-run.
- **Destination:** the migrated source selection is written to the per-user override file, NOT the committed `roubo.yaml`. Migration is a per-user concern; we do not auto-commit changes to a checked-in file.
- **Credentials:** the existing OAuth token in `~/.roubo/auth.json` is moved into the bundled github.com plugin's credential slot in the OS keyring. The legacy `auth.json` is deleted after successful migration.
- **Bench snapshots:** existing benches have `integrationId: github-com` defaulted and `externalId` derived from the legacy numeric `number`. They keep working; source-sync stays enabled because the github.com plugin is the same source. If a project later switches integration, those benches show an `Issue from previous integration` badge and source-sync is disabled for them.
- **Communication:** a one-time banner explains the change after migration completes.

## Adjacent work

- The existing `server/services/github.ts`, `github-auth.ts`, and `issue-assignment.ts` are superseded by the new bundled GitHub.com plugin. The `githubRequest` helper currently at `server/services/github.ts:255` should be preserved verbatim inside the plugin to retain ETag caching, primary and secondary rate-limit backoff, 30-second TTL caches, GraphQL batching for blocking relationships, and GitHub Projects v2 pagination behaviours. Re-deriving these in a fresh implementation is a known risk.
- The existing `/api/projects/:projectId/jigs/issue-type-mappings` endpoints continue to operate; issue type strings are now sourced from the active integration plugin rather than hardcoded to GitHub.
- The `/api/projects/:projectId/permissions` endpoint comments hardcoded to "Claude Code" are flagged for generalization in the next slug (AI-agent plugins).
- The `roubo.yaml` schema changes shape (a new optional `integration` block). The schema bump must be additive and backwards compatible; existing roubo.yaml files without an `integration` block must keep working.
- Planned follow-on slugs: AI-agent plugins, then project-component plugins. The runtime, manifest schema, and permission vocabulary designed here must accommodate both without a host-API major-version bump.

## Success criteria

### Leading (observed during build / alpha, before public release)

- The project owner uses the bundled GHE plugin against a real GHE instance and the bundled Jira plugin against a real self-hosted Jira instance, end-to-end, for at least two weeks before public release.
- Migration of existing GitHub.com projects produces zero user-visible errors across the alpha cohort.

The user explicitly did NOT pick the following as leading indicators, so they are not gates: external alpha testers per non-bundled integration, a third-party-built plugin in under a day.

### Lagging (measured 3 to 6 months after release)

- Zero P0 security incidents tied to plugin permissions in the first 6 months.
- Integration-config support volume stays under 10% of total support load through the first 6 months.

The user explicitly did NOT pick the following as lagging indicators, so they are not measured: % of new installs configuring a non-GitHub.com integration, count of community-built third-party integrations.

## Open questions

Resolve during PRD, architecture, or build stages. These were not put to the user during this interview.

- **Plugin lifecycle on config change:** when the user edits a plugin's config (instance URL, credentials, sources), does the plugin process restart, or does it live-reload? Lean: restart on config change for safety; live-reload only if a plugin opts in.
- **Plugin uninstall semantics when projects still reference it:** if a user uninstalls a plugin but a project's `roubo.yaml` references it, what happens on next project load? Lean: the same "missing plugin" prompt-to-install flow as for a teammate cloning a repo.
- **`Test connection` UX during initial bundled-plugin migration:** the github.com plugin gets a migrated token; should "Test connection" auto-run as part of migration verification, or stay user-driven?
- **Source-candidate paging:** is `listSourceCandidates` paginated like `listIssues`, or does it always return all candidates? Lean: always-all for now; paginate later if real Jira instances surface huge filter / board lists.
- **Per-plugin observability in the UI:** do we ship an in-app "view plugin logs" surface, or rely on the user opening files in `~/.roubo/plugins/<id>/logs/`? Lean: ship the in-app surface; per-plugin logs are part of the Plugins page already.
- **Exact zod schema and JSON Schema shape for `roubo.yaml`'s new `integration` block:** documented in PRD / architecture.
- **`hostApiVersion` semver bump policy after 1.0.0:** documented during architecture.
- **Status-transition write-back identity:** if `plugin.applyTransition(externalId, transition)` requires a user who has permission to do so, and the user's credentials only grant read-access on that workflow, how does the failure surface? Lean: plugin returns a structured error; Roubo surfaces it inline.

## Decisions made during interview

All decisions below correspond to a direct user selection during the structured Q&A on 2026-05-21. None are auto-mode guesses.

- **Plugin kinds in scope:** integrations only this slug.
- **GitHub.com:** full re-implementation as the bundled plugin.
- **In-scope capabilities:** Plugins page UI, third-party install via Git URL, published SDK + author docs.
- **Migration of existing GitHub.com users:** automatic + invisible.
- **Out-of-scope cuts:** marketplace, signing, webhooks, plugin React UI, Jira Cloud validation, cross-plugin dedup, narrow normalized issue fields.
- **Write-back stays in scope** (with specific operations below).
- **Write-back operations:** status transitions and assign / unassign. NOT commenting. NOT PR linking.
- **Plugin runtime:** child Node process per plugin, JSON-RPC over stdio.
- **Plugin language:** Node-only for this slug.
- **Plugin discovery dirs:** bundled `plugins/` + `~/.roubo/plugins/<plugin-id>/`. PLUS: the project's chosen integration plugin is recorded in `roubo.yaml`, so loading a project requires having the plugin installed.
- **`roubo.yaml` integration block:** field-level optional. Layered with a per-user override.
- **Merge semantics:** per-field deep merge of `roubo.yaml` integration block + user override.
- **Missing plugin on project load:** prompt to install.
- **Install sources:** bundled + Git URL + local directory path.
- **Versioning:** plugin id only in `roubo.yaml`.
- **Permission categories declared in manifest:** network hosts + credential slots + filesystem (beyond plugin dir) + child-process spawning.
- **Credential store:** OS keyring via pure-JS shellout to platform CLIs.
- **Self-signed TLS:** per-plugin opt-in, off by default, warning shown.
- **Native modules:** hard constraint, no native deps anywhere.
- **GitHub.com auth:** keep the Roubo OAuth app.
- **GHE auth:** PAT + instance URL.
- **Jira auth:** PAT only (Data Center 8.14+).
- **Identity for write-back:** derive from credentials at config time via `plugin.getCurrentUser()`.
- **Plugins UI location:** new top-level Plugins settings page.
- **Per-project integration config UI:** Issue source tile on the project detail page.
- **Source picker:** declarative shapes returned by plugins; host renders.
- **Status-transition triggers:** never auto. Roubo reasons about the next stage from the allowed-transitions list.
- **Issue state model:** plugin returns `currentState` + `allowedTransitions` in the normalized issue.
- **Blocks enforcement:** soft warning, not hard block. (Deliberate relaxation of current Roubo behaviour.)
- **Issue hierarchy:** out of scope; just blocks / blocked-by.
- **Polling:** on-demand + UI events. No background timer.
- **Migration mechanics:** atomic all-or-nothing on first launch.
- **Migration target:** writes to per-user override, NOT the committed `roubo.yaml`.
- **Plugin restart policy:** 3 attempts in 5 minutes, then mark errored.
- **Performance:** paginated `listIssues`, default page size 50, plugin-configurable.
- **Forward compatibility investment:** design intentionally + verify with a paper sketch before host-API freeze.
- **Test connection UX:** explicit button on the configure flow that calls `plugin.validateConfig()`.
- **Leading indicators of success:** owner dogfoods bundled GHE + Jira for 2 weeks before release; zero migration regressions across the alpha cohort.
- **Lagging indicators of success:** zero P0 security incidents in 6 months; integration-config support volume under 10% in 6 months.

## Re-interview - 2026-05-24: Security & quality issues option

> Scope: a single new requirement layered on top of the bundled github.com (and GitHub Enterprise) integration plugin. Adds an option to pull GitHub's "Security & quality" alerts alongside regular Issues. All clusters below were answered via interactive `AskUserQuestion` round-trips on 2026-05-24. Verbatim Q&A is in `qa-log.md` under the matching dated section.

### New requirement (one-liner)

Add a per-source option on the bundled github.com plugin (and, in this slug, the bundled GHE plugin as well) to also retrieve GitHub "Security & quality" alerts. These are surfaced in the existing normalized issue list, distinguished by a visible category chip, and are bench-creatable like any other issue. They are read-only with respect to write-back.

### Categories in scope

Three independent per-source booleans, default off:

- **Include Code Scanning alerts** (CodeQL or third-party SAST findings).
- **Include Secret Scanning alerts** (leaked tokens; private repos require GitHub Advanced Security; public repos always available).
- **Include Dependabot alerts** (dependency vulnerabilities; requires repo admin).

User can mix and match. No "include all security & quality" master switch; the three booleans are the model. No severity, state, or age filters this slug (deferred).

### Surfacing in the product

- Alerts are merged into the existing Issues list returned by `listIssues`.
- Each alert carries a category tag so the UI renders a distinct chip ("CodeQL", "Secret", "Dependabot") next to the title. The chip is the only required visual distinction.
- Bench creation has full parity with regular Issues: blueprint-by-issue-type lookup (issue types like `security-code-scanning`, `security-secret-scanning`, `security-dependabot` participate in the existing blueprint-by-issue-type UI), blocks / blocked-by stays empty (alerts don't have linked dependencies), assign uses the existing captured-identity flow (but see write-back below: assign is disabled for alerts).
- Source picker: no change. Alerts ride along with their parent repo; the per-source option determines whether alerts are pulled for that repo.

### Setting model and config location

- Three per-source booleans live as fields on the github.com / GHE plugin's per-source configuration (the source-level override, not the plugin-global config). Different teammates and different projects opt in independently.
- Follows the existing field-level-optional `roubo.yaml` integration block + per-user override pattern. The committed `roubo.yaml` MAY pin the booleans (so a team can require Dependabot alerts everywhere) but defaults are unset (= off) and the per-user override deep-merges on top.
- Plugin Configure dialog grows a single "Security & quality alerts" section per source row with three checkboxes.

### Auth and permissions

- The Roubo GitHub OAuth app's scope set MUST add `security_events` (existing tokens continue to work for regular Issues).
- The plugin detects, per source per pull, whether the user's current token grants `security_events`. If it does not AND any of the three booleans are on for that source, the plugin triggers an OAuth re-consent flow with an upgrade prompt that explains why the new scope is needed.
- Users who never enable any security category never see the re-consent prompt. The OAuth app change itself does not force existing users to re-consent.
- GHE Personal Access Tokens behave analogously: the plugin checks the token's scopes on each pull and, if `security_events` is missing while a category is enabled, surfaces a configure-dialog warning telling the user to regenerate the PAT.

### Failure semantics (degradation)

- Per-category graceful skip. If a category is enabled but unavailable (token lacks scope, repo doesn't have GHAS, Code Scanning disabled, Dependabot off, etc.), that category is silently skipped for that source on that pull. Other enabled categories continue to fetch. The Issues list is never bench-blocked by a misconfigured category.
- A warning chip is surfaced on the source row in the Configure dialog explaining the cause: "Code Scanning unavailable: GHAS not enabled on this repo.", "Dependabot alerts unavailable: token lacks `security_events`.", etc. Warnings are per-source per-category and dismiss themselves once the condition resolves on the next successful pull.

### Polling cost

- Alerts are fetched on the same trigger as Issues (on-demand and on UI events). No new background timer.
- Each enabled category becomes one additional paginated REST call sequence per source per pull. Same `page size` config the rest of `listIssues` uses; the UI pages through the merged result.
- No pre-emptive rate-limit headroom display in the Configure UI. Rate-limit errors, if they occur, surface through the existing plugin error path with the next-reset timestamp.

### Write-back semantics for alerts

- Alerts are read-only from Roubo. `allowedTransitions: []` and `assignees: []` on every alert.
- The bench's Transition dropdown is hidden when the assigned issue is an alert; the Assign control is disabled.
- Resolution happens by pushing code that fixes the underlying issue (GitHub auto-closes the alert). Dismissal from Roubo is explicitly out of scope.

### Normalized issue contract changes

- No new normalized fields. Alert-specific metadata (severity, CVE id, affected package, advisory URL, etc.) lives in the opaque plugin-scoped `raw` field. The category tag is carried as `issueType` (e.g. `security-code-scanning`).
- Future slug may promote severity to a normalized field if there is user pull; out of scope here.

### Integration parity within this slug

- Both bundled GitHub.com **and** bundled GitHub Enterprise plugins gain this option in this slug. Same code path (REST endpoints are identical between github.com and GHE); the GHE PAT auth shape carries the `security_events` scope check.
- Jira self-hosted plugin gains nothing. Jira has no equivalent surface; "out".

### Out of scope (explicitly recorded)

- Jira plugin parity (Jira has no equivalent surface).
- Write-back to alerts from Roubo: dismiss / resolve / re-open. Explicit follow-on if there is pull.
- Webhook / push delivery of new alerts ("notify me the moment Dependabot fires"). Polling-only, same as the rest of the integration runtime.
- Auto-creating benches when a high-severity alert fires. Bench creation stays user-initiated.
- Severity / state / age filter UI in the Configure dialog. Booleans only this slug.
- Sorting or grouping the merged Issues list by severity, category, or any alert-specific field beyond what the existing list already supports.
- Pre-emptive rate-limit headroom UI.
- Surfacing alert metadata (severity, CVE, package) as first-class normalized fields. Lives in `raw` only.

### Open questions raised during re-interview (all resolved downstream)

- **OAuth re-consent placement.** Resolved during the PRD stage: inline action inside the per-source warning chip (decisions-log.md 2026-05-24; FR-045). Replaces the top-level-banner and dedicated-section alternatives that were on the table at re-interview time.
- **Migration of pre-existing bench `assignedIssue` snapshots when a category is later disabled.** Resolved during the PRD stage: bench snapshot is frozen at create-time, list pull simply stops returning new alerts in that category, existing benches keep functioning (FR-050; decisions-log.md 2026-05-24). The architecture addendum confirms the BenchManager read path tolerates the frozen value.
- **Type-chip UI presence for regular Issues.** Resolved during the prototype stage: regular Issues do NOT receive a type chip. Chips render only for the three security categories (CodeQL / Secret / Dependabot). See screen 18 in prototype/mockups.md.
