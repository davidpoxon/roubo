# Brief: Hosted marketplace and plugin de-bundling

> Parent spec: component-plugins (`.specifications/component-plugins`). This increment realizes that spec's deferred **v3 marketplace** phase (its capability 6 and open question "Marketplace infrastructure & trust") and goes one step further: it de-bundles every plugin from the app.

> One-line pitch: Move the plugin marketplace into its own hosted repository that serves built, signed plugin artifacts, and stop bundling plugins inside the Roubo app, so every plugin (integrations and components alike) is installed the same way and actually runs on a fresh machine.

## Problem

The parent `component-plugins` spec pre-designed a "v3 marketplace" but left its hosting and trust model open. The marketplace was then partially built (a signed catalog, ed25519 integrity, an install flow) but it has two defects that make it unusable as the real distribution channel, and the app currently papers over them by bundling a subset of plugins:

- **The marketplace ships unbuilt source.** `plugin-installer.ts` installs by git-cloning the repo subdirectory `plugins/<id>` and renaming it into place with **no build step**; `dist/` is gitignored and never committed, and the integrity digest is computed over the **source** subdir. So an installed plugin has `src/` but no `dist/index.js` and fails to start with `missing-entry`. This is exactly why the `process` and `database` component plugins are broken on a user's machine today.
- **The app masks this by bundling only some plugins.** `BUNDLED_PLUGIN_IDS` in `electron/src/packaging/copy-resources.ts` pre-builds and ships only the three integration plugins (`github-com`, `ghe`, `jira-self-hosted`). The two component plugins are not bundled, so on a fresh machine there is **no working way** to get them: not bundled, and the marketplace would deliver broken source.
- **The catalog is embedded in the app.** `marketplace-catalog.json` lives in `server/services/`, so updating the catalog or adding a plugin requires shipping a new app release. The marketplace is not really a separable, hosted thing.

The fix is to make the marketplace a real, separate, hosted distribution channel that serves **built, signed artifacts**, and to route **every** plugin through it (removing in-app bundling), so distribution is uniform and correct rather than "bundled ones work, marketplace ones are broken."

## Target users

- **Primary: consumers (teams).** Same as the parent: developers assembling a bench from first-party plus community plugins. They need every plugin to install and run identically and reliably, and a fresh install to be usable, without a plugin silently failing because it shipped as source.
- **Secondary: plugin authors.** A separate, hosted marketplace repo with a published build/sign/publish pipeline is the path by which a third party ships a working plugin without it being baked into a Roubo release.
- **Also: the Roubo team (marketplace operator).** Curates the catalog, holds the signing key, and publishes artifacts, now from a dedicated repo rather than the app repo.
- **Not the user:** end users of the applications a bench runs.

## Jobs to be done

- **As a consumer:** install any plugin (integration or component) from the marketplace and have it actually run, on any machine, with no manual build step, and have a fresh app be immediately usable for the common case.
- **As an author:** publish a working, signed plugin artifact to the hosted marketplace without a change to the Roubo app or a Roubo release.
- **As the operator:** update the catalog, add or revoke a plugin, and rotate the signing key without shipping a new app build.

## Current alternatives & their gaps

