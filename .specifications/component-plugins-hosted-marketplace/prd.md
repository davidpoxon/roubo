# PRD: Hosted marketplace and plugin de-bundling

|                 |                                                          |
| --------------- | -------------------------------------------------------- |
| **Slug**        | component-plugins-hosted-marketplace                     |
| **Parent spec** | component-plugins (`.specifications/component-plugins/`) |
| **Status**      | draft                                                    |
| **Brief**       | ./brief.md                                               |
| **Feasibility** | ./feasibility.md                                         |

This is a **case-B branch-new increment** on the shipped `component-plugins` spec. It realizes that spec's deferred **v3 marketplace** (its capability 6 and the open question "Marketplace infrastructure & trust") and extends it: the marketplace becomes a separate, hosted repository serving built, signed artifacts, and the app stops bundling plugins. The parent folder is read-only.

## Problem statement

Roubo's marketplace was pre-designed (parent v3) and partially built (a signed catalog, ed25519 integrity, an install flow), but it is unusable as the real distribution channel and the app masks that by bundling a subset of plugins:

- The installer ships **unbuilt source**: it git-clones the repo subdir `plugins/<id>` and renames it into place with no build step, and `dist/` is gitignored. An installed plugin has `src/` but no `dist/index.js` and fails to start (`missing-entry`). This is exactly why the `process` and `database` component plugins are broken on a user's machine today.
- The app bundles only the three integration plugins (`BUNDLED_PLUGIN_IDS` in `copy-resources.ts`), so on a fresh machine the component plugins have **no working distribution path at all**: not bundled, and the marketplace would deliver broken source.
- The catalog is **embedded in the app** (`server/services/marketplace-catalog.json`), so any catalog change needs a new app release.

The fix is to make the marketplace a real, separate, hosted channel that serves **built, signed artifacts**, route every plugin through it (removing in-app bundling), and keep a tiny first-run seed cache so the common case stays usable offline.

## Goals & non-goals

- **Goals:** A separate hosted marketplace repo serving built + signed plugin artifacts; the app fetches the catalog over the network and verifies it fail-closed; every plugin (integration and component) installs the same way and runs on a fresh machine; a first-run seed cache (github-com, process, database) keeps the common case usable offline; the vestigial Components Role-toggle UI is removed.
- **Non-goals:** Migration of existing installs (clean break, see below). Enforced sandboxing (parent v2, already shipped). A third-party plugin submission path (catalog stays maintainer-curated). Adopting Sigstore/TUF/npm/OCI for signing (feasibility ruled it out at this scale).

## In scope

- Separate, hosted marketplace repository (catalog + artifacts), with a build/sign/publish CI pipeline.
- Built, self-contained artifact delivery; integrity verified over the built artifact.
- De-bundling all plugins from the app; first-run seed cache of the three defaults; ghe/jira marketplace-only.
- Network catalog fetch with fail-closed verification and offline degradation to the seed/last-known state.
- Clean-break upgrade behavior.
- Removal of the legacy Components Role-toggle UI.
- Making the plugin-sdk (+ shared) resolvable from the separate repo.

## Out of scope

- **Migration of existing installs:** none (clean break). Existing bundled installs are dropped on upgrade; no config/instance migration.
- **`ErroredBanner` legibility fix** (CPHM-FR-012): captured here for traceability but is **independently shippable** and not a dependency of the re-platforming.
- Third-party submission / community curation; build-provenance attestation (only if later required).

## User stories

- **CPHM-US-001** As a consumer on a fresh machine, I want every plugin (integration or component) to install from the marketplace and actually run with no manual build, so a clean install is usable. _(P0)_
- **CPHM-US-002** As a consumer, I want the common-case app (GitHub.com + process + database) to work first-run and offline, so I am not blocked by the network on first launch. _(P0)_
- **CPHM-US-003** As the marketplace operator, I want to add, update, or revoke a plugin and rotate the signing key without shipping a new app release, so the catalog is independently maintainable. _(P0)_
- **CPHM-US-004** As a plugin author, I want to publish a working, signed plugin artifact to the hosted marketplace via CI without changing the Roubo app, so I can ship without a Roubo release. _(P1)_
- **CPHM-US-005** As a consumer, I want the app to verify every installed plugin against a key it holds and fail closed on tampering, so I can trust what runs. _(P0)_
- **CPHM-US-006** As a consumer configuring components, I want the Components editor to reflect the real plugin-binding model (no vestigial Role toggle), so I am not misled into "configuring a database with no plugin." _(P1)_

