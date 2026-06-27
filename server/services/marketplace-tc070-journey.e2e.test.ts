// CPHM-TC-070 (e2e_flow, level 2): the author journey. A plugin author builds in
// the separate plugins repo against the PUBLISHED @roubo SDK; CI builds, packs the
// plugin into a normalized reproducible tarball, signs it with node:crypto ed25519,
// and publishes it to the marketplace catalog; the publish-gate self-check confirms
// the uploaded asset digest equals the catalog entry digest; a rebuild of the same
// revision yields the identical sha256; and the host re-verifies the digest and the
// signature with node:crypto only.
//
// The "running system" here is the REAL, already-merged primitives composed in
// process under vitest, not a mock of the publish pipeline (AC: "the host re-verifies
// with node:crypto only"):
//   - the reproducible normalized-tarball recipe is a verbatim port of the publish
//     CI's packer, roubo-plugins/scripts/release/pack.mjs (ustar headers with mtime=0
//     and fixed mode, wrapped in a fully-pinned gzip container; node:crypto + node:zlib
//     only). It is reproduced in-process rather than imported so this test stays
//     hermetic and independent of the sibling roubo-plugins submodule being checked
//     out (the author/CI pack itself is slice-covered by CPHM-TC-066/067);
//   - the host re-verification drives the REAL host verifier,
//     server/services/marketplace-integrity.ts (computePackageDigest,
//     verifyPackageIntegrity, verifyCatalogSignature, canonicalPayloadBytes), which
//     uses node:crypto ed25519/sha256 only.
// The only thing the test stands in for is the human push and the CI runner (TC-070
// S003), modelled by driving the pack/sign/verify primitives in-process, exactly as
// TC-019 stands in for the human clicking "mark passed". The journey is deterministic,
// network-free, and runs under `npm test`.
//
// Two digests live in this journey, and the drift-guard keeps their roles distinct
// (this reconciles the #765 built-artifact migration note in marketplace-integrity.ts):
//   - the normalized-tarball sha256 (from the pack recipe) is the reproducible asset
//     digest the publish-gate self-check (roubo-plugins/scripts/release/self-check.mjs)
//     re-hashes the uploaded `.tgz` against; it is recorded on the catalog entry's
//     `source.sha256`. It carries S004 / S006 / S007-O01.
//   - the unpacked built-artifact directory digest (computePackageDigest) is the
//     catalog entry's `integrity`, which the host's verifyPackageIntegrity recomputes
//     over the unpacked artifact. It carries the S007-O02 host digest re-verification.
//
// Drift guard: each it() is named after its CPHM-TC-070 step id and the step's expected
// observation is kept explicit, so a change to the authoritative CPHM-TC-070 in
// .specifications/component-plugins-hosted-marketplace/test-cases.json forces this test
// to be updated.
//
// Failure-output contract (AC: "On failure the test reports the diverging step,
// expected vs actual, and the owning slice issue(s)"): every assertion attaches an
// expected-vs-actual message naming the diverging step and the owning slice from
// #316's blocked-by set, so a red run localizes the integration drift to one
// attributable slice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, constants as zlibConstants } from "node:zlib";
import {
  canonicalPayloadBytes,
  computePackageDigest,
  verifyCatalogSignature,
  verifyPackageIntegrity,
} from "./marketplace-integrity.js";

// ── Owning slices (this e2e unit's blocked-by set, from #316) ──
// Each step localizes a divergence to the slice(s) that own its behaviour, so a red
// run points at one attributable issue rather than the whole journey.
const SLICE_SDK_PUBLISH =
  "#300 (publish @roubo/plugin-sdk + shared + shared-github for out-of-repo builds)";
const SLICE_REPO_SPLIT =
  "#303 (roubo-plugins repo split: the author builds against the published SDK)";
const SLICE_CI_PUBLISH = "#304 (CI build/sign/publish pipeline with reproducible digest)";
const SLICE_TRUSTED_PUBLISHERS =
  "#323 (npm trusted publishers for @roubo/shared + @roubo/shared-github)";

