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

---

# Re-interview mockups - 2026-05-25 (UI/UX polish, GitHub settings consolidation, e2e harness)

Plain-language descriptions of every new surface introduced by US-014..US-025. Same conventions as sections 1..20 above: React Aria primitives (Button, Dialog, ToggleButton, Switch, Listbox, ComboBox, ColumnGroup, Tooltip), Tailwind for layout, Inter for UI text, JetBrains Mono for code/technical values. Design language follows `docs/brand.md`.

## 21. Status chip - taxonomy and surfaces _(supports US-014, FR-051..FR-055, NFR-016, NFR-017)_

### Layout
A `StatusChip` component with five canonical variants. Each variant combines colour AND a non-colour signal (icon prefix + shape) so it remains distinguishable in greyscale and under colour-blind palettes (NFR-016). Pill shape, height 22px, padding 6px horizontal, font size 12px, font weight 500 (Inter). Icon size 12px, sits 4px left of the label.

| Variant | Colour token | Icon | Copy | Notes |
|---|---|---|---|---|
| `connected` | `emerald-500` background, `emerald-50` text | dot (filled circle) | "Connected" | Resting healthy state. |
| `disconnected` | `stone-300` background, `stone-700` text | slash (-) | "Not connected" | Plugin enabled but no credentials. |
| `auth-problem` | `amber-500` background, `amber-900` text | key (key outline) | "Sign in again" | Token expired or 401. |
| `errored` | `red-500` background, `red-50` text | alert-triangle | "Error" | Rate-limit, unreachable, crash, or never-checked. Detail in tooltip. |
| `disabled` | `stone-200` background, `stone-500` text | dash (em-rule alternative drawn as a 6px horizontal bar) | "Disabled" | Bundled plugin not yet enabled. Never reflects connectivity. |

The chip text label is followed by a tiny "as of HH:MM" suffix in `text-stone-400 text-[10px] ml-2`, except for the `disabled` variant which never carries a timestamp.

### Three placement surfaces

**Surface A - Plugin card on Settings > Plugins.** Chip sits in the top-right corner of the tile, opposite the plugin name. See section 22 for the full tile layout.

**Surface B - Configure modal header.** When the user opens the Configure dialog for a plugin, the dialog header contains: plugin icon (24x24), plugin name (Inter 16px / weight 600), the status chip flush right. The chip in the header is identical to the tile chip; same component, same data source.

**Surface C - Per-project integration tab tile.** The active integration plugin's tile inside the per-project Settings page (the renamed tab from section 26) shows the same chip in the tile header.

### Tooltip on hover
For `auth-problem` and `errored` variants, hovering the chip surfaces a Tooltip (React Aria Tooltip) with a one-line explanation and the last-error detail. Example: `auth-problem` -> "Token expired 2 hours ago. Click Configure to sign in again." `errored` -> "Rate-limited until 14:42 UTC. Cut list shows last-known data."

### Behaviour
- The chip renders synchronously from the cached value (NFR-017: <50ms render).
- On UI events that trigger an opportunistic re-check (Settings > Plugins tab open, Configure modal open, cut-list load), the chip enters a transient "rechecking" state where the timestamp text reads "rechecking..." with a 12px subtle pulse animation. When the re-check returns, the chip updates with no flash.
- The `disabled` chip never enters the rechecking state.

## 22. Settings > Plugins - grid layout _(supports US-015, FR-056, FR-057, FR-058, NFR-016)_

### Layout
The Settings page wrapper changes from `max-w-4xl` (constrained) to `w-full` with a left/right padding of 32px (`px-8`). Every tab benefits from the wider container.

Inside the Plugins tab, the plugin list is now a CSS Grid: `grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4`. Tiles wrap responsively without explicit breakpoints. 1 column at narrow widths (<760px), 2 at default (~1100px), 3+ on wide displays.