- **Embedded catalog + source-clone install (today):** the catalog is baked into the app and installs deliver unbuilt source. Gaps: catalog changes need an app release; installed plugins that are not also bundled fail to start; integrity is over source, not the runtime artifact.
- **Bundle plugins in the app (today's masking):** only the three integrations are pre-built and shipped. Gaps: component plugins have no working distribution path at all; the bundled set is fixed at app-build time; "bundled works, marketplace is broken" is an inconsistent, surprising model.
- **Tell users to build from source:** requires the repo and a Node toolchain the packaged app and a normal user do not have.

## Core capabilities

- **1. Separate, hosted marketplace repository.** The catalog and the plugin artifacts live in their own repo and are served from there; the app fetches the catalog over the network (still signature-verified against a key the app holds, fail-closed) instead of from an embedded file.
- **2. Built, signed artifact delivery.** The marketplace serves pre-built, self-contained plugin artifacts (`tsup` already bundles deps into a self-contained `dist/index.js`); install fetches, verifies, and places the built artifact. Integrity moves from digest-over-source to **digest-over-built-artifact**, preserving the existing signing / revocation / key-rotation properties (#622, #689, #750).
- **3. De-bundle all plugins from the app.** Remove `BUNDLED_PLUGIN_IDS`-style in-app bundling; the app ships no plugins inside it. Every plugin is a marketplace install.
- **4. First-run seed cache (the cold-start answer).** The installer carries a small one-time seed of **built, signed artifacts for `github-com`, `process`, and `database` only**, auto-installed once on first launch and thereafter marketplace-managed. `ghe` and `jira-self-hosted` are **marketplace-only** (not seeded). This keeps the common-case fresh app usable first-run and offline without truly bundling plugins.
- **5. Build / sign / publish pipeline in the new repo.** CI in the marketplace repo builds each plugin, signs the artifact, computes the artifact digest, and publishes both the artifact and the regenerated catalog.
- **6. Remove the vestigial Role-toggle UI.** Delete the legacy "Role" (Process/Database) toggle in the project Components editor (`ComponentRowEditor.tsx`) that edits the deprecated `component.type` field, decoupled from plugin bindings and vestigial after closed #612 / #614. It is what currently lets a user "configure a Database component with no plugin."

## Out of scope (v1)

- **Migration of existing installs: there is none (clean break).** On upgrade, existing in-place bundled installs are dropped; their config / instances are not carried over. The first-run seed cache provides fresh installs of `github-com` / `process` / `database`; anything else (`ghe`, `jira-self-hosted`) is reinstalled from the marketplace. This is the deliberate, simplest path.
- **The `ErroredBanner` legibility fix is orthogonal.** It hardcodes integration-only "3 restart attempts / issue snapshot" copy and never surfaces a plugin's real `lastError`. Worth doing (it is why the original breakage was undiagnosable) but it can ship independently of this re-platforming; tracked in breakdown, not a dependency.
- **Third-party submission / community curation flow.** The catalog stays maintainer-curated (no third-party submission path), as today.

## Constraints

- **Platform/tech:** Node.js >= 24.14.0; Electron-packaged app (plugins live outside the asar so the host can spawn `dist/index.js`); `tsup` produces self-contained plugin bundles; existing ed25519-signed catalog + sha256 integrity model (`marketplace-integrity.ts`).
- **Trust model parity (hard):** signing, revocation (#622 / #689), and key rotation (#750) must carry over, now binding to built artifacts. The app must still fail closed on a signature or digest mismatch.
- **Build prerequisite:** plugins build against `@roubo/plugin-sdk` (already `publishConfig: public`) and integrations also against `@roubo/shared` / `@roubo/shared-github`, which are `file:` monorepo refs today and must be made resolvable from the separate repo (publish vs co-locate, decided in architecture).
- **No regression in the working case:** `github-com` works today because it is bundled pre-built; after de-bundling, the seed cache must make it work identically first-run.
- **Migration:** clean break (see Out of scope); no byte-compatibility obligation.

## Differentiation

Internal distribution infrastructure, not a competitive surface. The point is correctness and uniformity: one install path that delivers working, verified plugins, replacing today's "bundled works, marketplace ships broken source" split.

## Success definition

- **Components work on a fresh machine:** a clean install can run a `process` and a `database` component, sourced through the marketplace / seed cache, with no manual build. (This is the concrete bug this whole effort closes.)
- **App ships no plugins inside it** (beyond the first-run seed cache), and the catalog is updatable without an app release.
- **Every marketplace install is a verified, built artifact:** integrity is checked over the runtime artifact and fails closed on mismatch; signing / revocation / rotation still hold.
- **The common-case fresh app is usable first-run and offline** via the three-plugin seed cache.

## Open questions & risks

- [ ] **Hosting target (build-vs-buy).** GitHub Releases vs an npm / OCI registry vs a bespoke service/CDN for the catalog and artifacts. **Routed to feasibility** (its single load-bearing dimension).
- [ ] **SDK / shared-package delivery.** Publish `@roubo/plugin-sdk` (+ `@roubo/shared`, `@roubo/shared-github`) to npm, co-locate them in the marketplace repo, or consume them build-time-only via submodule/CI. **Routed to architecture.**
- [ ] **Integrity-over-built-artifact mechanics.** Exact digest/signing scheme over the built artifact (vs today's over-source), and how the build is made reproducible enough to verify. **Routed to architecture.**
- [ ] **Catalog versioning & update cadence** against a now-external catalog: how the app pins / discovers catalog versions, caches it, and behaves when the marketplace is unreachable after first run.
- [ ] **Clean-break UX impact.** Dropping existing installs and their config is disruptive; confirm the seed cache sufficiently softens it for the common case and that the loud failure mode is acceptable.
- [ ] **Repo-split mechanics.** Moving `plugins/*` to the new repo, where the SDK build dependency lives, and how the main app references the catalog/key.

## Source notes

- Raw input: re-platform plugin distribution: move the marketplace to a separate hosted repo serving built + signed artifacts; de-bundle all plugins (integrations `github-com` / `ghe` / `jira-self-hosted` and components `process` / `database`); fix the install-ships-unbuilt-source defect; remove the vestigial Components Role-toggle UI. Surfaced from a user hitting the broken `process` component plugin (`missing-entry`) and discovering it had no working distribution channel.
- Interview changelog (2026-06-25):
  - **Cold-start / offline = first-run seed cache**, limited to **`github-com`, `process`, `database`**; `ghe` and `jira-self-hosted` are marketplace-only (not seeded).
  - **Migration = clean break**: existing bundled installs are dropped on upgrade; no config/instance migration; seed cache provides the three defaults, marketplace covers the rest.
  - **Hosting build-vs-buy = routed to feasibility** (kept as the one feasibility dimension).
  - **SDK delivery + integrity-over-built-artifact = routed to architecture** (recorded open questions).
  - Scope confirmed as a **case-B branch-new increment** on the shipped `component-plugins` parent; parent kept read-only.
