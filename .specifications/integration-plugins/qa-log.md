# Q&A log: integration-plugins

> Interview date: 2026-05-21
>
> All questions below were asked via `AskUserQuestion`. All answers are the user's actual selections (or their typed clarifications). Auto mode was on for the surrounding orchestrator, but the interview itself was conducted as real Q&A per durable feedback memory `feedback-product-flow-interview`.

## Cluster 1: Vision, scope, GitHub.com rewrite

**Q1.1: Which plugin kinds should this slug actually deliver?**

- Options: Integrations only · Integrations + AI-agent plugins · All three kinds in one slug
- **A:** Integrations only

**Q1.2: How aggressive should the GitHub.com re-implementation be?**

- Options: Full re-implementation · Wrapper, not rewrite · Defer to follow-on slug
- **A:** Full re-implementation as the bundled GitHub.com plugin

**Q1.3 (multi-select): Which in-scope items should be in this slug?**

- Options: Plugins page UI · Third-party install · Plugin SDK + docs · Automatic migration
- **A:** Plugins page UI, third-party install via Git URL, plugin SDK + docs
- (Automatic migration not picked; revisited in cluster 2)

## Cluster 2: Confirm cuts, clarify migration

**Q2.1: Migration of existing GitHub.com users — what do you actually want?**

- Options: Auto + invisible · Auto behind explicit user action · No migration, legacy path keeps working · No migration, no legacy path
- **A:** Yes, automatic + invisible to users

**Q2.2 (multi-select): Scope cuts A — pick what you want OUT.**

- Options: Write-back · Webhook/push · Marketplace · Signing
- **A:** Marketplace, signing, webhooks
- (Write-back NOT cut → write-back stays in scope.)

**Q2.3 (multi-select): Scope cuts B — pick what you want OUT.**

- Options: Plugin React UI · Jira Cloud · Cross-plugin dedup · Narrow issue fields
- **A:** Plugin React UI, Jira Cloud, cross-plugin dedup, narrow normalized fields (all four cut)

## Cluster 3: Write-back ops and runtime architecture

**Q3.1 (multi-select): Which write-back operations does this slug need?**

- Options: Comment on issue · Transition status · Assign/unassign · Link PR to issue
- **A:** Transition status, assign / unassign
- (Commenting and PR-link write-back NOT in scope.)

**Q3.2: How should plugins actually run?**

- Options: Child Node process + JSON-RPC over stdio · In-process module loading · Docker per plugin · WebAssembly sandbox
- **A:** Child Node process per plugin, JSON-RPC over stdio

**Q3.3: Are plugins always Node, or do we leave the door open?**

- Options: Node-only · Any executable · Pluggable runtimes per manifest
- **A:** Node-only for this slug, revisit later

**Q3.4 (multi-select): Plugin discovery locations.**

- Options: Bundled `plugins/` · `~/.roubo/plugins/<id>/` · Project-scoped under repo · npm-style global
- **A:** Bundled `plugins/`, `~/.roubo/plugins/<plugin-id>/`
- **PLUS user-typed clarification:** "If a project is defined to use an integration plugin, then that config will be stored in the project's roubo.yaml. This means that any other user will first need to have that plugin before they can load the project into Roub[o]"
- This was a load-bearing addition. It moved the integration choice into `roubo.yaml` itself, triggering cluster 4.

## Cluster 4: Where does the integration choice live (single re-asked question)

After the previous answer, the orchestrator initially proposed four pre-canned models for "where does the integration choice live." The user declined to pick one and instead asked to clarify, noting:

> "On the one hand, some projects will have very specific issue sets, so it makes sense to set the integration / how issues are retrieved at the project level. Other projects will be very large with multiple teams working on them, and centralising how issues are retrieved, i.e., by committing the config to GitHub, would not be helpful as it would be defined team by team, potentially user by user."

**Q4.1 (re-asked, with previews): Who decides which integration + sources a project uses, and where does that decision live?**

- Options: Layered (roubo.yaml + per-user override) · Plugin choice in roubo.yaml, sources per-user · Everything per-user · Everything in roubo.yaml
- **A:** No option selected. User typed:
  > "each value in the roubo.yaml should be optional, e.g., roubo.yaml has the integration but not the sources so the user provides the sources in the override. or the roubo.yaml does not set an integration at all, so the user sets the whole thing in their override."
- **Captured as:** layered with per-field optionality. Effective config = roubo.yaml + per-user override, merged.

## Cluster 5: Merge semantics, missing plugin, install sources, versioning

**Q5.1: Merge semantics for roubo.yaml + user override.**

- Options: Per-field deep merge (with preview) · Whole-block replace · Override fills gaps only
- **A:** Per-field deep merge

**Q5.2: When a teammate clones a repo whose roubo.yaml references a plugin they don't have installed, what happens?**

- Options: Prompt to install on load · Load with banner · Refuse to load
- **A:** Roubo prompts to install on project load

**Q5.3 (multi-select): How can users install plugins?**

- Options: Bundled · Git URL · Local directory path · Tarball / zip
- **A:** Bundled, Git URL, local directory path
- (Tarball / zip NOT in scope.)

**Q5.4: How are plugins versioned in roubo.yaml?**

- Options: Plugin id only · Plugin id + semver range · Plugin id + exact version · No version at all
- **A:** Plugin id only

## Cluster 6: Trust, permissions, credentials

**Q6.1 (multi-select): What permission categories should a plugin manifest declare?**

- Options: Network hosts · Credential slots · Filesystem · Child-process spawning
- **A:** All four

**Q6.2: How does the host store credentials?**

- Options: OS keyring via pure-JS shellout · Electron safeStorage · Native-module keyring · Encrypted-at-rest file
- **A:** OS keyring with pure-JS shellout to platform CLIs

