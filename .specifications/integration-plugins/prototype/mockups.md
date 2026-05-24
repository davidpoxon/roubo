# Mockups: integration-plugins

Plain-language descriptions of every user-facing surface introduced by this slug. Each screen lists layout, components, copy, and state.

Component vocabulary (matches Roubo's existing conventions):

- React Aria Components: `Button`, `Dialog`, `TextField`, `Checkbox`, `Tooltip`, `MultiSelect`, `ListBox`, `Tabs`.
- Tailwind CSS 4 with the design tokens in `docs/brand.md` (stone foundation, amber-500 primary accent).
- Inter for UI text; JetBrains Mono for code, ports, paths.

---

## 1. Top-level Plugins settings page _(supports US-004, US-007, US-009)_

**Where:** new top-level entry on Roubo's settings screen, alongside Projects, Connections, etc.

**Layout:** two-column shell. Left rail: existing settings nav. Right column scrollable content.

**Header row:**

- Title: `Plugins` (Inter, weight 600, size xl).
- Subtitle: `Manage integration plugins for issue sources. Bundled plugins ship with Roubo; install community plugins from a Git URL or local directory.` (size sm, stone-600).
- Right-aligned primary `Button`: `Install plugin`.

**List section heading:** `Installed plugins` (weight 500, size base).

**List item card** (stacked, generous vertical gap):

- Plugin display name + version on the same row, monospace for version. Example: `GitHub.com 1.0.0`.
- Status pill: one of `Enabled` (green-700 text, green-100 bg) / `Disabled` (stone-600 / stone-100) / `Errored` (red-700 / red-100) / `Incompatible` (amber-700 / amber-100).
- Source label, JetBrains Mono, stone-500: either `Bundled` or `~/.roubo/plugins/<plugin-id>/`.
- One-line description from manifest, stone-700.
- Footer actions row, all `Button`s with `variant=tertiary` and amber hover state: `Configure` · `View logs` · toggle between `Enable` and `Disable` · `Uninstall` (only on third-party plugins).

**Empty state for third-party:** `No third-party plugins installed yet.` + secondary CTA `Install plugin`. Bundled plugins always render (you cannot uninstall them).

**Errored card variant:** the status pill is red, a red-50 banner sits inside the card with copy `Plugin failed to start after 3 restart attempts. Showing your last successful issue snapshot.` followed by inline links `View logs` and `Restart`.

**Incompatible card variant:** the status pill is amber, banner copy `This plugin declares Roubo host API ^2.0.0; your Roubo provides 1.0.0. Update the plugin or use a newer Roubo.`

**Keyboard nav:** Tab through cards in order. Within a card: action row is a single focus group. Enter on a card opens the configure dialog.

---

## 2. Install plugin dialog _(supports US-004, US-007)_

**Triggered from:** `Install plugin` button on the Plugins page.

**Dialog:** React Aria `Dialog`, modal, sized to about 480px wide.

**Title:** `Install plugin`.

**Body:** tabbed via React Aria `Tabs`, two tabs:

- `From Git URL` (default)
  - `TextField` labelled `Git URL`. Placeholder: `https://github.com/example/roubo-plugin-linear`. Mono font in the input. Help text below: `Roubo clones the repository into ~/.roubo/plugins/.`
  - `Install` button (primary). Disabled until the URL is non-empty and looks like a Git URL.
- `From local directory`
  - `TextField` labelled `Plugin directory`. Placeholder: `/Users/you/code/my-plugin`. Mono font.
  - Help text: `Useful for plugin authors developing locally. The directory must contain a roubo-plugin.yaml file.`
  - `Install` button.

**Footer:** `Cancel` button only (the primary CTA is inside each tab).

**State machine:**

1. Idle. User enters URL or path; `Install` enables.
2. Clicked: dialog shows a centered spinner with copy `Cloning...` (Git) or `Reading manifest...` (local). The `Install` and `Cancel` buttons disable.
3. On manifest load success → transition to the **Install permissions dialog** (next screen).
4. On error → inline red banner with the structured error. Examples:
   - `Could not clone repository. git exited with code 128: Repository not found.`
   - `roubo-plugin.yaml not found at /Users/you/code/my-plugin.`
   - `Plugin requires Roubo host API ^2.0.0; you have 1.0.0.`

---

## 3. Install permissions dialog _(supports US-007, FR-007)_

**Triggered after** the Install dialog successfully reads a manifest.

**Title:** `Install <Plugin Name>?`

**Subtitle:** `<plugin-id> <version> from <source>`. Source is either the Git URL or the local directory path, in JetBrains Mono.

**Permissions section heading:** `This plugin requests:` (weight 500).

**Permission rows:** each a small card with an amber dot accent (no divider line; whitespace separates):

- **Network access**
  - Sub-text lists every glob in `network.hosts`. Example: `*.atlassian.net`, `jira.acme.com`.
  - Tooltip on hover: `Roubo enforces this allowlist; the plugin cannot reach other hosts.`
- **Credentials**
  - Sub-text lists each slot name + description from the manifest. Example: `jira-token: Personal Access Token for Jira API access`.
  - Tooltip: `Credentials are stored in your OS keyring. Only this plugin can read its own slots.`
- **Filesystem (only shown if declared)**
  - Sub-text lists each declared path beyond the plugin's own directory.
- **Child processes (only shown if declared)**
  - Sub-text either lists the executable names (if the manifest is specific) or shows `Spawning child processes`.

**Footer disclosure:** small stone-500 caption, `Trust is rooted in the source URL you entered. Roubo does not verify plugin signatures.`

**Footer buttons:** `Cancel` (tertiary, left), `Install and enable` (primary, amber, right). The primary is the only way the install proceeds.

**Post-accept transitions to:** the new plugin's card on the Plugins page, with status `Enabled` and a brief toast `<Plugin Name> installed.`

---

## 4. Per-plugin configure dialog _(supports US-001, US-002, FR-034)_

**Triggered from:** `Configure` button on a plugin card (Plugins page), OR `Configure` button on the Issue source tile in a project detail page (see screen 6). The dialog renders the plugin's `configSchema` (from manifest) as a form.

**Title:** `Configure <Plugin Name>` (e.g. `Configure Jira (self-hosted)`).

**Form:** rendered from the plugin's manifest `configSchema` (a JSON-Schema-derived shape). For the bundled plugins, the fields are:

**GitHub.com plugin:**

- Read-only `Connected as <username>` block once OAuth is complete. Button `Re-authenticate` re-runs the OAuth flow.

**GitHub Enterprise plugin:**

- `TextField` labelled `Instance URL`. Placeholder: `https://ghe.acme.com`. Mono font in the value.
- `TextField` labelled `Personal access token`. Type: password. Help text: `Token must have `repo`and`read:project` scopes.`
- `Checkbox` labelled `Allow self-signed TLS certificates`. Default off. Help text below: `Only enable if your GHE instance uses an internal CA. A warning will appear in the Plugins page.`

**Jira (self-hosted) plugin:**

- `TextField` labelled `Instance URL`. Placeholder: `https://jira.acme.com`. Mono.
- `TextField` labelled `Personal access token` (type: password). Help text: `Generate from Jira > Profile > Personal Access Tokens (Data Center 8.14+).`
- `Checkbox` `Allow self-signed TLS certificates` (same as GHE).
- Disclosure section `Advanced` (collapsed by default):
  - `TextField` `'Blocks' link type name` (default `blocks`).
  - `TextField` `'Is blocked by' link type name` (default `is blocked by`).
  - `TextField` `Page size` (default `50`).

**Footer row:**

- Left: `Test connection` button (tertiary). Below it, a result strip that updates after the test runs.
- Right: `Cancel` (tertiary) · `Save` (primary). `Save` is disabled until `Test connection` has succeeded at least once for the current values (or, for re-opening with previously-saved values, immediately enabled).

**Test connection result strip states:**

- Idle: hidden.
- Running: spinner + `Connecting to <instance URL>...`
- Success: green check + `Connected as <Resolved User Display Name>.` (from `plugin.getCurrentUser`)
- Auth error: red dot + `Authentication failed: 401 Unauthorized. Check that the token is valid and has the required scopes.`
- Network error: red dot + `Could not reach <instance URL>: ENOTFOUND. Check the URL and your VPN.`
- TLS error: red dot + `TLS error: self-signed certificate. Enable 'Allow self-signed TLS' if your instance uses an internal CA.` Plus an inline `Enable` button that toggles the checkbox and re-runs.

**Save behaviour:** writes to the per-user override file (NOT roubo.yaml). Closes dialog. Toast: `Saved <Plugin Name> configuration.`

---

## 5. Per-plugin log viewer _(supports US-009, FR-015)_

**Triggered from:** `View logs` on a plugin card.

**Drawer or full dialog** (recommend right-side `Drawer` if Roubo has the pattern; otherwise a wide `Dialog`). Title: `<Plugin Name> logs`.

**Toolbar row:**

- File selector dropdown: `current.log` or `previous.log`.
- `Search` `TextField` for inline filter.
- `Refresh` button.
- `Open file location` button (opens the OS file browser at `~/.roubo/plugins/<id>/logs/`).

**Body:** monospace block, JetBrains Mono, size xs, dark background, fixed-height with scroll. Each line shows: timestamp (stone-500), level pill (info / warn / error), message. Errors highlight in red-50 with red-700 text.

**Empty state:** `No log entries yet.`

**Tail behaviour:** when scrolled to the bottom, auto-tail; when the user scrolls up, an inline button appears: `New entries (3). Jump to bottom`.

---

## 6. Per-project Issue source tile _(supports US-001, US-002, US-006, US-010, FR-018, FR-023)_

**Where:** the project detail page, sitting alongside other tiles (e.g. Containers, Inspections, Tools).

**Tile header:** small amber dot + label `Issue source` (weight 500). No divider line (per the design philosophy, whitespace separates tiles).

**Body — configured state:**

- Active integration: pill displaying the plugin name, e.g. `Jira (self-hosted)`. Stone-700.
- Instance URL row (only shown if the plugin has an instance field): JetBrains Mono, stone-600. Example: `jira.acme.com`.
- Selected sources, grouped by category for `categorized-multi-list`, plain list for `multi-list`. Example for Jira:
  - Boards: `Platform team (id 12)`, `Frontend team (id 14)`
  - Epics: `Q3 OKRs (PLAT-100)`
  - Filters: `My open issues (id 207)`
- Effective config note (small caption, stone-500). One of:
  - `Plugin and instance from roubo.yaml; sources from your override.`
  - `Configuration from your override; roubo.yaml has no integration block.`
  - `Configuration from roubo.yaml (committed for the team).`
- Action row: `Configure...` (tertiary) · `Switch integration...` (tertiary).

**Body — unconfigured state:**

- Stone-500 description: `No issue source configured for this project.`
- Primary CTA `Choose integration` opens the Switch integration dialog (screen 7).

**Body — configured but plugin missing (matches FR-024):**

- Amber dot + banner: `This project uses <plugin-id>, which is not installed.`
- Primary CTA `Install plugin` (opens the Install permissions dialog with the plugin pre-resolved from the project's roubo.yaml).
- Sub-text: `<sources detail>` if available.

---

## 7. Switch integration dialog _(supports US-006)_

**Triggered from:** `Switch integration...` on the Issue source tile, OR `Choose integration` from the unconfigured tile state.

**Title:** `Choose issue-source integration`.

**Body:**

- Stone-500 lead: `A project has exactly one active issue-source integration.`
- Radio group (React Aria `RadioGroup`) listing every enabled integration plugin. Each row:
  - Plugin display name (e.g. `Jira (self-hosted)`).
  - One-line description.
  - Pill `Currently active` next to the current selection.
- Sub-row under each option: `Configure...` link that opens the per-plugin configure dialog inline.

**Footer:**

- `Cancel` (tertiary).
- `Switch integration` (primary, amber). When switching from a configured integration:
  - Confirmation step (still in the same dialog): `Switching from <Old Plugin> to <New Plugin>. Your active benches will keep their stored issue snapshot and show an 'Issue from previous integration' badge. New benches will use <New Plugin>.`
  - `Cancel` · `Confirm switch`.

**On confirm:** updates per-user override (NOT roubo.yaml). Closes dialog. Issue source tile re-renders with the new integration. Toast: `Switched to <New Plugin>.`

---

## 8. Source picker — `multi-list` shape _(GitHub.com / GHE; supports US-001)_

**Triggered from:** `Configure sources` action inside the Configure dialog (screen 4), OR via the Issue source tile.

**Dialog title:** `Select sources for <Plugin Name>`.

**Layout:**

- Search `TextField` at top: `Search repositories and projects...`
- Below: `MultiSelect` list of items (Roubo's existing `MultiSelect.tsx` primitive). Each item:
  - Icon (repo vs Project glyph).
  - Item name. For repos: `acme/widgets`. For Projects: `Roadmap Q3`.
  - Type label, stone-500 size xs: `Repository` or `Project`.
- Selected-items strip at the bottom: shows the chosen items as removable chips with x.

**Footer:** `Cancel` · `Select N source(s)` (primary, label updates with count).

**Empty / loading states:**

- Empty: `No repositories or projects found. Check that your token has the right scopes.`
- Loading: skeleton rows.

---

## 9. Source picker — `categorized-multi-list` shape _(Jira; supports US-002)_

**Triggered from:** same actions as screen 8, when the active integration is Jira (self-hosted).

**Dialog title:** `Select sources for Jira (self-hosted)`.

**Layout:**

- React Aria `Tabs`. Three tabs in order: `Boards`, `Epics`, `Filters`. Tab badge shows selected count per category.
- Each tab body:
  - Search `TextField` `Search <boards/epics/filters>...`
  - `MultiSelect` list. Items in each tab:
    - Boards: name + `Board id 12`.
    - Epics: epic key + summary, e.g. `PLAT-100 — Q3 OKRs` (note: epic display key uses a hyphen, no em dash).
    - Filters: filter name + owner. Example: `My open issues (owner: jane.doe)`.
- Across-tab selected strip at the bottom: chips grouped by category.

**Footer:** `Cancel` · `Select N source(s) across M categories` (primary).

**Empty / loading:** same patterns as screen 8.

---

## 10. Bench view: Transition dropdown _(supports US-008, FR-036)_

**Where:** the existing bench view, near the assigned issue display.

**Component:** a `Button` that opens a popover menu. Label: `Transition: <currentState>` (e.g. `Transition: In Progress`). Button uses tertiary style with amber hover.

**Popover content:**

- Header label: `Move to:` (stone-500, weight 500, size xs).
- Menu items: one per entry in the issue's `allowedTransitions` array. Each item is the transition's display name (e.g. `In Review`, `Blocked`, `Done`). No other states are shown; if `allowedTransitions` is empty, the popover shows `No transitions available from this state.`
- On click: optimistic UI update (the button label flips to the new state), call `plugin.applyTransition`. On error: revert + inline red banner under the button with the structured error from the plugin (e.g. `Your token lacks permission to transition this workflow.`).

**Disabled states:**

- If the plugin is errored or disabled, button shows a tooltip on hover: `<Plugin Name> is currently unavailable. Last seen state shown.` Click is a no-op.

---

## 11. Bench view: Assign / unassign control _(supports FR-037)_

**Where:** next to the Transition dropdown.

**Component:** a small `Button` that toggles between two states:

- `Assign to me` (when the captured user identity is not in `assignees`).
- `Unassign me` (when it is).

**On click:** optimistic toggle, calls `plugin.assignIssue` or `plugin.unassignIssue`. On error: revert + same inline error pattern as the Transition dropdown.

**Tooltip on `Assign to me`:** `Assigns this issue to <Resolved User Display Name> on <Plugin Name>.`

---

## 12. Soft-block warning banner _(supports FR-030)_

**Where:** in the bench-creation flow (Issue picker modal or wherever a user starts a bench from an issue), AND on the bench detail page if a bench is open against a blocked issue.

**Component:** amber-50 background, amber-500 border-left accent (no full border, follows the design philosophy of accent dots over divider lines), amber-900 text.

**Copy variants:**

- One open blocker: `This issue is blocked by <PROJ-100> (still open). You can create the bench anyway.`
- Multiple open blockers: `This issue is blocked by <PROJ-100>, <PROJ-105>, and 2 others (all open). You can create the bench anyway.`

**Behaviour:** banner is informational only. The `Create bench` button is NOT disabled. Cursor on the blocker keys reveals tooltips with the blocker titles.

**This is a deliberate change from current Roubo behaviour, which hard-blocks creation.** The PRD calls this out at FR-030. Tests must cover both the hard-block site (`server/services/issue-assignment.ts:102`) and the UI counterpart (`client/src/components/IssuePickerModal.tsx:91`) flipping in lockstep.

---

## 13. Migration banner _(supports US-003, FR-027)_

**Where:** top of the application shell, shown once after a successful migration.

**Component:** a slim banner, full-width, stone-100 background, stone-800 text, single line of copy with a `Learn more` link.

**Copy:** `Roubo now manages GitHub integration through a plugin. Your projects have been migrated; you don't need to take any action.` Followed by a tertiary link `Learn more` (opens a help page in the user's browser) and a close `x`.

**Dismiss state:** dismissed banner does not reappear; the migration version marker tracks dismissal.

**Error path:** if migration failed and rolled back, the banner copy changes to red-tinted: `Roubo could not migrate your GitHub configuration automatically. Your existing setup is unchanged. Open the Plugins page for details.` with a link `Open Plugins page`.

---

## 14. Missing-plugin prompt on project load _(supports US-005, FR-024)_

**Triggered when:** the user opens a project whose effective integration config references a `plugin` id that is not installed locally.

**Component:** `Dialog`, modal.

**Title:** `Plugin needed for this project`.

**Body:**

- Stone-700 lead: `This project uses the <plugin-id> plugin, which isn't installed in your Roubo.`
- Source resolution panel. One of three cases:
  - **Bundled** (theoretically impossible, but shown for completeness): `Bundled plugin missing. Reinstall Roubo.`
  - **Resolvable from project hints** (if a sibling `roubo.lock` or another teammate's history is available — see Open questions): `Install from <Git URL or local path>` button.
  - **Not resolvable**: a `TextField` labelled `Where can Roubo install <plugin-id> from?` with placeholder `https://github.com/example/roubo-plugin-...`. Below it: `Or install from a local directory`. Secondary path opens the local-dir picker.

**Footer:** `Skip for now` (tertiary, dismisses the dialog; the project loads with the Issue source tile showing the missing-plugin banner from screen 6) · `Install` (primary). Clicking `Install` proceeds through the Install permissions dialog (screen 3) and then completes the project load.

---

## 15. Active-bench badge: `Issue from previous integration` _(supports US-006, FR-028)_

**Where:** within an existing bench's header, when the bench was created against an integration that has since been changed.

**Component:** a small `Tooltip`-wrapped pill, stone-100 background, stone-700 text. Copy: `Issue from previous integration`.

**On hover:** tooltip explains: `This bench's issue came from <Old Plugin>, which is no longer the active integration for this project. Source sync is disabled for this bench. Clear or merge this bench when done.`

**Behaviour:** source-sync controls inside the bench are visibly disabled. Transition and assign actions still attempt to call the plugin and surface errors if it's not installed.

---

## 16. Plugin restart and recovery surfaces _(supports US-009, FR-013, FR-014)_

Two related affordances:

**Last-good-snapshot banner** (across the app, header-level): if any active plugin is `errored`, a slim banner reads: `Showing the last successful issue snapshot from <Plugin Name>. The plugin is currently unavailable.` A `Manage plugins` button links to the Plugins page.

**Restart button on errored card** (Plugins page): visible when status is `errored`. Copy: `Restart`. On click: the host clears the restart-window counter and attempts to start the plugin. The card shows a spinner; success transitions to `Enabled`; failure stays `errored` with the same banner.

---

## 17. Migration banner — text variants

Three states across the lifecycle:

- **Success (one-time):** the banner from screen 13.
- **Rolled back:** the error variant in screen 13.
- **Skipped by user (not in current PRD; flagged in context.md open questions):** if we add an "ask permission first" mode later, the dismissal of the prompt is a third state. NOT shipped this slug.

---

## State transitions overview

A simplified state machine across the surfaces:

1. First launch with new Roubo binary → migration runs → either screen 13 (success) or 13-error.
2. User opens an existing GitHub.com project → Issue source tile shows configured state pointing at github-com plugin.
3. User opens a project with a missing plugin → screen 14 (missing-plugin prompt) → either install via screen 3 then back to project, or dismiss and see the missing-plugin tile state (screen 6 variant).
4. User picks `Switch integration` → screen 7 → confirm → tile updates, existing benches gain the badge in screen 15.
5. User picks `Install plugin` from Plugins page → screen 2 → screen 3 → new card appears on Plugins page.
6. Plugin crashes → restart loop bounded by FR-013 → card transitions to errored (screen 1, errored variant) → last-good-snapshot banner from screen 16 shows globally.

---

## Copy that must NOT contain em dashes

Per CLAUDE.md, the following copy strings must use periods, commas, parentheses, or colons rather than em dashes:

- Effective config note ("Plugin and instance from roubo.yaml; sources from your override.")
- Soft-block banner copy (uses parentheses around blocker keys).
- Permission dialog row labels (use colons).
- Transition popover label (uses colon: `Move to:`).

This is enforced at write time, not visually. Any future text additions to these screens must keep the rule.

---

# Addendum - 2026-05-24: Security & quality issues option

> Scope: the Configure-dialog and Issues-list surfaces added by the 2026-05-24 PRD addendum. Layered on top of the screens above. New mockups extend screens 4, 6, and 10; new screens are 18, 19, and 20. Read after the original screens for full context.

## 4 (extended). Per-plugin configure dialog - github.com + GHE _(supports US-011, US-012, FR-040, FR-045, FR-046)_

Both the github.com and GHE plugin configure dialogs gain a new section that appears **per source** in the source list, immediately below the existing per-source row (the row that today shows the repo / Project name and a remove icon).

**Section title:** `Security & quality alerts` (subtle h4-weight label with the amber-500 section-anchor dot used elsewhere on the page).

**Section body:** three React Aria `Checkbox` rows.

1. `Code Scanning alerts` - help text below in muted weight: `CodeQL or third-party SAST findings on this repo.`
2. `Secret Scanning alerts` - help text: `Leaked tokens committed to the repo. Private repos require GitHub Advanced Security.`
3. `Dependabot alerts` - help text: `Known vulnerabilities in this repo's dependencies. Requires repo admin.`

All three default unchecked. Each checkbox tooltip names the GitHub REST endpoint and required scope on hover. No "select all" affordance (decision: three booleans is the model).

**State variants per checkbox row:**

- `Off (default)`: just label + help text + checkbox.
- `On, no warning`: checked checkbox; help text replaced with a one-line green-check status: `Active. Last pull returned <N> open alerts.` where `<N>` is the count from the last successful pull.
- `On, warning chip` (the meat of US-012): the row grows a warning chip immediately under the help text. Chip is a React Aria `<Button>` rendered as an amber-bordered pill with a small triangle warning glyph. Chip text is the human-readable cause string. Examples:
  - `Code Scanning unavailable: GHAS not enabled on this repo.` (cause: HTTP 404/410)
  - `Secret Scanning unavailable: requires GitHub Advanced Security on private repos.` (cause: HTTP 451)
  - `Dependabot unavailable: token lacks security_events permission. Click to upgrade.` (cause: missing scope; this variant is also the re-consent affordance, see screen 19)
  - `Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.` (cause: `X-OAuth-Scopes` header absent on fine-grained GHE PAT; NFR-015 graceful path)
- `Off but previously on with frozen benches` (FR-050 honesty surface): help text reads `Off. <K> existing benches still show alerts from this category.` in muted weight. No warning chip. Helps the user understand the toggle has no destructive side effect.

**Position in the dialog:** for each repo source in the source list, the `Security & quality alerts` section is collapsed by default behind a disclosure triangle to keep the dialog compact when none of the three are enabled. The disclosure label shows a chip count when one or more categories are on: `Security & quality alerts (Code Scanning, Dependabot)`.

**Save behavior unchanged:** per-source booleans persist to the existing per-user override file. Toggling a checkbox on for a source where the token lacks `security_events` opens the inline re-consent flow described in screen 19 before Save is allowed to commit.

---

## 18. Issues list: category chip _(supports US-011, FR-041, FR-043)_

The existing project Issues list (rendered by `IssueQueuePanel.tsx` and `IssuePickerModal.tsx`) gains a category chip rendered to the LEFT of each issue's title for issues whose normalized `issueType` is one of `security-code-scanning`, `security-secret-scanning`, or `security-dependabot`. Regular Issues remain unchanged (no chip).

**Chip variants:**

- `CodeQL` - charcoal text on a muted slate background.
- `Secret` - charcoal text on a muted amber background (more attention-grabbing because of the redaction sensitivity).
- `Dependabot` - charcoal text on a muted blue-gray background.

All three use the JetBrains Mono font at the small-uppercase weight already used for technical chips elsewhere. Chip height matches the existing `Pull request` chip. Tooltip on hover shows the alert's external id (`wday-planning/roubo#code-scanning-17`) so users can correlate with GitHub's UI.

**Row metadata:** no severity surfaced in the row (decision: lives in `raw`, not normalized). The user must click into the bench detail view to see severity if the bench is created. Sort order, filtering, and grouping behave identically to regular Issues.

---

## 10 (extended). Bench view: Transition / Assign for alert-backed benches _(supports FR-048)_

When a bench's `assignedIssue.issueType` is one of the three security categories:

- The `Transition to:` dropdown described in screen 10 is HIDDEN entirely (not rendered, not disabled-and-greyed). In its place a single muted line reads: `Resolved by pushing code that fixes the underlying alert. GitHub auto-closes the alert.`
- The `Assign to me` / `Unassign` control described in screen 11 is rendered but DISABLED with a tooltip on hover: `Security alerts cannot be assigned from Roubo. They are repo-level findings, not user-assigned work.`
- All other bench affordances (start, stop, clear, blueprint selection, logs, terminal) work identically to a regular-Issue bench.

**Rationale shown to the user:** the bench detail header surfaces the category chip from screen 18 alongside the title, so the differentiated controls are visually justified.

---

## 19. OAuth re-consent inline action _(supports US-011, FR-045)_

Triggered when the user toggles any of the three category checkboxes on (in screen 4-extended) AND the stored token lacks `security_events`. Rendered inline within the source row's warning chip from screen 4-extended; not a top-level banner.

**Visual:** the warning chip text changes to `Dependabot unavailable: token lacks security_events permission. Click to upgrade.` and the chip becomes a clearly-actionable button (cursor changes to pointer; amber border thickens on hover).

**On click:**

1. Chip enters a `Connecting...` state with a small spinner replacing the glyph.
2. A React Aria `<Dialog>` opens with copy: `Upgrade GitHub connection. Roubo needs additional permission to read security & quality alerts (security_events). You'll be redirected to GitHub to authorize this scope. Your existing connection stays valid.` Buttons: `Cancel` (tertiary), `Continue to GitHub` (primary).
3. On `Continue to GitHub`, Roubo opens the OAuth authorize URL in the external browser (same `roubo://oauth/github/callback` deep link the existing GitHub.com OAuth uses). The dialog closes; the chip stays in `Waiting for browser...` state.
4. On successful callback, the chip clears (because the next probe succeeds) OR re-renders with the next applicable cause (e.g. `Dependabot unavailable: not a repo admin.` if the user is missing admin rights on this specific repo).
5. On cancel or callback failure, the chip reverts to the unauthenticated cause string with a small `Retry` text link inside.

**State announcement (NFR-014):** chip state transitions (idle, connecting, waiting, success, error) are announced via a React Aria live region so a screen-reader user hears `Upgrading GitHub connection.` → `Waiting for browser authorization.` → `Connection upgraded. Dependabot alerts will appear on the next pull.`

**GHE plugin variant:** for the GHE plugin, the same chip text appears but the action is `Open token settings on <instance URL>` (a plain link to the GHE instance's PAT page); there is no OAuth flow. After regenerating the PAT manually the user pastes it back into the existing `Personal access token` field on the dialog.

---

## 20. Test connection: per-category status _(supports US-013, FR-047)_

Extends the test connection result strip described in screen 4. When at least one category is enabled on the source whose `Test connection` button was clicked, the result strip stacks per-category rows beneath the existing connection result.

**Layout:**

```
[ok] Connected as @david.poxon.
[ok] Issues: ok (read 1 item).
[ok] Code Scanning: ok (read 1 item).
[warn] Secret Scanning: GHAS not enabled on private repo.
[ok] Dependabot: ok (read 1 item).
```

Each category row uses the same icon vocabulary as the broader status strip: green check for ok, amber triangle for unavailable (with cause), red dot for hard failure (e.g. 5xx). Disabled categories do not get a row. Timeouts surface as `[warn] <Category>: timed out` and do not fail the overall connection test (FR-047).

**Probe details:** each enabled category endpoint is called with `per_page=1` in parallel after the existing `validateConfig` call returns. Total wall-clock budget for the strip stays inside the existing connection-test budget; if the per-category probes outrun it, individual category rows render `Timed out` while the overall result stays whatever `validateConfig` returned.

---

## State transitions overview (addendum)

New transitions layered on the state machine above:

7. User toggles a category checkbox ON for a source. If token has `security_events`: row renders `Active.` and next pull merges alerts (US-011, FR-041). If not: row's warning chip becomes the re-consent action (screen 19).
8. User toggles a category checkbox OFF for a source with K existing alert-backed benches. The K benches keep showing alerts (FR-050); the row renders the `<K> existing benches still show alerts from this category.` muted help text.
9. User clicks Test connection on a source with categories enabled. Per-category rows render (screen 20) with ok / unavailable + cause / timed out per category, independent of the overall connection result.
10. User completes OAuth re-consent. Stored token replaced in place in the keyring (existing slot). On the next pull, the chip clears OR re-renders with a different cause if the new scope still cannot reach a specific category endpoint (e.g. repo-admin requirement for Dependabot).

---

## Copy that must NOT contain em dashes (addendum copy)

The new copy strings introduced by the addendum:

- All warning chip cause strings (use colons, periods).
- The Transition-hidden line on alert-backed benches (`Resolved by pushing code that fixes the underlying alert. GitHub auto-closes the alert.`) - period-separated.
- The OAuth re-consent dialog body (period-separated, no dashes).
- The per-category Test connection rows (`Code Scanning: ok (read 1 item).`) - colon + period.
- The `<K> existing benches still show alerts from this category.` muted help text - period.

Same enforcement rule as the broader feature.
