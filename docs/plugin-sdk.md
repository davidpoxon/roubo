# Plugin author guide

`@roubo/plugin-sdk` is the package plugin authors import to talk to the Roubo host. It wraps the JSON-RPC protocol so authors implement only contract methods and call typed host helpers; the SDK handles framing, stdio binding, and error wrapping.

This document covers the manifest format, every contract method, pagination, host helpers, the error shape, and the trust model. The SDK source itself lives at [`plugin-sdk/`](../plugin-sdk/).

## Install

The SDK is published to npm. Add it to your plugin project:

```bash
npm install @roubo/plugin-sdk
```

The package ships ESM (`type: "module"`) with bundled `.d.ts` declarations. SDK versions follow the plugin contract, not the Roubo app version; a newer host keeps working against an older SDK because the JSON-RPC protocol is additive.

## Quick start

A plugin is a directory with two files: a `roubo-plugin.yaml` manifest and a Node entry script. Drop the directory into `~/.roubo/plugins/<id>/` and Roubo discovers it on next start.

```yaml
# ~/.roubo/plugins/example/roubo-plugin.yaml
id: example
name: Example Tracker
version: 0.1.0
description: Example integration
kind: integration
roubo: ^1.0.0
entry: ./index.mjs
permissions:
  network:
    hosts:
      - api.example.com
  credentials:
    slots:
      - slot: api-token
        scope: read-write
        description: Personal access token
  filesystem:
    paths: []
  processes: false
```

```js
// ~/.roubo/plugins/example/index.mjs
import { definePlugin, host } from "@roubo/plugin-sdk";

definePlugin({
  async getCurrentUser() {
    const token = await host.credentials.get("api-token");
    const res = await host.fetch("https://api.example.com/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    const me = JSON.parse(res.body);
    return { externalId: String(me.id), displayName: me.name };
  },
  async listIssues({ cursor, pageSize }) {
    const url = `https://api.example.com/issues?cursor=${cursor ?? ""}&pageSize=${pageSize}`;
    const res = await host.fetch(url);
    const page = JSON.parse(res.body);
    return { items: page.items, nextCursor: page.nextCursor ?? null };
  },
  async validateConfig({ config }) {
    if (!config.workspace)
      return { ok: false, errors: [{ field: "workspace", message: "Required" }] };
    return { ok: true };
  },
});
```

Roubo will spawn the plugin as a Node child process, talk to it over stdio, and call the contract methods you implemented.

## Manifest reference

The manifest is validated by [`schema/roubo-plugin.schema.json`](../schema/roubo-plugin.schema.json). Fields (required unless marked optional):

| Field                           | Type                  | Notes                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                            | kebab-case string     | Stable plugin id. Used as a log prefix and as the credential namespace                                                                                                                                                                                                                                                                            |
| `name`                          | string                | Display name in the Plugins settings tab                                                                                                                                                                                                                                                                                                          |
| `version`                       | semver string         | Your plugin version                                                                                                                                                                                                                                                                                                                               |
| `description`                   | string                | One-line summary shown in the UI                                                                                                                                                                                                                                                                                                                  |
| `kind`                          | literal `integration` | Reserved for future plugin kinds                                                                                                                                                                                                                                                                                                                  |
| `roubo`                         | semver range          | Host API range you require (e.g. `^1.0.0`)                                                                                                                                                                                                                                                                                                        |
| `entry`                         | relative path         | Node entry script, relative to the plugin directory                                                                                                                                                                                                                                                                                               |
| `icon`                          | string                | Optional. Tile icon: a `data:` URI (`data:image/svg+xml;...` or `data:image/png;base64,...`) or a relative POSIX path inside the plugin directory. Rendered at 32×32 on the Plugins tile and 24×24 in the Configure modal header. Currently only `data:` URIs render; relative paths fall back to the generated monogram until path serving lands |
| `permissions.network.hosts`     | string[]              | Glob allowlist for `host.fetch`. `*` matches one DNS label; `**` matches one or more                                                                                                                                                                                                                                                              |
| `permissions.credentials.slots` | object[]              | Each slot: `{ slot, scope: "read" \| "read-write", description }`                                                                                                                                                                                                                                                                                 |
| `permissions.filesystem.paths`  | string[]              | Reserved for future filesystem access                                                                                                                                                                                                                                                                                                             |
| `permissions.processes`         | `false` or object     | `false` for no child processes, or `{ executables: string[] }` listing spawnable executables (reserved; not yet enforced)                                                                                                                                                                                                                         |
| `configSchema`                  | JSON Schema object    | Optional, describes user-facing config fields                                                                                                                                                                                                                                                                                                     |
| `capabilities`                  | object                | Optional capability flags                                                                                                                                                                                                                                                                                                                         |
| `defaultIntegrationConfig`      | object                | Optional. Plugin-global defaults seeded into the three-layer effective-config merge (per-project and per-source layers override these). See [Default integration config](#default-integration-config)                                                                                                                                             |

`host.fetch` to a host outside `network.hosts` is rejected with a structured error before any DNS lookup. `host.credentials.get/set` to a slot not declared in `permissions.credentials.slots` is rejected before the keyring is touched.

### Default integration config

`defaultIntegrationConfig` ships plugin-global defaults that become the base layer of the host's three-layer effective-config merge (plugin defaults < per-project < per-source). The host reads it at manifest load and exposes it through the `/integration` config endpoints; the user can override any value in the Configure dialog.

```yaml
defaultIntegrationConfig:
  # Issue statuses to hide from the cut list by default, as the provider's
  # native state strings.
  excludedStatuses:
    - Closed
    - Cancelled
  # Category-first status exclusion (e.g. "Done"), ANDed alongside
  # excludedStatuses for providers whose query language supports status
  # categories (e.g. Jira's statusCategory in JQL).
  excludedStatusCategories:
    - Done
