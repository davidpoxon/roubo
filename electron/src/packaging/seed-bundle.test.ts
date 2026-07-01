import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { seedBundle, SEED_PLUGIN_PINS, type FetchLike } from "./seed-bundle.js";

const CATALOG_URL = "https://feed.test/catalog.json";

let tmpDir: string;
let electronRoot: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "seed-bundle-test-"));
  electronRoot = path.join(tmpDir, "electron");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assetUrlFor(id: string, version: string): string {
  return `https://assets.test/${id}-v${version}.tgz`;
}

function assetBytesFor(id: string, version: string): Buffer {
  return Buffer.from(`${id}-${version}-built-tarball-bytes`);
}

type EntryOverride = {
  version?: string;
  source?: Record<string, unknown>;
  revoked?: boolean;
  digestPrefix?: string;
};

function releaseEntry(id: string, version: string, override: EntryOverride = {}) {
  const bytes = assetBytesFor(id, version);
  const prefix = override.digestPrefix ?? "sha256-";
  const source = override.source ?? {
    type: "release",
    assetUrl: assetUrlFor(id, version),
    sha256: `${prefix}${sha256Hex(bytes)}`,
  };
  return {
    id,
    name: id,
    kind: "component",
    version: override.version ?? version,
    summary: `${id} summary`,
    source,
    provenance: `roubo/plugins@${id}`,
    integrity: `sha256-${sha256Hex(bytes)}`,
    ...(override.revoked !== undefined ? { revoked: override.revoked } : {}),
    verified: true,
  };
}

interface CatalogOpts {
  signature?: string;
  omitEntries?: boolean;
}

function buildCatalog(entries: unknown[], opts: CatalogOpts = {}) {
  const payload = opts.omitEntries
    ? { schemaVersion: 1, keyId: "ed25519-deadbeefdeadbeef" }
    : {
        schemaVersion: 1,
        generatedAt: "2026-06-29T00:00:00.000Z",
        keyId: "ed25519-deadbeefdeadbeef",
        entries,
      };
  return {
    payload,
    signature: opts.signature ?? "c3R1Yi1zaWduYXR1cmU=",
  };
}

/**
 * Build the seeded-set entries (github-com, process, database) plus the
 * marketplace-only ghe and jira-self-hosted entries, so a test can prove the
 * latter two are never seeded.
 */
function fullCatalogEntries() {
  return [
    releaseEntry("database", "0.1.1"),
    releaseEntry("process", "0.1.0"),
    releaseEntry("github-com", "0.1.0"),
    releaseEntry("ghe", "0.1.0"),
    releaseEntry("jira-self-hosted", "0.1.0"),
  ];
}