### Tile content (top to bottom)
1. **Header row**: plugin icon (32x32, left), plugin name (Inter 14px / weight 600), status chip (right-aligned). Header padding: 16px top/horizontal.
2. **Description row**: one-line plugin description (Inter 13px / weight 400, `text-stone-600`). Truncated to two lines with ellipsis.
3. **Spacer**: 16px.
4. **Footer row**: React Aria Switch (`ToggleButton` styled as a switch) labelled "Enabled" / "Disabled" on the left; primary action button on the right (label `Connect` if no credentials, `Configure` once connected). Footer padding: 16px bottom/horizontal.

Tile background: `bg-stone-50`. Border: `border border-stone-200 rounded-lg`. Hover state: `border-amber-500/40`, `shadow-sm` transition over 200ms.

### Empty state
If the user has installed no plugins beyond the bundled three and the bundled three are all disabled, the grid renders the three bundled tiles with the `Disabled` chip. There is no separate empty state.

### Keyboard navigation (NFR-016)
Tab order moves through tiles in DOM order: tile 1 enable toggle, tile 1 primary action, tile 2 enable toggle, tile 2 primary action, etc. Inside a tile, Enter on the primary action opens the Configure dialog; Space on the toggle flips enable state.

## 23. Bundled plugin - disabled state on a fresh install _(supports US-016, FR-059, FR-060)_

### Layout
On a fresh install (no state file version marker, see FR-059), the user's first visit to Settings > Plugins shows three bundled plugin tiles (github.com, GitHub Enterprise, Jira) each with:

- Enabled toggle in the OFF position.
- `Disabled` chip in the header.
- Primary action button reading `Connect` (since the plugin has no credentials AND is disabled). Clicking `Connect` performs two actions in one click: enables the plugin AND opens the Configure modal pre-focused on the credentials field. The user is shown a small inline "Plugin enabled" toast after the modal opens.

### Copy
- Description for github.com: "Pull issues from github.com repositories. Sign in with GitHub."
- Description for GitHub Enterprise: "Pull issues from your company's GitHub Enterprise instance."
- Description for Jira: "Pull issues from self-hosted Jira Data Center 8.14 or later."

### Migration semantics for existing installs
Existing installs (state file already carries a `version` marker) bypass FR-059's default-disabled logic entirely. The tiles render whatever enable state the install already had. No migration banner is shown for this change; users notice no difference unless they install fresh.

## 24. Project-load - "Enable plugin" prompt _(supports US-017, FR-061, NFR-022, NFR-024)_

### Layout
A React Aria `Dialog` opens centred over the project list view when the user clicks a project whose `roubo.yaml` references a disabled bundled plugin. The dialog is 480px wide, padding 24px.

Dialog content:
- **Title** (Inter 16px / weight 600): "Enable [plugin name] to load this project?"
- **Body** (Inter 14px / weight 400, `text-stone-600`): "This project's `roubo.yaml` specifies `[plugin name]` as its issue source. The plugin is currently disabled. Enabling it will let Roubo pull issues from this project."
- **Footer buttons** (right-aligned, 12px gap): `Cancel` (secondary), `Enable and load project` (primary amber).

### Focus management (NFR-022)
On open: focus moves to the primary `Enable and load project` button. Tab cycles inside the dialog. Esc cancels (returns to project list with no state change). Enter on the focused button activates it.

### Failure path (NFR-024)
If the Enable click fails because the plugin process refuses to start (manifest error, host-API mismatch), the dialog displays an inline error block above the buttons (red border, alert-triangle icon, error text). The plugin remains disabled; the project does not load. The user can dismiss the modal or try Configure to fix the underlying problem.

### Telemetry
NFR-019: the dialog Enable click is logged as a structured event with `pluginId` only; no enable-state payload leaves the device.

## 25. Cut-list filters - status exclusion + plugin-declared facets _(supports US-018, US-019, US-020, FR-062..FR-067, NFR-021)_

### Layout
The cut-list page already has a filter row above the issue table (existing component). This stage extends that row.

