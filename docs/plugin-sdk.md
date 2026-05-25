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

The manifest is validated by [`schema/roubo-plugin.schema.json`](../schema/roubo-plugin.schema.json). Required fields:

| Field                           | Type                  | Notes                                                                                |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `id`                            | kebab-case string     | Stable plugin id. Used as a log prefix and as the credential namespace               |
| `name`                          | string                | Display name in the Plugins settings tab                                             |
| `version`                       | semver string         | Your plugin version                                                                  |
| `description`                   | string                | One-line summary shown in the UI                                                     |
| `kind`                          | literal `integration` | Reserved for future plugin kinds                                                     |
| `roubo`                         | semver range          | Host API range you require (e.g. `^1.0.0`)                                           |
| `entry`                         | relative path         | Node entry script, relative to the plugin directory                                  |
| `permissions.network.hosts`     | string[]              | Glob allowlist for `host.fetch`. `*` matches one DNS label; `**` matches one or more |
| `permissions.credentials.slots` | object[]              | Each slot: `{ slot, scope: "read" \| "read-write", description }`                    |
| `permissions.filesystem.paths`  | string[]              | Reserved for future filesystem access                                                |
| `permissions.processes`         | `false` or object     | Reserved for child-process spawning                                                  |
| `configSchema`                  | JSON Schema object    | Optional, describes user-facing config fields                                        |
| `capabilities`                  | object                | Optional capability flags (e.g. `prSync: true`)                                      |

`host.fetch` to a host outside `network.hosts` is rejected with a structured error before any DNS lookup. `host.credentials.get/set` to a slot not declared in `permissions.credentials.slots` is rejected before the keyring is touched.

## Contract methods

All contract methods are optional. If the host calls a method you did not register, the SDK responds with JSON-RPC `MethodNotFound` (-32601). Implement the methods relevant to your integration.

### `listSourceCandidates(): Promise<SourceCandidate[]>`

Returns the list of sources the user can pick (repos, projects, queues) when they configure the integration. Each candidate is `{ category, externalId, displayName, description? }`. Called by the source picker UI.

### `listIssues({ sources, cursor, pageSize, filters? }): Promise<{ items, nextCursor }>`

The paginated list endpoint. The host passes `sources` (the per-project source selections, see [ConfiguredSource](#configuredsource)), `cursor` (null on the first page), `pageSize` (defaults to 50, plugin-overridable via `configSchema.pageSize`), plus optional `filters: { labels?, search? }`. Return a page of `NormalizedIssue` plus the cursor the host should pass next, or `null` when there are no more pages.

### `getIssue({ externalId }): Promise<NormalizedIssue>`

Returns the full issue for a single id. Used when the user opens an issue directly.

### The opaque `raw` field

Every `NormalizedIssue` carries a `raw: unknown` payload that is opaque to the host. Roubo never inspects it; only your plugin reads it back.

- **Lifecycle.** While a bench is active, `raw` for the bench's assigned issue may be persisted to `~/.roubo/state.json` so your plugin can re-hydrate without an extra upstream fetch when Roubo restarts. When the bench is cleared, the whole record (including `raw`) is removed from `state.json`. Nothing else in `state.json` carries `raw`.
- **PII contract (NFR-004).** Plugins MUST NOT put personally identifying information in `raw` unless functionally required. Treat it like a cache hint, not a data sink: upstream ETags, internal IDs, page tokens, transition metadata. Avoid full upstream payloads, free-text bodies, emails, and access tokens. If a field is already on `NormalizedIssue` (assignees, labels, body), it does not also need to live in `raw`.
- The host may reduce or re-evaluate `raw`'s lifetime in a follow-on slug, so do not rely on long-lived persistence.

### `getComments({ externalId }): Promise<NormalizedComment[]>`

Returns the comments on an issue. Optional; if omitted the comments panel is empty.

### `getCurrentUser(): Promise<{ externalId, displayName }>`

Called once when the user finishes configuring the integration, to capture their identity on the external system for write-back operations.

### `validateConfig({ config }): Promise<{ ok, errors? }>`

Called when the user clicks **Test connection**. Return `{ ok: true }` on success or `{ ok: false, errors: [{ field?, message }] }` to highlight specific config fields.

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

### `getConnectionStatus(): Promise<ConnectionStatus>` (host-API 1.1.0+)

Optional. Returns the plugin's self-reported connectivity. The host calls this to render the Settings > Plugins status chip without paying a full `listIssues` round-trip.

```ts
type ConnectionStatus = {
  state: "connected" | "disconnected" | "auth-problem" | "errored";
  detail?: string;
  checkedAt: string; // ISO-8601
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

### `filterFacets(): Promise<FilterFacet[]>` (host-API 1.1.0+)

Optional. Declares the filter facets the core cut-list UI should render for this plugin. Core renders generic filter controls from the descriptors; you populate the per-issue values via the new `facetValues` field on `NormalizedIssue`.

```ts
type FilterFacet = {
  id: string;
  label: string;
  type: "enum" | "enum-async" | "multi-enum";
  options?: string[];
};
```

- `enum` — small fixed set; provide `options` inline.
- `enum-async` — set is large or remote; omit `options` and the host requests them lazily on dropdown open via a separate RPC (to be specified).
- `multi-enum` — multi-select variant of `enum`.

```js
async filterFacets() {
  return [
    { id: "milestone", label: "Milestone", type: "enum-async" },
  ];
}
```

If you omit this method, the host falls back to a fixed common-facet set (Status, Label, Assignee, Type). Plugins built against host-API 1.0.0 keep working without changes.

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
};
```

The host derives `sources` per request from the project's `roubo.yaml` integration block.

## Pagination

`listIssues` is the only paginated method. The shape is:

```ts
type ListIssuesParams = {
  sources: ConfiguredSource[];
  cursor: string | null;
  pageSize: number;
  filters?: { labels?: string[]; search?: string };
};

type ListIssuesResult = {
  items: NormalizedIssue[];
  nextCursor: string | null;
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

## Trust boundaries

The plugin host model is cooperative, not adversarial. A plugin runs as a Node child process with the same OS permissions as Roubo itself; the SDK helpers enforce the manifest declarations, but a plugin that ignores the SDK and reaches for Node APIs directly is not blocked.

What this means in practice:

- The **install-time contract** is the manifest. The user reviews `network.hosts`, `credentials.slots`, and the source URL before enabling the plugin.
- The **runtime enforcement** is at the host RPC boundary. `host.fetch` honours the network allowlist; `host.credentials.*` honours the slot scopes. Denials are logged with the `<pluginId>.<methodName>` identifier so the user can trace what happened.
- The user vets the source. Bundled plugins are part of Roubo's release; third-party plugins are something the user chose to install from a URL they recognised.

When you build a plugin, treat the manifest as the documented surface area. Anything you do via the SDK is what the user accepted; anything you do behind the SDK's back is on you.