```

Both keys are optional string arrays. The host resolves the merged exclusion set and passes it back to your plugin on each `listIssues` call as `excludedStatuses` / `excludedStatusCategories` (see [Pagination](#pagination)), so a plugin that filters server-side never has to read the manifest field itself.

## Contract methods

All contract methods are optional. If the host calls a method you did not register, the SDK responds with JSON-RPC `MethodNotFound` (-32601). Implement the methods relevant to your integration.

### `listSourceCandidates(): Promise<SourceCandidatesResponse>`

Returns a declarative envelope describing the sources the user can pick (repos, projects, boards, queues) when they configure the integration. The host renders the source-picker UI from this envelope; plugins ship no React. Called by the source picker UI.

```ts
type SourceCandidatesResponse = {
  shape: "multi-list" | "categorized-multi-list" | "searchable-categorized";
  items?: SourceCandidateItem[]; // present iff shape === "multi-list"
  categories?: SourceCandidateCategory[]; // present iff shape === "categorized-multi-list"
  searchableCategories?: SearchableSourceCategory[]; // present iff shape === "searchable-categorized"
  nextCursor?: string | null; // reserved for future pagination; v1 returns undefined
};

type SourceCandidateItem = {
  externalId: string;
  label: string;
  sublabel?: string;
  icon?: "repo" | "project" | "board" | "epic" | "filter";
};

type SourceCandidateCategory = { id: string; label: string; items: SourceCandidateItem[] };

