# Integrations

Roubo integrates with external services to support issue assignment, pull request tracking, and authentication. This document covers how to configure each integration.

## GitHub

### Overview

Roubo uses GitHub OAuth to authenticate users and access repository data (issues, PRs, project boards). The OAuth flow uses a `roubo://` custom-protocol deep link as the callback: the authorization page opens in the user's default browser, GitHub redirects to `roubo://oauth/github/callback`, the OS hands the URL to the Roubo Electron app, and the app exchanges the code for a token stored at `~/.roubo/auth.json` (mode `0600`).

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

Roubo requests the following scopes at authorize-time (configured in [`server/services/github-auth.ts`](../server/services/github-auth.ts)):

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

These are read at startup in `server/services/github-auth.ts`.

### Step 4. Verify the flow

1. Start Roubo (`npm run dev` or launch the packaged Electron app).
2. Open **Settings** → click **Connect GitHub**.
3. The GitHub authorization page opens in your default browser. This is intentional; Roubo does not embed the OAuth flow in the Electron window (see `windowOpenHandler` in [`electron/src/main.ts`](../electron/src/main.ts)).
4. Approve access. Your browser will show a prompt to open `roubo://…`; allow it.
5. The Roubo window comes to the foreground and Settings displays your connected GitHub username.
6. Confirm the token was written: `ls -l ~/.roubo/auth.json` should show the file with mode `600`.

### Troubleshooting

**`redirect_uri_mismatch` from GitHub**  
The Authorization callback URL on the OAuth App does not exactly match `roubo://oauth/github/callback` (or the value of `GITHUB_REDIRECT_URI`). Fix the callback URL on the GitHub OAuth App settings page and retry.

**Browser cannot open `roubo://` links**  
The `roubo://` protocol handler is not registered with the OS. In development, it is registered at runtime via `app.setAsDefaultProtocolClient('roubo')` in `electron/src/main.ts`. In a packaged build it is declared in [`electron/forge.config.ts`](../electron/forge.config.ts). Rebuild or reinstall the packaged app to refresh the OS registration.

**Nothing happens after GitHub redirects**  
Check the Electron main-process logs for errors in `handleDeepLink`. The single-instance lock (`requestSingleInstanceLock` in `electron/src/main.ts`) ensures a second Roubo launch forwards the URL to the running instance. If Roubo was not running when the redirect happened, the OS should have launched it and replayed the URL via the `pendingDeepLinkUrl` buffer.

**"State mismatch" error dialog**  
OAuth `state` tokens expire after 10 minutes (`STATE_TTL_MS` in `server/services/github-auth.ts`). Start the authorization flow again from Settings.
