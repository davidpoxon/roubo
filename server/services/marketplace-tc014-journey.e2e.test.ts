// CPHM-TC-014 (e2e_flow, level 2): the maintainer publish-then-revoke client
// journey. A maintainer triggers CI to build, sign, and digest a new plugin
// artifact and publish a re-signed catalog with the new entry; a client launches
// the app, verifies the catalog signature, and installs the entry after digest
// verification; the maintainer then sets revoked:true, re-signs, and republishes
// the catalog with NO app release; and the client blocks the entry at the next
// refresh (delisted, install + update rejected).
//
// The "running system" here is the REAL, already-merged host primitives composed
// in process under vitest, not a mock of the publish pipeline:
//   - the reproducible normalized-tarball recipe is a verbatim port of the publish
//     CI's packer, roubo-plugins/scripts/release/pack.mjs (ustar headers with
//     mtime=0 and fixed mode, wrapped in a fully-pinned gzip container; node:crypto
//     + node:zlib only). It is reproduced in-process rather than imported so this
//     test stays hermetic and independent of the sibling roubo-plugins submodule
//     being checked out (the author/CI pack itself is slice-covered elsewhere);
//   - the host re-verification drives the REAL host verifier,
//     server/services/marketplace-integrity.ts (canonicalPayloadBytes,
//     verifyCatalogSignature, computePackageDigest, verifyPackageIntegrity), which
//     uses node:crypto ed25519/sha256 only.
// The only things the test stands in for are the human "trigger CI" / "reopen the
// marketplace" actions and the CI runner, modelled by driving the pack / sign /
// verify primitives in-process. The journey is deterministic, network-free, and
// runs under `npm test`.
//
// Two digests live in this journey, and the drift-guard keeps their roles distinct:
//   - the normalized-tarball sha256 (from the pack recipe) is the reproducible
//     "computed digest" of the published GitHub Release asset (S001-O01). The real
//     @roubo/shared MarketplaceCatalogEntry.source is a git source with no sha256
//     field, so this asset digest is tracked off-entry as the journey's published
//     Release-asset digest rather than on `source`.
//   - the unpacked built-artifact directory digest (computePackageDigest) is the
//     catalog entry's `integrity`, which the host's verifyPackageIntegrity
//     recomputes over the unpacked artifact before install (S004).
//
// KEY DECISION (why the in-process list/install/revoke semantics, not marketplace.ts):
// marketplace.ts binds listCatalog / install / update to a STATIC load-time catalog
// (module-level ENTRIES derived once from the checked-in RAW), so it cannot be
// driven across two catalog states (published, then revoked + republished). This
// journey therefore reproduces its exact revoke / list / install semantics
// in-process, faithful to the module: the host gate fails closed to zero entries
// when the signature does not verify (CATALOG_VERIFIED ? entries : []), listCatalog
// filters `revoked !== true`, and install / update reject `revoked === true` with a
// `revoked` rejection. The catalog SIGNATURE and DIGEST verification themselves run
// through the REAL marketplace-integrity primitives.
//
// KEY-RING NUANCE: CPHM-TC-014 S003 references "the key-ring anchored by the
// embedded root key," but the host currently verifies the catalog against the single
// bundled CATALOG_PUBLIC_KEY_PEM (the architecture's app-side key-ring resolution is
// a documented PRD-delta, owned by #305, not yet realized). The maintainer's
// operational signing key is held out of band and is NOT the bundled key, so the
// journey catalog's signature leg drives the same node:crypto ed25519 primitive
// verifyCatalogSignature wraps, keyed to the journey's operational public key, while
// the REAL verifyCatalogSignature is exercised against the committed catalog to
// prove the shipped host gate is node:crypto-only and green (exactly as the TC-070
// author journey does). No key-ring resolution the app does not yet implement is
// invented here.
//
// Drift guard: each it() is named after its CPHM-TC-014 step id and the step's
// expected observation is kept explicit, so a change to the authoritative
// CPHM-TC-014 in
// .specifications/component-plugins-hosted-marketplace/test-cases.json forces this
// test to be updated.
//
// Failure-output contract (AC: "On failure the test reports which e2e step diverged,
// expected vs actual, and the owning slice issue(s)"): every assertion attaches an
// expected-vs-actual message naming the diverging step and the owning slice from
// #311's blocked-by set (#304, #305), so a red run localizes the integration drift
// to one attributable slice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, constants as zlibConstants } from "node:zlib";
import type { MarketplaceCatalogEntry, SignedMarketplaceCatalog } from "@roubo/shared";
import {
  canonicalPayloadBytes,
  computePackageDigest,
  verifyCatalogSignature,
  verifyPackageIntegrity,
} from "./marketplace-integrity.js";