type SearchableSourceCategory = {
  id: "project" | "board" | "filter" | "epic" | "mine";
  label: string;
  icon?: SourceCandidateItem["icon"];
  scopedBy?: "project"; // category is disabled until the named parent selection exists
  options?: { id: string; label: string }[]; // inline modes for synthetic categories like "mine"
};
```

Pick a `shape` by how the upstream's sources are organised:

- `multi-list`: one flat, eagerly-shipped list. Populate `items`.
- `categorized-multi-list`: a handful of fixed groups, all shipped inline. Populate `categories`.
- `searchable-categorized`: the source set is large or remote. Declare which categories exist via `searchableCategories` and ship no items inline; the host fetches each category's items lazily via [`getSourceOptions`](#getsourceoptions-category-scope-search-cursor--promisesourceoptionsresult) as the user searches.

### `listIssues({ sources, cursor, pageSize, filters? }): Promise<{ items, nextCursor }>`

The paginated list endpoint. The host passes `sources` (the per-project source selections, see [ConfiguredSource](#configuredsource)), `cursor` (null on the first page), `pageSize` (defaults to 50, plugin-overridable via `configSchema.pageSize`), plus optional `filters: { labels?, search? }`. Return a page of `NormalizedIssue` plus the cursor the host should pass next, or `null` when there are no more pages.

### `getIssue({ externalId }): Promise<NormalizedIssue>`

Returns the full issue for a single id. Used when the user opens an issue directly.

### `NormalizedIssue`

The shape `listIssues` and `getIssue` return. Normalize your upstream's issue into this:

```ts
type NormalizedIssue = {
  integrationId: string; // the plugin id this issue came from
  externalId: string; // plugin-native id (the key for getIssue/assign/transition)
  externalUrl: string; // canonical web URL for the issue
  title: string;
  body: string | null; // markdown/plain body, or null
  currentState: string; // provider-native state string (e.g. "open", "In Progress")
  allowedTransitions: string[]; // states this issue may move to (see applyTransition)
  assignees: Array<{ externalId: string; displayName: string }>;
  labels: string[];
  issueType: string | null; // provider issue type, powers issue-type→jig mapping
  blocks: string[]; // externalIds this issue blocks
  blockedBy: string[]; // externalIds blocking this issue
  updatedAt: string; // ISO-8601
  raw: unknown; // opaque cache hint, see below
  facetValues?: Record<string, string | string[]>; // host-API 1.1.0+, see below
};
```

`blocks` / `blockedBy` drive the bench dependency graph; `issueType` powers the issue-type-to-jig mapping UI. Leave `assignees`/`labels` as empty arrays (not `null`) when the upstream has none.

### The opaque `raw` field

Every `NormalizedIssue` carries a `raw: unknown` payload that is opaque to the host. Roubo never inspects it; only your plugin reads it back.

- **Lifecycle.** While a bench is active, `raw` for the bench's assigned issue may be persisted to `~/.roubo/state.json` so your plugin can re-hydrate without an extra upstream fetch when Roubo restarts. When the bench is cleared, the whole record (including `raw`) is removed from `state.json`. Nothing else in `state.json` carries `raw`.
- **PII contract (NFR-004).** Plugins MUST NOT put personally identifying information in `raw` unless functionally required. Treat it like a cache hint, not a data sink: upstream ETags, internal IDs, page tokens, transition metadata. Avoid full upstream payloads, free-text bodies, emails, and access tokens. If a field is already on `NormalizedIssue` (assignees, labels, body), it does not also need to live in `raw`.
- The host may reduce or re-evaluate `raw`'s lifetime in a follow-on slug, so do not rely on long-lived persistence.

### `getComments({ externalId }): Promise<NormalizedComment[]>`

Returns the comments on an issue. Optional; if omitted the comments panel is empty.

```ts
type NormalizedComment = {
  externalId: string;
  author: { externalId: string; displayName: string };
  body: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
};
```

### `getCurrentUser(): Promise<{ externalId, displayName }>`

Called once when the user finishes configuring the integration, to capture their identity on the external system for write-back operations.

### `validateConfig({ config }): Promise<{ ok, errors? }>`

Called when the user clicks **Test connection**. Return `{ ok: true }` on success or `{ ok: false, errors: [{ field?, message, code? }] }` to highlight specific config fields. The optional `code` is a stable discriminator your UI copy can switch on.

### `setActiveConfig({ config }): Promise<{ ok, errors? }>`

Optional. Receives the plugin-wide configuration (e.g. an API instance URL, TLS toggles) before any source-bound RPC runs, so a plugin that holds global config can validate and cache it once. Same result shape as `validateConfig`. Per-project state never flows through here: source selections arrive via `sources` on each source-bound call, so the plugin process holds no per-project state. Plugins with a fixed API host (e.g. github.com) can skip this method entirely.

### `applyTransition({ externalId, transition }): Promise<void>`

Transition an issue's state (e.g. from `open` to `closed`). The valid transitions for an issue are surfaced via `allowedTransitions` on the issue or via `getAvailableTransitions`.

### `assignIssue({ externalId, assigneeExternalId }) / unassignIssue(...): Promise<void>`

Assign or unassign a user. The assignee id matches the `externalId` shape on `NormalizedIssue.assignees`.

### `getAvailableTransitions({ externalId }): Promise<string[]>`

Optional. Useful when allowed transitions depend on the issue's current state or workflow.

### `listIssueTypes({ sources }): Promise<{ id, name }[]>`

Optional. Returns the issue types defined on the external system for the given `sources` (see [ConfiguredSource](#configuredsource)). Powers the issue-type-to-jig mapping UI.

### `listLabels({ sources }): Promise<string[]>`

Optional. Returns the labels available on the external system for the given `sources` (see [ConfiguredSource](#configuredsource)).

### `listStatusCategories(): Promise<string[]>`

Optional. Enumerates the connected instance's status categories. The host uses these as the option list for the Configure dialog's status-category exclusion toggle (the same values that flow back as `excludedStatusCategories`, see [Default integration config](#default-integration-config)). Returned names must be valid wherever your plugin consumes excluded categories (e.g. Jira returns `statusCategory` names usable in JQL). If you omit this method (`MethodNotFound`) or discovery fails, the host falls back to a canonical category set.

### `probeRepoAccess({ repoFullName }): Promise<ProbeRepoAccessResult>`

Optional. Directly probes access to a single source (e.g. `GET /repos/{owner}/{repo}`) so the host can explain why a configured source is missing from `listSourceCandidates`. it distinguishes "no such source" from "access blocked by policy" (e.g. org OAuth App access restrictions) rather than reporting a generic miss.

```ts
type ProbeRepoAccessResult = {
  accessible: boolean;
  status?: number; // underlying HTTP status, forwarded verbatim
  message?: string; // underlying error message, for host classification
};
```

### `getSourceOptions({ category, scope?, search?, cursor? }): Promise<SourceOptionsResult>`

Optional. The lazy, paginated, type-ahead loader behind the `searchable-categorized` source-picker shape (see [`listSourceCandidates`](#listsourcecandidates-promisesourcecandidatesresponse)). The host calls it as the user types and pages within a searchable category. `scope` carries the parent selection a scoped category is confined to (e.g. the Jira project keys a board/filter/epic search lives under); a scoped category with no `scope.project` returns an empty page. `search` is the optional user-typed term (debounced client-side); plugins MAY ignore it. The plugin stays stateless: the parent `scope` is supplied on every call.

```ts
type GetSourceOptionsParams = {
  category: "project" | "board" | "filter" | "epic";
  scope?: { project?: string[] };
  search?: string;
  cursor?: string | null;
};

