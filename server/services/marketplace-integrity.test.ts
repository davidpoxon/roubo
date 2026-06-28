import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, createPublicKey, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  computePackageDigest,
  fingerprintKeyId,
  resolveActiveKey,
  verifyCatalogSignature,
  verifyKeyRing,
  verifyPackageIntegrity,
} from "./marketplace-integrity.js";

// Unit tests for the marketplace channel-integrity primitives (CP-FR-021,
// issue #622): deterministic canonicalization, ed25519 catalog-signature
// verification (fail-closed), and the deterministic built-artifact digest +
// integrity check. The digest now targets the unpacked built artifact (issue
// #765, FR-003/NFR-006), not the cloned source subdir.

// Assemble an unpacked built-artifact fixture: the ReleaseAsset file set the
// marketplace digests (dist/index.js + roubo-plugin.yaml + package.json +
// README), self-contained with no `src/` and no `node_modules`. This is what a
// downloaded, unpacked plugin tarball looks like, and what the digest binds to.
async function writeBuiltArtifact(dir: string): Promise<void> {
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "dist", "index.js"), "export const plugin = () => {};\n");
  await writeFile(path.join(dir, "roubo-plugin.yaml"), "id: demo\nentry: dist/index.js\n");
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "0.1.0", main: "dist/index.js" })}\n`,
  );
  await writeFile(path.join(dir, "README.md"), "# Demo plugin\n");
}

// Assemble a cloned-source-subdir fixture: src/ + build config, no dist/. This
// is the OLD digest target (issue #689 / #750); the digest must now distinguish
// it from the built artifact above.
async function writeSourceSubdir(dir: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "index.ts"), "export const plugin = () => {};\n");
  await writeFile(path.join(dir, "roubo-plugin.yaml"), "id: demo\nentry: dist/index.js\n");
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "0.1.0", main: "dist/index.js" })}\n`,
  );
  await writeFile(path.join(dir, "tsup.config.ts"), "export default {};\n");
  await writeFile(path.join(dir, "README.md"), "# Demo plugin\n");
}

