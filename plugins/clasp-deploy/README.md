# @roubo/plugin-clasp-deploy

Roubo **component** plugin with a **one-shot** deploy lifecycle. Its start hook
runs a single deploy command to completion through the host process broker, then
reports `completed`: there is no long-running process to supervise. This is the
shape a `long-running` component (a dev server, a watcher, a database) does not
have, and it is what the marketplace detail drawer surfaces PRE-INSTALL as the
Lifecycle row "one-shot" (issue #401).

## How it works

The plugin is **imperative** (the escape hatch): it implements the four
lifecycle hooks (`start` / `stop` / `health` / `cleanup`) rather than a
declarative `translate`, because a one-shot run-to-completion deploy cannot be
expressed as a static `ProvisionDescriptor`. The manifest declares
`componentMode: imperative` so the host dispatches the hooks directly instead of
calling `translate` (#396), and `lifecycle: one-shot` so the host derives the
one-shot shape server-side for the drawer.

`start`:

1. Gates on the broker capability via `host.capability.query({ method:
"host.process.run" })` (CP-FR-017 graceful version gate). On a host too old
   to expose the method the plugin reports `error` and degrades rather than
   crashing.
2. Runs the deploy command to completion through `host.process.run`. The host
   owns the spawned process; `run` blocks until it exits and returns the exit
   code.
3. Reports `completed` on a zero exit code, or `error` with the exit code
   otherwise.

`stop` and `cleanup` report / reset the terminal status; `health` returns the
last terminal status so the host can poll it independently of the pushed
`reportStatus` notification. Because the deploy has already run to completion,
`cleanup` has no long-lived process to reap: the host clears the resource ledger
for `(pluginId, benchId)` once it returns.

The lifecycle logic lives in `src/contract.ts` (`buildContract`) so it is
unit-testable against a mocked host, and `src/index.ts` registers it via
`defineComponentPlugin`. See `src/contract.test.ts`.

## Permissions

- `processes`: the plugin drives a single executable through the host broker.
- `network`: a deploy reaches a remote target, so outbound network is declared.

Both declared categories drive the consent gate the installer presents before
the plugin runs.
