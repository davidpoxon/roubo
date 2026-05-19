# Releasing Roubo

The release workflow (`.github/workflows/release.yml`) triggers on `release: [created]` and builds signed macOS arm64, macOS x64, and Linux x64 artifacts automatically via `electron-forge make`. Artifacts (`.dmg`, `.zip`, `.deb`) are uploaded to the GitHub release. macOS builds are signed and notarized when the Apple secrets below are configured.

## How versioning works

The git tag is the single source of truth for the release version. `electron/package.json` on `main` is permanently set to `0.0.0` — do not edit it. When the release workflow runs, it stamps the real version into `electron/package.json` at build time by stripping the `v` prefix from the tag (e.g. tag `v1.2.3` → version `1.2.3`). This happens on every matrix runner before `electron-forge make` is called; the change is never committed back.

## Packaging dependencies

Before `electron-forge make` runs on each matrix runner, the `make` script inside `electron/package.json` performs a nested `npm install` (`--omit=dev --no-save --package-lock=false --workspaces=false --install-strategy=nested`). This populates `electron/node_modules/` with the production deps that npm workspaces otherwise hoist to the repo root. `electron-packager`'s dependency walker (`flora-colossus`) cannot follow the hoist, so without this step the packaging phase fails with `Failed to locate module "mssql" …`. The install is idempotent, adds ~10–30 s per matrix job, and does not modify any tracked files.

## App Bundle Identifier

The bundle ID is set at `electron/forge.config.ts:30`:

```
appBundleId: 'dev.roubo.desktop'
```

The format is reverse-DNS: the organisation domain (`roubo.dev`) reversed to `dev.roubo`, then the app name appended. This value is load-bearing:

- macOS keys user settings (`~/Library/Preferences/dev.roubo.desktop.plist`), keychain entries, TCC permission grants (microphone, full-disk access, etc.), and Launch Services registration to it.
- `codesign` and `notarytool` bind signatures and notarization tickets to it; the Developer ID cert (`APPLE_IDENTITY`) must cover this identifier.
- `update-electron-app` uses it as the stable app identity when checking for updates across versions.

**Do not change it on a shipped app without a migration plan.** A new bundle ID is effectively a new app to macOS and to Apple's notarization service.

### Changing the bundle ID (if ever required)

1. Update `appBundleId` in `electron/forge.config.ts`.
2. Confirm the Developer ID Application cert covers the new identifier. Apple certs are team-scoped (not bundle-ID-scoped), but verify with `security find-identity -v -p codesigning` and do a test sign before releasing.
3. The first post-change release starts a fresh notarization history — Apple treats it as a new app; factor in notarization latency for the initial submission.
4. Existing users' settings (`~/Library/Preferences/<old-id>.plist`), keychain entries, and TCC permission grants will not carry over. Either migrate them on first launch or accept the reset and communicate clearly in release notes.
5. `update-electron-app` will not bridge installs from the old bundle ID to the new one — users on the old build must manually download the new release. Note this prominently in release notes.
6. Update any URL-scheme, UTI, Sparkle feed URL (if introduced), or analytics identifiers that reference the bundle ID.

## Prerequisites

- Apple Developer Program membership (for signing certificates and notarization)
- Repo admin access (to set GitHub Actions secrets)
- macOS with Keychain Access (to export the `.p12` certificate)

## Release Checklist

1. **Create a draft release** with a `v`-prefixed tag. Either via the GitHub web UI:
   1. Go to the repo on GitHub → **Releases** → **Draft a new release**
   2. Click **Choose a tag** and type the new tag (e.g. `v1.2.3`) — select **Create new tag: v1.2.3 on publish**
   3. Leave **Target** as `main`
   4. Set the release title to match the tag (e.g. `v1.2.3`)
   5. Click **Generate release notes** to auto-populate the description
   6. Click **Save draft** (not **Publish release**) — publishing now would upload artifacts to an already-live release

   Or via the `gh` CLI:

   ```bash
   gh release create v1.2.3 --draft --title "v1.2.3" --generate-notes
   ```

2. **Trigger the build manually** — GitHub does not fire `release` events for draft releases, so the workflow must be dispatched:

   ```bash
   gh workflow run release.yml -f tag_name=v1.2.3
   ```

   The workflow validates the tag format, stamps `electron/package.json` at build time, then builds all platform artifacts in parallel. macOS artifacts are signed and notarized when the Apple secrets are configured. Allow ~8–15 min; macOS notarization is the slowest step.