**Q6.3: How should self-signed TLS be handled?**

- Options: Per-plugin opt-in · Global Roubo setting · Custom CA bundle · Never allow
- **A:** Per-plugin opt-in, off by default, warning shown when enabled

**Q6.4: Is the 'no native modules' rule a hard constraint?**

- Options: Hard constraint · Soft preference · No constraint
- **A:** Hard constraint

## Cluster 7: Auth shapes per integration

**Q7.1: GitHub.com authentication — what does the bundled plugin support?**

- Options: Keep Roubo OAuth app · OAuth + PAT both · PAT only
- **A:** Keep the Roubo OAuth app (current behaviour)

**Q7.2: GHE authentication — what does the bundled GHE plugin support?**

- Options: PAT + instance URL · PAT plus optional GHE OAuth · OAuth-only per-instance
- **A:** PAT + instance URL

**Q7.3 (multi-select): Self-hosted Jira authentication.**

- Options: PAT (Data Center 8.14+) · Username + API token · Username + password · Cookie-session
- **A:** Personal Access Token (Data Center 8.14+) only

**Q7.4: How does Roubo know the user's identity on the source system?**

- Options: Derive from credentials at config time · User enters explicit username · Pick from list every time
- **A:** Derive from credentials at config time via `plugin.getCurrentUser()`

## Cluster 8: Surfacing UX

**Q8.1: Where does the Plugins management UI live?**

- Options: New top-level Plugins settings page · Inside existing Connections area · Per-project, no global page
- **A:** New top-level 'Plugins' settings page

**Q8.2: Where does the user configure which integration is active for THIS project + sources?**

- Options: Issue source tile on project detail page · Tab in project settings dialog · Inline wizard on first project open
- **A:** Issue source tile on the project detail page

**Q8.3: How does the source picker render?**

- Options: Declarative shapes, host renders · Always-stacked sections · Always-tabbed
- **A:** Declarative shapes the plugin returns, host renders

**Q8.4 (multi-select): When should Roubo transition an issue's status?**

- Options: Bench created → In Progress · PR merged → Done · Bench cleared → To Do · Never auto
- **A:** Never auto, user explicitly transitions from a Roubo UI control
- **PLUS user-typed clarification:** "We should reason about what the next stage is, rather than just going straight to 'done'"
- Captured as: plugin exposes `allowedTransitions`; Roubo's dropdown offers the actual next states from the source workflow, not a generic "Done."

## Cluster 9: Issue model details

**Q9.1: How rich is the normalized issue state?**

- Options: Current state + allowed next-state array (with preview) · Binary open/closed + separate transitions RPC · Full workflow graph
- **A:** Plugin returns current state name + an array of allowed next-state names

**Q9.2: How strictly does Roubo enforce blocks / blocked-by?**

- Options: Hard block · Soft warning · Display-only
- **A:** Soft warning. Show a banner but let the user proceed.
- (Deliberate relaxation of current Roubo behaviour, which hard-blocks.)

**Q9.3: Are issue hierarchies (epics, parents, subtasks) included?**

- Options: Just blocks/blocked-by · Add parent + children · Add full epic hierarchy
- **A:** Just blocks / blocked-by; no parent/child or epic hierarchy this slug

**Q9.4: How does Roubo poll source systems?**

- Options: On-demand + UI events · On-demand + background timer · Plugin decides
- **A:** On-demand + UI events. No background timer.

## Cluster 10: Migration, reliability, performance

**Q10.1: Migration mechanics for existing GitHub.com projects.**

- Options: Atomic all-or-nothing · Atomic + 30-day undo · Ask permission first
- **A:** Atomic all-or-nothing migration on first launch

**Q10.2: Where does the migrated project's selected GitHub Project end up?**

- Options: User override · Committed roubo.yaml · Ask the user
- **A:** User override

**Q10.3: Plugin failure handling — auto-restart policy?**

- Options: 3 in 5 min then errored · Indefinite with backoff · No auto-restart
- **A:** Auto-restart up to 3 times within 5 minutes, then mark errored

**Q10.4: Performance budget for `listIssues` on a typical project (~500 issues).**

- Options: 10s warm / 30s cold · 5s / 15s · 30s / 60s · No documented budget
- **A:** No pre-canned option selected. User typed:
  > "We need to introduce paginated retrieval of issues. The default should be 50, but we should expose this as a config setting in the plugin"
- Captured as: paginated retrieval. Default page size 50. Plugin-exposed configurable. No "fetch-all" time budget.

## Cluster 11: Forward-compat, validate, success criteria

**Q11.1: How much do we invest THIS slug for forward compatibility?**

- Options: Design intentionally + paper sketch · Notes-to-self only · Ignore future kinds
- **A:** Design intentionally; verify with a paper sketch before host-API freeze

**Q11.2: Should the configure flow include a 'Test connection' button?**

- Options: Yes, explicit button · Yes, on save · No
- **A:** Yes — button calls `plugin.validateConfig()` and surfaces errors inline

**Q11.3 (multi-select): Leading indicators.**

- Options: Owner dogfoods 2 weeks · External alpha tester per integration · 100-line third-party plugin in a day · Zero migration errors
- **A:** Owner dogfoods 2 weeks; zero migration errors
- (External alpha tester and third-party-in-a-day NOT picked.)

**Q11.4 (multi-select): Lagging indicators.**

- Options: 20% non-GitHub installs in 6 months · 1+ community plugin in 6 months · Zero P0 security incidents · <10% support load
- **A:** Zero P0 security incidents in 6 months; <10% support load on integration config
- (Adoption % and community-plugin count NOT picked as gates.)