type SourceOptionsResult = {
  items: SourceCandidateItem[]; // same shape as listSourceCandidates items
  nextCursor: string | null; // opaque token, or null when the set is exhausted
};
```

### `getConnectionStatus(): Promise<ConnectionStatus>` (host-API 1.1.0+)

Optional. Returns the plugin's self-reported connectivity. The host calls this to render the Settings > Plugins status chip without paying a full `listIssues` round-trip.

```ts
type ConnectionStatus = {
  state: "connected" | "disconnected" | "auth-problem" | "errored";
  detail?: string;
  checkedAt: string; // ISO-8601
  // Present on `connected` when the plugin can cheaply resolve the authenticated
  // account (e.g. from the same GET /user probe). The host forwards it to the
  // UI's "Connected as <login>" label; omit it otherwise.
  account?: { login: string };
};
```

```js
async getConnectionStatus() {
  const token = await host.credentials.get("api-token");
  if (!token) {
    return { state: "auth-problem", detail: "No token stored", checkedAt: new Date().toISOString() };
  }
  const res = await host.fetch("https://api.example.com/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    return { state: "auth-problem", detail: "Token rejected", checkedAt: new Date().toISOString() };
  }
  if (res.status >= 500) {
    return { state: "errored", detail: `Upstream ${res.status}`, checkedAt: new Date().toISOString() };
  }
  return { state: "connected", checkedAt: new Date().toISOString() };
}
```

If you omit this method, the host catches the resulting `MethodNotFound` and falls back to calling `validateConfig`, inferring `connected` vs `auth-problem` from its result. Plugins built against host-API 1.0.0 keep working without changes.

### `probeAlertCategories({ sources, enabledCategories, timeoutMsPerProbe? }): Promise<ProbeAlertCategoriesResult>`

Optional. Probes each requested alert-category endpoint for a sample source and returns one report per category. The host invokes it as part of **Test connection** and renders one result-strip row per report. A throw or `MethodNotFound` is treated as "no per-category data" and never fails the overall test.

```ts
type ProbeAlertCategory = "code-scanning" | "secret-scanning" | "dependabot";