/** An offline fetcher serving the catalog JSON and the release-asset bytes. */
function makeFetch(catalog: unknown, calls: string[]): FetchLike {
  return async (url: string) => {
    calls.push(url);
    if (url === CATALOG_URL) {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    // Match the asset URL back to its bytes by id+version.
    for (const pin of SEED_PLUGIN_PINS) {
      if (url === assetUrlFor(pin.id, pin.version)) {
        return new Response(Uint8Array.from(assetBytesFor(pin.id, pin.version)), { status: 200 });
      }
    }
    for (const id of ["ghe", "jira-self-hosted"]) {
      if (url === assetUrlFor(id, "0.1.0")) {
        return new Response(Uint8Array.from(assetBytesFor(id, "0.1.0")), { status: 200 });
      }
    }
    return new Response(null, { status: 404 });
  };
}

async function run(catalog: unknown, calls: string[] = []) {
  await seedBundle({ electronRoot, catalogUrl: CATALOG_URL, fetchImpl: makeFetch(catalog, calls) });
}

const seedDir = () => path.join(electronRoot, "resources", "seed");

describe("seedBundle", () => {
  it("writes exactly the three seed tarballs plus a signed catalog.json", async () => {
    await run(buildCatalog(fullCatalogEntries()));

    const files = (await readdir(seedDir())).sort();
    expect(files).toEqual(
      ["catalog.json", "database-0.1.1.tgz", "github-com-0.1.0.tgz", "process-0.1.0.tgz"].sort(),
    );
  });

  it("writes each tarball's verified bytes verbatim", async () => {
    await run(buildCatalog(fullCatalogEntries()));

    for (const pin of SEED_PLUGIN_PINS) {
      const written = await readFile(path.join(seedDir(), `${pin.id}-${pin.version}.tgz`));
      expect(written.equals(assetBytesFor(pin.id, pin.version))).toBe(true);
    }
  });

  it("ships the signed catalog envelope verbatim", async () => {
    const catalog = buildCatalog(fullCatalogEntries());
    await run(catalog);

    const written = JSON.parse(await readFile(path.join(seedDir(), "catalog.json"), "utf8"));
    expect(written).toEqual(catalog);
    expect(typeof written.signature).toBe("string");
    expect(written.signature.length).toBeGreaterThan(0);
    expect(Array.isArray(written.payload.entries)).toBe(true);
  });

  it("never seeds ghe or jira-self-hosted (marketplace-only)", async () => {
    const calls: string[] = [];
    await run(buildCatalog(fullCatalogEntries()), calls);

    const files = await readdir(seedDir());
    expect(files.some((f) => f.startsWith("ghe-"))).toBe(false);
    expect(files.some((f) => f.startsWith("jira-self-hosted-"))).toBe(false);

    // Their assets are never even fetched.
    expect(calls).not.toContain(assetUrlFor("ghe", "0.1.0"));
    expect(calls).not.toContain(assetUrlFor("jira-self-hosted", "0.1.0"));
  });

  it("accepts a bare-hex asset digest (no sha256- prefix)", async () => {
    const entries = [
      releaseEntry("database", "0.1.1", { digestPrefix: "" }),
      releaseEntry("process", "0.1.0", { digestPrefix: "sha256:" }),
      releaseEntry("github-com", "0.1.0"),
    ];
    await run(buildCatalog(entries));

    const files = await readdir(seedDir());
    expect(files).toContain("database-0.1.1.tgz");
    expect(files).toContain("process-0.1.0.tgz");
  });

  it("is idempotent: a rerun replaces the prior seed cache", async () => {
    await run(buildCatalog(fullCatalogEntries()));
    await run(buildCatalog(fullCatalogEntries()));

    const files = (await readdir(seedDir())).sort();
    expect(files).toEqual(
      ["catalog.json", "database-0.1.1.tgz", "github-com-0.1.0.tgz", "process-0.1.0.tgz"].sort(),
    );
  });

  it("fails closed on an asset digest mismatch", async () => {
    const entries = fullCatalogEntries();
    // Tamper the database asset digest so verification must reject.
    (entries[0] as unknown as { source: { sha256: string } }).source.sha256 =
      `sha256-${"0".repeat(64)}`;

    await expect(run(buildCatalog(entries))).rejects.toThrow(/failed integrity verification/);
  });

  it("fails closed when a seed entry version drifts from the pin", async () => {
    const entries = [
      releaseEntry("database", "0.1.1"),
      releaseEntry("process", "0.1.0"),
      releaseEntry("github-com", "0.2.0", { version: "0.2.0" }),
    ];
    await expect(run(buildCatalog(entries))).rejects.toThrow(/pinned to 0\.1\.0/);
  });

  it("fails closed when a seed entry is missing from the catalog", async () => {
    const entries = [releaseEntry("database", "0.1.1"), releaseEntry("process", "0.1.0")];
    await expect(run(buildCatalog(entries))).rejects.toThrow(
      /no catalog entry for seed plugin "github-com"/,
    );
  });

  it("fails closed when a seed entry is revoked", async () => {
    const entries = [
      releaseEntry("database", "0.1.1", { revoked: true }),
      releaseEntry("process", "0.1.0"),
      releaseEntry("github-com", "0.1.0"),
    ];
    await expect(run(buildCatalog(entries))).rejects.toThrow(/is revoked/);
  });

  it("fails closed when a seed entry is a git source, not a built release", async () => {
    const entries = [
      releaseEntry("database", "0.1.1", {
        source: {
          type: "git",
          url: "https://github.com/davidpoxon/roubo.git",
          directory: "plugins/database",
        },
      }),
      releaseEntry("process", "0.1.0"),
      releaseEntry("github-com", "0.1.0"),
    ];
    await expect(run(buildCatalog(entries))).rejects.toThrow(/must be a built release artifact/);
  });

  it("fails closed when a release entry has no asset URL", async () => {
    const entries = [
      releaseEntry("database", "0.1.1", { source: { type: "release", sha256: "sha256-abc" } }),
      releaseEntry("process", "0.1.0"),
      releaseEntry("github-com", "0.1.0"),
    ];
    await expect(run(buildCatalog(entries))).rejects.toThrow(/no release asset URL/);
  });

  it("fails closed when a release entry has no asset digest", async () => {
    const entries = [
      releaseEntry("database", "0.1.1", {
        source: { type: "release", assetUrl: assetUrlFor("database", "0.1.1") },
      }),
      releaseEntry("process", "0.1.0"),
      releaseEntry("github-com", "0.1.0"),
    ];
    await expect(run(buildCatalog(entries))).rejects.toThrow(/no asset digest/);
  });

  it("fails closed when the catalog fetch is not 200", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response(null, { status: 503 });
    };
    await expect(seedBundle({ electronRoot, catalogUrl: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /catalog fetch failed with HTTP status 503/,
    );
  });

  it("fails closed when an asset download is not 200", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === CATALOG_URL) {
        return new Response(JSON.stringify(buildCatalog(fullCatalogEntries())), { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    await expect(seedBundle({ electronRoot, catalogUrl: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /asset download failed with HTTP status 404/,
    );
  });

  it("fails closed when the catalog payload has no entries array", async () => {
    await expect(run(buildCatalog([], { omitEntries: true }))).rejects.toThrow(
      /missing its entries array/,
    );
  });

  it("fails closed when the catalog is not signed", async () => {
    await expect(run(buildCatalog(fullCatalogEntries(), { signature: "" }))).rejects.toThrow(
      /not signed/,
    );
  });

  it("wraps a catalog fetch network error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(seedBundle({ electronRoot, catalogUrl: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /could not fetch the catalog: ECONNREFUSED/,
    );
  });

  it("wraps an asset fetch network error", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === CATALOG_URL) {
        return new Response(JSON.stringify(buildCatalog(fullCatalogEntries())), { status: 200 });
      }
      throw new Error("socket hang up");
    };
    await expect(seedBundle({ electronRoot, catalogUrl: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /could not download the .* asset: socket hang up/,
    );
  });

  it("exposes the pinned seed set: exactly github-com, process, database", () => {
    expect(SEED_PLUGIN_PINS.map((p) => p.id).sort()).toEqual(
      ["database", "github-com", "process"].sort(),
    );
    expect(SEED_PLUGIN_PINS.map((p) => p.id)).not.toContain("ghe");
    expect(SEED_PLUGIN_PINS.map((p) => p.id)).not.toContain("jira-self-hosted");
  });
});