// ── Fixture identifiers (TC-070 preconditions) ──
// A plugin author has a plugin project in the separate plugins repo with PINNED @roubo
// dependencies (no file: refs), the @roubo SDK published at pinned versions, and CI
// configured to build, pack (normalized), sign (node:crypto ed25519), and publish.
const PLUGIN_ID = "demo-author-plugin";
const PLUGIN_VERSION = "0.1.0";
const SDK_VERSION = "0.1.1"; // published, pinned exact
const SHARED_VERSION = "0.1.1"; // published, pinned exact
const TSUP_VERSION = "8.5.0"; // pinned exact (build-only)
// NFR-006 / S005-O01: the sign+publish path must add no supply-chain tooling.
const FORBIDDEN_SUPPLY_CHAIN = ["oras", "cosign", "sigstore", "tuf"];
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

/** The `sha256-<hex>` integrity of an in-memory asset (the publish-gate's uploaded `.tgz`). */
function integrityOfBuffer(buf: Buffer): string {
  return `sha256-${createHash("sha256").update(buf).digest("hex")}`;
}

// ── Fixture: a self-contained, built author plugin (the ReleaseAsset file set) ──
// package.json pins @roubo deps as exact devDependencies (bundled by tsup) with NO
// runtime dependencies and NO file: refs; dist/index.js is the bundled output that
// inlines the @roubo SDK (no bare @roubo imports survive). Written deterministically
// so two packs are byte-identical.
async function writeAuthorPlugin(dir: string): Promise<void> {
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(
    path.join(dir, "dist", "index.js"),
    [
      '"use strict";',
      "// Bundled by tsup: @roubo/plugin-sdk and @roubo/shared are inlined below, so the",
      "// published artifact has no runtime imports of the @roubo SDK.",
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
    // No runtime `dependencies`: the @roubo SDK is bundled into dist at build time.
    devDependencies: {
      "@roubo/plugin-sdk": SDK_VERSION,
      "@roubo/shared": SHARED_VERSION,
      tsup: TSUP_VERSION,
    },
  };
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(
    path.join(dir, "roubo-plugin.yaml"),
    [
      `id: ${PLUGIN_ID}`,
      "name: Demo Author Plugin",
      `version: ${PLUGIN_VERSION}`,
      "kind: component",
      "entry: dist/index.js",
      "description: An author-journey demo plugin built against the published SDK.",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "README.md"), "# Demo Author Plugin\n");
}

interface CatalogEntry {
  id: string;
  version: string;
  // Host (in-app) verifier leg: marketplace-integrity.verifyPackageIntegrity checks this
  // against computePackageDigest of the unpacked built-artifact directory.
  integrity: string;
  source: {
    type: "release";
    assetUrl: string;
    // Publish-gate self-check leg: the normalized `.tgz` CI uploads. The gate re-hashes
    // the uploaded asset and asserts it equals this recorded sha256.
    sha256: string;
  };
}

interface CatalogPayload {
  entries: CatalogEntry[];
}

// ── Shared journey world, threaded across the ordered it() blocks so the journey is
// continuous: the author's built plugin dir, the packed tarball digest, the signed
// catalog, and the node:crypto ed25519 keypair the CI signs with. ──
let pluginDir: string;
let tarballIntegrity: string; // reproducible normalized-tarball sha256 (S004)
let dirDigest: string; // unpacked built-artifact directory digest (catalog `integrity`)
let catalogPayload: CatalogPayload;
let catalogSignature: string; // base64 detached ed25519 over canonicalPayloadBytes(payload)
let signPublicKey: KeyObject;

beforeAll(async () => {
  pluginDir = await mkdtemp(path.join(tmpdir(), "roubo-tc070-"));
  await writeAuthorPlugin(pluginDir);
});

afterAll(async () => {
  await rm(pluginDir, { recursive: true, force: true });
});

/** Collect every declared dependency spec across runtime / dev / peer scopes. */
function allDepSpecs(pkg: Record<string, unknown>): Array<{ name: string; spec: string }> {
  const out: Array<{ name: string; spec: string }> = [];
  for (const scope of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = pkg[scope];
    if (block && typeof block === "object") {
      for (const [name, spec] of Object.entries(block as Record<string, string>)) {
        out.push({ name, spec });
      }
    }
  }
  return out;
}

describe("CPHM-TC-070: author builds against the published SDK, CI publishes reproducibly, digest matches", () => {
  it("S001: clean install in the separate plugin repo -> all @roubo/* deps resolve at pinned versions with no file: refs (S001-O01)", async () => {
    const pkg = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const deps = allDepSpecs(pkg);
    const roubo = deps.filter((d) => d.name.startsWith("@roubo/"));

    // The author depends on the PUBLISHED SDK, so at least one @roubo/* dep must exist.
    expect(
      roubo.map((d) => d.name).sort(),
      `CPHM-TC-070 step S001 (S001-O01) diverged: expected the author project to depend on the published @roubo SDK, got @roubo deps ${JSON.stringify(
        roubo.map((d) => d.name),
      )}. Owning slices: ${SLICE_SDK_PUBLISH} for the published SDK, ${SLICE_REPO_SPLIT} for the split-out project.`,
    ).toEqual(["@roubo/plugin-sdk", "@roubo/shared"]);

    // Every @roubo/* dep is an EXACT pinned semver: no ^/~/*/tag ranges.
    for (const { name, spec } of roubo) {
      expect(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec),
        `CPHM-TC-070 step S001 (S001-O01) diverged: expected ${name} pinned to an exact published version, got "${spec}". Owning slice: ${SLICE_SDK_PUBLISH}.`,
      ).toBe(true);
    }

    // No dependency anywhere is a local file:/link: ref (the build resolves from the registry).
    for (const { name, spec } of deps) {
      expect(
        /^(file:|link:|portal:|workspace:)/.test(spec),
        `CPHM-TC-070 step S001 (S001-O01) diverged: expected no local file:/link: refs (the build must resolve the published SDK from the registry), but ${name} is "${spec}". Owning slices: ${SLICE_REPO_SPLIT} for the split, ${SLICE_SDK_PUBLISH} for the published SDK.`,
      ).toBe(false);
    }
  });

  it("S002: local tsup build -> a self-contained dist/index.js bundles the @roubo deps with no runtime dependencies (S002-O01)", async () => {
    const distPath = path.join(pluginDir, "dist", "index.js");
    const dist = await readFile(distPath, "utf8");

    // The build produced a non-empty dist bundle.
    expect(
      dist.length,
      `CPHM-TC-070 step S002 (S002-O01) diverged: expected a non-empty built dist/index.js, got ${dist.length} bytes. Owning slice: ${SLICE_REPO_SPLIT}.`,
    ).toBeGreaterThan(0);

    // The bundle is self-contained: no bare @roubo import/require survives bundling.
    const externalised = /(?:from\s+['"]@roubo\/)|(?:require\(\s*['"]@roubo\/)/.test(dist);
    expect(
      externalised,
      `CPHM-TC-070 step S002 (S002-O01) diverged: expected the @roubo deps to be bundled (inlined) into dist/index.js, but a runtime @roubo import/require survived. Owning slices: ${SLICE_REPO_SPLIT} for the bundling, ${SLICE_SDK_PUBLISH} for the resolvable SDK.`,
    ).toBe(false);

    // No runtime dependencies: the @roubo deps live in devDependencies, bundled at build.
    const pkg = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const runtimeDeps = Object.keys((pkg.dependencies as Record<string, string>) ?? {});
    expect(
      runtimeDeps,
      `CPHM-TC-070 step S002 (S002-O01) diverged: expected a self-contained artifact with no runtime dependencies, got dependencies ${JSON.stringify(
        runtimeDeps,
      )}. Owning slice: ${SLICE_REPO_SPLIT}.`,
    ).toEqual([]);
  });

  it("S003: push the source revision -> the in-process CI stand-in receives a built artifact ready to pack (handoff, no TC-070 observation)", () => {
    // TC-070 S003 declares no observation: it is the human push that triggers CI. As
    // TC-019 stands in for the human "mark passed", the journey here stands in for the
    // push by handing the built artifact to the in-process pack/sign/publish primitives.
    // The only assertion is that the artifact CI will operate on is present and buildable.
    expect(
      statSync(path.join(pluginDir, "dist")).isDirectory(),
      `CPHM-TC-070 step S003 diverged: expected a built dist/ artifact ready to hand to the CI build-and-publish pipeline, but none was present. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(true);
  });

  it("S004: CI builds and packs with the normalized-tarball recipe -> a packed artifact with a computed sha256 digest (S004-O01)", () => {
    const { tgz, integrity } = packNormalizedTarball(pluginDir);
    tarballIntegrity = integrity;

    expect(
      tgz.length,
      `CPHM-TC-070 step S004 (S004-O01) diverged: expected CI to produce a non-empty packed artifact, got ${tgz.length} bytes. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBeGreaterThan(0);
    expect(
      integrity,
      `CPHM-TC-070 step S004 (S004-O01) diverged: expected CI to compute a sha256-<hex> digest of the packed artifact, got "${integrity}". Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toMatch(SHA256_RE);
  });

  it("S005: CI signs with node:crypto ed25519 and publishes -> signed + uploaded with no oras/cosign/Sigstore/TUF dependency (S005-O01)", async () => {
    // The host's digest leg binds to the unpacked built-artifact directory digest.
    dirDigest = await computePackageDigest(pluginDir);
    catalogPayload = {
      entries: [
        {
          id: PLUGIN_ID,
          version: PLUGIN_VERSION,
          integrity: dirDigest,
          source: {
            type: "release",
            assetUrl: `https://example.invalid/${PLUGIN_ID}-${PLUGIN_VERSION}.tgz`,
            sha256: tarballIntegrity,
          },
        },
      ],
    };

    // Sign the catalog payload with node:crypto ed25519. The maintainer's private key is
    // held out of band; as marketplace-integrity.test.ts does, the test exercises the
    // sign+verify path with an independent ed25519 keypair over the SAME canonical bytes
    // the host verifier checks.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    signPublicKey = publicKey;
    catalogSignature = sign(null, canonicalPayloadBytes(catalogPayload), privateKey).toString(
      "base64",
    );

    // The signature is real ed25519 (node:crypto verify round-trips over the host's
    // canonical bytes).
    expect(
      verify(
        null,
        canonicalPayloadBytes(catalogPayload),
        signPublicKey,
        Buffer.from(catalogSignature, "base64"),
      ),
      `CPHM-TC-070 step S005 (S005-O01) diverged: expected a valid node:crypto ed25519 signature over the catalog payload, but verification failed. Owning slices: ${SLICE_CI_PUBLISH} for the sign step, ${SLICE_TRUSTED_PUBLISHERS} for the publish identity.`,
    ).toBe(true);

    // The host verifier adds no third-party crypto / supply-chain dependency: it imports
    // node: builtins only and names none of oras/cosign/Sigstore/TUF.
    const verifierSrc = await readFile(
      fileURLToPath(new URL("./marketplace-integrity.ts", import.meta.url)),
      "utf8",
    );
    const importedModules = [...verifierSrc.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const mod of importedModules) {
      expect(
        mod.startsWith("node:"),
        `CPHM-TC-070 step S005 (S005-O01) diverged: expected the host verifier to import node: builtins only (node:crypto ed25519/sha256), got an import of "${mod}". Owning slice: ${SLICE_CI_PUBLISH}.`,
      ).toBe(true);
    }
    for (const banned of FORBIDDEN_SUPPLY_CHAIN) {
      expect(
        new RegExp(banned, "i").test(verifierSrc),
        `CPHM-TC-070 step S005 (S005-O01) diverged: expected the sign/verify path to add no "${banned}" supply-chain dependency, but the host verifier references it. Owning slices: ${SLICE_CI_PUBLISH} for the sign path, ${SLICE_TRUSTED_PUBLISHERS} for the publish path.`,
      ).toBe(false);
    }

    // The author's plugin manifest likewise pulls in no such tooling.
    const pkg = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const depNames = allDepSpecs(pkg).map((d) => d.name.toLowerCase());
    for (const banned of FORBIDDEN_SUPPLY_CHAIN) {
      expect(
        depNames.some((n) => n.includes(banned)),
        `CPHM-TC-070 step S005 (S005-O01) diverged: expected the published plugin to declare no "${banned}" dependency, got deps ${JSON.stringify(
          depNames,
        )}. Owning slice: ${SLICE_TRUSTED_PUBLISHERS}.`,
      ).toBe(false);
    }
  });

  it("S006: publish-gate self-check -> the uploaded asset's sha256 equals the catalog entry digest and the publish completes (S006-O01)", () => {
    // The gate re-downloads (re-packs, here) the uploaded asset and re-hashes its bytes,
    // mirroring roubo-plugins/scripts/release/self-check.mjs (expected = catalog, actual
    // = uploaded). The recorded digest must be a real sha256, and the recomputed upload
    // digest must equal it, or the publish FAILS.
    const entry = catalogPayload.entries[0];
    expect(
      entry.source.sha256,
      `CPHM-TC-070 step S006 (S006-O01) diverged: expected the catalog entry to record a real sha256-<hex> asset digest, got "${entry.source.sha256}". Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toMatch(SHA256_RE);

    const uploaded = integrityOfBuffer(packNormalizedTarball(pluginDir).tgz);
    expect(
      uploaded,
      `CPHM-TC-070 step S006 (S006-O01) diverged: publish-gate self-check failed for ${entry.id}: digest mismatch\n    expected (catalog):  ${entry.source.sha256}\n    actual (uploaded):   ${uploaded}. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(entry.source.sha256);
  });

  it("S007: rebuild the same revision -> identical sha256 (S007-O01), and the host re-verifies digest + signature with node:crypto only (S007-O02)", async () => {
    // S007-O01: a second pack of the same source revision is byte-for-byte reproducible,
    // so the asset digest is identical to S004's (the reproducible-build property).
    const rebuilt = packNormalizedTarball(pluginDir).integrity;
    expect(
      rebuilt,
      `CPHM-TC-070 step S007 (S007-O01) diverged: expected a rebuild of the same revision to yield the identical sha256 (reproducible build)\n    expected (first build):  ${tarballIntegrity}\n    actual (second build):   ${rebuilt}. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(tarballIntegrity);

    const entry = catalogPayload.entries[0];

    // S007-O02 (digest leg): the host re-verifies the unpacked artifact against the
    // catalog `integrity` via the REAL verifyPackageIntegrity (computePackageDigest =
    // node:crypto sha256 over the artifact directory).
    expect(
      await verifyPackageIntegrity(pluginDir, entry.integrity),
      `CPHM-TC-070 step S007 (S007-O02) diverged: expected the host (marketplace-integrity, node:crypto sha256) to re-verify the unpacked artifact against the catalog digest ${entry.integrity}, but verifyPackageIntegrity failed. Owning slices: ${SLICE_CI_PUBLISH} for the reproducible digest, ${SLICE_TRUSTED_PUBLISHERS} for the published artifact.`,
    ).toBe(true);

    // S007-O02 (signature leg): the host re-verifies the catalog signature with node:crypto
    // ed25519 over the SAME canonical bytes (the journey's freshly-signed catalog).
    expect(
      verify(
        null,
        canonicalPayloadBytes(catalogPayload),
        signPublicKey,
        Buffer.from(catalogSignature, "base64"),
      ),
      `CPHM-TC-070 step S007 (S007-O02) diverged: expected the host to re-verify the catalog signature with node:crypto ed25519, but verification failed. Owning slices: ${SLICE_CI_PUBLISH} for the sign step, ${SLICE_TRUSTED_PUBLISHERS} for the publish identity.`,
    ).toBe(true);

    // A tampered payload must fail the host signature check closed (the verification is
    // load-bearing, not nominal).
    const tampered: CatalogPayload = {
      entries: [{ ...entry, integrity: `sha256-${"0".repeat(64)}` }],
    };
    expect(
      verify(
        null,
        canonicalPayloadBytes(tampered),
        signPublicKey,
        Buffer.from(catalogSignature, "base64"),
      ),
      `CPHM-TC-070 step S007 (S007-O02) diverged: expected a tampered catalog payload to fail the host node:crypto signature check closed, but it verified. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(false);

    // The shipped host signature gate (verifyCatalogSignature, bundled ed25519 public key)
    // is itself node:crypto-only and green on the committed catalog, so the production
    // re-verification path the journey models is real.
    const committed = (await import("./marketplace-catalog.json", { with: { type: "json" } }))
      .default as { payload: unknown; signature: string };
    expect(
      verifyCatalogSignature(committed.payload, committed.signature),
      `CPHM-TC-070 step S007 (S007-O02) diverged: expected the shipped host verifier (verifyCatalogSignature, node:crypto ed25519) to verify the committed marketplace catalog, but it failed closed. Owning slice: ${SLICE_CI_PUBLISH}.`,
    ).toBe(true);
  });
});
