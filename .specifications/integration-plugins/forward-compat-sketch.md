# Forward-compat paper sketch: AI-agent + project-component plugin kinds

## Purpose and gate

This one-page sketch satisfies FR-038 and verifies NFR-011. It exists so the team can confirm, before `hostApiVersion` 1.0.0 is frozen, that the host API surface designed in the integration-plugins slug can host two planned follow-on plugin kinds (AI-agent, project-component) without a host-API major-version bump. TC-041 is the existence-and-reference gate; TC-084 is the exploratory validation that runs when the AI-agent slug enters interview / feasibility. The sketch is not a design for either follow-on slug; it is a falsifiability check on the current host design.

## What every plugin kind inherits

The shared host surface introduced in this slug is intentionally minimal and kind-agnostic. Future kinds reuse it verbatim:

- **Manifest envelope** (from `architecture.md`, "Plugin manifest and host-API shared schema"): `id`, `name`, `version`, `kind`, `roubo` (the host-API semver range the plugin requires), `entry`, `description`, `configSchema`, `permissions`, optional `capabilities`. The `kind` field is a string literal union, widened by addition, never replaced.
- **Permission categories**: `network.hosts`, `credentials`, `filesystem.paths`, `childProcess`. The host treats unknown categories as opt-out, so adding categories is a non-breaking 1.x minor.
- **Host RPC surface** (from `architecture.md`, "Host services exposed to plugins"): `host.fetch(url, init)`, `host.credentials.get|set|delete(slot)`, `host.logger.info|warn|error(payload)`, `host.spawn(executable, args, opts)`.
- **Process model**: supervised child process, JSON-RPC framed over stdio via `vscode-jsonrpc`, restart-budget tracking, structured per-plugin log files. Landed in WU-005.
- **SDK ergonomics**: `definePlugin({...})` registers handlers; the SDK exposes `host.*` as imports. Method sets are passed as the object shape, so a new kind defines its own shape without touching the SDK contract.

## AI-agent plugin kind

**Manifest delta.** `kind: "ai-agent"`. New optional `capabilities` flags such as `streaming`, `toolUse`, `vision`, `embeddings`. `configSchema` declares vendor-specific settings (model id, default temperature). `permissions` envelope is reused unchanged.

**Method set (proposed).** `validateConfig`, `getCurrentUser` (account / billing identity), `listModels` (optional), `startConversation`, `streamMessage`, `cancelMessage`. These are entirely disjoint from the integration method set (`listIssues`, `getIssue`, ...) and coexist through the `kind` discriminator at the call-routing layer. The host never dispatches an integration method to an AI-agent plugin or vice versa.

**Permission needs.** `network.hosts` for the vendor endpoint glob. `credentials` for the API key. No `childProcess`, no `filesystem.paths`. No new permission category required.

**Streaming caveat.** `streamMessage` returns incrementally. The current `host.fetch` is request / response only (architecture.md: "There is no body streaming this slug"), and the design already anticipates this: "Future plugin kinds that need streaming get a separate `host.fetchStream` method in a 1.x minor." `host.fetchStream` is purely additive and therefore non-breaking.

**Verdict.** Fits inside the 1.0.0 host API. Streaming and any new `capabilities` flags arrive as additive 1.x minors. No major bump.

## Project-component plugin kind

**Manifest delta.** `kind: "project-component"`. New optional `capabilities` flags such as `dockerCompose`, `processSupervision`, `portAllocation`, `healthCheck`. `configSchema` declares per-component settings (compose file path, default port range, environment variables).

**Method set (proposed).** `validateConfig`, `provision`, `start`, `stop`, `healthCheck`, `getLogs`, `teardown`. Like the AI-agent kind, this set is disjoint from the integration set and routed by `kind`.

**Permission needs.** This is the one area where the sketch flags a deviation from the current shape. Project-component plugins will plausibly need two new permission categories:

- `ports`: declarative port-range claim, so the host can keep its existing port-allocator authoritative.
- `docker`: declarative permission to drive a Docker Compose lifecycle through `host.spawn` or a future `host.docker.*` surface.

The current schema accommodates this without a major bump. Per architecture.md "Risks and alternatives": "This slug's manifest schema is designed so additional permission categories can be added in a 1.x minor (the zod schema's `permissions` object is `.passthrough()`-aware at the category level, and the host treats unknown categories as opt-out)." The existing `unknown - flag for refinement` marker at the same line (paper sketch may force `ports` / `docker` permission categories now rather than later) is the open question that this sketch closes: **deferring to a 1.x minor is fine.**

**Verdict.** Fits inside the 1.0.0 host API on the runtime side. Adds two new permission categories as an additive 1.x minor when the project-component slug actually ships. No major bump.

## Conclusion

The host API designed in this slug can host both planned follow-on plugin kinds without a major-version bump:

- **AI-agent kind:** zero changes for 1.0.0; `host.fetchStream` arrives as a 1.x minor when needed.
- **Project-component kind:** zero changes for 1.0.0; `ports` and `docker` permission categories arrive as a 1.x minor when needed.

`hostApiVersion` 1.0.0 freeze is safe. Both flagged forward-looking gaps are additive and were already anticipated in the design.

When the AI-agent or project-component slugs enter feasibility, TC-084 runs to validate the predictions in this sketch against the real manifest and method-set proposals. Any deviation gets logged as a decision with rationale.
