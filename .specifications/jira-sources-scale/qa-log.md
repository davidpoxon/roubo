# Q&A Log: jira-sources-scale

Verbatim record of the interview. Questions asked by the orchestrator via
`AskUserQuestion`; answers are the user's selections (recorded verbatim).

## Round 1 — Core design model

**Q1. How should source selection be reframed mentally? Today it's a flat tab of
Boards / Epics / Filters pulled from the whole instance. What's the primary way a
developer should narrow down to their issues?**

A1: Project-first, then refine.

**Q2. Which source types should the redesigned Jira picker support? (Pick all that
should exist.)**

A2: Project, Board (scrum/kanban), Saved filter (JQL), Epics / raw JQL / mine —
"For Option 4, just epics and mine" (i.e. Epics + "assigned to me"; raw JQL excluded).

**Q3. Closed/Done tickets are leaking into the cut list today because status exclusion
runs client-side, not in the query. How should excluded statuses work?**

A3: Push into JQL, fully user-editable.

**Q4. Is a developer's source configuration personal to them, or committed and shared
with the team?**

A4: Team default + personal override.

## Round 2 — Discovery, scale, scope, success

**Q5. How should users find the right project/board/filter when there are thousands?
And how should we fix the 'truncated, can't-tell-which-is-which' problem?**

A5: Server-side type-ahead + rich labels.

**Q6. Roughly how large is the Jira instance this must handle? (Pick the closest
magnitude so we size pagination/search correctly.)**

A6: Very large (Workday-scale).

**Q7. What's the scope boundary for this redesign? (multi-select)**

A7: jira-self-hosted plugin, Fix modal clipping bug, Host picker contract.
(Not selected: Migrate existing configs.)

**Q8. What does success look like? What's the signal that tells us this redesign
worked? (multi-select)**

A8: Time-to-configure, No wrong/closed issues, Picker never stalls/truncates,
Self-serve no support.

## Round 3 — Gap closing

**Q9. You didn't select 'migrate existing configs'. People already have sources
configured under the old boards/epics/filters shape. What should happen to them?**

A9: Clean break, re-pick.

**Q10. The seed notes some developers span multiple projects/boards. How many sources
should a single Roubo project be able to combine?**

A10: Multiple, mixed types.

**Q11. Is Jira Cloud in scope, or is this strictly the self-hosted (Server/Data Center)
plugin?**

A11: Self-hosted only.

**Q12. Epics had the worst scale problem (all-instance, 50-cap, no search). With the
project-first model, what's their fate?**

A12: Keep, project-scoped + searchable.
