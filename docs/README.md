# Roubo Documentation

Documentation for [Roubo](../README.md), a workbench for running multiple parallel dev environments off the same repository.

## For users

- **[Getting Started](./getting-started.md)**: install Roubo, register a project, set up your first bench.
- **[Configuration Reference](./configuration.md)**: the full `roubo.yaml` schema, with every section explained.
- **[API Reference](./api.md)**: drive Roubo programmatically from any AI coding tool, script, or IDE plugin. Endpoint reference plus a worked curl example.

## For contributors

- **[Architecture](./architecture.md)**: how Roubo thinks about projects, benches, components, ports, and the API surface.
- **[Plugin Author Guide](./plugin-sdk.md)**: writing an integration or agent plugin against `@roubo/plugin-sdk`. The manifest format, the contract methods, the agent contract and its launch descriptor, host helpers, and the trust model.
- **[The Cut List](./cut-list.md)**: how Roubo retrieves issues and security alerts across a project's sources, and how the multi-source paging scheme works, with worked examples.
- **[Development](./development.md)**: running Roubo from source, code quality, building the desktop app.
- **[TestBench Schema Migrations](./testbench-schema-migrations.md)**: the versioned `test-cases.json` / `test-results.json` schemas, their breaking-change history, and how existing files migrate (NFR-005).
- **[Releasing](./releasing.md)**: how releases are cut, signed, and published.
- **[Releasing the SDK](./releasing-sdk.md)**: how `@roubo/plugin-sdk` is versioned, tagged, and published to npm, independently of the app.
- **[Integrations](./integrations.md)**: configuring GitHub OAuth and other external services.

## Reference

- **[Route Inventory](./routes.md)**: every HTTP route the server registers, generated from `server/routes/` and gated against drift in CI.
- **[Brand Guide](./brand.md)**: vocabulary, design philosophy, and tone.
- **[Contributing](../CONTRIBUTING.md)**: issue reporting, PR process, DCO sign-off.
- **[Trademark Policy](../TRADEMARK.md)**: guidance on use of the Roubo name and mark.
