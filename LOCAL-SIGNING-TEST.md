# Local Signing Test

A scratchpad runbook for testing the macOS sign + notarize pipeline on your machine before pushing to CI. Delete this file when you're done — it's not meant to live long.

## Why a separate keychain?

`electron-osx-sign` runs `codesign` against ~1,500 files inside the Electron app bundle. If the private key lives in your login keychain with the default ACL (Confirm before allowing access), each invocation either pops a dialog or hangs waiting for one. The CI workflow sidesteps this by creating a temporary keychain and using `set-key-partition-list` to grant `/usr/bin/codesign` non-interactive access. We mirror that locally.

## Prerequisites

- `.p12` exported from your login keychain. Default expected path: `~/Desktop/roubo-signing.p12`. If yours is elsewhere, change `P12_PATH` below.
- The `.p12` password (= `CSC_KEY_PASSWORD`).
- Your Apple ID app-specific password (`APPLE_APP_SPECIFIC_PASSWORD`).
- TypeScript dependency is in sync (`npx tsc --version` reports `6.0.3`). If not, run `npm install` from the repo root first.

## Step 1 — Build the temp keychain

Run this from the repo root. **Use `source` (not `./`) so `CSC_KEY_PASSWORD` and `P12_PATH` stay set in your shell for Step 2.**

```bash
source ./local-signing-setup.sh
```

It will prompt for the `.p12` password (silently — nothing appears as you type). If your `.p12` is not at `~/Desktop/roubo-signing.p12`, set `P12_PATH=/path/to/cert.p12` before sourcing.

**Why source, not execute?** Pasting an inline block with `read -s` causes zsh to consume the next pasted line as the password (because stdin still has the rest of the paste buffered). Running from a file makes `read -s` read from your actual TTY instead.

### Expected output

```
1) <40-char-hash> "Developer ID Application: David Poxon (7V688EGLE9)"
   1 valid identity found
```

If you see `0 valid identities found`, the import didn't take — check that the `.p12` path is right and the password was entered correctly.

## Step 2 — Run `npm run make`

Same terminal (so `CSC_KEY_PASSWORD` is still exported). Replace `<your-new-app-specific-password>` with the actual value. Do **not** put a leading space.

```bash
cd /Users/olsnacky/Developer/roubo/electron && \
APPLE_IDENTITY="Developer ID Application: David Poxon (7V688EGLE9)" \
APPLE_TEAM_ID="7V688EGLE9" \
APPLE_ID="david@poxon.au" \
APPLE_APP_SPECIFIC_PASSWORD="<your-new-app-specific-password>" \
CSC_LINK="$(base64 -i "$P12_PATH")" \
npm run make
```

### What you should see

1. `tsc` + resource copy + icon build + nested npm install — a few seconds each.
2. `Packaging application` — ~30s.
3. `Finalizing package` — this is where signing happens. Expect **1–3 minutes of silence**. This is normal. No keychain dialogs should appear.
4. Notarization — also silent. Apple typically responds in **5–15 minutes**.

### Checking notarization progress

In a **second terminal** while step 4 is running:

```bash
xcrun notarytool history \
  --apple-id "david@poxon.au" \
  --team-id "7V688EGLE9" \
  --password "<your-new-app-specific-password>"
```

You should see a submission with status `In Progress`, then `Accepted` (or `Invalid` if something is wrong with the signing).

### When it finishes

Check the produced artifacts:

```bash
codesign --verify --deep --strict --verbose=2 \
  electron/out/Roubo-darwin-*/Roubo.app
spctl --assess --type execute --verbose \
  electron/out/Roubo-darwin-*/Roubo.app
```

`spctl --assess` should report `accepted source=Notarized Developer ID`. If it says `source=Developer ID` (no "Notarized"), then signing succeeded but notarization didn't run — check the `electron-forge` log for `notarytool` errors.

## Step 3 — Cleanup

After the test, remove the temp keychain (do this even on failure):

```bash
security delete-keychain "$KEYCHAIN_PATH"
security list-keychains -d user -s \
  $(security list-keychains -d user | tr -d '"' | grep -v 'roubo-signing.keychain-db')
```

Also unset the exported password from the current shell:

```bash
unset CSC_KEY_PASSWORD
```

## Troubleshooting

### Still hanging at "Finalizing package"

Check whether `codesign` is actually running:

```bash
ps aux | grep codesign | grep -v grep
```

- If `codesign` appears with state `R+` or `S+` and CPU activity changes between checks → it's progressing, give it more time.
- If no `codesign` is running but `npm run make` is → it advanced to notarization. Run the `xcrun notarytool history` command above.
- If `codesign` is in state `S+` with zero CPU for >2 min and there's no notarytool submission → still being blocked by a keychain prompt. Try `osascript -e 'tell application "System Events" to set frontmost of every process to false'` to surface hidden dialogs.

### `notarytool` errors

The two most common ones:

- `Error: Could not authenticate` — wrong app-specific password, wrong Apple ID, or the password has a stray space/newline.
- `Error: 403 ...` — the team ID doesn't match the cert's team. Check that `APPLE_TEAM_ID="7V688EGLE9"` matches the team in your Developer ID Application identity string.

### Notarization succeeded but `spctl --assess` says "rejected"

The notarization ticket isn't stapled to the bundle. `electron-osx-notarize` does this automatically; if it didn't, run `xcrun stapler staple electron/out/Roubo-darwin-*/Roubo.app` manually.

## When to delete this file

Once a CI release run produces a signed + notarized `.dmg` that passes `spctl --assess --type execute`, this local-test runbook has served its purpose. Delete both `LOCAL-SIGNING-TEST.md` and `local-signing-setup.sh`, or fold the diagnostic tips into `RELEASING.md` if any of them proved useful.