type ProbeAlertCategoriesParams = {
  sources: ConfiguredSource[]; // plugin samples a target (typically the first repo)
  enabledCategories: ProbeAlertCategory[]; // never empty
  timeoutMsPerProbe?: number; // host hint; defaults to 5000ms when omitted
};

type ProbeAlertCategoriesResult = {
  reports: Array<{
    category: ProbeAlertCategory;
    status: "ok" | "scope-missing" | "not-enabled" | "timed-out" | "error";
    detail?: string;
    httpStatus?: number;
  }>;
};
```

Status semantics: `ok` (HTTP 2xx), `scope-missing` (token lacks the scope, 401/403), `not-enabled` (feature off for the repo, 404/410/451), `timed-out` (exceeded the per-probe cap; rendered amber, does not fail the test), `error` (unexpected status or non-timeout throw). If none of `sources` are probeable, return an `error` row per requested category.

### `filterFacets(): Promise<FilterFacet[]>` (host-API 1.1.0+)

Optional. Declares the filter facets the core cut-list UI should render for this plugin. Core renders generic filter controls from the descriptors; you populate the per-issue values via the new `facetValues` field on `NormalizedIssue`.

```ts
type FilterFacet = {
  id: string;
  label: string;
  type: "enum" | "enum-async" | "multi-enum";
  options?: FilterFacetOption[];
};

