# Architecture: Hosted marketplace and plugin de-bundling

**Parent spec:** component-plugins (`.specifications/component-plugins/`). This is the case-B increment that realizes that spec's deferred v3 marketplace. The parent folder is read-only.

## Context

**PRD:** ./prd.md

Roubo's marketplace was partially built but ships **unbuilt source** (the installer git-clones `plugins/<id>` and renames it, no build step, `dist/` gitignored), so any plugin not also pre-bundled in the app fails to start (`missing-entry`). Only the three integration plugins are bundled, so the component plugins have no working distribution path at all. This architecture makes the marketplace a real, separate, hosted channel that serves **built, signed artifacts**, de-bundles every plugin, and keeps a tiny first-run seed cache. The choice is non-trivial because it is trust-critical: it must preserve fail-closed signature/integrity verification (NFR-001), key rotation and revocation without an app release (FR-007, NFR-004), offline degradation that never drops to zero plugins (FR-009, NFR-003), a `< 5s` no-network first run and `p95 < 10s` install (NFR-002), and it must add no new runtime crypto/supply-chain dependency (NFR-006).

## Decision summary

**Lens:** Buy-not-build: GitHub Releases + static signed catalog, reuse the existing verifier.

A new public repository (`davidpoxon/roubo-plugins`) holds the plugin sources, the build/sign/publish CI, the signed catalog, and the published artifacts. Its GitHub Actions CI builds each plugin with `tsup` into a self-contained `dist/index.js`, packs a **normalized, reproducible tarball**, computes a sha256 digest over that built tarball, uploads it as a **GitHub Release asset**, and regenerates an **ed25519-signed catalog** served from **GitHub Pages**. The Roubo app drops its embedded catalog and instead fetches the signed catalog over HTTPS, verifies it with the **existing zero-dependency `marketplace-integrity` verifier** (extended only to digest the built artifact rather than a source subdir), caches the last verified catalog on disk, and installs by downloading + verifying + unpacking a Release asset (no git clone, no build). The app bundles no plugin sources; a **seed cache** of three built+signed artifacts (`github-com`, `process`, `database`) ships in the installer and is auto-installed once on first launch. Key rotation without an app release is handled by an **app-fetched signed key-ring** anchored by one long-lived bootstrap root key the app embeds.

This lens won because it adds the least new infrastructure, honors NFR-006 (no new runtime crypto/supply-chain dependency, the ed25519/sha256 verifier is reused verbatim), and fits the real scale (single-vendor, ~5 plugins, maintainer-curated). The tradeoff that tipped it: B and C both add a moving part (an OCI client in the host; a public backend to operate) to buy capabilities the existing signed-catalog + sha256 model already provides or the PRD defers.

### Considered and rejected

- **B: OCI registry (ghcr.io):** adds a host-side OCI pull client for content-addressing the existing sha256 digest already provides, directly against NFR-006; revocation still has to live in the signed catalog anyway, so the registry is transport ceremony.
- **C: Dedicated marketplace service:** builds and operates a public backend (API + bucket + CDN + DB) for telemetry / instant revocation / third-party submission, all of which the PRD frames as future; its own recommended phase 1 collapses back to lens A (static signed catalog + artifacts on a CDN).

## Components