## Functional requirements

- **CPHM-FR-001** The catalog and plugin artifacts live in a separate, hosted marketplace repository; the app fetches the catalog from a hosted URL rather than an embedded file. _(serves CPHM-US-001, CPHM-US-003; P0)_
- **CPHM-FR-002** The marketplace serves pre-built, self-contained plugin artifacts; installing a plugin places a runnable `dist/index.js` with no build step on the user's machine. _(serves CPHM-US-001; P0)_
- **CPHM-FR-003** Plugin integrity is verified against the **built artifact** (digest over the built package, not the source subdir), and the catalog signature is verified against a key the app holds; verification fails closed (no install, no listing, no execution on mismatch). _(serves CPHM-US-005; P0)_
- **CPHM-FR-004** The app bundles no plugins except a first-run **seed cache** containing built + signed artifacts for `github-com`, `process`, and `database` only, auto-installed once on first launch and thereafter marketplace-managed. _(serves CPHM-US-002, CPHM-US-001; P0)_
- **CPHM-FR-005** `ghe` and `jira-self-hosted` are marketplace-only (not seeded) and install on demand from the hosted marketplace. _(serves CPHM-US-001; P0)_
- **CPHM-FR-006** A CI pipeline in the marketplace repo builds each plugin, signs the artifact, computes its digest, and publishes the artifact plus the regenerated signed catalog. _(serves CPHM-US-004, CPHM-US-003; P0)_
- **CPHM-FR-007** The catalog supports add / update / revoke of an entry and signing-key rotation without an app release; a revoked entry is removed from listings and blocked from install/update. _(serves CPHM-US-003; P0)_
- **CPHM-FR-008** On upgrade to the marketplace-based build, existing in-place bundled installs are dropped (clean break); the seed cache provides the three defaults and any other plugin is reinstalled from the marketplace. No config/instance migration. _(serves CPHM-US-001; P0)_
- **CPHM-FR-009** When the hosted catalog is unreachable after first run, the app degrades to the seed cache / last-known catalog rather than to zero plugins; install attempts fail with a clear error, not a crash. _(serves CPHM-US-002; P0)_
- **CPHM-FR-010** The legacy "Role" (Process/Database) toggle is removed from the Components editor; the editor reflects the plugin-binding model only. _(serves CPHM-US-006; P1)_
- **CPHM-FR-011** `@roubo/plugin-sdk` (and `@roubo/shared` / `@roubo/shared-github` for integrations) are made resolvable from the separate plugins repo so plugins build there (publish vs co-locate decided in architecture). _(serves CPHM-US-004; P1)_
- **CPHM-FR-012** The errored-plugin banner surfaces the plugin's real `lastError` (code + message) instead of hardcoded integration-only copy ("3 restart attempts / issue snapshot"), and omits the issue-snapshot line for non-integration plugins. _(serves CPHM-US-005; P2; independently shippable, not a re-platforming dependency)_

## Non-functional requirements

Each NFR has a measurable target and a verification method.

- **CPHM-NFR-001** _(Security)_ Every installed artifact is integrity-verified (digest over the built package) and the catalog is ed25519 signature-verified against an app-held public key; any signature or digest mismatch fails closed. **Target:** a tampered artifact **and** a tampered catalog are both rejected; 0 unverified artifacts executed. **Verify:** automated no-network test that a tampered artifact and a tampered catalog are each rejected (mirrors `marketplace-integrity.test.ts`).
- **CPHM-NFR-002** _(Performance)_ Seed-cache cold start makes the common-case app usable with no network; a single marketplace install is fast. **Target:** first-run readiness **< 5s with no network call on the critical path**; single-plugin install (fetch + verify + place) **p95 < 10s @ 10 Mbps**; catalog fetch payload **< 256 KB**. **Verify:** timed first-run test with network disabled; timed install benchmark.
- **CPHM-NFR-003** _(Reliability / availability)_ With the marketplace unreachable after first run, the app degrades gracefully (seed cache / last-known catalog), never to zero plugins; verification stays fail-closed. **Target:** seeded + previously-installed plugins load 100% of the time offline; new installs surface a clear error, not a crash. **Verify:** offline test (marketplace unreachable) confirming seeded/installed plugins load and install attempts fail gracefully.
- **CPHM-NFR-004** _(Operability / supply-chain)_ The ed25519 signing key is never exposed in CI logs or published artifacts; revocation and key rotation propagate to clients without an app release. **Target:** signing key present only as a CI secret / out-of-band, never in published artifacts or logs; a revoked plugin is blocked at the next catalog refresh (cadence set in architecture). **Verify:** secret-scan of published artifacts and CI logs; revocation test that a revoked entry is blocked after refresh.
- **CPHM-NFR-005** _(Compatibility / no-regression)_ After de-bundling, `github-com` behaves identically to its previously-bundled self, and existing `roubo.yaml` configs run unchanged (the Role-toggle removal does not affect plugin bindings). **Target:** 0 regressions in the seeded plugins vs bundled behavior; existing component configs start identically. **Verify:** parity test of seeded `github-com`/`process`/`database` vs the prior bundled build; config-load regression test.
- **CPHM-NFR-006** _(Maintainability)_ The existing zero-dependency ed25519/sha256 verifier is reused; no heavyweight signing/supply-chain dependency is added to the Electron host, and the marketplace build/sign/publish is reproducible. **Target:** no new runtime crypto / supply-chain dependency in the host (no Sigstore/TUF/OCI client); the artifact digest is reproducible enough to re-verify. **Verify:** dependency audit; reproducible-build check on the digest.