type FilterFacetOption = {
  value: string;
  label: string;
};
```

Pick a `type` based on how big and stable the option set is:

- `enum`: small, stable set; ship `options` inline. Recommended only when you expect the option set to stay under roughly 100 items.
- `enum-async`: set is large or remote; omit `options` and implement `getFacetOptions` (below). The host renders the dropdown empty with a loading affordance until the user opens it.
- `multi-enum`: multi-select variant of `enum`.

```js
async filterFacets() {
  return [
    { id: "milestone", label: "Milestone", type: "enum-async" },
  ];
}
```

If you omit this method, the host falls back to a fixed common-facet set (Status, Label, Assignee, Type). Plugins built against host-API 1.0.0 keep working without changes.

### `getFacetOptions({ facetId, sources, search? }): Promise<FilterFacetOption[]>` (host-API 1.1.0+)

Optional. The lazy counterpart to `filterFacets` for any facet you declared with `type: "enum-async"`. The host calls this when the user opens the dropdown for that facet; `search` is the optional user-typed prefix/substring (apply it server-side if your upstream supports it, otherwise filter the full set yourself).

`sources` is the same `ConfiguredSource[]` shape the rest of the source-bound RPCs receive, so the plugin stays stateless across projects.

```js
async getFacetOptions({ facetId, sources, search }) {
  if (facetId !== "milestone") return [];
  const titles = await fetchMilestones(sources[0].externalId);
  const options = titles.map((title) => ({ value: title, label: title }));
  if (!search) return options;
  const needle = search.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().includes(needle));
}
```

If you omit this method, the host resolves to an empty option list rather than surfacing `MethodNotFound`; the dropdown stays empty. Plugins built against host-API 1.0.0 keep working without changes.

### Per-issue facet values (host-API 1.1.0+)

`NormalizedIssue` gains an optional `facetValues?: Record<string, string | string[]>` field. When you declare facets via `filterFacets`, populate this map on each issue with values keyed by the facet `id`. Core filters the cut list on these values.

```js
async listIssues({ sources, cursor, pageSize }) {
  // ... fetch a page from your API ...
  return {
    items: page.items.map((upstream) => ({
      // ... other NormalizedIssue fields ...
      facetValues: {
        milestone: upstream.milestone?.title ?? "",
      },
    })),
    nextCursor: page.nextCursor ?? null,
  };
}
```

Plugins built against host-API 1.0.0 omit this field; core treats absence as an empty map.

## Source-bound calls

`listIssues`, `listIssueTypes`, and `listLabels` are source-bound: the host passes the per-project source selections on every call, so the plugin process never holds per-project state.

### `ConfiguredSource`

```ts
type ConfiguredSource = {
  // Plugin-defined source kind, e.g. `"repo"` or `"project"` for the GitHub plugins.
  kind: string;
  // Plugin-native id for that source, e.g. `"owner/repo"` or `"owner/#42"`.
  externalId: string;

  // Jira self-hosted only (ignored by other plugin families):
  project?: string; // the project key this source is scoped to
  boardMode?: "active-sprint" | "whole-board"; // for a `board` source
  mineScope?: "in-project" | "anywhere"; // for the synthetic "assigned to me" source

  // github.com / GHE only (ignored by other plugin families): per-source toggles
  // for the GitHub Advanced Security alert categories surfaced as security-* issue
  // types. Default false on each.
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
};
```

The host derives `sources` per request from the project's `roubo.yaml` integration block. The core `{ kind, externalId }` pair is all most plugins read; the optional fields are namespaced to the GitHub and Jira families and safely ignored by everyone else.

## Pagination

`listIssues` is the only paginated method. The shape is:

```ts
type ListIssuesParams = {
  sources: ConfiguredSource[];
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
  // Status exclusion the host resolved from the three-layer merge (plugin
  // defaultIntegrationConfig < per-project < per-source). Apply it in your query
  // so excluded issues never occupy a page. `excludedStatusCategories` is the
  // category-first default (e.g. ["Done"]); `excludedStatuses` is the status-name
  // fallback for instances whose query language lacks status categories. A plugin
  // that does not filter server-side ignores both.
  excludedStatusCategories?: string[];
  excludedStatuses?: string[];
};

type ListIssuesResult = {
  items: NormalizedIssue[];
  nextCursor: string | null;
  // Optional. Non-fatal per-source/per-category fetch problems (e.g. a missing
  // GitHub Advanced Security scope) surfaced as chips without failing the pull.
  // A warning clears on the next successful page-1 result that omits it.
  warnings?: ListIssuesWarning[];
  // Optional. Count of issues dropped in-query by the status exclusion above, so
  // the cut list can show "N filtered out by status". The host sums it across
  // pages; absence means "unknown".
  excludedCount?: number;
};

