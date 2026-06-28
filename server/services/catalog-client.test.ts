import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  KeyRingEntry,
  MarketplaceCatalogEntry,
  SignedKeyRing,
  SignedMarketplaceCatalog,
} from "@roubo/shared";
import { canonicalize, fingerprintKeyId } from "./marketplace-integrity.js";
import { CatalogUnverifiedError, createCatalogClient } from "./catalog-client.js";
import committedSeed from "./marketplace-catalog.json";

// Catalog-client degrade-chain tests (CPHM-FR-001 / FR-009 / NFR-003, issue
// #306). The client is exercised through dependency injection: a generated root
// + operational keypair (never the embedded bootstrap root, whose private half
// is held out of band), a fake fetch, a temp cache dir, the committed catalog as
// the bundled seed, and a no-op log sink so the run is silent.

const CACHE_FILENAME = "catalog-cache.json";

const SEED = committedSeed as SignedMarketplaceCatalog;

function spkiPem(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function sampleEntries(): MarketplaceCatalogEntry[] {
  return [
    {
      id: "ghe",
      name: "GitHub Enterprise",
      kind: "integration",
      version: "0.1.0",
      summary: "GHE integration",
      source: { type: "git", url: "https://example.invalid/ghe.git", directory: "plugins/ghe" },
      provenance: "roubo/plugins@ghe",
      integrity: "sha256-ghe",
      verified: true,
    },
  ];
}

interface Keys {
  rootPub: KeyObject;
  rootPriv: KeyObject;
  opPub: KeyObject;
  opPriv: KeyObject;
  keyId: string;
}

function makeKeys(): Keys {
  const root = generateKeyPairSync("ed25519");
  const op = generateKeyPairSync("ed25519");
  return {
    rootPub: root.publicKey,
    rootPriv: root.privateKey,
    opPub: op.publicKey,
    opPriv: op.privateKey,
    keyId: fingerprintKeyId(op.publicKey),
  };
}

function buildKeyRing(keys: Keys, status: "active" | "revoked" = "active"): SignedKeyRing {
  const entries: KeyRingEntry[] = [
    { keyId: keys.keyId, publicKeyPem: spkiPem(keys.opPub), status },
  ];
  const payload = { keys: entries, generatedAt: "2026-06-28T00:00:00.000Z" };
  const signature = sign(null, Buffer.from(canonicalize(payload), "utf8"), keys.rootPriv).toString(
    "base64",
  );
  return { payload, signature };
}

function buildCatalog(
  keys: Keys,
  entries: MarketplaceCatalogEntry[],
  keyId = keys.keyId,
): SignedMarketplaceCatalog {
  const payload = {
    schemaVersion: 1,
    generatedAt: "2026-06-28T00:00:00.000Z",
    keyId,
    entries,
  };
  const signature = sign(null, Buffer.from(canonicalize(payload), "utf8"), keys.opPriv).toString(
    "base64",
  );
  return { payload, signature };
}

function fetchReturning(catalog: SignedMarketplaceCatalog, keyRing: SignedKeyRing): typeof fetch {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("key-ring") ? keyRing : catalog;
    return { ok: true, json: async () => body } as Response;
  });
  return impl as unknown as typeof fetch;
}

const failingFetch = vi.fn(async () => {
  throw new Error("ENOTFOUND simulated offline");
}) as unknown as typeof fetch;

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "roubo-catalog-client-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function clientWith(opts: Parameters<typeof createCatalogClient>[0] = {}) {
  return createCatalogClient({
    catalogUrl: "https://example.invalid/catalog.json",
    keyRingUrl: "https://example.invalid/key-ring.json",
    cacheDir,
    seed: SEED,
    log: vi.fn(),
    ...opts,
  });
}

async function readCache(): Promise<{ catalog: SignedMarketplaceCatalog }> {
  const raw = await readFile(path.join(cacheDir, CACHE_FILENAME), "utf8");
  return JSON.parse(raw) as { catalog: SignedMarketplaceCatalog };
}

