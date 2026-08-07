# Releasing Roubo

This guide walks maintainers through cutting a release. It is reference material; for day-to-day development see [development.md](./development.md).

## What the release workflow does

The release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) triggers on `release: [created]` and on `workflow_dispatch`. It validates the tag format, stamps the version, builds via `electron-forge make`, then uploads every `.dmg`, `.zip`, `.deb`, and `.AppImage` it finds to the GitHub release. macOS builds are signed and notarized when the Apple secrets below are configured.

Only one matrix entry is active: `macos-latest` / `arm64`. The `macos-latest` / `x64` and `ubuntu-22.04` / `x64` entries are commented out, so a release currently ships two macOS arm64 artifacts and nothing else:

```
Roubo-<version>-arm64.dmg
Roubo-darwin-arm64-<version>.zip
```

[`electron/forge.config.ts`](../electron/forge.config.ts) still configures `deb` and AppImage makers for Linux, but no runner builds them today. Uncomment the matrix rows to ship those platforms.

The `.zip` is the artifact that matters for auto-updates. `update.electronjs.org` only recognises a macOS asset whose filename matches `.*-(mac|darwin|osx).*\.zip$`, and reads the architecture from a `-arm64` or `-universal` segment in that filename. The default `maker-zip` output already satisfies this; renaming the asset would silently break updates.

## How versioning works

The git tag is the single source of truth for the release version. `electron/package.json` on `main` is permanently set to `0.0.0`; do not edit it. When the release workflow runs, it stamps the real version into `electron/package.json` at build time by stripping the `v` prefix from the tag (e.g. tag `v1.2.3` becomes version `1.2.3`). This happens on every matrix runner before `electron-forge make` is called; the change is never committed back.

## Packaging dependencies

Before `electron-forge make` runs on each matrix runner, the `make` script inside `electron/package.json` performs a nested `npm install` (`--omit=dev --no-save --package-lock=false --workspaces=false --install-strategy=nested`). This populates `electron/node_modules/` with the production deps that npm workspaces otherwise hoist to the repo root. `electron-packager`'s dependency walker (`flora-colossus`) cannot follow the hoist, so without this step the packaging phase fails with `Failed to locate module "mssql" …`. The install is idempotent, adds 10–30 s per matrix job, and does not modify any tracked files.

## App Bundle Identifier

The bundle ID is set at [`electron/forge.config.ts`](../electron/forge.config.ts) line 30:

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
3. The first post-change release starts a fresh notarization history. Apple treats it as a new app; factor in notarization latency for the initial submission.
4. Existing users' settings (`~/Library/Preferences/<old-id>.plist`), keychain entries, and TCC permission grants will not carry over. Either migrate them on first launch or accept the reset and communicate clearly in release notes.
5. `update-electron-app` will not bridge installs from the old bundle ID to the new one; users on the old build must manually download the new release. Note this prominently in release notes.
6. Update any URL-scheme, UTI, Sparkle feed URL (if introduced), or analytics identifiers that reference the bundle ID.

## Prerequisites

- Apple Developer Program membership (for signing certificates and notarization)
- Repo admin access (to set GitHub Actions secrets)
- macOS with Keychain Access (to export the `.p12` certificate)

## Scripted draft release (recommended)

For day-to-day pre-release builds, `npm run release:draft` does the whole dance in one command: it computes the next version, creates the draft release, and dispatches the build workflow.

```bash
npm run release:draft -- <patch|minor|major>
```

What it does, in order:

1. Reads the latest published release (the one GitHub marks as `Latest`) and bumps it by the level you pass. Drafts and existing pre-releases are ignored.
2. Fetches `origin/main` and appends a SemVer pre-release identifier (per [spec item 9](https://semver.org/#spec-item-9)) built from that commit's short sha: `-rc.<short-sha>`. For example, a `patch` bump off a `v0.1.2` base at commit `a1b2c3d` becomes `v0.1.3-rc.a1b2c3d`. The `rc.` keeps the first identifier non-numeric, which sidesteps the SemVer rule that a numeric identifier must not have a leading zero.
3. Creates the GitHub release as `--draft --prerelease` with `--generate-notes`, targeting the `origin/main` HEAD commit. The build always uses the latest pushed code regardless of your local checkout.
4. Dispatches `release.yml` with the matching `tag_name`, kicking off the platform builds.

Flags:

- `--dry-run`: print the resolved base, the computed tag, and the exact `gh` commands, then exit without making any changes. Use this to preview the tag.
- `--no-dispatch`: create the draft release but do not trigger the build workflow. The command prints the `gh workflow run` line to run later.

Requirements:

- An authenticated GitHub CLI. Check with `gh auth status`; run `gh auth login` if needed.

These are draft, pre-release builds. `update.electronjs.org` does not serve them to users. Review the artifacts on the draft, then take it public by following [Publishing a public release](#publishing-a-public-release) from step 4; publishing alone is not enough, the verification steps are part of the release.

## Publishing a public release

This is the full path for a release that reaches users. The scripted flow above only ever produces a draft pre-release, which `update.electronjs.org` will not serve, so every public release finishes with the publish and verification steps below. Steps 1 and 2 are also the fallback for that scripted flow when you need full control over the tag, target, or notes.

Do not stop at step 4. A release can be published, correctly signed, and still invisible to the updater; step 5 is what catches that, and it has caught it in production before (see [Troubleshooting](#troubleshooting-a-published-release-is-not-offered-to-users)).

1. **Create a draft release** with a `v`-prefixed tag. Either via the GitHub web UI:
   1. Go to the repo on GitHub → **Releases** → **Draft a new release**
   2. Click **Choose a tag** and type the new tag (e.g. `v1.2.3`); select **Create new tag: v1.2.3 on publish**
   3. Leave **Target** as `main`
   4. Set the release title to match the tag (e.g. `v1.2.3`)
   5. Click **Generate release notes** to auto-populate the description
   6. Click **Save draft**, not **Publish release**. Publishing now would upload artifacts to an already-live release

   Or via the `gh` CLI:

   ```bash
   gh release create v1.2.3 --draft --title "v1.2.3" --generate-notes
   ```

2. **Trigger the build manually.** GitHub does not fire `release` events for draft releases, so the workflow must be dispatched:

   ```bash
   gh workflow run release.yml -f tag_name=v1.2.3
   ```

   The workflow validates the tag format, stamps `electron/package.json` at build time, then runs the build matrix (one macOS arm64 job today). macOS artifacts are signed and notarized when the Apple secrets are configured. Allow 8–15 minutes; macOS notarization is the slowest step.

   Check the run log to confirm signing actually happened. The step echoes its own script, so the line `::warning::CSC_LINK or CSC_KEY_PASSWORD not set` appears in the log as echoed source text even on a fully signed build. The signal to look for is the resolved identity:

   ```bash
   gh run view <run-id> --log | grep "Developer ID Application"
   ```

3. **Review artifacts** on the draft release page. Confirm both expected macOS arm64 files are present and that the `.zip` filename still matches the pattern in [What the release workflow does](#what-the-release-workflow-does).

4. **Publish the release.** Draft and pre-release releases are not served by `update.electronjs.org`; publishing is what makes the release eligible for users. Via the GitHub UI, open the draft and click **Publish release**. Or via the `gh` CLI:

   ```bash
   gh release edit v1.2.3 --draft=false --latest
   ```

5. **Verify the release is publicly visible.** Run the checks in [Verifying a public release](#verifying-a-public-release). This step is mandatory and cannot be done with `gh`, because `gh` authenticates as you and will show a release the public cannot see.

6. **Confirm rollout expectations.** Clients poll on the interval set in [`electron/src/main.ts`](../electron/src/main.ts) (currently one hour) and only while the app is running, so uptake is gradual. Users who checked for updates before the release went live are not re-prompted until their next poll.

## Verifying a public release

`update-electron-app` points the app at `update.electronjs.org`, which resolves the latest version from exactly one endpoint:

```
GET https://api.github.com/repos/davidpoxon/roubo/releases?per_page=100
```

It walks that list in order, skips drafts and pre-releases, and takes the **first** release carrying an asset that matches the platform. It never calls `releases/latest`. A release that is missing from this one listing is invisible to every user, even when the release page, the tag, `releases/latest`, and the asset downloads all work perfectly.

Run all three checks unauthenticated. Do not substitute `gh`, which would mask the exact failure this catches.

These checks are manual today. Automating the first one as a release-workflow gate is tracked in #1171.

1. **The new tag appears in the public listing**, and appears first:

   ```bash
   curl -s "https://api.github.com/repos/davidpoxon/roubo/releases?per_page=100" | jq -r '.[].tag_name'
   ```

   The new tag must be in the output, and it must be the first entry. Because the service takes the first matching release rather than the highest version, a new release listed below an older one would leave users on the older build. If the tag is absent or not first, stop and go to [Troubleshooting](#troubleshooting-a-published-release-is-not-offered-to-users); the release is not reaching users.

2. **The update feed offers the new version** to someone on the previous release. Substitute the version users are upgrading _from_:

   ```bash
   curl -s "https://update.electronjs.org/davidpoxon/roubo/darwin-arm64/1.2.2" | jq -r '.name, .url'
   ```

   This must print the new tag and the `.zip` download URL. An empty response means HTTP 204, which is the server saying "already up to date".

   The service caches its per-repo result for roughly 15 minutes, so allow for that lag before treating a 204 as a failure. Re-run until it flips rather than assuming the first answer is final.

3. **The new version reports itself as current:**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "https://update.electronjs.org/davidpoxon/roubo/darwin-arm64/1.2.3"
   ```

   Expect `204`.

## Troubleshooting: a published release is not offered to users

**Symptom.** The release page looks correct and the artifacts download, but users are never prompted to update. Check 1 above shows the tag missing from the public listing while `gh release list` shows it normally.

This has happened in production. Release `v0.2.1` was published, signed, notarized, and reachable via `releases/latest`, its tag, and its asset URLs, yet it was absent from the public `releases` listing for over a day. Users on `v0.2.0` were told they were up to date, and users on older builds were offered `v0.2.0`. Nothing distinguished it from the release before it: same workflow, same draft-then-publish sequence, identical `draft`, `prerelease`, and `target_commitish` fields. It was a GitHub-side indexing inconsistency, where the release record read as published but the public list index behaved as though it were still a draft.

**Diagnosis.** Confirm the split between the authenticated and public views:

```bash
gh api "repos/davidpoxon/roubo/releases?per_page=100" --jq '.[].tag_name'   # shows the tag
curl -s "https://api.github.com/repos/davidpoxon/roubo/releases?per_page=100" | jq -r '.[].tag_name'   # omits it
```

If the first command lists the tag and the second does not, the release record is fine and the listing index is stale.

**Fix.** Toggling the pre-release flag rewrites the listing row and forces a reindex:

```bash
gh release edit v1.2.3 --prerelease
gh release edit v1.2.3 --prerelease=false --latest
```

Re-run check 1; the tag should appear immediately. Then re-run check 2, allowing the usual cache lag before the feed flips from 204 to 200.

Releases report `immutable: true`, which locks published assets but does not block these metadata edits. Marking the release as a pre-release briefly is safe: the updater already ignores it in that state, which is the state it was effectively stuck in anyway.

**If the toggle does not take.** Delete and recreate the release against the existing tag, then re-run the build to re-upload the artifacts:

```bash
gh release delete v1.2.3 --yes            # the git tag is left in place
gh release create v1.2.3 --title "v1.2.3" --generate-notes
gh workflow run release.yml -f tag_name=v1.2.3
```

Failing that, cut the next patch version and abandon the stuck tag.

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

Signing (`CSC_LINK` + `CSC_KEY_PASSWORD`) must be enabled for notarization to run; Apple rejects unsigned binaries. When signing secrets are absent, notarization is automatically skipped.

### Provisioning Each Value

#### `APPLE_ID`

Your Apple Developer account email address, the account enrolled in the Apple Developer Program. This is used by `notarytool` to authenticate with Apple's notarization service.

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
4. Copy the generated password immediately; it is not shown again

If this password is leaked, revoke it from the same page and generate a new one.

#### `APPLE_IDENTITY`

The full identity string for your Developer ID Application certificate (e.g. `Developer ID Application: Acme Inc (AB12CD34EF)`). This is the identity passed to `codesign`.

First, generate a Certificate Signing Request (CSR):

1. Open **Keychain Access** on macOS.
2. **Deselect any certificate first**: in the main list, click an empty area so nothing is highlighted. This is important: if a certificate is selected, the menu item becomes **Request a Certificate … With `<hash>`** and the request will fail with _"The specified item could not be found in the keychain."_
3. From the menu bar: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…** (confirm the menu item has no "With …" suffix).
4. Fill in the dialog:
   - **User Email Address**: your Apple Developer account email (the `APPLE_ID` value)
   - **Common Name**: a descriptive name, e.g. `Roubo Developer ID`
   - **CA Email Address**: leave blank
   - **Request is**: select **Saved to disk**
5. Click **Continue** and save the `.certSigningRequest` file somewhere memorable (e.g. `~/Desktop/roubo.certSigningRequest`).
6. Keychain Access creates a matching private key in your **login** keychain; the eventual `.p12` export will use it, so do not delete it.

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
2. Click the **My Certificates** tab at the top of the window. This view only lists certificates that have a matching private key in the keychain, which is what enables `.p12` export. If you select the certificate from **All Items** instead, the export dialog will only offer `.cer` (public key only).
3. Select your **Developer ID Application** certificate.
4. Right-click it → **Export** → in the **File Format** dropdown choose **Personal Information Exchange (.p12)** and save the file.
5. Set a strong password when prompted; this becomes `CSC_KEY_PASSWORD`.
6. Base64-encode and copy the file:

   ```bash
   base64 -i /path/to/cert.p12 | pbcopy
   ```

7. Paste the result as `CSC_LINK`.

Delete the `.p12` file from your machine once the secrets are stored.
