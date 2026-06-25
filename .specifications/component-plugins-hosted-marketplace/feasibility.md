# Feasibility: Hosted marketplace and plugin de-bundling

> **Recommendation: DE-RISK**: Proceed. The direction is sound and off-the-shelf hosting fits, but a few hosting/trust details (catalog-fetch + staleness handling, CI signing-key custody, catalog-path choice) must be nailed in architecture before build.

> Parent spec: component-plugins (`.specifications/component-plugins`). This is the minimal, single-dimension feasibility pass for that spec's deferred v3 marketplace, scoped to the one open question the brief routed here.

**Brief:** ./brief.md

_Scope note: this was a deliberately minimal (depth: minimal) feasibility pass. Technical and effort feasibility are inherited from the shipped parent `component-plugins` GO and are not re-litigated (the marketplace, signing, and install flow already exist; the change is largely mechanical). Market / economic / compliance are N/A: this is internal plugin-distribution infrastructure, single-vendor, no PII. The one load-bearing open question, build-vs-buy on hosting + signing, is investigated below._

## Per-dimension summary

| Dimension                        | Verdict                  | Confidence | Top risk                                                                                                              | Mitigation                                                                                                                                                                                 |
| -------------------------------- | ------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build-vs-buy (hosting + signing) | feasible-with-conditions | high       | The signed catalog must now be fetched over the network and verified, genuinely new code vs today's embedded catalog. | Reuse the existing fail-closed verifier verbatim against the fetched catalog; keep the shipped seed cache as the fallback so a fetch failure degrades to the seeded set, not zero plugins. |

## Dimension detail

### Build-vs-buy (hosting + signing)

**Bottom line:** Adopt **GitHub Releases** (assets served from `objects.githubusercontent.com`, public, S3-backed, outside the 2025 anonymous rate-limit tightening) as the off-the-shelf artifact host, plus a **static signed catalog served from the repo**. **Keep Roubo's existing zero-dependency ed25519 signed-catalog + sha256-digest model** for signing/integrity rather than adopting Sigstore/cosign, TUF, npm provenance, or OCI/ORAS. At a tiny single-vendor, maintainer-curated, GitHub-native catalog (~5 plugins) those off-the-shelf supply-chain stacks all add a heavier trust root, a new runtime dependency in the Electron host, and operational burden that exceed their value, while the existing custom verifier already provides fail-closed verification, revocation, and key rotation. The condition: wire the build/sign/publish step into Actions CI and rebase the integrity digest from the git-cloned subdir onto the **built** artifact.

**Key findings (evidence):**