describe("getVerifiedCatalog network path", () => {
  it("fetches and verifies the catalog from the hosted URL and writes the cache (AC1, AC2)", async () => {
    const keys = makeKeys();
    const entries = sampleEntries();
    const fetchImpl = fetchReturning(buildCatalog(keys, entries), buildKeyRing(keys));
    const client = clientWith({ rootPublicKeyPem: spkiPem(keys.rootPub), fetchImpl });

    const result = await client.getVerifiedCatalog({ forceRefresh: true });

    expect(result.source).toBe("network");
    expect(result.entries.map((e) => e.id)).toEqual(["ghe"]);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The fetch hit the configured hosted URL, not an embedded file.
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.invalid/catalog.json",
      expect.any(Object),
    );
    // The verified envelope was written to the on-disk cache (AC3 setup).
    const cached = await readCache();
    expect(cached.catalog.payload.entries.map((e) => e.id)).toEqual(["ghe"]);
  });

  it("fetches the catalog/key-ring from the configured option URLs", async () => {
    const keys = makeKeys();
    const fetchImpl = fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys));
    const client = createCatalogClient({
      catalogUrl: "https://pages.example/catalog.json",
      keyRingUrl: "https://pages.example/key-ring.json",
      cacheDir,
      seed: SEED,
      log: vi.fn(),
      rootPublicKeyPem: spkiPem(keys.rootPub),
      fetchImpl,
    });
    await client.getVerifiedCatalog({ forceRefresh: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pages.example/catalog.json",
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pages.example/key-ring.json",
      expect.any(Object),
    );
  });

  it("ignores the environment for the fetch target (no env URL override; SSRF hardening)", async () => {
    const keys = makeKeys();
    const fetchImpl = fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys));
    process.env.ROUBO_MARKETPLACE_CATALOG_URL = "https://evil.example/catalog.json";
    process.env.ROUBO_MARKETPLACE_KEY_RING_URL = "https://evil.example/key-ring.json";
    try {
      const client = createCatalogClient({
        cacheDir,
        seed: SEED,
        log: vi.fn(),
        rootPublicKeyPem: spkiPem(keys.rootPub),
        fetchImpl,
      });
      await client.getVerifiedCatalog({ forceRefresh: true });
      const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
      expect(urls).toContain("https://davidpoxon.github.io/roubo-plugins/catalog.json");
      expect(urls).toContain("https://davidpoxon.github.io/roubo-plugins/key-ring.json");
    } finally {
      delete process.env.ROUBO_MARKETPLACE_CATALOG_URL;
      delete process.env.ROUBO_MARKETPLACE_KEY_RING_URL;
    }
  });

  it("rejects a fetched catalog whose key-ring resolves to a revoked key (fail closed, degrades)", async () => {
    const keys = makeKeys();
    const fetchImpl = fetchReturning(
      buildCatalog(keys, sampleEntries()),
      buildKeyRing(keys, "revoked"),
    );
    const client = clientWith({ rootPublicKeyPem: spkiPem(keys.rootPub), fetchImpl });
    const result = await client.getVerifiedCatalog({ forceRefresh: true });
    // No cache yet, so it falls through to the seed; nothing from the unverifiable
    // fetch is served.
    expect(result.source).toBe("seed");
  });

  it("rejects a fetched catalog whose keyId is unknown to the ring (fail closed, degrades)", async () => {
    const keys = makeKeys();
    const fetchImpl = fetchReturning(
      buildCatalog(keys, sampleEntries(), "ed25519-0000000000000000"),
      buildKeyRing(keys),
    );
    const client = clientWith({ rootPublicKeyPem: spkiPem(keys.rootPub), fetchImpl });
    const result = await client.getVerifiedCatalog({ forceRefresh: true });
    expect(result.source).toBe("seed");
  });

  it("memoizes the resolved catalog in-memory without forceRefresh (one network fetch)", async () => {
    const keys = makeKeys();
    const fetchImpl = fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys));
    const client = clientWith({ rootPublicKeyPem: spkiPem(keys.rootPub), fetchImpl });
    await client.getVerifiedCatalog({ forceRefresh: true });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const again = await client.getVerifiedCatalog();
    expect(again.source).toBe("network");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("re-runs the degrade chain on a plain call once the memo TTL has elapsed", async () => {
    const keys = makeKeys();
    const fetchImpl = fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys));
    // memoTtlMs: 0 makes the in-memory memo immediately stale, so the next plain
    // (non-forceRefresh) call re-fetches rather than reusing the prior result.
    const client = clientWith({ rootPublicKeyPem: spkiPem(keys.rootPub), fetchImpl, memoTtlMs: 0 });
    await client.getVerifiedCatalog({ forceRefresh: true });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const again = await client.getVerifiedCatalog();
    expect(again.source).toBe("network");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      calls,
    );
  });
});