New filter dropdowns, left to right after the existing Status filter:
1. **Status** (existing) - multi-select. When the user opens this dropdown, the items already excluded by the resolved `excludedStatuses` config (FR-062) are shown with a subtle "Hidden by default" tag and a checkbox state of OFF. The user can toggle them back ON for the current cut-list view (session-scoped toggle, does not persist to config).
2. **Plugin-declared facets** (new) - rendered from `filterFacets()` (FR-065). For github.com / GHE this includes `Milestone` (multi-select enum). For Jira this includes `Epic` (multi-select enum-async). Each facet is a separate dropdown.

Filter chips below the row show active filters. The session-scoped "show hidden statuses" toggle renders as an `Including hidden: Closed, Done` chip with an X to remove.

### Per-source override surface (US-019)
Inside the Configure modal for a plugin, each source row has an `Advanced` disclosure. Inside that disclosure: an `Excluded statuses` chips input pre-populated with the resolved per-source value (merged from plugin-global + per-project + per-source). The user can add or remove statuses; the change is per-source and persists into `roubo.yaml`'s `sources[<id>]` block.

### Default-exclusions transparency
At the top of the Status filter dropdown, a single line of body copy reads: "By default, Closed, Done, Resolved, In review, PR open, and Waiting on reviewer are hidden. Toggle them above to include." Users can also navigate to the plugin Configure dialog to change the default at the plugin-global layer, or to the per-project Settings to change it at the project layer.

### Performance (NFR-021)
Toggling a facet or status filter triggers a client-side recompute only (no server fetch). Recompute and re-render complete within 50ms p95 for up to 500 issues. A subtle skeleton on the row count (`72 issues -> 14 issues`) animates the change.

## 26. Per-project Settings - plugin-driven tab _(supports US-022, US-023, FR-069..FR-073)_

### Layout
The per-project Settings page is a tabbed surface. Today's tabs: `Overview`, `Identity`, `Project setup`, `Issue source`, others. After this scope:

- The `Identity` tab keeps project name, default branch, Roubo-managed paths.
- The `Issue source` tab is renamed to the active integration plugin's display name: `GitHub`, `GitHub Enterprise`, `Jira`. When no integration is configured, the tab is named `Source`.
- Repository path, linked GitHub Project, and meta-repo submodule list move OUT of `Identity` and INTO the renamed tab.

### Renamed-tab content (top to bottom)
1. **Header row**: plugin icon + plugin display name (Inter 16px / 600), status chip (right-aligned). Same component as the global plugin tile header.
2. **Connection block**:
   - Primary action button. Label is `Connect` if no credentials are configured, `Configure` if connected (FR-072). Clicking opens the same modal in both cases (the Configure modal already mocked in sections 4 and 4 extended).
   - The legacy `Choose sources` button is gone (FR-072).
3. **Identity fields block** (moved from `Identity` tab):
   - Repository path / GitHub repo URL field (read-only when not configured; editable inside the modal).
   - Linked GitHub Project (Project v2 board) field. Includes a `Browse projects` action that opens a picker.
   - Meta-repo submodule list. Rendered as a read-only table of submodule name + path. The submodules block is only visible when the repo is a meta-repo.
4. **Source picker block**: the existing multi-list (github.com / GHE) or categorized-multi-list (Jira) picker, unchanged.
5. **Advanced disclosure**: per-source overrides (excluded statuses, see section 25). Closed by default.

### GHE parity (FR-073)
GitHub Enterprise plugin renders the same tab layout with one extra read-only line: `Instance: https://github.acme.com`. The single Connect/Configure button switches label identically.