- Roubo's signing/integrity is already complete and zero-third-party-dependency: detached ed25519 over canonical JSON verified against a bundled public key, fail-closed (`server/services/marketplace-integrity.ts`, `marketplace.ts`), plus a deterministic sha256 package digest. Re-platforming needs the digest rebased onto the **built** artifact, not a new crypto library.
- Revocation (`revoked: true`, filtered at listing + blocked at install/update) and key rotation (re-sign the catalog, replace the bundled public-key constant, #750) already exist in a few lines: these are exactly the capabilities Sigstore/TUF are usually adopted to provide.
- GitHub Releases fits at zero marginal cost: assets are public, S3-backed, work unauthenticated, and GitHub states anonymous asset downloads are not affected by the 2025 unauthenticated rate-limit change. CI already exists, so build-and-publish is incremental.
- npm registry is a poor fit (forces public-package semantics + Sigstore-anchored provenance, not "verify against a key the app holds"). OCI/ORAS adds an OCI client dependency to fetch ~5 artifacts and only duplicates the sha256 addressing Roubo already has. Sigstore/cosign keyless adds a Fulcio/Rekor transparency-log dependency that is hostile to the required offline at-rest verification. TUF is supply-chain-correct but heavy for a single-maintainer 5-plugin catalog and has no mature Node/TS client to embed.

**Risks:**

1. The catalog must now be fetched + verified over the network (new code vs embedded). Severity: **medium**. Mitigation: reuse the existing fail-closed verifier against the fetched catalog; seed cache is the fallback.
2. Keeping the bespoke verifier means Roubo owns key custody/rotation/revocation itself (no transparency log). Severity: **low**. Mitigation: acceptable at single-vendor scale; out-of-band key + documented re-sign rotation + `revoked` flag cover the realistic threat model; revisit Sigstore/TUF only if third-party submission ever opens.
3. GitHub Releases couples artifact availability to GitHub. Severity: **low**. Mitigation: shallow lock-in, the catalog already abstracts `source.url` per entry and the installer is source-agnostic; re-pointing to a CDN later is a catalog edit + re-sign, not a rewrite.

**Assumptions:**

- The `davidpoxon/roubo` plugins repo is and remains **public** (so Releases downloads, and optionally Artifact Attestations, need no GitHub Enterprise Cloud plan).
- Catalog/trust stays **single-vendor, maintainer-curated, no third-party submission**. If that changes, the Sigstore/TUF calculus flips.
- The Electron host must verify artifacts **offline / at rest** against a key it already holds (favors the node:crypto verifier over a transparency-log path).
- Built artifacts stay small self-contained `dist/index.js` bundles (tsup), well within Releases' per-asset limits.
- Existing Actions CI can host the build/sign/publish step.

## Top risks (ranked, cross-dimension)

1. **Network-fetched catalog is new, trust-critical code** (verification + staleness/offline handling): severity medium; owner: architecture + the install/catalog code.
2. **CI custody of the ed25519 private signing key** (currently a manual, strictly out-of-band maintainer step): severity medium; owner: architecture / security design.
3. **Single-vendor distribution lock-in to GitHub**: severity low; owner: catalog abstraction (already mostly mitigated).

## De-risking plan

These are lightweight: all resolve as **architecture decisions**, not blocking pre-build spikes. The direction (GitHub Releases + keep custom signing) is settled; these pin the details.

- [ ] Decide the **catalog hosting path** (GitHub raw vs Pages vs a Releases asset) and the client's **caching / staleness / offline** behavior: resolves risk 1. → architecture
- [ ] Decide **CI signing-key custody** (CI secret vs manual local re-sign) without exposing the out-of-band private key: resolves risk 2. → architecture / security
- [ ] Confirm **integrity-of-bytes (sha256) is sufficient** vs needing build provenance/attestation (only adopt Sigstore if provenance is a stated requirement): resolves the trust-model scope. → architecture
- [ ] Decide **per-plugin vs monorepo release/versioning** and how it shapes catalog `source` addressing. → architecture
- [ ] Confirm the **revocation refresh cadence** of the network-fetched catalog meets desired kill-switch latency. → architecture

_(These become `spike` issues at breakdown only if architecture cannot settle them on paper; the expectation is they are decided in architecture.)_

## Recommendation

**DE-RISK**: proceed to `/product-dev:prd`, carrying the de-risking items into architecture. There is no high-severity unmitigated risk and no infeasible dimension; the "conditions" are normal design decisions, so this is a proceed, not a stop.

## Assumptions to validate

- The plugins repo stays public and single-vendor / maintainer-curated (no third-party submission path).
- Offline/at-rest verification against a self-held key is a hard requirement (it is, per the brief's fail-closed + seed-cache model).

## Open questions

- [ ] Catalog hosting path + client caching/staleness behavior (raw vs Pages vs Release asset).
- [ ] CI key custody for the ed25519 private key vs the current manual out-of-band signing step.
- [ ] sha256-of-bytes sufficient, or is build provenance/attestation actually required?
- [ ] Per-plugin independent releases vs a single monorepo release; effect on catalog source addressing.
- [ ] Revocation/kill-switch propagation latency against the catalog refresh cadence.