| Name                     | Kind       | New / existing / extended | Responsibility                                                                                                                                                                                                                    |
| ------------------------ | ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roubo-plugins` repo     | external   | new                       | Separate public repo holding plugin sources, the publish CI, the signed catalog, the key-ring, and the Release assets (the marketplace, FR-001).                                                                                  |
| `marketplace-publish-ci` | external   | new                       | Actions workflow: builds each plugin (`tsup`), packs a normalized reproducible tarball, computes its built-artifact sha256, uploads it as a Release asset, and regenerates + signs the catalog (FR-002, FR-006, NFR-006).         |
| `release-assets`         | external   | new                       | GitHub Releases storage hosting each plugin's pre-built tarball `<id>-<version>.tgz` as the install download target (FR-002).                                                                                                     |
| `signed-catalog`         | external   | new                       | Static signed catalog envelope `{payload, signature}` served from GitHub Pages at a stable URL (FR-001, FR-003, FR-007).                                                                                                          |
| `signed-key-ring`        | external   | new                       | Signed list of active/revoked operational signing keys, anchored by the app's embedded bootstrap root key; enables operational-key rotation without an app release (FR-007, NFR-004).                                             |
| `marketplace-integrity`  | module     | extended                  | Existing zero-dep ed25519-over-canonical-JSON + sha256 verifier; reused verbatim except the package digest now targets the unpacked built artifact, and it gains key-ring resolution (FR-003, NFR-001, NFR-006).                  |
| `catalog-client`         | module     | new                       | Fetches the signed catalog (and key-ring) over HTTPS, verifies signatures, caches the last verified envelope on disk, and degrades to cache then seed when offline (FR-001, FR-009, NFR-003).                                     |
| `marketplace` service    | module     | extended                  | Swaps the embedded-JSON import for `catalog-client` output; listing, revoke filtering, install/update routing otherwise unchanged (FR-007).                                                                                       |
| `plugin-installer`       | module     | extended                  | Adds a download-and-unpack-tarball staging path (no git clone, no build) with path-containment + size limits; integrity is checked over the unpacked artifact before the existing atomic commit/rename (FR-002, FR-003, NFR-001). |
| `seed-bundle`            | data-store | new                       | Three built+signed tarballs + a signed seed-catalog snapshot shipped under the app's `resources/`; auto-installed once on first launch via the local-artifact install path (FR-004, NFR-002).                                     |
| `plugin-manager`         | module     | extended                  | Gains a one-time first-run seed step and a clean-break upgrade that drops prior bundled-discovered installs; discovery of `~/.roubo/plugins` and spawn/supervision otherwise unchanged (FR-004, FR-008, NFR-005).                 |
| `app-packaging`          | module     | extended                  | Stops shipping plugin source dirs; instead downloads the pinned seed artifacts + seed catalog into `resources/seed/` at package time (replaces the `BUNDLED_PLUGIN_IDS` source-copy path) (FR-004, FR-005).                       |
| `sdk-shared-publish`     | external   | new                       | Publishes `@roubo/plugin-sdk`, `@roubo/shared`, `@roubo/shared-github` to a registry so the separate plugins repo builds against pinned versions instead of `file:` (FR-011).                                                     |
| `component-row-editor`   | client     | extended                  | Removes the vestigial Role (Process/Database) toggle tied to legacy `component.type`, leaving plugin-bound components only (FR-010).                                                                                              |
| `errored-banner`         | client     | extended                  | Surfaces the plugin's real `lastError` instead of hardcoded integration-only copy (FR-012; independently shippable).                                                                                                              |

## Data model

| Entity                   | Owner             | Shape                                                                                                                                                                                                                    |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CatalogEntry` (revised) | `signed-catalog`  | `id, name, kind ('component'\|'integration'), version, summary, source: { type:'release', assetUrl: string, sha256: string }, integrity: 'sha256-<hex over built tarball>', provenance, revoked?: bool, verified?: bool` |
| `SignedCatalog`          | `signed-catalog`  | `{ payload: { schemaVersion, generatedAt, keyId, entries: CatalogEntry[] }, signature: base64 ed25519 over canonical payload bytes }` (envelope shape unchanged from today)                                              |
| `SignedKeyRing`          | `signed-key-ring` | `{ payload: { keys: [{ keyId, publicKeyPem, status: 'active'\|'revoked' }], generatedAt }, signature: base64 ed25519 by the bootstrap ROOT key }`                                                                        |
| `CachedCatalog`          | `catalog-client`  | last verified `SignedCatalog` envelope + `fetchedAt`, on disk under `~/.roubo/marketplace/`; read on offline degrade (FR-009)                                                                                            |
| `ReleaseAsset`           | `release-assets`  | `<id>-<version>.tgz` containing `dist/index.js` + `roubo-plugin.yaml` + `package.json` + `README` (self-contained, no `node_modules`, no `src`)                                                                          |
| `SeedBundle`             | `seed-bundle`     | `resources/seed/{ catalog.json, <id>-<version>.tgz x3 }` consumed once on first launch                                                                                                                                   |