_Dropped as N/A: accessibility (a UI deletion, no new UI), scalability (tiny single-vendor catalog, ~5 plugins), compliance/privacy (no PII, internal tooling)._

## Success indicators

### Leading

| Indicator                                                                                                             | Baseline          | Target | Source                    | Validates              |
| --------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ------------------------- | ---------------------- |
| Fresh-machine component success rate (% of clean installs that run a process/database component with no manual build) | 0% (broken today) | 100%   | install telemetry / QA    | CPHM-US-001, CPHM-FR-002, CPHM-FR-004 |
| First-run offline readiness (% of first launches usable offline with the 3-plugin seed set)                           | n/a               | 100%   | QA / telemetry            | CPHM-US-002, CPHM-FR-004         |
| Catalog updates shipped without an app release                                                                        | 0                 | >= 1   | marketplace repo releases | CPHM-US-003, CPHM-FR-007         |

### Lagging

| Indicator                                                                                  | Baseline                      | Target           | Source                                                                 | Validates   |
| ------------------------------------------------------------------------------------------ | ----------------------------- | ---------------- | ---------------------------------------------------------------------- | ----------- |
| "Plugin won't start" issue volume for component plugins                                    | nonzero (the bug this closes) | ~0 after rollout | GitHub issues                                                          | the feature |
| Non-seeded / third-party plugin installs (ghe, jira, community) via the hosted marketplace | 0                             | growing          | GitHub Release download counts (lens A ships no first-party telemetry) | CPHM-US-004      |

## Dependencies & assumptions

- The `davidpoxon/roubo-plugins` plugins repo is and remains **public** (Releases downloads / optional attestations need no GitHub Enterprise Cloud plan).
- Catalog/trust stays **single-vendor, maintainer-curated**, no third-party submission path; if that changes, the signing calculus (Sigstore/TUF) is revisited.
- The Electron host must verify artifacts **offline / at rest** against a key it holds.
- Built artifacts stay small self-contained `dist/index.js` bundles (tsup, no runtime deps).
- Existing Actions CI hosts the build/sign/publish step.

## Open questions

Carried from feasibility (DE-RISK), resolved in architecture:

- [x] Catalog hosting path: GitHub Pages serves the signed catalog; the client caches the last-verified envelope on disk and degrades to cache then seed when offline (CPHM-FR-009).
- [x] CI custody of the ed25519 private signing key: held only as a scoped CI secret (GitHub OIDC / Actions secret), never written to an artifact or log (CPHM-NFR-004).
- [x] sha256-of-bytes is sufficient: the digest is sha256 over the built tarball; no Sigstore/TUF/attestation is adopted (CPHM-NFR-006).
- [x] Per-plugin independent releases: each plugin ships as its own GitHub Release asset tagged `<id>-v<version>` (not a single monorepo release).
- [x] Revocation / kill-switch propagation: the catalog is fetched on app launch and on opening the marketplace, so a revoked entry is blocked within an app session (CPHM-NFR-004).
- [x] SDK / shared-package delivery: publish `@roubo/plugin-sdk`, `@roubo/shared`, and `@roubo/shared-github` to a registry and pin versions in the separate repo (CPHM-FR-011).