// ── Owning slices (this e2e unit's blocked-by set, from #311) ──
// Each step localizes a divergence to the slice(s) that own its behaviour, so a red
// run points at one attributable issue rather than the whole journey.
const SLICE_CI_PUBLISH = "#304 (CI build/sign/publish pipeline with reproducible digest)";
const SLICE_CATALOG_REVOKE = "#305 (signed catalog on Pages + signed key-ring + revocation)";

// ── Fixture identifiers (CPHM-TC-014 preconditions) ──
// The marketplace repo CI is configured with the signing key as a CI secret, a client
// app instance with the embedded bootstrap root key is available, and the hosted
// catalog + key-ring are reachable. The fixture plugin is the built ReleaseAsset file
// set the maintainer publishes.
const PLUGIN_ID = "demo-maintainer-plugin";
const PLUGIN_VERSION = "0.1.0";
const SHA256_RE = /^sha256-[0-9a-f]{64}$/;

// The files the marketplace ReleaseAsset always carries, beyond the whole dist/ tree.
const TOP_LEVEL_ENTRIES = ["package.json", "roubo-plugin.yaml", "README.md"];

// ── Normalized-tarball recipe (verbatim port of roubo-plugins/scripts/release/pack.mjs) ──
// Reproduced in-process so the journey is hermetic. Every byte is pinned (mtime=0,
// uid/gid=0, fixed mode, sorted entries, gzip MTIME zeroed and OS byte fixed), so two
// packs of the same source yield an identical digest. node:crypto + node:zlib only.

/** Pad an octal number into a fixed-width NUL-terminated ustar field. */
function octalField(value: number, width: number): Buffer {
  const str = value.toString(8).padStart(width - 1, "0");
  return Buffer.from(`${str}\0`, "ascii");
}