### Tab title fallback
When the project has no `roubo.yaml` integration block (newly-created project that hasn't picked an integration yet), the tab is titled `Source`. Inside the tab, a CTA reads "Pick an integration to track issues for this project." with a `Choose integration` button that opens a small dialog listing enabled plugins.

### Sidebar / breadcrumb
The renamed tab title also appears in the project sidebar (current tab list) and in the breadcrumb. Open question from PRD resolved: yes, the rename propagates to both. Implementation note: the tab list is currently hardcoded in `ProjectSettings.tsx`; this stage requires it to read the active integration's display name from the project state.

## 27. Connect / Configure button - context-aware single button _(supports US-023, FR-072, FR-073)_

### Layout
A single button slot in the integration tab's connection block. Component is a React Aria `Button` with the primary action style (amber-500 background, white text, 10px padding, rounded-md).

### State machine
- **State A - No credentials configured**: button label `Connect`. Tooltip: "Set up [plugin name] for this project."
- **State B - Credentials configured, connected**: button label `Configure`. Tooltip: "Edit [plugin name] settings."
- **State C - Credentials configured, auth-problem**: button label `Sign in again`. Tooltip: "Token expired. Click to refresh."
- **State D - Credentials configured, errored**: button label `Configure`. The error chip in the header carries the actionable text.

Clicking opens the same Configure modal (sections 4 / 4 extended) in every state. The modal opens focused on the most relevant field for the state (credentials for A and C, sources for B).

### No "Choose sources" button
The `Choose sources` button is removed from the project Settings page entirely. Source selection happens only inside the Configure modal.

## 28. Cut-list chip taxonomy _(supports US-021, FR-068, NFR-016)_

### Categories and visual treatment
Each chip category combines a distinct colour with a distinct non-colour signal:

| Category | Colour | Shape / icon | Example labels |
|---|---|---|---|
| Status | `emerald-500` family (open=emerald, in-progress=amber, blocked=red, done=stone) | Pill (rounded-full) | Open, In progress, Blocked, Done |
| Label | `cyan-500` family, opacity-tinted | Square corners (rounded-sm), border-only style | bug, feature, good-first-issue |
| Issue type | `violet-500` family | Pill with leading icon (icon varies by type: bug=bug, feature=spark, chore=wrench) | Bug, Feature, Chore, Task, CodeQL, Secret scanning, Dependabot |
| Metadata cluster | `stone-500` family | Pill with leading key icon (key varies: milestone=flag, priority=arrow-up, assignee=user, security=shield) | Milestone v1.2, P1, @alice, Critical |

### Greyscale fallback
When the user's system is in high-contrast or colour-blind palette, the chips fall back to the shape / icon signal only. The chips remain distinguishable by border style and icon prefix.

### Density
Cut-list rows can show up to ~6 chips before truncation. Truncation rule: prioritise Status > Issue type > Metadata > Label. The truncated count renders as a `+N more` chip in the metadata bucket.

## 29. Playwright e2e harness - developer-facing surface _(supports US-025, FR-077..FR-080, NFR-018)_

### What the user sees
None - this is a maintainer-facing surface. There is no UI for the harness itself.

### Files added under repo root
- `e2e/` directory containing `*.spec.ts` files. Each spec exercises one or more flows from FR-080.
- `e2e/fixtures/stubbed-plugin/` - the deterministic fake plugin process (FR-078). Implements the full plugin RPC contract.
- `playwright.config.ts` - existing file already in repo at `/Users/david.poxon/Developer/roubo/playwright.config.ts` per feasibility findings, extended to point at the new spec set.
- `server/routes/test.ts` - new env-gated route file. Exposes `POST /test/__reset` (FR-079). Disabled when `process.env.ROUBO_E2E !== '1'`.

### Stubbed-plugin determinism (NFR-018)
The stubbed plugin process accepts a startup arg `--scenario=<name>` that selects from a fixture pack. Each scenario is a JSON file under `e2e/fixtures/stubbed-plugin/scenarios/` describing the deterministic responses to every RPC call. Time is pinned via a `--now=<ISO-8601>` arg; the stub uses that as its clock for `checkedAt` and any other timestamp.

### CI integration
Existing `pr-check` workflow gets a new job `e2e` that runs `npx playwright test` against the built Roubo app. The job has its own retry budget of 0 (NFR-018: 10/10 zero-flake). If any spec fails on the first run, the job fails the PR.

## 30. Alerts addition - cut-list chip + Configure block _(supports US-024, FR-074..FR-076)_

This was previously sketched in sections 18 and 4-extended above. This re-prototype confirms that with the new chip taxonomy from section 28, alerts integrate cleanly:

- CodeQL / Secret scanning / Dependabot chips render with the `Issue type` category (violet, with their respective icons: shield for CodeQL, key for Secret, package for Dependabot).
- The per-source `Include CodeQL alerts` / `Include Secret scanning alerts` / `Include Dependabot alerts` Checkboxes from section 4-extended remain inside the Configure modal's per-source row (Advanced disclosure).
- Inline OAuth re-consent affordance (section 19) renders inside the per-source warning chip when the user toggles a category ON for a github.com source. For GHE (PAT), the same affordance renders an inline reminder string instead of the OAuth button.

## State transitions overview (2026-05-25 addendum)

```
[fresh install]
  -> bundled plugins all disabled, Disabled chip on each tile
  -> user clicks Connect on github.com tile
       -> plugin enabled (toast)
       -> Configure modal opens focused on credentials
       -> user completes OAuth
       -> chip flips to Connected

[existing install]
  -> bundled plugins retain prior enable state, no change

[user opens project that needs disabled bundled plugin]
  -> Enable prompt modal opens
  -> user clicks Enable
       -> plugin enabled (persistent state updated)
       -> project loads
  -> user clicks Cancel
       -> returns to project list, no state change

[cut-list opens]
  -> opportunistic re-check fires for each enabled plugin
       -> chip enters "rechecking" state on each tile
       -> on response, chip updates (no flash)

[token expires]
  -> next re-check returns auth-problem
       -> chip flips to amber "Sign in again"
       -> single button label changes from Configure to Sign in again
       -> tooltip surfaces "Token expired N hours ago"
```

## Copy that must NOT contain em dashes (2026-05-25 addendum copy)

- "Enable [plugin name] to load this project?"
- "This project's roubo.yaml specifies [plugin name] as its issue source."
- "Plugin enabled"
- "Sign in again"
- "Token expired. Click to refresh."
- "Token expired N hours ago."
- "By default, Closed, Done, Resolved, In review, PR open, and Waiting on reviewer are hidden."
- "Pick an integration to track issues for this project."
- "Set up [plugin name] for this project."
- "Edit [plugin name] settings."
- "Cut list shows last-known data."
- "Rate-limited until HH:MM UTC."

## Open questions for the architecture stage

- **`pluginEnableState` storage location.** Extend `~/.roubo/state.json` with a new `pluginEnableState: Record<pluginId, boolean>` field, or create a separate `~/.roubo/plugins-state.json`? The state.json extension keeps one file; a separate file isolates plugin concerns and avoids schema-version drift on the existing state. Architecture picks one.
- **`filterFacets()` value population.** Should plugins return facet `options` eagerly (one batch on `filterFacets()` call) or lazily (the host calls a `getFacetOptions(facetId)` on demand when the dropdown opens)? Eager is simpler but slow for large enums (e.g. all assignees in a giant repo). Lazy is more complex but scales. Architecture picks one.
- **Status chip rechecking concurrency.** When the cut-list opens, opportunistic re-check fires for all enabled plugins simultaneously. Should the host throttle to N concurrent (and which N)? Or run all in parallel? Per-plugin in-flight de-dup is non-negotiable; concurrency policy is open.
- **`/test/__reset` blast radius.** Should the route reset only the plugin-manager singleton, or all server-side caches (project-registry, state cache, OAuth tokens)? Wider blast radius makes specs more isolated but slower. Architecture picks the boundary.
- **Sidebar / breadcrumb integration.** Confirmed in this stage that the renamed tab title propagates to sidebar and breadcrumb. Architecture must specify whether the project state model carries a derived `activeIntegrationDisplayName` or whether each consumer derives it from the project's integration block.