3. **Review artifacts** on the draft release page.
4. **Publish the release** from the GitHub UI. `update-electron-app` picks it up on the next client check. (Draft and pre-release releases are not served by `update.electronjs.org` — publishing is what makes updates visible to users.)

## Environment Variables

These GitHub Actions secrets must be set in the repo (**Settings → Secrets and variables → Actions → New repository secret**) to produce signed and notarized macOS artifacts:

| Secret                        | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `CSC_LINK`                    | Base64-encoded `.p12` certificate for code signing   |
| `CSC_KEY_PASSWORD`            | Password for the `.p12` certificate                  |
| `APPLE_IDENTITY`              | Full `Developer ID Application: …` identity string   |
| `APPLE_ID`                    | Apple Developer account email used for notarization  |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated at appleid.apple.com |
| `APPLE_TEAM_ID`               | 10-character Apple Developer Team ID                 |

Signing (`CSC_LINK` + `CSC_KEY_PASSWORD`) must be enabled for notarization to run — Apple rejects unsigned binaries. When signing secrets are absent, notarization is automatically skipped.

### Provisioning Each Value

#### `APPLE_ID`

Your Apple Developer account email address — the account enrolled in the Apple Developer Program. This is used by `notarytool` to authenticate with Apple's notarization service.

#### `APPLE_TEAM_ID`

The 10-character team identifier assigned to your Apple Developer account.

1. Sign in at [developer.apple.com](https://developer.apple.com/account)
2. Go to **Membership details**
3. Copy the **Team ID** value (e.g. `AB12CD34EF`)

#### `APPLE_APP_SPECIFIC_PASSWORD`

An app-specific password that allows `notarytool` to sign in to your Apple ID without your main password.

1. Sign in at [appleid.apple.com](https://appleid.apple.com)
2. Go to **Sign-In and Security → App-Specific Passwords**
3. Click **+** and generate a new password with a label like `roubo-notarization`
4. Copy the generated password immediately — it is not shown again

If this password is leaked, revoke it from the same page and generate a new one.

#### `APPLE_IDENTITY`

The full identity string for your Developer ID Application certificate (e.g. `Developer ID Application: Acme Inc (AB12CD34EF)`). This is the identity passed to `codesign`.

First, generate a Certificate Signing Request (CSR):

1. Open **Keychain Access** on macOS.
2. **Deselect any certificate first**: in the main list, click an empty area so nothing is highlighted. This is important — if a certificate is selected, the menu item becomes **Request a Certificate … With `<hash>`** and the request will fail with _"The specified item could not be found in the keychain."_
3. From the menu bar: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…** (confirm the menu item has no "With …" suffix).
4. Fill in the dialog:
   - **User Email Address**: your Apple Developer account email (the `APPLE_ID` value)
   - **Common Name**: a descriptive name, e.g. `Roubo Developer ID`
   - **CA Email Address**: leave blank
   - **Request is**: select **Saved to disk**
5. Click **Continue** and save the `.certSigningRequest` file somewhere memorable (e.g. `~/Desktop/roubo.certSigningRequest`).
6. Keychain Access creates a matching private key in your **login** keychain — the eventual `.p12` export will use it, so do not delete it.

Then create the certificate using the CSR:

1. Go to [developer.apple.com](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles → Certificates**
2. Click **+** and choose **Developer ID Application**
3. When prompted, upload the `.certSigningRequest` file generated above
4. Download the resulting `.cer` file
5. Double-click the `.cer` to install it into your login keychain

Then find the identity string:

```bash
security find-identity -v -p codesigning
```

Copy the full quoted string next to your Developer ID Application entry.

#### `CSC_LINK` and `CSC_KEY_PASSWORD`

`CSC_LINK` is the base64-encoded `.p12` bundle containing your Developer ID Application certificate and its private key. `CSC_KEY_PASSWORD` is the password you set when exporting it.

1. Open **Keychain Access** on macOS and select the **login** keychain.
2. Click the **My Certificates** tab at the top of the window. This view only lists certificates that have a matching private key in the keychain, which is what enables `.p12` export — if you select the certificate from **All Items** instead, the export dialog will only offer `.cer` (public key only).
3. Select your **Developer ID Application** certificate.
4. Right-click it → **Export** → in the **File Format** dropdown choose **Personal Information Exchange (.p12)** and save the file.
5. Set a strong password when prompted — this becomes `CSC_KEY_PASSWORD`.
6. Base64-encode and copy the file:
   ```bash
   base64 -i /path/to/cert.p12 | pbcopy
   ```
7. Paste the result as `CSC_LINK`.

Delete the `.p12` file from your machine once the secrets are stored.
