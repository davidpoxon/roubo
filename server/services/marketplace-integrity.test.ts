import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalize,
  computePackageDigest,
  verifyCatalogSignature,
  verifyPackageIntegrity,
} from "./marketplace-integrity.js";

// Unit tests for the marketplace channel-integrity primitives (CP-FR-021,
// issue #622): deterministic canonicalization, ed25519 catalog-signature
// verification (fail-closed), and the deterministic staged-package digest +
// integrity check.

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

describe("computePackageDigest / verifyPackageIntegrity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "roubo-integrity-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is deterministic and order-independent for the same content", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "b.txt"), "beta");
    const first = await computePackageDigest(dir);
    const second = await computePackageDigest(dir);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("excludes the .git directory from the digest", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    const before = await computePackageDigest(dir);
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    const after = await computePackageDigest(dir);
    expect(after).toBe(before);
  });

  it("changes when file content changes", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    const before = await computePackageDigest(dir);
    await writeFile(path.join(dir, "a.txt"), "tampered");
    const after = await computePackageDigest(dir);
    expect(after).not.toBe(before);
  });

  it("changes when a file is added (layout change)", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    const before = await computePackageDigest(dir);
    await writeFile(path.join(dir, "extra.txt"), "alpha");
    const after = await computePackageDigest(dir);
    expect(after).not.toBe(before);
  });

  it("ignores a dangling symlink without throwing", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    await symlink(path.join(dir, "missing-target"), path.join(dir, "dangling"));
    await expect(computePackageDigest(dir)).resolves.toMatch(/^sha256-/);
  });

  it("verifyPackageIntegrity returns true on an exact digest match", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    const expected = await computePackageDigest(dir);
    expect(await verifyPackageIntegrity(dir, expected)).toBe(true);
  });

  it("verifyPackageIntegrity returns false on a mismatch", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    expect(await verifyPackageIntegrity(dir, "sha256-deadbeef")).toBe(false);
  });

  it("verifyPackageIntegrity returns false for a null/empty expected digest", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha");
    expect(await verifyPackageIntegrity(dir, null)).toBe(false);
    expect(await verifyPackageIntegrity(dir, "")).toBe(false);
  });
});
