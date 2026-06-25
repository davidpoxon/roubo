import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

describe("checked-in catalog digests validate against the real per-plugin sources (issue #689 / #750)", () => {
  // End-to-end guard: every installable catalog entry's `integrity` digest must be
  // a real content digest of its `plugins/<id>` source subdirectory (the
  // monorepo-subdir source model, #750), validated through the same
  // verifyPackageIntegrity path the installer uses. This catches a
  // wrong/placeholder/stale digest in the committed catalog at CI time: because a
  // digest binds to live `plugins/<id>` content, any change there without
  // recomputing the digest and re-signing the catalog fails this test (fail
  // closed on drift). No network: the source is exported from the local git tree
  // (tracked content at HEAD, exactly what a fresh clone then subdir-stage
  // produces).
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  interface CatalogEntry {
    id: string;
    integrity: string;
    source: { directory?: string };
    revoked?: boolean;
  }

  async function loadEntries(): Promise<CatalogEntry[]> {
    const catalog = (await import("./marketplace-catalog.json", { with: { type: "json" } }))
      .default as { payload: { entries: CatalogEntry[] } };
    return catalog.payload.entries;
  }

  // Export a subdirectory's tracked content at HEAD into a fresh temp dir: the
  // same clean content a `git clone` + subdir-stage stages and digests. stdio is
  // pinned so the subprocesses stay silent (no test stdout/stderr noise).
  const dirs: string[] = [];
  async function exportSubdir(directory: string): Promise<string> {
    const dest = await mkdtemp(path.join(tmpdir(), "roubo-catalog-src-"));
    dirs.push(dest);
    const archive = execFileSync("git", ["-C", repoRoot, "archive", `HEAD:${directory}`], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("tar", ["-x", "-C", dest], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
    return dest;
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const installable = ["database", "process", "github-com", "ghe", "jira-self-hosted"] as const;

  it.each(installable)(
    "verifies the %s entry's catalog digest against its plugins/<id> source",
    async (id: string) => {
      const entry = (await loadEntries()).find((e) => e.id === id);
      if (!entry) throw new Error(`expected a ${id} catalog entry`);
      expect(entry.revoked ?? false).toBe(false);
      const directory = entry.source.directory;
      if (directory === undefined) {
        throw new Error(`expected ${id} to declare a source.directory`);
      }
      expect(directory).toBe(`plugins/${id}`);
      // The catalog digest must be a real sha256 hex, not a placeholder.
      expect(entry.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
      const dir = await exportSubdir(directory);
      expect(await verifyPackageIntegrity(dir, entry.integrity)).toBe(true);
    },
  );

  it("rejects a wrong/placeholder digest against a real source package", async () => {
    // A placeholder or otherwise incorrect catalog digest must fail closed, which
    // is exactly the regression this end-to-end test exists to catch.
    const dir = await exportSubdir("plugins/database");
    expect(await verifyPackageIntegrity(dir, "sha256-database-0.1.0-PLACEHOLDER")).toBe(false);
    expect(await verifyPackageIntegrity(dir, `sha256-${"0".repeat(64)}`)).toBe(false);
  });
});