describe("canonicalize", () => {
  it("sorts object keys recursively and is whitespace-insensitive", () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("verifyCatalogSignature", () => {
  // A signature produced by the bundled public key's matching private key is
  // not available to the test (the private key is held out of band), so we
  // exercise the verifier against an independent test keypair via the same
  // canonicalization the production verifier uses, plus the fail-closed paths.
  it("rejects a missing or empty signature (fail closed)", () => {
    expect(verifyCatalogSignature({ entries: [] }, "")).toBe(false);
    expect(verifyCatalogSignature({ entries: [] }, undefined as unknown as string)).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(verifyCatalogSignature({ entries: [] }, "not-base64!!")).toBe(false);
  });

  it("rejects a signature made with a different key (fail closed)", () => {
    // Sign with a foreign key; the bundled public key must NOT verify it.
    const { privateKey } = generateKeyPairSync("ed25519");
    const payload = { entries: [{ id: "x" }] };
    const sig = sign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString(
      "base64",
    );
    expect(verifyCatalogSignature(payload, sig)).toBe(false);
  });

  it("verifies the checked-in catalog against the bundled public key", async () => {
    // The committed catalog must verify with the bundled key: this is the
    // load-time gate the marketplace service depends on.
    const catalog = (await import("./marketplace-catalog.json", { with: { type: "json" } }))
      .default as { payload: unknown; signature: string };
    expect(verifyCatalogSignature(catalog.payload, catalog.signature)).toBe(true);
  });

  it("rejects the catalog when its payload is tampered with", async () => {
    const catalog = (await import("./marketplace-catalog.json", { with: { type: "json" } }))
      .default as { payload: { entries: { id: string }[] }; signature: string };
    const tampered = {
      entries: [...catalog.payload.entries, { id: "evil-injected" }],
    };
    expect(verifyCatalogSignature(tampered, catalog.signature)).toBe(false);
  });
});

// Key-ring trust chain (CPHM-FR-007 / NFR-001, issue #306): the client mirrors
// the producer publish gate (roubo-plugins scripts/release/verify-keyring.mjs).
// Verification is exercised against an independent generated root + operational
// keypair, never the embedded bootstrap root (whose private half is held out of
// band), plus the fail-closed paths.

function spkiPem(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function signEnvelope(
  payload: unknown,
  privateKey: KeyObject,
): { payload: unknown; signature: string } {
  const signature = sign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString(
    "base64",
  );
  return { payload, signature };
}

describe("fingerprintKeyId", () => {
  it("derives a stable ed25519-prefixed 16-hex-char fingerprint", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const id = fingerprintKeyId(publicKey);
    expect(id).toMatch(/^ed25519-[0-9a-f]{16}$/);
    // Deterministic: the same key fingerprints identically.
    expect(fingerprintKeyId(createPublicKey(spkiPem(publicKey)))).toBe(id);
  });

  it("derives distinct fingerprints for distinct keys", () => {
    const a = fingerprintKeyId(generateKeyPairSync("ed25519").publicKey);
    const b = fingerprintKeyId(generateKeyPairSync("ed25519").publicKey);
    expect(a).not.toBe(b);
  });
});

describe("verifyKeyRing", () => {
  it("returns the keys map for a ring signed by the root key", () => {
    const root = generateKeyPairSync("ed25519");
    const op = generateKeyPairSync("ed25519");
    const keyId = fingerprintKeyId(op.publicKey);
    const envelope = signEnvelope(
      {
        keys: [{ keyId, publicKeyPem: spkiPem(op.publicKey), status: "active" }],
        generatedAt: "t",
      },
      root.privateKey,
    );
    const ring = verifyKeyRing(envelope, spkiPem(root.publicKey));
    expect(ring).not.toBeNull();
    expect(ring?.get(keyId)?.status).toBe("active");
  });

  it("rejects a ring whose payload was tampered after signing (fail closed)", () => {
    const root = generateKeyPairSync("ed25519");
    const op = generateKeyPairSync("ed25519");
    const envelope = signEnvelope(
      { keys: [{ keyId: "a", publicKeyPem: spkiPem(op.publicKey), status: "active" }] },
      root.privateKey,
    ) as { payload: { keys: { status: string }[] }; signature: string };
    // Flip the key status after signing: the signature no longer covers it.
    envelope.payload.keys[0].status = "revoked";
    expect(verifyKeyRing(envelope, spkiPem(root.publicKey))).toBeNull();
  });

  it("rejects a ring signed by a different (non-root) key (fail closed)", () => {
    const root = generateKeyPairSync("ed25519");
    const foreign = generateKeyPairSync("ed25519");
    const op = generateKeyPairSync("ed25519");
    const envelope = signEnvelope(
      { keys: [{ keyId: "a", publicKeyPem: spkiPem(op.publicKey), status: "active" }] },
      foreign.privateKey,
    );
    expect(verifyKeyRing(envelope, spkiPem(root.publicKey))).toBeNull();
  });

  it("rejects a structurally malformed envelope without throwing", () => {
    const root = generateKeyPairSync("ed25519");
    const rootPem = spkiPem(root.publicKey);
    expect(verifyKeyRing(null, rootPem)).toBeNull();
    expect(verifyKeyRing({ payload: { keys: [] } }, rootPem)).toBeNull();
    expect(verifyKeyRing({ signature: "x" }, rootPem)).toBeNull();
    expect(verifyKeyRing({ payload: { keys: "nope" }, signature: "x" }, rootPem)).toBeNull();
  });
});

describe("resolveActiveKey", () => {
  function ringWith(entries: { keyId: string; publicKeyPem: string; status: string }[]) {
    const root = generateKeyPairSync("ed25519");
    const envelope = signEnvelope({ keys: entries }, root.privateKey);
    const ring = verifyKeyRing(envelope, spkiPem(root.publicKey));
    if (!ring) throw new Error("expected a verifiable ring");
    return ring;
  }

  it("returns the active key's PEM when its fingerprint matches the keyId", () => {
    const op = generateKeyPairSync("ed25519");
    const keyId = fingerprintKeyId(op.publicKey);
    const pem = spkiPem(op.publicKey);
    const ring = ringWith([{ keyId, publicKeyPem: pem, status: "active" }]);
    expect(resolveActiveKey(ring, keyId)).toBe(pem);
  });

  it("rejects a revoked key (fail closed)", () => {
    const op = generateKeyPairSync("ed25519");
    const keyId = fingerprintKeyId(op.publicKey);
    const ring = ringWith([{ keyId, publicKeyPem: spkiPem(op.publicKey), status: "revoked" }]);
    expect(resolveActiveKey(ring, keyId)).toBeNull();
  });

  it("rejects an unknown keyId (signed by an unknown key)", () => {
    const op = generateKeyPairSync("ed25519");
    const keyId = fingerprintKeyId(op.publicKey);
    const ring = ringWith([{ keyId, publicKeyPem: spkiPem(op.publicKey), status: "active" }]);
    expect(resolveActiveKey(ring, "ed25519-0000000000000000")).toBeNull();
  });

  it("rejects a key filed under a keyId that does not match its fingerprint", () => {
    const op = generateKeyPairSync("ed25519");
    const mislabeled = "ed25519-deadbeefdeadbeef";
    const ring = ringWith([
      { keyId: mislabeled, publicKeyPem: spkiPem(op.publicKey), status: "active" },
    ]);
    expect(resolveActiveKey(ring, mislabeled)).toBeNull();
  });
});

describe("verifyCatalogSignature with an explicit operational key", () => {
  it("verifies a catalog signed by the resolved operational key", () => {
    const op = generateKeyPairSync("ed25519");
    const payload = { schemaVersion: 1, keyId: fingerprintKeyId(op.publicKey), entries: [] };
    const sig = sign(null, Buffer.from(canonicalize(payload), "utf8"), op.privateKey).toString(
      "base64",
    );
    expect(verifyCatalogSignature(payload, sig, spkiPem(op.publicKey))).toBe(true);
  });

  it("rejects a catalog signed by a different key than the one supplied (fail closed)", () => {
    const op = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const payload = { entries: [] };
    const sig = sign(null, Buffer.from(canonicalize(payload), "utf8"), op.privateKey).toString(
      "base64",
    );
    expect(verifyCatalogSignature(payload, sig, spkiPem(other.publicKey))).toBe(false);
  });
});

describe("computePackageDigest / verifyPackageIntegrity (over the built artifact)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "roubo-integrity-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is deterministic and order-independent over the unpacked built artifact", async () => {
    await writeBuiltArtifact(dir);
    const first = await computePackageDigest(dir);
    const second = await computePackageDigest(dir);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("digests the built artifact (dist + manifest), not the cloned source subdir", async () => {
    // AC1: the same logical plugin produces a different digest depending on
    // whether the built artifact (dist/index.js + manifest) or the source subdir
    // (src/ + build config) is the target. The marketplace binds to the former.
    const builtDir = await mkdtemp(path.join(tmpdir(), "roubo-integrity-built-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "roubo-integrity-src-"));
    try {
      await writeBuiltArtifact(builtDir);
      await writeSourceSubdir(sourceDir);
      const builtDigest = await computePackageDigest(builtDir);
      const sourceDigest = await computePackageDigest(sourceDir);
      expect(builtDigest).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(builtDigest).not.toBe(sourceDigest);
    } finally {
      await rm(builtDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("excludes the .git directory from the digest", async () => {
    await writeBuiltArtifact(dir);
    const before = await computePackageDigest(dir);
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    const after = await computePackageDigest(dir);
    expect(after).toBe(before);
  });

  it("changes when a built file's content changes", async () => {
    await writeBuiltArtifact(dir);
    const before = await computePackageDigest(dir);
    await writeFile(path.join(dir, "dist", "index.js"), "export const plugin = () => 'evil';\n");
    const after = await computePackageDigest(dir);
    expect(after).not.toBe(before);
  });

  it("changes when a file is added to the built artifact (layout change)", async () => {
    await writeBuiltArtifact(dir);
    const before = await computePackageDigest(dir);
    await writeFile(path.join(dir, "dist", "extra.js"), "console.log('injected');\n");
    const after = await computePackageDigest(dir);
    expect(after).not.toBe(before);
  });

  it("ignores a dangling symlink without throwing", async () => {
    await writeBuiltArtifact(dir);
    await symlink(path.join(dir, "missing-target"), path.join(dir, "dangling"));
    await expect(computePackageDigest(dir)).resolves.toMatch(/^sha256-/);
  });

  it("verifyPackageIntegrity returns true on an exact digest match", async () => {
    await writeBuiltArtifact(dir);
    const expected = await computePackageDigest(dir);
    expect(await verifyPackageIntegrity(dir, expected)).toBe(true);
  });

  it("verifyPackageIntegrity rejects a tampered built artifact (fail closed)", async () => {
    // AC2: pin the expected digest from the clean artifact, then mutate a built
    // file. The recomputed digest no longer matches, so the check fails closed.
    await writeBuiltArtifact(dir);
    const expected = await computePackageDigest(dir);
    await writeFile(path.join(dir, "dist", "index.js"), "export const plugin = () => 'evil';\n");
    expect(await verifyPackageIntegrity(dir, expected)).toBe(false);
  });

  it("verifyPackageIntegrity returns false on a mismatch", async () => {
    await writeBuiltArtifact(dir);
    expect(await verifyPackageIntegrity(dir, "sha256-deadbeef")).toBe(false);
  });

  it("verifyPackageIntegrity returns false for a null/empty expected digest", async () => {
    await writeBuiltArtifact(dir);
    expect(await verifyPackageIntegrity(dir, null)).toBe(false);
    expect(await verifyPackageIntegrity(dir, "")).toBe(false);
  });
});

describe("catalog integrity digests bind to the built artifact (reconciles #689 / #750 onto #765)", () => {
  // The #689 / #750 guard verified that the committed catalog's `integrity`
  // digests were real content digests of each `plugins/<id>` SOURCE subdir.
  // Issue #765 retargets the digest to the unpacked BUILT artifact, so that
  // source-subdir assertion no longer holds: the committed catalog's digests are
  // over source and signed with an out-of-band key, so they cannot be recomputed
  // and re-signed against built artifacts here, and catalog (re)generation moves
  // to the external roubo-plugins CI under the de-bundling (catalog hosting #5,
  // download/unpack install #7 are both out of scope for this slice). What stays
  // load-bearing and in-scope is the property #689 / #750 protected: a catalog
  // `integrity` digest must be a real content digest of the artifact the
  // installer verifies, and any drift or placeholder fails closed. We assert that
  // property over a synthetic catalog entry whose digest is computed over an
  // unpacked built-artifact fixture, the same verifyPackageIntegrity path the
  // installer uses. The committed catalog's ed25519 SIGNATURE is still exercised
  // unchanged above (verifyCatalogSignature against the bundled public key).
  interface CatalogEntry {
    id: string;
    integrity: string;
    source: { type: "release"; assetUrl: string };
  }

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "roubo-catalog-built-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("verifies a catalog entry whose digest is a real digest of the built artifact", async () => {
    await writeBuiltArtifact(dir);
    const entry: CatalogEntry = {
      id: "demo",
      integrity: await computePackageDigest(dir),
      source: { type: "release", assetUrl: "https://example.invalid/demo-0.1.0.tgz" },
    };
    expect(entry.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(await verifyPackageIntegrity(dir, entry.integrity)).toBe(true);
  });

  it("rejects a wrong/placeholder catalog digest against a real built artifact (fail closed)", async () => {
    // A placeholder or otherwise incorrect catalog digest must fail closed, which
    // is exactly the drift regression the #689 / #750 guard existed to catch.
    await writeBuiltArtifact(dir);
    expect(await verifyPackageIntegrity(dir, "sha256-demo-0.1.0-PLACEHOLDER")).toBe(false);
    expect(await verifyPackageIntegrity(dir, `sha256-${"0".repeat(64)}`)).toBe(false);
  });

  it("rejects a tampered built artifact against a pinned catalog digest (fail closed)", async () => {
    await writeBuiltArtifact(dir);
    const integrity = await computePackageDigest(dir);
    // Inject a file into the unpacked artifact after the digest was pinned.
    await writeFile(path.join(dir, "dist", "payload.js"), "console.log('injected');\n");
    expect(await verifyPackageIntegrity(dir, integrity)).toBe(false);
  });
});

describe("committed catalog digests match the live plugin subdirs (drift guard, issue #818)", () => {
  // Regression guard for issue #818. The synthetic-fixture guard above (added by
  // #765) proves the verifyPackageIntegrity property in the abstract, but it
  // never recomputes a committed catalog `integrity` over the real plugin source
  // it claims to digest, so it could not catch a real-world drift: in #818 a
  // dependency bump (#790, commit 6debe7f) edited package.json in every
  // installable plugin subdir AFTER the catalog was last signed, leaving every
  // recorded `integrity` stale and breaking the happy-path install (the catalog
  // still verified its ed25519 signature, because that drift never altered the
  // payload). The install path digests the staged `source.directory` subdir
  // (plugins/<id>) and compares it to the recorded `integrity`, so this guard
  // recomputes computePackageDigest over each live subdir and asserts equality.
  // It also re-asserts the committed signature, so any plugin-content change that
  // is not followed by a catalog re-sign fails CI here rather than at install.
  // No network is used: the subdirs and catalog are read from the working tree.
  //
  // NOTE on the #765 built-artifact direction: #765 retargets the digest to the
  // unpacked BUILT artifact (dist/) and notes catalog regeneration is moving to
  // external roubo-plugins CI. Until that download/unpack install path and the
  // external catalog generation land, the production install path (and this
  // catalog's recorded digests) bind to the live source subdir, which is what
  // this guard checks. When the built-artifact install path lands, this guard's
  // digest target moves with it; the property it protects (a recorded catalog
  // digest must equal a real digest of the artifact the installer verifies) is
  // unchanged.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  async function loadCatalog(): Promise<{
    payload: { entries: CatalogFileEntry[] };
    signature: string;
  }> {
    return (await import("./marketplace-catalog.json", { with: { type: "json" } })).default as {
      payload: { entries: CatalogFileEntry[] };
      signature: string;
    };
  }

  interface CatalogFileEntry {
    id: string;
    integrity: string;
    revoked?: boolean;
    source: { directory?: string };
  }

  it("recomputes each non-revoked entry's digest over its live plugins/<id> subdir and matches", async () => {
    const catalog = await loadCatalog();
    const installable = catalog.payload.entries.filter(
      (e) => !e.revoked && typeof e.source.directory === "string",
    );
    // Sanity: the catalog still carries the expected installable set.
    expect(installable.map((e) => e.id).sort()).toEqual([
      "database",
      "ghe",
      "github-com",
      "jira-self-hosted",
      "process",
    ]);
    for (const entry of installable) {
      const subdir = path.resolve(repoRoot, entry.source.directory as string);
      const live = await computePackageDigest(subdir);
      expect(
        live,
        `catalog integrity for "${entry.id}" is stale: live ${live} != recorded ${entry.integrity}. Recompute the digest and re-sign the catalog (server/scripts/sign-marketplace-catalog.ts).`,
      ).toBe(entry.integrity);
      expect(await verifyPackageIntegrity(subdir, entry.integrity)).toBe(true);
    }
  });

  it("the committed catalog signature still verifies against the bundled public key", async () => {
    const catalog = await loadCatalog();
    expect(verifyCatalogSignature(catalog.payload, catalog.signature)).toBe(true);
  });
});
