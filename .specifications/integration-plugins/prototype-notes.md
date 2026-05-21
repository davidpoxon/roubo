# Prototype notes: integration-plugins

> Stage: prototype · Written: 2026-05-21

## Intent and scope

The prototype is intentionally low-fi: plain-language mockups in `prototype/mockups.md` describing every user-facing surface from the PRD. No runnable Vite app this stage; per Roubo's CLAUDE.md guidance, plain-language descriptions outperform abstract ASCII diagrams or premature visual fidelity for design discussions. The user selected this shape during the prototype-stage checkpoint.

The mockups cover all ten user stories. Surfaces covered:

1. Top-level Plugins settings page.
2. Install plugin dialog (Git URL / local directory tabs).
3. Install permissions dialog.
4. Per-plugin configure dialog (with Test connection result strip).
5. Per-plugin log viewer.
6. Per-project Issue source tile (configured / unconfigured / missing-plugin variants).
7. Switch integration dialog.
8. Source picker `multi-list` shape (GitHub / GHE).
9. Source picker `categorized-multi-list` shape (Jira).
10. Bench view Transition dropdown.
11. Bench view Assign / unassign control.
12. Soft-block warning banner.
13. Migration banner (success and error variants).
14. Missing-plugin prompt on project load.
15. Active-bench `Issue from previous integration` badge.
16. Plugin restart and recovery surfaces.

## Design decisions made during this stage

- **Plain-language markdown over runnable prototype.** The user selected this option at the prototype checkpoint. The trade-off: faster iteration, easier to scan, but no clickable interaction testing for keyboard nav / focus traps. Architecture stage should flag any decision that depends on clickable interaction testing as something to validate with a quick HTML or Storybook spike during build.
- **Whitespace + colored accent dots over divider lines.** Followed the design philosophy in `CLAUDE.md` and `docs/brand.md`: section headers in tiles use small amber dots, not horizontal rules. The Plugins page list uses card stacking with generous vertical gap rather than dividers.
- **Test connection result strip rather than separate dialog or toast.** Inline below the button so the user sees the cause directly. Failure paths surface structured plugin errors verbatim (no Roubo wrapper text) plus a contextual fix link where one exists (e.g. the TLS-error `Enable self-signed TLS` inline button).
- **Soft-block banner uses amber-50 background + amber-500 left accent, NOT a destructive red.** The action is allowed; the warning is informational. Red is reserved for destructive or error states.
- **Migration banner is intentionally slim.** Stone-tinted, dismissable, full-width. Avoids the "important corporate announcement" feel; conveys "we updated something behind the scenes; here's a Learn more if you care."
- **Missing-plugin prompt has three resolution modes** (bundled, project-hint-resolvable, manual entry). The third path is the catch-all; the second is aspirational and depends on whether we ship a `roubo.lock`-equivalent file (open question for architecture).
- **`Configure sources` is a separate dialog from `Configure plugin`.** Configure plugin handles instance URL + credentials + advanced settings; Configure sources handles the source picker. Both are reached from the Issue source tile; the configure dialog has a link/button to "Configure sources" inside it. Rationale: source selection can require a working connection (the picker calls `listSourceCandidates`), so it makes sense to separate.
- **Active-bench badge is intentionally non-destructive.** A small stone pill with tooltip explanation. Source sync controls are visibly disabled. The user can still transition / assign via the still-installed plugin; the only blocked path is "refresh this issue from source", which would conflict with the new integration's normalized contract.
- **Transition popover renders only `allowedTransitions`.** No hidden states, no greyed-out options. If the array is empty, the popover communicates that explicitly.

## What did NOT change from the PRD

- Permission category list (4 categories) is enforced visually in the install dialog.
- Single integration per project is enforced via the Switch integration dialog rather than letting two integrations coexist.
- Migration is one-way and invisible; the mockups intentionally do NOT include an "undo migration" affordance because the PRD does not include one.
- Plugin signing / marketplace / webhook surfaces are absent because they are out of scope.

## Open questions surfaced for the architecture stage

- **`roubo.lock`-equivalent for plugin resolution.** Screen 14 (missing-plugin prompt) is most useful when Roubo knows where to install the missing plugin from. We could ship a per-project committed `roubo.lock` (or extend `roubo.yaml`) that records the install source for each referenced plugin. Architecture stage to decide: ship a lock-like artifact this slug, or require the user to enter the source when prompted.
- **Per-user override file location and format.** PRD names it `~/.roubo/` based; architecture must pick a concrete path and shape. Recommendation: `~/.roubo/projects/<projectId>/integration.override.yaml`. Confirm during architecture.
- **Where the "Test connection has succeeded at least once for the current values" state is tracked.** This is a Save-button gate. Trivial to track in dialog-local state; architecture should note it.
- **`Drawer` component for the log viewer.** Roubo may not have a Drawer primitive today; if not, the log viewer falls back to a wide `Dialog`. Architecture should call out whether we introduce a Drawer primitive this slug or stick with Dialog.
- **Optimistic UI update semantics for Transition / Assign actions.** What happens if `applyTransition` succeeds on the source system but Roubo's process crashes mid-flight? Recommendation: persist nothing; reconcile from the source on next refresh. Architecture must call this out.
- **Migration banner versioning.** Once dismissed, never shown again — but across Roubo versions, do we re-show on a new feature? Recommendation: no; once dismissed, dismissed forever. Architecture confirms.
- **Plugin restart-window counter reset semantics.** When the user clicks `Restart` on an errored card, the 3-in-5-minutes window resets. Architecture confirms this is the intended UX (vs. e.g. resetting only on successful start).
- **Source picker pagination.** `listIssues` is paginated per FR-022, but `listSourceCandidates` is not in the PRD. If a Jira instance has hundreds of filters, the picker may need its own pagination or aggressive virtualization. Architecture should call this out as a real risk on instances with many filters.

## Screenshots

No screenshots produced in this stage. The mockups are textual. If visual mockups are required before architecture begins, raise it as a checkpoint follow-up.
