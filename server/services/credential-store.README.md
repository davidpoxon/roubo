# credential-store

Stores plugin credentials in the operating-system keyring via pure-JS shellouts. No native modules, no plaintext on disk.

## Platform matrix

| Platform | Backend                              | Tool          |
| -------- | ------------------------------------ | ------------- |
| macOS    | Keychain                             | `security`    |
| Linux    | Secret Service (gnome-keyring, etc.) | `secret-tool` |
| Other    | not supported                        | throws        |

Roubo does not support Windows. On any platform other than `darwin` or `linux`, every entry point throws `CredentialStoreError("unsupported-platform", ...)` before shelling out.

## Public API

```ts
import { get, set, deleteSlot, CredentialStoreError } from "./credential-store.js";

await set("github-com", "oauth-token", "ghp_xxx"); // store
const token = await get("github-com", "oauth-token"); // read; null when absent
await deleteSlot("github-com", "oauth-token"); // remove; idempotent
```

The first argument is always the plugin id; the second is the slot name from the plugin's manifest. The store namespaces the keyring entry as `<pluginId>/<slotName>` so plugins cannot collide.

## RPC surface

Plugins do not call this module directly. The plugin host (see `plugin-host-api.ts`) exposes three JSON-RPC methods:

- `host.credentials.get({ slot })` returns the stored value or `null`.
- `host.credentials.set({ slot, value })` writes the value.
- `host.credentials.delete({ slot })` removes the value.

Each call is checked against the plugin manifest. A plugin that asks for a slot it did not declare in `permissions.credentials.slots[]` receives a structured `ResponseError` whose `data` is:

```json
{
  "code": "permission-denied",
  "category": "credentials",
  "slot": "<requested-slot>",
  "reason": "slot-not-declared" | "scope-read-only"
}
```

A `read`-scope declaration permits `get` only; `set` and `delete` are denied with `scope-read-only`. Denials are logged to the plugin's `~/.roubo/plugins/<pluginId>/logs/current.log` with the stable identifier `<pluginId>.<methodName>`.

## Storage layout

- Service: the literal string `roubo-plugins`.
- Account: `<pluginId>/<slotName>` (e.g. `github-com/oauth-token`).
- Label (Linux only): `roubo-<pluginId>-<slotName>` so the entry is recognisable in `seahorse` or `secret-tool search`.

To inspect on macOS: open Keychain Access and search for `roubo-plugins`. To inspect on Linux: `secret-tool search service roubo-plugins`.

## Ubuntu headless recipe

`secret-tool` needs a Secret Service implementation running. Desktop Ubuntu has one out of the box (gnome-keyring or kwallet). Headless boxes do not. Install the tools and start a daemon under a D-Bus session:

```bash
# One-time install
sudo apt-get install -y libsecret-tools gnome-keyring dbus-user-session

# Per-shell session (interactive):
export $(dbus-launch)
printf '\n' | gnome-keyring-daemon --unlock --components=secrets
gnome-keyring-daemon --start --components=secrets

# Or as a one-shot wrapper for headless CI / servers:
dbus-run-session -- sh -c 'printf "\n" | gnome-keyring-daemon --unlock --components=secrets && roubo'
```

If the daemon is not reachable, `secret-tool` exits non-zero with a "Cannot autolaunch D-Bus" message. The credential store throws `CredentialStoreError("keyring-unavailable", ...)` and the host surfaces that error to the plugin. The store does **not** fall back to a plaintext file: the PRD constraint "credentials never on disk in plaintext" applies even on headless boxes.

## Why pure-JS shellouts

Native modules (e.g. `keytar`) require platform-specific build toolchains, prebuilt binaries per Node ABI, and add a long-term maintenance burden disproportionate to the surface they provide. The shellout approach has one moving part per OS, is auditable, and survives Node upgrades unchanged. The trade-off is that the macOS `security` CLI accepts the secret as a command-line argument (`-w <value>`), so it is briefly visible to `ps` for the lifetime of the child process. On Linux we avoid this by piping the secret into `secret-tool store` on stdin.