type ListIssuesWarning = {
  category: "code-scanning" | "secret-scanning" | "dependabot" | string;
  sourceExternalId: string;
  cause: string;
  code?:
    | "missing-scope"
    | "scope-unverifiable"
    | "feature-disabled"
    | "insufficient-permission"
    | "not-found"
    | "rate-limited"
    | "unknown";
  detail?: { status?: number; code?: string; missingScope?: string };
};
```

- The first call has `cursor: null`.
- Return the cursor your API uses for the next page, or `null` to signal the end.
- The host detects non-progressing cursors. If your plugin returns the same `nextCursor` twice in a row, the host stops paging and surfaces a note to the user. Make sure each cursor moves forward.

`pageSize` defaults to 50 (see FR-022). Expose `pageSize` in your `configSchema` if the upstream API has its own minimums or maximums.

## Host helpers

All helpers are accessible via the top-level `host` export. Calling them before `definePlugin` runs throws an explanatory error.

### `host.fetch(url, init?): Promise<FetchResult>`

Performs an HTTP request through the host. Allowlist enforcement happens on the host before the request is dispatched. Out-of-allowlist URLs reject with a `network-denied` error (see [Error shape](#error-shape)).

`init` accepts `{ method?, headers?, body?, allowSelfSignedTls? }`. `body` is a string (JSON, form-encoded, or plain text). Binary request bodies are not supported. `allowSelfSignedTls` (default `false`) opts this single request into a TLS agent with `rejectUnauthorized: false`; the flag is scoped to the call and does not mutate global Node TLS state. Reserve it for self-hosted integrations against test endpoints.

`FetchResult` is `{ status, headers, body }`. Response headers are passed through verbatim (including `set-cookie` as an array, and `etag`, `retry-after`, `x-ratelimit-*` exposed for your own caching and backoff). `body` is the response text. `host.fetch` currently supports textual content types only (`text/*`, `application/json`, XML, form-encoded); non-textual responses reject with an `unsupported-response` error.

### `host.credentials.get(slot): Promise<string | null>`

Reads from the OS keyring (macOS Keychain on Darwin, libsecret on Linux). Returns `null` if no value is stored. The user enters the value in the integration config dialog; you never see it in plaintext at rest on disk.

### `host.credentials.set(slot, value): Promise<void>`

Writes to the OS keyring. Slot must be declared with `scope: read-write` in the manifest.

### `host.logger.info(payload) / warn / error`

Fire-and-forget structured logs. `payload` is either a string or `{ message, data? }`. The host writes one line per call to the plugin's `current.log` file, visible in the **View logs** dialog. Use this for things you want the user to be able to inspect when debugging your plugin.

## Error shape

Every error the host throws is a JSON-RPC `ResponseError` with a numeric `code` and a structured `data` discriminator. The SDK forwards these directly, so contract code can:

```js
try {
  await host.fetch("https://blocked.example.com/x");
} catch (err) {
  if (err.data?.code === "network-denied") {
    // user has not allowlisted this host; surface a clear message via host.logger.error
  }
}
```

Discriminators:

| `data.code`            | Source               | Meaning                                                                            |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `permission-denied`    | `host.credentials.*` | Slot not declared in the manifest, or scope is read-only on a `set`                |
| `network-denied`       | `host.fetch`         | Host not in `permissions.network.hosts`, or URL was invalid                        |
| `unsupported-response` | `host.fetch`         | Response content type is not textual; `data.contentType` carries the rejected type |
| `invalid-params`       | All host RPCs        | Required parameter missing or wrong type                                           |
| `internal-error`       | All host RPCs        | Underlying call (keyring, network) failed; `message` carries the cause             |

Errors are also written to the plugin's log with a stable identifier of the form `<pluginId>.<methodName>` (for example `example.host.credentials.get`). This is the line your error banner should reference when something goes wrong.

Contract method errors thrown from your code propagate as JSON-RPC errors with whatever message you threw. The host surfaces them to the UI and writes them to the log.

## User-facing strings

Every user-facing string a plugin or first-party component renders, status labels, button copy, modal headings, error fallbacks, alert category names, lives in a typed key map at the top of the consuming module. The host has no `t(key)` runtime; the pattern is convention, not framework. It exists so a future localization pass can swap copy without touching JSX (NFR-025).

The convention, taken directly from `client/src/components/settings/plugins/ConnectionStatusPill.tsx`:

```ts
const LABELS: Record<ConnectionState, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  "auth-problem": "Sign in again",
  errored: "Error",
  disabled: "Disabled",
};

// ...
<span>{LABELS[state]}</span>
```

Rules of thumb:

- Declare a module-scope constant (`LABELS`, `STRINGS`, `BUTTON_LABELS`, name it for the role). One constant per role keeps the file scannable.
- Type it `Record<KeyUnion, string>` when keys map to an enum (reuse the union from `@roubo/shared` where one exists), or `Record<string, string>` for free-form copy slots.
- For strings that splice in runtime values (plugin name, count, timestamp), expose a small format function on the same constant, mirroring `formatTimestamp` in `ConnectionStatusPill.tsx`. The templating tokens stay inside the constant; the JSX calls the function.
- Treat error-fallback strings (`errorMessage(err, fallback)`) as user-visible. Put the fallback in the same map.
- No em-dashes (`—`) in any user-facing copy. The project lint enforces it. En-dashes (`–`) are fine for numeric ranges only.

The structural test for this rule lives at TC-155 (`.specifications/integration-plugins/test-cases.json`): grep new components for inline English in JSX and `aria-label` / `title`; expect none.

## Trust boundaries

The plugin host model is cooperative, not adversarial. A plugin runs as a Node child process with the same OS permissions as Roubo itself; the SDK helpers enforce the manifest declarations, but a plugin that ignores the SDK and reaches for Node APIs directly is not blocked.

What this means in practice:

- The **install-time contract** is the manifest. The user reviews `network.hosts`, `credentials.slots`, and the source URL before enabling the plugin.
- The **runtime enforcement** is at the host RPC boundary. `host.fetch` honours the network allowlist; `host.credentials.*` honours the slot scopes. Denials are logged with the `<pluginId>.<methodName>` identifier so the user can trace what happened.
- The user vets the source. Bundled plugins are part of Roubo's release; third-party plugins are something the user chose to install from a URL they recognised.

When you build a plugin, treat the manifest as the documented surface area. Anything you do via the SDK is what the user accepted; anything you do behind the SDK's back is on you.

## Isolation threat model (component plugins)

Component plugins run under a two-tier model: an always-on broker floor plus an opt-in, capability-gated OS-isolation tier. The delivered guarantee is scoped deliberately, so state it precisely rather than over-claim.

- **The broker floor is unconditional.** Every privileged operation (process spawn, compose up/down, port allocation) funnels through the single host broker, which denies any call outside the plugin's declared permission categories and audit-logs it. This contains accidental damage, honest-but-buggy plugins, and casual abuse on every host, with no container engine, VM, or OS sandbox required. It is the floor: it is always present.
- **The broker floor does not resist a determined attacker.** A plugin that ignores the SDK and reaches for native Node APIs (raw sockets, `child_process`, `fs`) directly inside its process bypasses the broker. There is no `host.network.*` broker method, so an undeclared outbound connection cannot be stopped at the broker at all. Closing that gap is the job of the OS-isolation tier, not the floor.
- **The OS-isolation tier is opt-in and capability-gated.** Where the host supports it, the plugin process runs inside the highest-isolation runtime available, highest-first: a Virtualization.framework per-plugin VM, then the Apple `container` framework, then a Docker container-per-plugin, degrading to the broker-only floor where none is present. Runtimes are probed, never assumed; a host with none keeps the broker floor. Docker is one rung among several, never a requirement.
- **When the tier is active, undeclared egress is blocked at the OS layer.** When a plugin declares no `permissions.network.hosts`, the sandbox denies all outbound traffic at the OS boundary (for the Docker rung, `docker run --network none`), so a direct outbound connection the plugin never declared cannot leave the boundary. When hosts are declared, the runtime carries that allowlist forward.
- **When the tier is active, blocked attempts are audited where attributable.** When the OS layer can attribute a blocked syscall (e.g. an undeclared outbound connection) to the plugin, it is recorded in the audit log as a `denied` outcome with `source: "sandbox"`, alongside the broker's own denials. Where the OS layer cannot attribute the syscall to a specific plugin, it is logged at the OS layer only.

**Current status (read this before relying on the tier).** This slice ships the OS-isolation tier as the enforced design and unit-tested behaviour: the tier model, the highest-first selection, the egress policy (`--network none` for undeclared networks), and the `source: "sandbox"` audit shape. It does **not** yet install the runtime capability probes, so today every host degrades to the broker-only floor: the OS-isolation tier does not engage, undeclared egress is not yet blocked at the OS layer, and no sandbox-attributed audit entry is recorded at runtime. Real runtime probe detection (and, for audit attribution, the broker runtime-wiring tracked under F2.1) lands in a later slice. Until then, **the broker floor is the guarantee delivered today**; the tier above it is staged, not active.

In one line: **accidental damage, honest plugins, and casual abuse are contained unconditionally at the broker today; resistance to a determined attacker is the job of the opt-in OS-isolation tier, which is staged in this slice and becomes active once runtime capability detection is wired (see Current status above), and is never claimed for the broker-only floor.**
