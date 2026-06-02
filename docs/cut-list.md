# The Cut List

The cut list is the unified, paginated list of work that Roubo shows for a project: open issues and security alerts, drawn from every source the project is configured against. This document explains the high-level approach to building that list, with particular attention to how paging works across multiple sources. It is a description of the model and the guarantees it provides, not a walk through the code.

For the `roubo.yaml` source configuration that feeds this, see [Configuration Reference](./configuration.md). For how the integration plugins are wired, see [Integrations](./integrations.md).

## What the cut list is

The cut list answers one question for a project: "what could I pick up right now?" It is a single, ordered stream of items that the UI paginates as the user scrolls. Two kinds of item appear in it:

- **Issues**: open issues from the project's configured repositories and GitHub Projects.
- **Security alerts**: open GitHub Advanced Security findings, in three categories, code scanning (CodeQL / code quality), secret scanning, and Dependabot (dependency vulnerabilities).

Issues and alerts are normalized into a single item shape so the UI can filter, group, and render them together. Alerts are read-only: they can be opened and injected into a bench, but they carry no assignees or state transitions.

## What feeds it: sources

A project does not point at a single repository. It points at a set of **sources**, and the cut list is the union of work across all of them.

For a GitHub-family project, the sources are derived automatically:

- The **root repository** declared in the project config.
- **Every git submodule** of that repository whose remote resolves to a GitHub `owner/repo`.
- Any **GitHub Projects (v2)** owned by those repositories' owners.

This is the important mental model for everything below: a single Roubo project routinely spans several repositories at once. A meta-repo with three submodules is a four-repository project. The cut list has to gather issues and alerts from all four and present them as one list.

Each repository source independently carries opt-ins for the three alert categories, so a project can surface, for example, Dependabot alerts from its submodules without enabling secret scanning anywhere.

## How retrieval works: the model

Retrieval follows a deliberately simple contract between two layers:

