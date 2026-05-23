# Integrations

Roubo integrates with external services to support issue assignment, pull request tracking, and authentication. This document covers how to configure each integration.

## GitHub

### Overview

Roubo uses GitHub OAuth to authenticate users and access repository data (issues, PRs, project boards). The OAuth flow uses a `roubo://` custom-protocol deep link as the callback: the authorization page opens in the user's default browser, GitHub redirects to `roubo://oauth/github/callback`, the OS hands the URL to the Roubo Electron app, and the app exchanges the code for a token persisted via the github-com plugin's keychain slot (`credentialStore.set("github-com", "github-token", …)` in `server/services/github-oauth.ts`). Any pre-existing `~/.roubo/auth.json` from an earlier Roubo version is migrated into the keychain and then deleted by `server/services/migrate.ts`.

### When you need your own OAuth App

Roubo ships with a default bundled OAuth App (client ID `Ov23li8FytWzZPHmc7fm`). You only need your own if you are:

- Developing or testing OAuth-related changes
- Forking Roubo for your own distribution
- Running a private build where you control the credentials

### Step 1. Create the OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**  
   (For an org-owned app: **GitHub → Your org → Settings → Developer settings → OAuth Apps**.)

2. Fill in the fields:

   | Field                          | Value                                                    |
   | ------------------------------ | -------------------------------------------------------- |
   | **Application name**           | `Roubo (dev)` or any name                                |
   | **Homepage URL**               | Any valid URL, e.g. `https://github.com/<you>/roubo-dev` |
   | **Authorization callback URL** | `roubo://oauth/github/callback`                          |

   The **Authorization callback URL** is the critical field: it must be exactly `roubo://oauth/github/callback`.

3. Click **Register application**.

4. On the next screen, click **Generate a new client secret** and copy it immediately; it is only shown once.

5. Also copy the **Client ID** shown at the top of the page.

### Step 2. Required scopes

Roubo requests the following scopes at authorize-time (configured in [`server/services/github-oauth.ts`](../server/services/github-oauth.ts)):

| Scope          | Purpose                                   |
| -------------- | ----------------------------------------- |
| `repo`         | Read/write access to repositories and PRs |
| `read:org`     | Read org membership for issue assignment  |
| `read:project` | Read GitHub Projects data                 |

No action is needed to configure scopes on the OAuth App itself; they are requested during the authorization flow. If `REQUIRED_SCOPES` is ever changed, connected users will be prompted to re-authorize.

### Step 3. Wire credentials into Roubo

Set these environment variables before starting the server:

```bash
export GITHUB_CLIENT_ID=<your client id>
export GITHUB_CLIENT_SECRET=<your client secret>

# Optional; defaults to roubo://oauth/github/callback.
# Must match the Authorization callback URL on the OAuth App exactly if overridden.
export GITHUB_REDIRECT_URI=roubo://oauth/github/callback
```

These are read at startup in `server/services/github-oauth.ts`.

### Step 4. Verify the flow

1. Start Roubo (`npm run dev` or launch the packaged Electron app).
2. Open **Settings → Plugins**, click **Configure** on the github-com plugin, then click **Connect GitHub** in the Configure dialog.
3. The GitHub authorization page opens in your default browser. This is intentional; Roubo does not embed the OAuth flow in the Electron window (see `windowOpenHandler` in [`electron/src/main.ts`](../electron/src/main.ts)).
4. Approve access. Your browser will show a prompt to open `roubo://…`; allow it.
5. The Roubo window comes to the foreground and the Configure dialog displays your connected GitHub username after a successful **Test connection**.

### Troubleshooting

**`redirect_uri_mismatch` from GitHub**  
The Authorization callback URL on the OAuth App does not exactly match `roubo://oauth/github/callback` (or the value of `GITHUB_REDIRECT_URI`). Fix the callback URL on the GitHub OAuth App settings page and retry.

**Browser cannot open `roubo://` links**  
The `roubo://` protocol handler is not registered with the OS. In development, it is registered at runtime via `app.setAsDefaultProtocolClient('roubo')` in `electron/src/main.ts`. In a packaged build it is declared in [`electron/forge.config.ts`](../electron/forge.config.ts). Rebuild or reinstall the packaged app to refresh the OS registration.

**Nothing happens after GitHub redirects**  
Check the Electron main-process logs for errors in `handleDeepLink`. The single-instance lock (`requestSingleInstanceLock` in `electron/src/main.ts`) ensures a second Roubo launch forwards the URL to the running instance. If Roubo was not running when the redirect happened, the OS should have launched it and replayed the URL via the `pendingDeepLinkUrl` buffer.

**"State mismatch" error dialog**  
OAuth `state` tokens expire after 10 minutes (`STATE_TTL_MS` in `server/services/github-oauth.ts`). Start the authorization flow again from the github-com plugin's Configure dialog.

## Plugin permissions

Integration plugins run as Node subprocesses spawned by the Roubo host. Every plugin ships a manifest (`roubo-plugin.yaml`) that declares the permissions it needs across four categories. The host enforces those declarations at runtime through a small RPC surface; calls that fall outside the declared scope are denied with a structured error and a warning written to the plugin's log file.

The manifest schema lives in [`shared/plugin-manifest-schema.ts`](../shared/plugin-manifest-schema.ts).

### The four categories

| Category      | Manifest field                                         | Host helper                                               |
| ------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Network       | `permissions.network.hosts` (glob list)                | `host.fetch(url, init?)`                                  |
| Credentials   | `permissions.credentials.slots` (slot + scope)         | `host.credentials.get/set/delete(slot)`                   |
| Filesystem    | `permissions.filesystem.paths` (extra roots)           | `host.fs.readFile/writeFile/readdir/stat/mkdir`           |
| Child process | `permissions.processes` (`false` \| `{ executables }`) | `host.process.spawn(executable, args?, { cwd?, stdin? })` |

The plugin's own install directory is always part of the filesystem allowlist; everything else must be listed explicitly. Relative entries in `filesystem.paths` resolve against the plugin directory.

### Denial shape

A denied request returns a JSON-RPC error with `code: -32001` and a structured `data` payload. The shape is consistent across categories:

```jsonc
{
  "code": "permission-denied",
  "category": "filesystem", // or: "credentials" | "processes" | "network"
  "reason": "path-not-in-allowlist", // category-specific reason string
  "path": "/tmp/exfiltrate.txt", // category-specific identifier (slot, executable, host)
}
```

Every denial is also logged to the plugin's host log line at `warn` level, prefixed with `${pluginId}.${methodName}` so audit grep is straightforward.

### Trust boundary: raw `fs` and `child_process`

The host helpers above are the **mediated** path. They are not a sandbox. A plugin running in a Node subprocess can still write `import { promises as fs } from "node:fs"` or `import { spawn } from "node:child_process"` and bypass the host helpers entirely. We do not run plugins inside a seccomp/sandbox-exec wrapper today.

This is a documented trust boundary, not a bug:

- The manifest is a declarative contract the plugin author publishes and the user accepts at install time. Plugins that bypass their own declared permissions are misbehaving software, not a defeated security control.
- Host-mediated calls are still the right path for plugin code because they get logged, audited, and surface clear errors to the user when scope is wrong.
- Future hardening (OS-level audit via process monitoring, per the integration-plugins Spike B) may capture raw bypass attempts. It is not promised in any specific release.

Plugin authors should use `host.fs.*` and `host.process.spawn` exclusively. Reviewers of third-party plugins should treat any raw `node:fs` or `node:child_process` import as a red flag that warrants closer reading of the manifest.