/** Build one 512-byte ustar (POSIX) header block. */
function ustarHeader(entry: {
  name: string;
  size: number;
  mode: number;
  typeflag: "0" | "5";
}): Buffer {
  if (Buffer.byteLength(entry.name, "utf8") > 100) {
    throw new Error(`Entry name too long for ustar (>100 bytes): ${entry.name}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(entry.name, 0, "utf8"); // name[100]
  octalField(entry.mode & 0o7777, 8).copy(header, 100); // mode[8]
  octalField(0, 8).copy(header, 108); // uid[8]
  octalField(0, 8).copy(header, 116); // gid[8]
  octalField(entry.size, 12).copy(header, 124); // size[12]
  octalField(0, 12).copy(header, 136); // mtime[12] (fixed epoch 0)
  header.write("        ", 148, "ascii"); // chksum[8] placeholder = spaces
  header.write(entry.typeflag, 156, "ascii"); // typeflag[1]
  header.write("ustar\0", 257, "ascii"); // magic[6]
  header.write("00", 263, "ascii"); // version[2]
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/** Collect the fixed entry set (whole dist/ tree + top-level files), sorted by path. */
function collectEntries(
  pluginDir: string,
): Array<{ name: string; isDir: boolean; content: Buffer }> {
  const entries: Array<{ name: string; isDir: boolean; content: Buffer }> = [];
  const distDir = path.join(pluginDir, "dist");
  let distStat: ReturnType<typeof statSync> | undefined;
  try {
    distStat = statSync(distDir);
  } catch {
    distStat = undefined;
  }
  if (!distStat || !distStat.isDirectory()) {
    throw new Error(`dist/ not found for ${pluginDir}. The artifact must be built before packing.`);
  }

  const walk = (dirAbs: string, relPrefix: string): void => {
    entries.push({ name: `${relPrefix}/`, isDir: true, content: Buffer.alloc(0) });
    const names = readdirSync(dirAbs).sort();
    for (const childName of names) {
      const childAbs = path.join(dirAbs, childName);
      const childRel = `${relPrefix}/${childName}`;
      const st = statSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile())
        entries.push({ name: childRel, isDir: false, content: readFileSync(childAbs) });
    }
  };

  walk(distDir, "dist");
  for (const topName of TOP_LEVEL_ENTRIES) {
    entries.push({
      name: topName,
      isDir: false,
      content: readFileSync(path.join(pluginDir, topName)),
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** Assemble the uncompressed ustar archive bytes for a plugin. */
function buildTar(pluginDir: string): Buffer {
  const entries = collectEntries(pluginDir);
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.isDir) {
      blocks.push(ustarHeader({ name: entry.name, size: 0, mode: 0o755, typeflag: "5" }));
    } else {
      blocks.push(
        ustarHeader({ name: entry.name, size: entry.content.length, mode: 0o644, typeflag: "0" }),
      );
      blocks.push(entry.content);
      const remainder = entry.content.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  let tar = Buffer.concat(blocks);
  const blockingFactor = 10240;
  const pad = (blockingFactor - (tar.length % blockingFactor)) % blockingFactor;
  if (pad !== 0) tar = Buffer.concat([tar, Buffer.alloc(pad, 0)]);
  return tar;
}

/** CRC32 (IEEE) over a buffer, dependency-free. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Wrap raw DEFLATE output in a fully-pinned gzip container (MTIME=0, OS byte fixed). */
function gzip(raw: Buffer): Buffer {
  const deflated = deflateRawSync(raw, { level: zlibConstants.Z_BEST_COMPRESSION });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw), 0);
  trailer.writeUInt32LE(raw.length >>> 0, 4);
  return Buffer.concat([header, deflated, trailer]);
}

/** Build the normalized tarball for one built plugin dir and return its bytes + digest. */
function packNormalizedTarball(pluginDir: string): { tgz: Buffer; integrity: string } {
  const tgz = gzip(buildTar(pluginDir));
  const integrity = `sha256-${createHash("sha256").update(tgz).digest("hex")}`;
  return { tgz, integrity };
}

// ── Fixture: a self-contained, built maintainer plugin (the ReleaseAsset file set) ──
// Written deterministically so two packs are byte-identical and the dir digest is
// stable. dist/index.js is the bundled output; package.json + roubo-plugin.yaml +
// README round out the published artifact.
async function writeMaintainerPlugin(dir: string): Promise<void> {
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(
    path.join(dir, "dist", "index.js"),
    [
      '"use strict";',
      "// Bundled by tsup: the @roubo SDK is inlined, so the published artifact has no",
      "// runtime imports of the @roubo SDK.",
      "const definePlugin = (config) => config;",
      `module.exports = { plugin: definePlugin({ id: ${JSON.stringify(PLUGIN_ID)} }) };`,
      "",
    ].join("\n"),
  );
  const pkg = {
    name: PLUGIN_ID,
    version: PLUGIN_VERSION,
    type: "module",
    main: "dist/index.js",
    scripts: { build: "tsup" },
  };
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(
    path.join(dir, "roubo-plugin.yaml"),
    [
      `id: ${PLUGIN_ID}`,
      "name: Demo Maintainer Plugin",
      `version: ${PLUGIN_VERSION}`,
      "kind: component",
      "entry: dist/index.js",
      "description: A publish-then-revoke journey demo plugin.",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "README.md"), "# Demo Maintainer Plugin\n");
}

// ── In-process host catalog semantics (faithful port of marketplace.ts) ──
// marketplace.ts is bound to one static load-time catalog and cannot be driven across
// the publish -> revoke transition, so its gate / list / install semantics are
// reproduced here. The catalog SIGNATURE check itself drives the same node:crypto
// ed25519 primitive verifyCatalogSignature wraps (keyed to the journey's operational
// key, per the KEY-RING NUANCE above).

/**
 * Verify a journey catalog's detached ed25519 signature over canonicalPayloadBytes,
 * keyed to the maintainer's operational public key. Mirrors verifyCatalogSignature's
 * fail-closed shape exactly (empty / malformed signature -> false, never throws); the
 * only difference is the key, because the operational key is held out of band and is
 * not the bundled CATALOG_PUBLIC_KEY_PEM.
 */
function verifyJourneyCatalog(catalog: SignedMarketplaceCatalog): boolean {
  if (typeof catalog.signature !== "string" || catalog.signature.length === 0) return false;
  try {
    return verify(
      null,
      canonicalPayloadBytes(catalog.payload),
      signPublicKey,
      Buffer.from(catalog.signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * The host gate, mirroring marketplace.ts (CATALOG_VERIFIED ? payload.entries : []):
 * the verified entry set, which still INCLUDES revoked entries so install / update can
 * emit the specific `revoked` rejection rather than a generic unknown-id error. Fails
 * closed to [] when the signature does not verify.
 */
function hostVerifiedEntries(catalog: SignedMarketplaceCatalog): MarketplaceCatalogEntry[] {
  return verifyJourneyCatalog(catalog) ? (catalog.payload.entries ?? []) : [];
}

/** Mirror marketplace.ts listCatalog: verified entries with `revoked !== true`. */
function listCatalog(catalog: SignedMarketplaceCatalog): MarketplaceCatalogEntry[] {
  return hostVerifiedEntries(catalog).filter((e) => e.revoked !== true);
}

/** Mirror marketplace.ts InstallError reason codes used by the install/update gate. */
class InProcessInstallError extends Error {
  constructor(
    readonly reason: "invalid-input" | "revoked",
    message: string,
  ) {
    super(message);
    this.name = "InProcessInstallError";
  }
}

/**
 * Mirror marketplace.ts assertInstallable (shared by install + update): resolve over
 * the verified set (revoked included), reject an unknown id (`invalid-input`) and a
 * revoked entry (`revoked`) fail-closed.
 *
 * Scope note (issue #558): the real assertInstallable now resolves over the MERGED
 * multi-source fan-out and adds the cross-source ambiguity gate
 * (`AmbiguousSourceError`). This mirror deliberately models only the FIRST-PARTY,
 * single-source slice that TC-014's journey exercises, where the two gates below
 * behave identically. It is a hand-maintained model, not a call into the real
 * function, so it does not fail to compile when that signature moves: the collision
 * gate is covered directly in marketplace.test.ts, and this mirror must not be read
 * as evidence that ambiguity is unenforced.
 */
function assertInstallable(catalog: SignedMarketplaceCatalog, id: string): MarketplaceCatalogEntry {
  const entry = hostVerifiedEntries(catalog).find((e) => e.id === id);
  if (!entry) {
    throw new InProcessInstallError("invalid-input", `Unknown catalog plugin: ${id}`);
  }
  if (entry.revoked === true) {
    throw new InProcessInstallError(
      "revoked",
      `Plugin "${id}" has been revoked and can no longer be installed or updated.`,
    );
  }
  return entry;
}

/** Capture the install/update gate's rejection (or undefined when installable). */
function installError(
  catalog: SignedMarketplaceCatalog,
  id: string,
): InProcessInstallError | undefined {
  try {
    assertInstallable(catalog, id);
    return undefined;
  } catch (err) {
    return err as InProcessInstallError;
  }
}

// ── Shared journey world, threaded across the ordered it() blocks so the journey is
// continuous: the maintainer's built plugin dir, the published Release-asset digest,
// the unpacked-dir digest (catalog `integrity`), the published + revoked signed
// catalogs, and the node:crypto ed25519 operational keypair the maintainer signs with. ──
let pluginDir: string;
let assetDigest: string; // normalized-tarball sha256 = published Release-asset digest (S001)
let dirDigest: string; // unpacked built-artifact directory digest (catalog `integrity`)
let publishedEntry: MarketplaceCatalogEntry;
let publishedCatalog: SignedMarketplaceCatalog;
let revokedCatalog: SignedMarketplaceCatalog;
let signPublicKey: KeyObject;
let signPrivateKey: KeyObject;

beforeAll(async () => {
  pluginDir = await mkdtemp(path.join(tmpdir(), "roubo-tc014-"));
  await writeMaintainerPlugin(pluginDir);
});

afterAll(async () => {
  await rm(pluginDir, { recursive: true, force: true });
});

/** Assemble one real @roubo/shared MarketplaceCatalogEntry for the fixture plugin. */
function buildEntry(opts: { revoked: boolean }): MarketplaceCatalogEntry {
  const entry: MarketplaceCatalogEntry = {
    id: PLUGIN_ID,
    name: "Demo Maintainer Plugin",
    kind: "component",
    version: PLUGIN_VERSION,
    summary: "A publish-then-revoke journey demo plugin.",
    source: { type: "git", url: `https://example.invalid/${PLUGIN_ID}.git` },
    provenance: "github.com/davidpoxon/roubo-plugins",
    integrity: dirDigest,
    verified: true,
  };
  if (opts.revoked) entry.revoked = true;
  return entry;
}

/** Re-sign a payload with the maintainer's operational key (REAL canonicalPayloadBytes). */
function signCatalog(payload: { entries: MarketplaceCatalogEntry[] }): SignedMarketplaceCatalog {
  const signature = sign(null, canonicalPayloadBytes(payload), signPrivateKey).toString("base64");
  return { payload, signature };
}

describe("CPHM-TC-014: maintainer publishes then revokes a plugin, client reflects both at next refresh", () => {
  it("S001: maintainer triggers CI to build, sign, and digest a new plugin artifact -> the published Release asset has a computed digest (S001-O01)", async () => {
    const { tgz, integrity } = packNormalizedTarball(pluginDir);
    assetDigest = integrity;
    // The host digest leg binds to the unpacked built-artifact directory digest, the
    // value the client's verifyPackageIntegrity recomputes before install.
    dirDigest = await computePackageDigest(pluginDir);

    expect(
      tgz.length,
      `CPHM-TC-014 step S001 (S001-O01) diverged: expected CI to produce a non-empty packed Release asset, got ${tgz.length} bytes. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBeGreaterThan(0);
    expect(
      assetDigest,
      `CPHM-TC-014 step S001 (S001-O01) diverged: expected the published Release asset to carry a computed sha256-<hex> digest, got "${assetDigest}". Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toMatch(SHA256_RE);
    expect(
      dirDigest,
      `CPHM-TC-014 step S001 (S001-O01) diverged: expected a computed sha256-<hex> digest of the unpacked built artifact (the catalog integrity input), got "${dirDigest}". Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toMatch(SHA256_RE);
  });

  it("S002: CI regenerates, re-signs, and publishes the catalog with the new entry -> the signed catalog verifies and includes the new entry (S002-O01)", () => {
    // The maintainer's operational signing key (the CI secret) signs the catalog. It
    // is held out of band; the journey generates an independent ed25519 keypair and
    // signs over the SAME canonical bytes the host verifier checks.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    signPublicKey = publicKey;
    signPrivateKey = privateKey;

    publishedEntry = buildEntry({ revoked: false });
    publishedCatalog = signCatalog({ entries: [publishedEntry] });

    // The signed catalog verifies (real node:crypto ed25519 over canonicalPayloadBytes).
    expect(
      verifyJourneyCatalog(publishedCatalog),
      `CPHM-TC-014 step S002 (S002-O01) diverged: expected the re-signed published catalog to verify under the maintainer's operational ed25519 key, but verification failed. Owning slices: ${SLICE_CI_PUBLISH} for the sign step, ${SLICE_CATALOG_REVOKE} for the published catalog.`,
    ).toBe(true);

    // The published catalog includes the new entry.
    expect(
      publishedCatalog.payload.entries.map((e) => e.id),
      `CPHM-TC-014 step S002 (S002-O01) diverged: expected the published catalog to include the new entry "${PLUGIN_ID}", got ${JSON.stringify(
        publishedCatalog.payload.entries.map((e) => e.id),
      )}. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toContain(PLUGIN_ID);
  });

  it("S003: client opens the marketplace Browse screen -> the app fetches the catalog and verifies its signature (S003-O01)", async () => {
    // The client verifies the fetched catalog's signature. Per the KEY-RING NUANCE,
    // the operational key is not the bundled CATALOG_PUBLIC_KEY_PEM, so the journey
    // drives the same node:crypto ed25519 primitive keyed to the operational key.
    expect(
      verifyJourneyCatalog(publishedCatalog),
      `CPHM-TC-014 step S003 (S003-O01) diverged: expected the client to verify the fetched catalog's signature, but verification failed. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(true);

    // Fail-closed: a tampered payload (entry version flipped) must fail the signature
    // check, so the host gate yields zero verified entries.
    const tampered: SignedMarketplaceCatalog = {
      payload: { entries: [{ ...publishedEntry, version: "9.9.9" }] },
      signature: publishedCatalog.signature,
    };
    expect(
      verifyJourneyCatalog(tampered),
      `CPHM-TC-014 step S003 (S003-O01) diverged: expected a tampered catalog payload to fail the client signature check closed, but it verified. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(false);
    expect(
      hostVerifiedEntries(tampered),
      `CPHM-TC-014 step S003 (S003-O01) diverged: expected the host gate to fail closed to zero entries on a tampered catalog, got ${JSON.stringify(
        hostVerifiedEntries(tampered).map((e) => e.id),
      )}. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toEqual([]);

    // The shipped host signature gate (verifyCatalogSignature, bundled ed25519 key) is
    // itself node:crypto-only and green on the committed catalog, so the production
    // re-verification path the client models is real.
    const committed = (await import("./marketplace-catalog.json", { with: { type: "json" } }))
      .default as { payload: unknown; signature: string };
    expect(
      verifyCatalogSignature(committed.payload, committed.signature),
      `CPHM-TC-014 step S003 (S003-O01) diverged: expected the shipped host verifier (verifyCatalogSignature, node:crypto ed25519) to verify the committed marketplace catalog, but it failed closed. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(true);
  });

  it("S004: client finds the new entry and installs it -> it is listed and installs after digest verification (S004-O01)", async () => {
    // The entry lists (the revoke filter passes: revoked !== true).
    expect(
      listCatalog(publishedCatalog).map((e) => e.id),
      `CPHM-TC-014 step S004 (S004-O01) diverged: expected the published entry "${PLUGIN_ID}" to be listed for install, got ${JSON.stringify(
        listCatalog(publishedCatalog).map((e) => e.id),
      )}. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toContain(PLUGIN_ID);

    // The install gate accepts it (resolvable, not revoked).
    const resolved = assertInstallable(publishedCatalog, PLUGIN_ID);
    expect(
      resolved.id,
      `CPHM-TC-014 step S004 (S004-O01) diverged: expected the install gate to accept the published entry, but it did not resolve "${PLUGIN_ID}". Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(PLUGIN_ID);

    // Install proceeds only after the host re-verifies the unpacked artifact digest via
    // the REAL verifyPackageIntegrity (node:crypto sha256 over the artifact directory).
    expect(
      await verifyPackageIntegrity(pluginDir, resolved.integrity),
      `CPHM-TC-014 step S004 (S004-O01) diverged: expected the host (marketplace-integrity, node:crypto sha256) to verify the unpacked artifact against the catalog digest ${resolved.integrity} before install, but verifyPackageIntegrity failed. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(true);

    // Fail-closed: a tampered digest must be rejected, blocking the install.
    const tamperedDigest = `sha256-${"0".repeat(64)}`;
    expect(
      await verifyPackageIntegrity(pluginDir, tamperedDigest),
      `CPHM-TC-014 step S004 (S004-O01) diverged: expected a tampered integrity digest to fail the host digest check closed (install blocked), but it verified. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(false);
  });

  it("S005: maintainer sets revoked:true, re-signs, and republishes (no app release) -> the republished catalog marks the entry revoked (S005-O01)", () => {
    // Catalog-only change: the SAME operational key re-signs a new envelope (no app
    // release, no key rotation). A revoked entry replaces the published one.
    revokedCatalog = signCatalog({ entries: [buildEntry({ revoked: true })] });

    // The republished catalog verifies under the same operational key.
    expect(
      verifyJourneyCatalog(revokedCatalog),
      `CPHM-TC-014 step S005 (S005-O01) diverged: expected the re-signed revoked catalog to verify under the same operational key (no app release), but verification failed. Owning slices: ${SLICE_CI_PUBLISH} for the re-sign, ${SLICE_CATALOG_REVOKE} for the revocation.`,
    ).toBe(true);

    // The entry is marked revoked in the republished payload.
    expect(
      revokedCatalog.payload.entries[0].revoked,
      `CPHM-TC-014 step S005 (S005-O01) diverged: expected the republished catalog entry "${PLUGIN_ID}" to be marked revoked:true, got revoked=${JSON.stringify(
        revokedCatalog.payload.entries[0].revoked,
      )}. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(true);
  });

  it("S006: client reopens the marketplace -> the refreshed catalog verifies, the entry is delisted, and install/update are blocked with no app release (S006-O01, S006-O02)", () => {
    // S006-O01: the refreshed (revoked) catalog still verifies.
    expect(
      verifyJourneyCatalog(revokedCatalog),
      `CPHM-TC-014 step S006 (S006-O01) diverged: expected the refreshed revoked catalog to verify, but verification failed. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(true);

    // S006-O01: the entry is delisted (the revoke filter removes it), so Install is off.
    expect(
      listCatalog(revokedCatalog).map((e) => e.id),
      `CPHM-TC-014 step S006 (S006-O01) diverged: expected the revoked entry "${PLUGIN_ID}" to be delisted at refresh, but it is still listed. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).not.toContain(PLUGIN_ID);

    // S006-O02: install of the revoked entry is blocked (the `revoked` rejection).
    expect(
      installError(revokedCatalog, PLUGIN_ID)?.reason,
      `CPHM-TC-014 step S006 (S006-O02) diverged: expected install of the revoked entry "${PLUGIN_ID}" to be blocked with a "revoked" rejection, got ${JSON.stringify(
        installError(revokedCatalog, PLUGIN_ID)?.reason,
      )}. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe("revoked");

    // S006-O02: update funnels through the same gate and is likewise blocked.
    expect(
      installError(revokedCatalog, PLUGIN_ID)?.reason,
      `CPHM-TC-014 step S006 (S006-O02) diverged: expected update of the revoked entry "${PLUGIN_ID}" to be blocked with a "revoked" rejection, got ${JSON.stringify(
        installError(revokedCatalog, PLUGIN_ID)?.reason,
      )}. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe("revoked");

    // No app release: the revocation took effect purely by re-verifying the refreshed
    // catalog under the SAME operational key that signed the published catalog, with no
    // change to the bundled key or host code (data-only republish).
    expect(
      verifyJourneyCatalog(publishedCatalog) && verifyJourneyCatalog(revokedCatalog),
      `CPHM-TC-014 step S006 (S006-O02) diverged: expected both the published and the revoked catalog to verify under the one operational key (no app release / no key rotation), but they did not. Owning slice: ${SLICE_CATALOG_REVOKE}.`,
    ).toBe(true);
  });
});
