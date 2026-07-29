# Changelog

All notable changes to `@roubo/plugin-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The SDK is pre-1.0, so per [`docs/releasing-sdk.md`](../docs/releasing-sdk.md) a minor bump may carry breaking contract changes; those are called out under **Breaking**.

`@roubo/plugin-sdk` and `@roubo/shared` are published in lockstep at the same version by `.github/workflows/sdk-release.yml`, so entries below cover both packages. The JSON-RPC protocol itself is additive: a newer host keeps working with an older SDK, so plugin authors upgrade only when they want new contract methods.

## [0.2.0] - 2026-07-29

Adds the **agent plugin contract**, a third plugin kind alongside integration and component. An agent plugin teaches Roubo to launch and supervise an AI coding agent CLI without the host hardcoding anything about that tool.

### Added

- **`defineAgentPlugin()`** (`@roubo/plugin-sdk`). Registers an agent plugin's contract over the host JSON-RPC channel, parallel to `definePlugin()` and `defineComponentPlugin()`. The contract is a single method, `translateLaunch({ config, context })`, returning an `AgentLaunchDescriptor` the host validates and executes:

  ```ts
  import { defineAgentPlugin } from "@roubo/plugin-sdk";

  defineAgentPlugin({
    translateLaunch({ config, context }) {
      return {
        schemaVersion: 1,
        kind: "agent-launch",
        command: "my-agent",
        args: ["--session-id", "{{sessionId}}"],
        cwd: context.workspacePath,
      };
    },
  });
  ```

- **`SUPPORTED_AGENT_CONTRACT_VERSION`** (currently `1`), the agent-contract counterpart to `SUPPORTED_CONTRACT_VERSION`.
- **New exported types:** `AgentCapabilities`, `AgentContract`, `AgentContractMethodName`, `AgentLaunchContext`, `AgentLaunchDescriptor`, `AgentPermissionsModel`, `AgentPluginHandle`, `AgentPosture`, `DeclarativeAgentContract`, `DefineAgentPluginOptions`, `NotificationWiring`, `PermissionsCapability`, `VersionProbeSpec`, `WaitingDetectionSpec`, `WorkspaceWriteSpec`, `WriteOp`.
- **Manifest schema (`@roubo/shared`):** `kind: agent` is an accepted value alongside `integration` and `component`, and an optional `agentCompatibility` block declares the agent CLI version floor and tested ceiling the host probes before launch.
- **New `@roubo/shared` subpath export:** `./agent-launch-descriptor-schema`, the zod schema and types for the descriptor an agent plugin returns.

### Breaking

- **`vscode-jsonrpc` upgraded from `8.2.1` to `9.0.0`** (#908). It is a direct `dependency` of `@roubo/plugin-sdk`, so a plugin that also imports `vscode-jsonrpc` directly should move to `9.x` to avoid two copies of the transport in one process. A plugin that only uses the SDK's own entry points needs no change.

### Security

- **An agent-kind manifest may not declare a `processes` permission** (#1030). A child process started through `host.process.spawn` does not inherit the filesystem broker allowlist, so spawn access would let an agent plugin write into a bench workspace and sidestep the descriptor path core validates and executes. Rejecting the permission at the schema layer leaves the declarative descriptor as an agent plugin's only write route.
- **An agent plugin holds no host broker client at all.** `defineAgentPlugin()` registers only `translateLaunch`, so every other contract method, including `host.fs.*`, `host.process.*`, `host.docker.*` and `host.ports.*`, answers `MethodNotFound`. There is deliberately no imperative escape hatch. Every privileged action (the PTY spawn, workspace writes, hook wiring, the version probe) is declarative data on the descriptor, carried out by the host.

### Compatibility

- **Existing integration and component plugins need no changes.** Every published manifest validates unchanged against the widened schema, with zero new required fields, and `agentCompatibility` is optional and absent on them. Nothing is misclassified as an agent by the added branch.
- Verified by the `smoke` matrix in `sdk-release.yml`, which builds and tests `github-com`, `process` and `database` standalone against the published version with no surviving workspace link.

## [0.1.1] - 2026-06-26

Released before this changelog existed; see the [`sdk-v0.1.1`](https://github.com/davidpoxon/roubo/releases/tag/sdk-v0.1.1) tag and the commits it spans for details.

## [0.1.0] - 2026-05-23

Initial public release of `@roubo/plugin-sdk`. Predates this changelog and the `sdk-v*` tagging convention.