PRD-supplied invariants: every artifact is integrity-verified over the **built** tarball and every catalog/key-ring is ed25519-verified, both fail closed (NFR-001); the catalog payload stays `< 256 KB` (NFR-002). The app embeds exactly one long-lived **bootstrap root public key**; all operational signing keys are rotated through the signed key-ring.

## Interfaces / contracts

### `marketplace-publish-ci` → `release-assets` (publish)

- **Action:** create a GitHub Release tagged `<id>-v<version>`, upload asset `<id>-<version>.tgz` (the normalized built tarball).
- **Signing:** the ed25519 private key is consumed only in a CI step from a scoped secret (GitHub OIDC / Actions secret), never written to an artifact or log (NFR-004).
- **Self-check (publish gate):** CI recomputes the digest over the exact uploaded asset and asserts it equals the value written into the catalog entry; a mismatch fails the release (mirrors the #689 integrity test). This is what makes the reproducible digest load-bearing rather than aspirational.

### `marketplace-publish-ci` → `signed-catalog` / `signed-key-ring` (publish)

- **Action:** regenerate `catalog.json` (entries with `assetUrl` + `sha256`), sign the canonical payload with the active operational key, publish to GitHub Pages. Key-ring is re-signed by the root key only on a rotation event.

### `catalog-client` → `signed-catalog` (HTTP)

- **Request:** `GET https://davidpoxon.github.io/roubo-plugins/catalog.json` (and `.../key-ring.json`).
- **Response:** `200` `SignedCatalog` (`< 256 KB`, NFR-002) / network error.
- **On `200`:** verify the catalog signature against the active key resolved from the verified key-ring; on success, write `CachedCatalog`. **On failure (network or signature):** fail closed, fall back to `CachedCatalog`, then to the `SeedBundle` catalog (never zero plugins, FR-009).
- **Fetch cadence:** on app launch and on opening the marketplace UI (so revocation propagates within an app session, NFR-004).

### `marketplace` → `catalog-client` (function-call)

- **Contract:** `getVerifiedCatalog(): { entries: CatalogEntry[], source: 'network' | 'cache' | 'seed' }`. Revoked entries are filtered from listings and blocked from install/update (FR-007), exactly as today.

### `plugin-installer` → `release-assets` (HTTP) + `marketplace-integrity` (function-call)

- **Download:** `GET entry.source.assetUrl` stream to a staging dir (`p95 < 10s @ 10 Mbps`, NFR-002).
- **Unpack:** extract into staging with path-containment (zip-slip guard via `resolveWithin`), entry-count + size limits, before any execution.
- **Verify:** `verifyPackageIntegrity(unpackedDir, entry.integrity)` over the **built** artifact; on mismatch throw `integrity-failed` and discard staging (0 unverified artifacts executed, NFR-001).
- **Commit:** the existing atomic stage → rename into `~/.roubo/plugins/<id>` flow, reused unchanged.

### `plugin-manager` → `plugin-installer` (function-call)

- **Contract:** `seedFromBundled()`: one-time install of `resources/seed/*.tgz` into `~/.roubo/plugins` on first launch, verifying each against the seed catalog digest (FR-004). Idempotent: a marker records the seed completed.

### `app-packaging` → `release-assets` (HTTP, build time)

- **Contract:** at package time, download the pinned seed artifacts (`github-com`, `process`, `database` at fixed versions) + the seed catalog into `resources/seed/`, verifying each digest. Replaces the `BUNDLED_PLUGIN_IDS` source-copy path; the app repo no longer carries plugin source.

## Sequence flows

### Publish a plugin version

1. Maintainer tags / merges in `roubo-plugins`; CI builds the plugin with `tsup` and packs a normalized reproducible tarball.
2. CI computes the tarball sha256, creates a Release `<id>-v<version>`, uploads `<id>-<version>.tgz`.
3. CI regenerates `catalog.json` with the new entry (`assetUrl`, `sha256`), signs it with the active operational key, runs the digest self-check, publishes to Pages.

### Install a non-seeded plugin (e.g. `ghe`)

1. App fetches + verifies the catalog (or uses cache), lists entries.
2. User installs; `plugin-installer` downloads the Release asset, unpacks with containment, verifies the digest over the built artifact, fails closed on mismatch.
3. On success, atomic rename into `~/.roubo/plugins/ghe`; `plugin-manager` discovers and spawns `dist/index.js`.

### First-run seed (offline-capable, FR-004 / NFR-002)

1. App launches with no prior `~/.roubo/plugins` seed marker, no network needed.
2. `plugin-manager.seedFromBundled()` installs the three `resources/seed/*.tgz` (verified against the seed catalog) into `~/.roubo/plugins`, writes the marker.
3. The common-case app (GitHub.com + process + database) is usable in `< 5s` with no network call on the critical path.

### Offline / marketplace unreachable (FR-009 / NFR-003)

1. Catalog fetch fails (network/signature); `catalog-client` returns `CachedCatalog`, else the seed catalog.
2. Seeded + previously-installed plugins load normally; a new non-seeded install surfaces a clear "marketplace unreachable" error, never a crash, never zero plugins.

### Revocation (FR-007 / NFR-004)

1. Maintainer sets `revoked: true` on the entry, re-signs + republishes the catalog (no app release).
2. At the next fetch (launch / marketplace open) the app delists it and blocks install/update. Already-installed running plugins are not force-killed (NFR-004 target is "blocked at next refresh").

### Operational-key rotation (FR-007 / NFR-004)

1. Maintainer adds the new operational key to the key-ring (status `active`), marks the old `revoked`, re-signs the key-ring with the **root** key, re-signs the catalog with the new key. No app release.
2. The app fetches + verifies the key-ring against its embedded root key, then verifies the catalog against the now-active key. Only a **root**-key change requires an app release.

## Operational concerns

- **Deployment:** publishing is GitHub Actions in `roubo-plugins`; hosting is GitHub Releases (artifacts) + Pages (catalog/key-ring). The app gains an HTTPS fetch path and a seed install; it no longer ships plugin source.
- **Observability:** GitHub-native hosting emits no first-party telemetry (an accepted limitation of lens A); install/failure counts are not measured. The host logs verification failures and offline-degrade events locally.
- **Scaling:** trivial; a `< 256 KB` static catalog and ~5 small tarballs served by GitHub's CDN.
- **Failure modes:** GitHub/Pages outage or rate-limit → degrade to disk cache then seed (FR-009); reproducibility drift → publish gate fails before release; tarball tampering → fail-closed integrity check.

## Security & compliance

- **NFR-001 (fail-closed verification):** every catalog, key-ring, and artifact is signature/digest verified against the app-held root key (via the key-ring) before any listing, install, or execution; any mismatch is rejected.
- **NFR-004 (key secrecy + propagation):** the ed25519 private key lives only in a scoped CI secret, never in artifacts or logs; rotation and revocation propagate via the signed key-ring + catalog with no app release.
- **NFR-006 (no new crypto/supply-chain dep):** the existing `node:crypto` ed25519/sha256 verifier is reused verbatim; the only additions are an HTTPS fetcher and a tarball unpacker built on Node primitives (a benign tar utility, if used, is not a crypto/supply-chain dependency). `oras`/`cosign`/Sigstore are explicitly not adopted.
- **Tarball intake** is a new untrusted-input surface; mitigated by path-containment, size/entry-count limits, and verify-before-execute.

## Supersedes / PRD deltas

- **CPHM-FR-003 / CPHM-NFR-001 (catalog-signature verification key):** the PRD originally stated the catalog signature is verified against a single key the app holds. This design refines that: the catalog is signed by a rotating operational key resolved from a signed key-ring, and the app embeds only the long-lived bootstrap root key that anchors the ring (only a root-key change requires an app release). A single embedded catalog key cannot satisfy FR-007 (rotation without an app release), so the key-ring model supersedes the app-held-key wording for these two IDs; the PRD text for FR-003 / NFR-001 has been updated to match.

Otherwise, Lens A satisfies every PRD FR/NFR as written, including FR-007 (rotation without an app release, via the key-ring) and the NFR-004 revocation target ("blocked at the next catalog refresh").

## Open questions

Resolved here (decisions): catalog hosting = GitHub Pages, artifacts = per-plugin Release assets tagged `<id>-v<version>`; revocation cadence = fetch on launch + marketplace open; key rotation = app-fetched signed key-ring under one embedded root key; SDK delivery = publish the three packages to a registry, plugins repo pins versions (runtime stays self-contained via `tsup`).

Genuinely still open (for breakdown / implementers):

- [ ] Bootstrap **root-key custody and recovery** (the prior signing key was lost in #750): where the root private key lives and the recovery story if it is lost (the one event that still needs an app release).
- [ ] Whether the plugins repo keeps an in-repo `file:` workspace path for first-party SDK dev alongside the published-version path, and how the two stay in sync.
- [ ] Whether `@roubo/shared-github` needs to be a published package at all. Unlike `@roubo/plugin-sdk` (public contract) and `@roubo/shared` (consumed by host and plugins), it is plugin-internal: only `github-com` and `ghe` import it, the host keeps its own copy of the parser (`server/services/alert-external-id.ts`), and `tsup` inlines it into each plugin's `dist`. Once #769 relocates the plugins it can become an in-repo workspace package there and drop out of the publish set (and out of #790's trusted-publisher registration). Decide: keep publishing it, or fold it into the plugins repo.
- [ ] Exact tarball normalization recipe needed for byte-stable digests across CI runs (sorted entries, fixed mtime, stripped pack metadata, pinned toolchain).

## Out of scope

- Telemetry, instant (sub-refresh) revocation, and a third-party submission path (lens C capabilities; documented as a future evolution from this design).
- Migration of existing installs (clean break per FR-008).
- Enforced sandboxing (parent v2, already shipped).

## Phase mapping (suggested delivery sequencing)

The PRD does not mandate phases for this increment; this is recommended sequencing for `breakdown` to slice along.

| Phase               | Components delivered                                                                                  | Outcome                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1. Foundation       | `marketplace-integrity` (digest-over-built-artifact), `sdk-shared-publish`                            | Verifier targets built artifacts; SDK/shared publishable (FR-003, FR-011, NFR-006).                                        |
| 2. Marketplace repo | `roubo-plugins` repo, `marketplace-publish-ci`, `release-assets`, `signed-catalog`, `signed-key-ring` | Built + signed artifacts and a signed catalog published from the new repo (FR-001, FR-002, FR-006, FR-007).                |
| 3. App client       | `catalog-client`, `marketplace` (network source), `plugin-installer` (download+verify+unpack)         | App installs verified built artifacts over HTTPS, fail-closed + offline-degrade (FR-001, FR-003, FR-009, NFR-001/002/003). |
| 4. De-bundle + seed | `app-packaging`, `seed-bundle`, `plugin-manager` (seed + clean-break)                                 | App ships no plugin source; first-run seed cache; clean-break upgrade (FR-004, FR-005, FR-008, NFR-005).                   |
| 5. UI cleanup       | `component-row-editor`, `errored-banner`                                                              | Vestigial Role toggle removed (FR-010); banner surfaces real errors (FR-012, independently shippable).                     |