- **The host** (Roubo's server and UI) owns the cut list as the user sees it. It requests one page at a time. It holds a single **cursor**, which it treats as an opaque token: it never inspects or constructs it. It stops when a page comes back with no next cursor.
- **The integration plugin** owns the sources. Given the full set of configured sources and a cursor, it returns one page of normalized items plus the next cursor. All knowledge of "which sources exist, how each one paginates, where alerts come from" lives here.

```
            request page (sources, cursor)
   HOST  ───────────────────────────────────────▶  PLUGIN
         ◀───────────────────────────────────────
            page of items + nextCursor (opaque)

   The host loops: feed nextCursor back in until it is null.
```

The host hands the plugin the entire source set on every request. The plugin is responsible for aggregating across all of them. This is the key design decision: **aggregation is the plugin's job, and it is hidden behind a single opaque cursor.** The host does not loop over sources, and it does not know how many there are.

## The paging scheme

### Design goals

The scheme is built to satisfy a few non-negotiable properties:

1. **Completeness.** Every open issue and every open alert from every source must appear somewhere in the list.
2. **No duplicates.** An item must not appear on more than one page.
3. **Alerts up front.** A source's security alerts should arrive with that source's first page, not be buried deep in pagination, so a vulnerability is visible immediately.
4. **Independent progress.** Sources have wildly different sizes. A 2-issue submodule must not hold back a 2000-issue monorepo, and a drained source must drop out cleanly.
5. **Opaqueness.** The host must not need to understand any of this. One token in, one token out.

### The composite cursor

The mechanism that makes this work is a **composite cursor**. Conceptually it is a small map:

```
{ "<source A>": "<source A's own cursor>",
  "<source B>": "<source B's own cursor>",
  ... }
```

Each source keeps paginating in whatever scheme is natural to it (repository sources use a page number, GitHub Project sources use an offset). The composite cursor simply records, for each source that still has more to give, where that source should resume. Sources that have been fully read are absent from the map. The map is serialized into the single opaque string the host carries.

Two rules drive how the map evolves from page to page:

- **Membership means "not yet exhausted."** A source appears in the cursor only while it has a next page. The moment a source runs dry, it falls out of the map and is never queried again for this scroll.
- **The values are owned by each source.** The aggregator stores and replays each source's resume-token verbatim. It never interprets them, so each source's own paging logic stays self-contained.

### First request

When the host asks for the first page it sends no cursor. The plugin treats this as "every source starts at the beginning":

- All sources are active. Each is read from its first page, in parallel.
- Because each source is on its own first page, each one also fetches its security alerts (see the first-page rule below).
- The results are concatenated in a stable source order (root repository first, then submodules, then projects).
- A fresh composite cursor is built from whichever sources reported that they have more pages. If none do, the next cursor is null and the list is complete in one page.

### Subsequent requests

For every later page the host sends back the opaque cursor it last received. The plugin:

- Decodes it into the per-source map.
- Activates **only the sources present in the map.** Exhausted sources are skipped entirely, with no API calls made on their behalf.
- Reads each active source from its recorded resume point, advancing it by one page. No active source is on its first page anymore, so **no alerts are fetched.**
- Rebuilds the cursor from whichever sources still have more.

### When paging ends

The list ends when the rebuilt cursor is empty, which the plugin signals by returning a null next cursor. Because every source removes itself from the cursor as soon as it drains, the cursor monotonically shrinks and the loop is guaranteed to terminate.

### Alerts and the first-page rule

Alerts are not paginated alongside issues. Instead, each source fetches **all** of its open alerts in one shot, on that source's first page, and appends them after that page's issues. Internally the alert fetch walks all of its own pages, so the full alert set for a source is delivered together.

This rule is what guarantees goals 2 and 3 at once:

- **Up front:** a source's alerts always land on its first page, never deeper.
- **No duplicates:** because alerts are fetched only on the first page, later pages of the same source never re-emit them.

The practical consequence: by the time the host has loaded the first page from the plugin, it already holds every alert from every source. Later pages are pure issue continuation.

### Page size and how alerts fit

The page size is a limit on **issues per source**, not on the page as a whole. It defaults to 50 and is capped at 100. It is applied to each source independently when reading that source's issues.

Alerts sit outside that budget. They are fetched in full on a source's first page regardless of the page-size value. So the size of the first page returned to the host is approximately:

```
first page size  ≈  Σ over sources ( up to pageSize issues )  +  Σ over sources ( all open alerts )
```

Two things follow from this, and they are worth stating plainly:

- The first page is the heavy one, and **its size is not bounded by the page-size setting.** With several submodules, the first page can carry several multiples of `pageSize` in issues, plus the union of every source's open alerts.
- Every later page is light: no alerts, and at most `pageSize` issues per source that is still active.

In practice alert counts are small, so this is rarely a problem, but it is a real characteristic of the design rather than an accident. See [Known limitations](#known-limitations).

### Ordering and deduplication

Within a page, order is stable and predictable: sources appear in configuration order, and within each source its issues come first, followed by its alerts in a fixed category order (code scanning, then secret scanning, then Dependabot).

Items are deduplicated by their integration and external identity, so if two sources happen to surface the same underlying item (for example a repository and a GitHub Project that both contain the same issue), it appears once.

### Stale and legacy cursors

Cursors are ephemeral. The UI starts every fresh load from the beginning, and a page request is only meaningful against the source set it was produced from. A cursor that cannot be understood (a malformed token, or a token from an older Roubo version that predates the composite scheme) is treated as "no active sources": it yields an empty final page, which the host reads as the end of the list. The next fresh load starts cleanly. There is no migration step and no error surfaced to the user.

## Worked examples

The examples use a meta-repo project with two repository sources and a page size of 2 (kept small so pagination is visible).

| Source                 | Open issues            | Code-scanning (CodeQL) alerts |
| ---------------------- | ---------------------- | ----------------------------- |
| `acme/api` (root)      | `#101`, `#102`, `#103` | `cs-5`, `cs-7`                |
| `acme/web` (submodule) | `#201`                 | `cs-9`                        |

### Example 1: a single small repo

First, the simplest case, just `acme/api` with two issues and its alerts, page size 2.

Request 1, no cursor:

- `acme/api` page 1 returns issues `#101`, `#102` (a full page, so it has a next page), then its alerts `cs-5`, `cs-7`.
- Items: `#101, #102, api·cs-5, api·cs-7`.
- Next cursor: `{ acme/api: page 2 }`.

Request 2, with that cursor:

- `acme/api` page 2 returns issue `#103` (not a full page, so it is now exhausted). It is page 2, so no alerts.
- Items: `#103`.
- Next cursor: empty, so null. The list ends.

Note that all four alerts arrived on the first page even though the issues spanned two pages.

### Example 2: the meta-repo, issues and code quality alerts together

Now both sources, page size 2. This is the case that motivated the multi-source design.

**Request 1 (cursor: none).** Both sources are active and read from page 1 in parallel.

- `acme/api` page 1: issues `#101`, `#102` (full page, has more), then alerts `cs-5`, `cs-7`.
- `acme/web` page 1: issue `#201` (not full, exhausted), then alert `cs-9`.

Concatenated in source order:

```
acme/api#101                 (issue)
acme/api#102                 (issue)
acme/api#code-scanning-5     (code quality alert)
acme/api#code-scanning-7     (code quality alert)
acme/web#201                 (issue)
acme/web#code-scanning-9     (code quality alert)
```

Cursor state after request 1:

| Source     | Status on page 1 | In next cursor? | Resume at |
| ---------- | ---------------- | --------------- | --------- |
| `acme/api` | full page        | yes             | page 2    |
| `acme/web` | partial page     | no (exhausted)  | n/a       |

Next cursor encodes `{ acme/api: page 2 }`. Crucially, the submodule's code quality alert `cs-9` is already on this first page.

**Request 2 (cursor: `{ acme/api: page 2 }`).** Only `acme/api` is active; `acme/web` is absent from the cursor and is not touched.

- `acme/api` page 2: issue `#103` (not full, exhausted). Page 2, so no alerts.

```
acme/api#103                 (issue)
```

Cursor state after request 2:

| Source     | Status on page 2 | In next cursor? |
| ---------- | ---------------- | --------------- |
| `acme/api` | partial page     | no (exhausted)  |

Next cursor is empty, so null. The list ends.

The full sequence the host sees:

```
Page 1:  api#101, api#102, api·cs-5, api·cs-7, web#201, web·cs-9
Page 2:  api#103
         (done)
```

Every issue and every alert from both repositories appeared, nothing was duplicated, and all alerts were on page 1.

### Example 3: two sources both paginating

Suppose instead `acme/web` had four issues (`#201`–`#204`) so it too spans more than one page, still page size 2.

**Request 1 (cursor: none).**

- `acme/api` page 1: `#101`, `#102` (full, has more) + `cs-5`, `cs-7`.
- `acme/web` page 1: `#201`, `#202` (full, has more) + `cs-9`.

Next cursor: `{ acme/api: page 2, acme/web: page 2 }`. Both sources carry forward.

**Request 2 (cursor: both at page 2).** Both active, read in parallel, neither on page 1 so no alerts.

- `acme/api` page 2: `#103` (partial, exhausted).
- `acme/web` page 2: `#203`, `#204` (full, has more).

Next cursor: `{ acme/web: page 3 }`. `acme/api` has dropped out.

**Request 3 (cursor: `{ acme/web: page 3 }`).** Only `acme/web` active.

- `acme/web` page 3: empty (exhausted).

Next cursor: empty, so null. Done.

Cursor evolution at a glance:

```
after page 1:  { api: 2, web: 2 }
after page 2:  { web: 3 }          ← api drained, removed
after page 3:  {}  → null          ← web drained, list ends
```

This is goal 4 in action: the two sources progress independently, and each leaves the cursor the moment it is done.

### Example 4: a stale or legacy cursor

If the host ever sends a cursor that the plugin cannot decode (a leftover from an older format, or a token unrelated to the current source set), the plugin reads it as "no active sources." It returns an empty page with a null next cursor, which the host treats as the end of the list. The user's next fresh load simply starts again from the first page. Nothing errors.

## Diagrams

The retrieval loop, end to end:

```
                     ┌─────────────────────────────────────────────┐
                     │                   HOST                       │
                     │  cursor = null                               │
                     │  loop:                                       │
                     │    page = ask plugin(sources, cursor)        │
                     │    render page.items                         │
                     │    cursor = page.nextCursor                  │
                     │  until cursor is null                        │
                     └───────────────┬─────────────────────────────┘
                                     │ (sources, opaque cursor)
                                     ▼
                     ┌─────────────────────────────────────────────┐
                     │                  PLUGIN                      │
                     │  decode cursor → which sources, where        │
                     │  read each active source in parallel:        │
                     │      issues (≤ pageSize)                     │
                     │      + alerts (all, only on its first page)  │
                     │  concatenate in source order                 │
                     │  re-encode cursor from sources with more     │
                     └─────────────────────────────────────────────┘
```

How a single source contributes over its lifetime:

```
  source first page:   [ issue, issue, ... up to pageSize ]  +  [ ALL its alerts ]
  source later pages:  [ issue, issue, ... up to pageSize ]      (no alerts)
  source exhausted:    removed from the cursor, never queried again
```

## Known limitations

- **Filter facets reflect the primary source only.** The label, issue-type, and other facet options offered in the cut list's filter UI are currently derived from the first source, not the union of all sources. In a multi-source project a label that exists only in a submodule may not be offered as a filter even though items carrying it appear in the list. Tracked in [issue #369](https://github.com/davidpoxon/roubo/issues/369).
- **The first page is not bounded by the page-size setting.** As described under [Page size and how alerts fit](#page-size-and-how-alerts-fit), the first page carries up to `pageSize` issues per source plus every open alert from every source, so it can be substantially larger than a single page-size worth of items. This is usually negligible but grows with the number of sources and alerts.
