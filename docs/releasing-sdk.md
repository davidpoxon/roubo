# Releasing @roubo/plugin-sdk

The plugin SDK ships independently of the Roubo desktop app. SDK versions track the plugin contract, not the app release cadence.

## Versioning

- Tag format: `sdk-vX.Y.Z` (distinct from app tags `vX.Y.Z`).
- The SDK is pre-1.0 (`0.x`); minor bumps may carry breaking contract changes, but call them out in the changelog.
- The JSON-RPC protocol is additive: newer hosts continue to work with older SDKs, so authors only upgrade when they want new contract methods.

## Release steps

1. Bump `version` to the same `X.Y.Z` in **both** `plugin-sdk/package.json` and `shared/package.json`. `@roubo/plugin-sdk` and `@roubo/shared` publish in lockstep, and the `sdk-release` workflow fails the release if either file disagrees with the tag.
2. Create (or update) `plugin-sdk/CHANGELOG.md` with the new version and notes.
3. Bump the internal pins to match, then run `npm install` and commit the resulting `package-lock.json`. Every workspace under `plugins/` that pins `@roubo/plugin-sdk` at an exact version needs the new version (at the time of writing: `_shared-github`, `database`, `github-com`, `process`), as does every one that pins `@roubo/shared` (at the time of writing: `github-com` only). Skip this and npm stops linking those workspaces, resolving the **previous** published SDK from `registry.npmjs.org` instead, so the first-party plugins build against the contract the release exists to retire. See commit `6debe7f` for the precedent.
4. Commit: `git commit -s -m "sdk: release vX.Y.Z"`. The `-s` is required; the `commit-msg` hook and the `DCO sign-off` check both reject unsigned commits.
5. Open a pull request against `main` and merge it once `pr-check` is green. `main` is branch-protected, so the version commit cannot be pushed to `main` directly; only the tag is pushed directly.
6. Tag the merged commit on `main`: `git fetch origin` then `git tag sdk-vX.Y.Z origin/main`.
7. Push the tag on its own: `git push origin sdk-vX.Y.Z`.
8. Watch the `sdk-release` workflow in GitHub Actions. It verifies the tag matches `plugin-sdk/package.json` and `shared/package.json`, builds, runs SDK tests, and publishes both packages to npm with provenance.

## Prerequisites

Publishing uses npm **trusted publishing** (OIDC). No `NPM_TOKEN` secret is needed; npm exchanges the GitHub OIDC token for a short-lived publish credential at runtime, and provenance is attached automatically.

The release workflow needs `id-token: write` permission (already set in `sdk-release.yml`).

## First-time setup (one-off)

Configure the trusted publisher on npmjs.com before the first publish:

1. Sign in to npmjs.com as a maintainer of the `@roubo` org.
2. Go to the `@roubo` org → **Packages** → either select `@roubo/plugin-sdk` (if it exists) or add a **pending trusted publisher** for it.
3. Choose **GitHub Actions** as the publisher and fill in:
   - **Organization or user:** `davidpoxon`
   - **Repository:** `roubo`
   - **Workflow filename:** `sdk-release.yml`
   - **Environment:** _(leave blank unless you add a GitHub Environment gate)_
4. Save.

After that, every push of an `sdk-v*` tag triggers a publish with no further secret management.

## Notes

- Trusted publishing requires npm CLI 11.5.1+. The workflow runs `npm install -g npm@latest` before publish to guarantee that.
- Provenance only works when the workflow runs from a public repo on `github.com`; if the repo ever moves, re-verify.
- If the repo is renamed or the workflow filename changes, update the trusted publisher record on npmjs.com to match, or publishes will fail with an OIDC mismatch.
