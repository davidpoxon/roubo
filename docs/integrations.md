# Integrations

Roubo integrates with external services to support issue assignment, pull request tracking, and authentication. This document covers how to configure each integration.

## GitHub

### Overview

Roubo uses GitHub OAuth to authenticate users and access repository data (issues, PRs, project boards). Sign-in uses GitHub's [OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow), which needs only the OAuth App's client ID. Roubo has no client secret: a desktop app cannot keep one, because anything shipped in the app can be extracted from it.

1. **Connect GitHub** asks the server to start a flow (`POST /api/plugins/github-com/oauth/device`). The server requests a device code from GitHub and keeps it in memory. The Configure dialog receives only a short user code and the URL to enter it at.
2. You enter the code at `https://github.com/login/device` in your browser and approve access.
3. Meanwhile the dialog polls the server (`POST /api/plugins/github-com/oauth/device/poll`) at the interval GitHub sets. Each poll makes at most one token request to GitHub. On approval the server saves the token to the github-com plugin's keychain slot (`credentialStore.set("github-com", "github-token", …)` in `server/services/github-oauth.ts`) and the dialog shows the connected account.

Any pre-existing `~/.roubo/auth.json` from an earlier Roubo version is migrated into the keychain and then deleted by `server/services/migrate.ts`.

### The bundled OAuth App

Packaged releases and source runs both use the bundled OAuth App (client ID `Ov23li8FytWzZPHmc7fm`). **Device Flow is enabled on the bundled OAuth App**, which is what lets it sign in without a client secret. Nothing else needs to be configured: **Connect GitHub** works from a source checkout as is.

### When you need your own OAuth App

Use your own OAuth App if you are:

- Forking Roubo for your own distribution
- Running a private build where you control the credentials
- Testing changes to the OAuth App's settings without touching the bundled one

#### Step 1. Create the OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**  
   (For an org-owned app: **GitHub → Your org → Settings → Developer settings → OAuth Apps**.)

2. Fill in the fields:

   | Field                          | Value                                                    |
   | ------------------------------ | -------------------------------------------------------- |
   | **Application name**           | `Roubo (dev)` or any name                                |
   | **Homepage URL**               | Any valid URL, e.g. `https://github.com/<you>/roubo-dev` |
   | **Authorization callback URL** | Any valid URL; the device flow does not use it           |

3. Tick **Enable Device Flow**, then click **Register application**.

4. Copy the **Client ID** shown at the top of the page. Do not generate a client secret; Roubo does not use one.

#### Step 2. Required scopes

Roubo requests the following scopes when it starts a flow (configured in [`server/services/github-oauth.ts`](../server/services/github-oauth.ts)):

| Scope             | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `repo`            | Read/write access to repositories and PRs          |
| `read:org`        | Read org membership for issue assignment           |
| `read:project`    | Read GitHub Projects data                          |
| `security_events` | Read code-scanning alerts for project repositories |

No action is needed to configure scopes on the OAuth App itself; they are requested during the authorization flow. If `REQUIRED_SCOPES` is ever changed, connected users will be prompted to re-authorize.

#### Step 3. Point Roubo at your OAuth App

Set the client ID before starting the server:

```bash
export GITHUB_CLIENT_ID=<your client id>
```

It is read once at startup in `server/services/github-oauth.ts`. No other credential is needed.

### Verify the flow

1. Start Roubo (`npm run dev` or launch the packaged Electron app).
2. Open **Settings → Plugins**, click **Configure** on the github-com plugin, then click **Connect GitHub** in the Configure dialog.
3. The dialog shows a code such as `ABCD-1234`. Click **Copy code and open GitHub**: the code goes to the clipboard and `https://github.com/login/device` opens in your default browser. Roubo does not embed the GitHub page in the Electron window (see `windowOpenHandler` in [`electron/src/main.ts`](../electron/src/main.ts)).
4. Paste the code and approve access.
5. Return to Roubo. The Configure dialog shows your connected GitHub username within a few seconds, with no further clicks.

### Troubleshooting

**"the device flow is not enabled on the OAuth App"**  
GitHub answered `device_flow_disabled`. Open the OAuth App's settings page, tick **Enable Device Flow**, save, and click **Connect GitHub** again.

**"The code expired before it was approved"**  
Device codes expire after the time GitHub sets, 15 minutes today. A server restart also discards the flow in progress. Click **Connect GitHub** again for a new code.

**"Access was denied on GitHub"**  
You clicked **Cancel** on the GitHub approval page. Click **Connect GitHub** again to retry.

**The dialog keeps waiting after you approved**  
Polling runs only while the Configure dialog is open, and it stops when you click **Cancel** or close the dialog. Reopen the dialog and connect again. If GitHub is unreachable or returns server errors, Roubo keeps polling quietly until the code expires, then reports it as expired; connect again once GitHub responds.

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

A child process is confined more tightly than `host.fs.*`. `host.process.spawn` pins the child's working directory to the plugin's own install directory, so a path declared in `permissions.filesystem.paths` stays readable through `host.fs.*` but is not a legal `cwd` (denied with `cwd-not-in-plugin-dir`). A bench workspace is rejected outright, as `cwd`, as the executable, or as an argument (`workspace-path-denied`). Argument scanning is a second barrier rather than a guarantee: it inspects discrete arguments and cannot see a workspace path composed inside a string the child itself interprets.

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