describe("getVerifiedCatalog cache degrade", () => {
  it("returns the cached envelope when the network fetch fails, reported as cache (TC-044)", async () => {
    const keys = makeKeys();
    const rootPublicKeyPem = spkiPem(keys.rootPub);
    // Phase 1: a successful fetch warms the cache.
    const online = clientWith({
      rootPublicKeyPem,
      fetchImpl: fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys)),
    });
    await online.getVerifiedCatalog({ forceRefresh: true });

    // Phase 2: a fresh client over the same cache dir with the network down.
    const offline = clientWith({ rootPublicKeyPem, fetchImpl: failingFetch });
    const result = await offline.getVerifiedCatalog({ forceRefresh: true });
    expect(result.source).toBe("cache");
    expect(result.entries.map((e) => e.id)).toEqual(["ghe"]);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("discards a fetched bad-signature payload and serves the cache without overwriting it (TC-049)", async () => {
    const keys = makeKeys();
    const rootPublicKeyPem = spkiPem(keys.rootPub);
    await clientWith({
      rootPublicKeyPem,
      fetchImpl: fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys)),
    }).getVerifiedCatalog({ forceRefresh: true });

    // A reachable marketplace that returns a tampered catalog.
    const tampered = buildCatalog(keys, sampleEntries());
    (tampered.payload.entries as MarketplaceCatalogEntry[]).push({
      ...sampleEntries()[0],
      id: "evil-injected",
    });
    const client = clientWith({
      rootPublicKeyPem,
      fetchImpl: fetchReturning(tampered, buildKeyRing(keys)),
    });
    const result = await client.getVerifiedCatalog({ forceRefresh: true });
    expect(result.source).toBe("cache");
    expect(result.entries.map((e) => e.id)).toEqual(["ghe"]);
    // The trusted cache was not overwritten by the rejected payload.
    const cached = await readCache();
    expect(cached.catalog.payload.entries.map((e) => e.id)).toEqual(["ghe"]);
  });
});

