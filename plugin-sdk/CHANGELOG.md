# Changelog

All notable changes to `@roubo/plugin-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The SDK is pre-1.0, so per [`docs/releasing-sdk.md`](../docs/releasing-sdk.md) a minor bump may carry breaking contract changes; those are called out under **Breaking**.

`@roubo/plugin-sdk` and `@roubo/shared` are published in lockstep at the same version by `.github/workflows/sdk-release.yml`, so entries below cover both packages. The JSON-RPC protocol itself is additive: a newer host keeps working with an older SDK, so plugin authors upgrade only when they want new contract methods.

## [0.4.0] - 2026-08-23

Two additive fields on the component provision descriptor. Both already sat on `main` under the unpublished `0.3.0`, so this release carries them together. Nothing is removed or narrowed, every `0.3.0` descriptor still validates, and there are no breaking changes.

### Added

- **`DescriptorShell` and an optional `shell` on the process, oneshot and docker-migration descriptors** (#836). A component command has always been spawned argv-only: the host executes the first token directly, so `&&`, `;`, globs, `$VAR` and a shell function such as `nvm` never resolve, and `nvm use && npm run dev` fails with a misleading `spawn nvm ENOENT`. `shell` is the opt-in out of that. `true` runs the command through `/bin/sh -c`, which makes operators, redirection, globs and `$VAR` work but sources no rc file; a string is the shell invocation the command is appended to as `-c`, so `"zsh -i"` spawns `zsh -i -c <command>` and is the only form that reaches an interactive shell, which an nvm-in-`.zshrc` setup needs. The host validates a string down to an absolute path (`/bin/zsh`) or a bare command name (`zsh`).

  The host owns the argv-vs-shell branch; a plugin only declares the field. `shell` is optional everywhere it appears (`ProcessProvisionDescriptor`, applying to both `command` and `setup`; `OneshotProvisionDescriptor`; and `DockerProvisionDescriptor.migration`), and omitting it leaves argv behaviour byte-identical, so a plugin that never sets it is unaffected.

- **`DescriptorUrl` and an optional `url` on every descriptor kind** (#834). A `translate`-only plugin never holds the `reportStatus` sink, because `translate` runs once before the descriptor executes, so it had no way to report a runtime URL. The descriptor now declares one and the host's `LifecycleEngine` sets `ComponentStatus.url`, which is what `{{urls.<componentName>}}` resolves to. Set exactly one of two forms: `template`, a static or `{{port}}` / `{{ports.<componentName>}}` templated URL the host fills from the allocated port, or `fromOutput`, a regular expression run over the output the command already captured. `ProcessProvisionDescriptor.url` accepts `template` only, since a long-running process has produced no completed output to match by the time the host reports `running`.

- **New exported types:** `DescriptorShell`, `DescriptorUrl` (both from `@roubo/plugin-sdk`).

## [0.3.0] - 2026-07-30

### Breaking

- **`AgentPermissionsModel` declared its two fields the wrong way round** (#652). It required `posture` and made `rules` optional, the exact inverse of what the host sends: the host omits `posture` whenever the project has never chosen one, and always sends `rules`. A plugin that typed or zod-validated `config.permissions` against the shipped contract would have rejected the common no-posture payload. `posture` is now optional and `rules` required, matching both the host producer and the shape already documented in `docs/plugin-sdk.md`.

  Host behaviour is unchanged; only the declared contract moved, and no first-party code validated against the old shape. It is listed as breaking because the correction narrows the published `0.2.0` type in both directions: a value with no `rules` no longer satisfies `AgentPermissionsModel`, so a plugin that annotated one (for example `{ posture: "guarded" }`) must add `rules`; and `posture` is now optional, so a plugin that read it as non-nullable must handle `undefined`. Both are source-level only, and the wire payload the host sends is exactly what it always was.

- **A version-probe bound must now be a bare `major.minor.patch` version** (#661). `VersionProbeSpecSchema` (`@roubo/shared/agent-launch-descriptor-schema`) accepted any non-empty string for `minVersion` and `testedCeiling`. The host compares a bound to the detected CLI version numerically, segment by segment, so a bound it could not parse that way (`v2.1.111`, `2.1`, `>=2.1.0`, or a prerelease or build-metadata suffix such as `2.1.111-beta.1`) silently compared as `NaN`: the floor half then classified every detected version `below-floor` and **hard-blocked every launch of that agent**, naming a floor the user could do nothing about.

  Such a bound is now rejected when the descriptor is validated, as an `AgentDescriptorError` naming the offending field. An agent plugin that declared one against `0.2.0` must correct it to `major.minor.patch`; it was never functional, so the practical effect is that a launch which used to fail mysteriously now fails with an error the author can act on. The manifest half of the same rule is the entry below, so the two declarations agree again on one shape.

- **A manifest `agentCompatibility` bound must now be a bare `major.minor.patch` version too** (#669). `minVersion` and `testedCeiling` validated through `PluginManifestSchema` (`@roubo/shared`) previously admitted a prerelease or build-metadata suffix such as `2.1.111-beta.1` or `2.1.111+build.5`. The host reads a manifest-declared window straight into its version probe without passing it through the descriptor schema, so such a bound reached the same numeric comparison as #661's and compared as `NaN`: a detected version sharing `major.minor` with the floor was classified `below-floor` even though it satisfied the window.

  The blast radius is narrower than #661's. The launch gate reads the descriptor's `capabilities.versionProbe`, not the manifest, so a manifest bound never blocked a launch; it fed the pre-launch compatibility verdict on the AI Agents card, which showed a floor the CLI already cleared. Both bounds are now rejected at manifest-validation time with an error naming the offending field. The manifest and descriptor schemas share one predicate again, so `roubo-plugin.yaml` and the descriptor a plugin returns from `translateLaunch` enforce exactly the same shape, which is the single rule `docs/plugin-sdk.md` documents. An agent plugin that declared such a bound against `0.2.0` must correct it to `major.minor.patch`; as with #661 it was never functional, so the practical effect is an authoring error in place of a silently wrong verdict. No first-party plugin declared one.

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