describe("getVerifiedCatalog seed degrade (never zero plugins, FR-009)", () => {
  it("serves the seed when there is no cache and the network is down (TC-047)", async () => {
    const result = await clientWith({ fetchImpl: failingFetch }).getVerifiedCatalog({
      forceRefresh: true,
    });
    expect(result.source).toBe("seed");
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("falls through to the seed when the cache is unparseable (TC-048)", async () => {
    await writeFile(path.join(cacheDir, CACHE_FILENAME), "{ not valid json", "utf8");
    const result = await clientWith({ fetchImpl: failingFetch }).getVerifiedCatalog({
      forceRefresh: true,
    });
    expect(result.source).toBe("seed");
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("rejects a tampered cached envelope and falls through to the seed (TC-046)", async () => {
    const keys = makeKeys();
    const rootPublicKeyPem = spkiPem(keys.rootPub);
    // Write a structurally valid but signature-broken cache: the cached catalog
    // payload is mutated after signing, so verification fails closed.
    const catalog = buildCatalog(keys, sampleEntries());
    (catalog.payload.entries as MarketplaceCatalogEntry[]).push({
      ...sampleEntries()[0],
      id: "tampered",
    });
    const cache = {
      catalog,
      keyRing: buildKeyRing(keys),
      fetchedAt: "2026-06-28T00:00:00.000Z",
    };
    await writeFile(path.join(cacheDir, CACHE_FILENAME), JSON.stringify(cache), "utf8");

    const result = await clientWith({
      rootPublicKeyPem,
      fetchImpl: failingFetch,
    }).getVerifiedCatalog({ forceRefresh: true });
    expect(result.source).toBe("seed");
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("throws CatalogUnverifiedError when even the seed fails verification (fail closed)", async () => {
    const badSeed: SignedMarketplaceCatalog = {
      payload: { entries: sampleEntries() },
      signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const client = clientWith({ seed: badSeed, fetchImpl: failingFetch });
    await expect(client.getVerifiedCatalog({ forceRefresh: true })).rejects.toBeInstanceOf(
      CatalogUnverifiedError,
    );
  });
});

describe("prefetch", () => {
  it("resolves without throwing on a successful fetch and warms the cache", async () => {
    const keys = makeKeys();
    const client = clientWith({
      rootPublicKeyPem: spkiPem(keys.rootPub),
      fetchImpl: fetchReturning(buildCatalog(keys, sampleEntries()), buildKeyRing(keys)),
    });
    await expect(client.prefetch()).resolves.toBeUndefined();
    const cached = await readCache();
    expect(cached.catalog.payload.entries.map((e) => e.id)).toEqual(["ghe"]);
  });

  it("swallows a degrade to seed and never rejects", async () => {
    await expect(clientWith({ fetchImpl: failingFetch }).prefetch()).resolves.toBeUndefined();
  });

  it("swallows even a CatalogUnverifiedError floor and never rejects", async () => {
    const badSeed: SignedMarketplaceCatalog = {
      payload: { entries: [] },
      signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    await expect(
      clientWith({ seed: badSeed, fetchImpl: failingFetch }).prefetch(),
    ).resolves.toBeUndefined();
  });
});

// ── ROUBO_E2E offline-journey seam (issue #314, CPHM-TC-051) ──────────────────
// The seam (the ROUBO_E2E branch in getDefaultClient plus __setE2EMarketplaceReachable
// and its helpers) is what the marketplace-offline-journey e2e flips to walk
// offline -> install-paused -> reconnect. Unlike the dependency-injection tests
// above, it drives the MODULE-LEVEL default client, which resolves its cache dir
// from getRouboDir(); so these tests redirect getRouboDir() at a throwaway tmp dir
// and re-import the module fresh per test (vi.resetModules) so the cached default
// client and the generated-keypair seam are rebuilt under the pinned ROUBO_E2E.
describe("__setE2EMarketplaceReachable (ROUBO_E2E offline-journey seam, #314)", () => {
  const originalE2E = process.env.ROUBO_E2E;
  let cacheHome: string;

  beforeEach(async () => {
    cacheHome = await mkdtemp(path.join(tmpdir(), "catalog-seam-"));
    vi.resetModules();
    vi.doMock("./state.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./state.js")>();
      return { ...actual, getRouboDir: () => cacheHome };
    });
  });

  afterEach(async () => {
    vi.doUnmock("./state.js");
    vi.resetModules();
    if (originalE2E === undefined) delete process.env.ROUBO_E2E;
    else process.env.ROUBO_E2E = originalE2E;
    await rm(cacheHome, { recursive: true, force: true });
  });

  it("is a no-op (returns null) outside the ROUBO_E2E gate", async () => {
    delete process.env.ROUBO_E2E;
    const mod = await import("./catalog-client.js");
    expect(await mod.__setE2EMarketplaceReachable(true)).toBeNull();
    expect(await mod.__setE2EMarketplaceReachable(false)).toBeNull();
  });

  it("resolves the live 'network' source when reachable under ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";
    const mod = await import("./catalog-client.js");
    expect(await mod.__setE2EMarketplaceReachable(true)).toBe("network");
  });

  it("degrades to the bundled seed when unreachable with no warmed cache", async () => {
    process.env.ROUBO_E2E = "1";
    const mod = await import("./catalog-client.js");
    expect(await mod.__setE2EMarketplaceReachable(false)).toBe("seed");
  });

  it("degrades off network to the warmed cache, then restores on reconnect", async () => {
    process.env.ROUBO_E2E = "1";
    const mod = await import("./catalog-client.js");
    // Reachable first warms the on-disk cache via the injected network fetch.
    expect(await mod.__setE2EMarketplaceReachable(true)).toBe("network");
    // Unreachable degrades off network to that last-verified cache (not the seed).
    expect(await mod.__setE2EMarketplaceReachable(false)).toBe("cache");
    // Reconnecting restores the live network source (the install-pause lifts).
    expect(await mod.__setE2EMarketplaceReachable(true)).toBe("network");
  });
});
