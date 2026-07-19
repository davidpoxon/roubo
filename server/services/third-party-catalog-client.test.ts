import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MarketplaceCatalogEntry, MarketplaceSource } from "@roubo/shared";

// Third-party (unsigned) source catalog client tests (issue #555,
// CPHMTP-NFR-001 / NFR-007 / FR-004). The client is exercised through dependency
// injection: a fake fetch, a temp cache dir (either injected or derived from a
// redirected getRouboDir), and a no-op log sink so the run is silent. It shares
// the DI fixture shape with catalog-client.test.ts but never touches the signed
// verify chain: third-party sources are unsigned by construction, so there is no
// key-ring, no signature, and no seed floor.

// getRouboDir() is redirected at a per-test temp base so the DEFAULT per-source
// cache path derivation (`<rouboDir>/marketplace/sources/<id>`) is exercised for
// real. Tests that inject an explicit cacheDir never call it.
const stateMock = vi.hoisted(() => ({ rouboDir: "" }));
vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return { ...actual, getRouboDir: () => stateMock.rouboDir };
});

import { createThirdPartyCatalogClient } from "./catalog-client.js";

const CACHE_FILENAME = "catalog-cache.json";

function makeSource(overrides: Partial<MarketplaceSource> = {}): MarketplaceSource {
  return {
    id: "acme",
    url: "https://example.invalid/acme/catalog.json",
    unsigned: true,
    hasCredential: false,
    allowHttp: false,
    registeredAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

// Plain, unsigned catalog entries as a third-party feed would serve them. Note
// `verified: false`: the client passes entries through untouched and never flips
// this to true (only the first-party signed path can set `verified`).
function sampleEntries(idPrefix = "acme"): MarketplaceCatalogEntry[] {
  return [
    {
      id: `${idPrefix}-tool`,
      name: "Acme Tool",
      kind: "component",
      version: "1.0.0",
      summary: "an unsigned third-party tool",
      source: { type: "git", url: "https://example.invalid/acme.git", directory: "plugins/acme" },
      provenance: "acme/plugins@tool",
      integrity: "sha256-acme",
      verified: false,
    },
  ];
}

// A validly shaped but oversized catalog: many padded entries, mirroring the
// first-party over-cap probe.
function oversizedEntries(count = 200): MarketplaceCatalogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    ...sampleEntries()[0],
    id: `padded-${i}`,
    summary: "x".repeat(512),
  }));
}

// Serve a real, streamable `Response` carrying a plain `{ entries }` body (no
// signature, no key-ring), so every test flows through fetchGuardedJson's
// streaming size guard unchanged. An explicit `contentLength` overrides the
// declared header to exercise the up-front check (a large declared value) or the
// streaming check (a small, lying value) in isolation.
function fetchReturning(entries: MarketplaceCatalogEntry[], contentLength?: number): typeof fetch {
  const impl = vi.fn(async () => {
    const body = JSON.stringify({ entries });
    const declared = contentLength ?? Buffer.byteLength(body, "utf8");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(declared) },
    });
  });
  return impl as unknown as typeof fetch;
}

const failingFetch = vi.fn(async () => {
  throw new Error("ENOTFOUND simulated offline");
}) as unknown as typeof fetch;

let rouboBase: string;

beforeEach(async () => {
  rouboBase = await mkdtemp(path.join(tmpdir(), "roubo-3p-catalog-"));
  stateMock.rouboDir = rouboBase;
});

afterEach(async () => {
  await rm(rouboBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

function clientFor(
  source: MarketplaceSource,
  opts: Parameters<typeof createThirdPartyCatalogClient>[1] = {},
) {
  return createThirdPartyCatalogClient(source, { log: vi.fn(), ...opts });
}

/** Default per-source cache path (`<rouboBase>/marketplace/sources/<id>/catalog-cache.json`). */
function sourceCachePath(id: string): string {
  return path.join(rouboBase, "marketplace", "sources", id, CACHE_FILENAME);
}

/** The first-party cache path, which third-party caching must never touch. */
function firstPartyCachePath(): string {
  return path.join(rouboBase, "marketplace", CACHE_FILENAME);
}

async function readJson(file: string): Promise<{ entries: MarketplaceCatalogEntry[] }> {
  return JSON.parse(await readFile(file, "utf8")) as { entries: MarketplaceCatalogEntry[] };
}

describe("createThirdPartyCatalogClient network path", () => {
  it("fetches unsigned entries, serves them as network, and writes the per-source cache", async () => {
    const source = makeSource();
    const fetchImpl = fetchReturning(sampleEntries());
    const client = clientFor(source, { fetchImpl });

    const result = await client.getCatalog({ forceRefresh: true });

    expect(result.source).toBe("network");
    expect(result.entries.map((e) => e.id)).toEqual(["acme-tool"]);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Entries pass through untouched: the client never sets `verified`.
    expect(result.entries[0].verified).toBe(false);
    // The per-source cache is a plain, unverified object: entries + fetchedAt,
    // with no signature envelope and no key-ring.
    const raw = JSON.parse(await readFile(sourceCachePath("acme"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw).sort()).toEqual(["entries", "fetchedAt"]);
    expect(raw).not.toHaveProperty("signature");
    expect(raw).not.toHaveProperty("keyRing");
  });

  it("forwards the per-source credential to guardedFetch as an Authorization header (thin pass-through)", async () => {
    const source = makeSource({ hasCredential: true });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer s3cr3t");
      return new Response(JSON.stringify({ entries: sampleEntries() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = clientFor(source, { fetchImpl, credential: "s3cr3t" });

    const result = await client.getCatalog({ forceRefresh: true });
    expect(result.source).toBe("network");
  });

  it("blocks a plain-http source that did not opt into allowHttp, degrading fail-closed", async () => {
    // allowHttp: false (the default). guardedFetch rejects the http hop before it
    // connects, so the fetch mock is never called and the chain degrades.
    const source = makeSource({
      url: "http://example.invalid/acme/catalog.json",
      allowHttp: false,
    });
    const fetchImpl = fetchReturning(sampleEntries());
    const client = clientFor(source, { fetchImpl });

    const result = await client.getCatalog({ forceRefresh: true });

    expect(result.entries).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches a plain-http source when it opted into allowHttp", async () => {
    const source = makeSource({ url: "http://example.invalid/acme/catalog.json", allowHttp: true });
    const fetchImpl = fetchReturning(sampleEntries());
    const client = clientFor(source, { fetchImpl });

    const result = await client.getCatalog({ forceRefresh: true });

    expect(result.source).toBe("network");
    expect(result.entries.map((e) => e.id)).toEqual(["acme-tool"]);
  });

  it("memoizes the resolved result in-memory without forceRefresh (one network fetch)", async () => {
    const fetchImpl = fetchReturning(sampleEntries());
    const client = clientFor(makeSource(), { fetchImpl });
    await client.getCatalog({ forceRefresh: true });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const again = await client.getCatalog();
    expect(again.source).toBe("network");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});

describe("createThirdPartyCatalogClient no-verifier construction (CPHMTP-TC-057)", () => {
  it("takes no verifier / key-ring parameter (only the source is required)", () => {
    // A verifier/key-ring positional would raise the required-arg count; the sole
    // required parameter is the source (options carries a default).
    expect(createThirdPartyCatalogClient).toHaveLength(1);
  });

  it("serves an unsigned feed with a single fetch (no key-ring fetch, no signature step)", async () => {
    const fetchImpl = fetchReturning(sampleEntries());
    const client = clientFor(makeSource(), { fetchImpl });

    const result = await client.getCatalog({ forceRefresh: true });

    // The signed first-party path fetches TWO URLs (catalog + key-ring); this
    // path fetches exactly ONE and requires no signature, proving the signed
    // chain is unreachable by construction.
    expect(result.source).toBe("network");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("has no seed floor: a total failure resolves to an empty result, never a seed", async () => {
    // Network down and no cache on disk. A first-party client would serve the
    // bundled seed here; the third-party client must serve an empty listing.
    const client = clientFor(makeSource(), { fetchImpl: failingFetch });

    const result = await client.getCatalog({ forceRefresh: true });

    expect(result.source).toBe("cache");
    expect(result.entries).toEqual([]);
    expect(result.fetchedAt).toBeNull();
  });
});

describe("createThirdPartyCatalogClient cache degrade (CPHMTP-TC-037)", () => {
  it("serves the source's own per-source cache when the network is down, never a seed", async () => {
    const source = makeSource();
    // Phase 1: a successful fetch warms this source's cache.
    await clientFor(source, { fetchImpl: fetchReturning(sampleEntries()) }).getCatalog({
      forceRefresh: true,
    });

    // Phase 2: a fresh client over the same default cache dir with the network down.
    const offline = clientFor(source, { fetchImpl: failingFetch });
    const result = await offline.getCatalog({ forceRefresh: true });

    expect(result.source).toBe("cache");
    expect(result.entries.map((e) => e.id)).toEqual(["acme-tool"]);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fails closed to an empty result on an unparseable per-source cache (no throw)", async () => {
    const source = makeSource();
    await mkdir(path.dirname(sourceCachePath("acme")), { recursive: true });
    await writeFile(sourceCachePath("acme"), "{ not valid json", "utf8");
    const result = await clientFor(source, { fetchImpl: failingFetch }).getCatalog({
      forceRefresh: true,
    });
    expect(result.entries).toEqual([]);
  });

  it("fails closed to an empty result on a wrong-shape per-source cache (no throw)", async () => {
    const source = makeSource();
    await mkdir(path.dirname(sourceCachePath("acme")), { recursive: true });
    // Valid JSON, but `entries` is not an array: the shape guard rejects it.
    await writeFile(sourceCachePath("acme"), JSON.stringify({ entries: "nope" }), "utf8");
    const result = await clientFor(source, { fetchImpl: failingFetch }).getCatalog({
      forceRefresh: true,
    });
    expect(result.entries).toEqual([]);
  });
});

describe("createThirdPartyCatalogClient over-cap payload (CPHMTP-TC-040)", () => {
  it("rejects an over-budget payload mid-stream and degrades to the cache, not overwriting it", async () => {
    const source = makeSource();
    // Phase 1: warm the cache with a small, valid payload.
    await clientFor(source, { fetchImpl: fetchReturning(sampleEntries()) }).getCatalog({
      forceRefresh: true,
    });
    const cachedBefore = await readFile(sourceCachePath("acme"), "utf8");

    // Phase 2: an oversized payload whose declared content-length lies small, so
    // the streaming byte counter is what catches the breach.
    const log = vi.fn();
    const client = clientFor(source, {
      fetchImpl: fetchReturning(oversizedEntries(), 10),
      log,
      maxCatalogBytes: 1024,
    });
    const result = await client.getCatalog({ forceRefresh: true });

    // Degraded to the warmed cache; none of the oversized entries leaked.
    expect(result.source).toBe("cache");
    expect(result.entries.map((e) => e.id)).toEqual(["acme-tool"]);
    expect(result.entries.some((e) => e.id.startsWith("padded-"))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("size budget"));
    // The trusted cache was not overwritten by the rejected payload.
    expect(await readFile(sourceCachePath("acme"), "utf8")).toBe(cachedBefore);
  });

  it("rejects up front when the declared content-length exceeds the budget", async () => {
    const source = makeSource();
    // A fresh source with no warmed cache: the up-front declared-size rejection
    // degrades all the way to the empty result.
    const client = clientFor(source, {
      fetchImpl: fetchReturning(sampleEntries(), 2048),
      maxCatalogBytes: 1024,
    });
    const result = await client.getCatalog({ forceRefresh: true });
    expect(result.entries).toEqual([]);
    await expect(readFile(sourceCachePath("acme"), "utf8")).rejects.toThrow();
  });
});

describe("createThirdPartyCatalogClient per-source namespacing (CPHMTP-TC-043 / TC-060 / TC-061)", () => {
  it("isolates two sources with colliding plugin ids under their own dirs; refreshing one leaves the other's bytes intact", async () => {
    // Two distinct sources whose catalogs both list a plugin id "ghe" (a
    // deliberate collision). Each must cache under its own sources/<id>/ dir.
    const sourceA = makeSource({ id: "source-a", url: "https://a.example.invalid/catalog.json" });
    const sourceB = makeSource({ id: "source-b", url: "https://b.example.invalid/catalog.json" });
    const entriesA: MarketplaceCatalogEntry[] = [{ ...sampleEntries()[0], id: "ghe", name: "A" }];
    const entriesB: MarketplaceCatalogEntry[] = [{ ...sampleEntries()[0], id: "ghe", name: "B" }];

    await clientFor(sourceA, { fetchImpl: fetchReturning(entriesA) }).getCatalog({
      forceRefresh: true,
    });
    await clientFor(sourceB, { fetchImpl: fetchReturning(entriesB) }).getCatalog({
      forceRefresh: true,
    });

    // Each source wrote ONLY under its own namespace, with its own entry data.
    expect((await readJson(sourceCachePath("source-a"))).entries[0].name).toBe("A");
    expect((await readJson(sourceCachePath("source-b"))).entries[0].name).toBe("B");

    // Capture B's cache bytes, then refresh A with a CHANGED payload.
    const bBytesBefore = await readFile(sourceCachePath("source-b"), "utf8");
    const entriesAChanged: MarketplaceCatalogEntry[] = [
      { ...sampleEntries()[0], id: "ghe", name: "A2", version: "2.0.0" },
    ];
    await clientFor(sourceA, { fetchImpl: fetchReturning(entriesAChanged) }).getCatalog({
      forceRefresh: true,
    });

    // A's cache moved; B's cache bytes are byte-identical (untouched).
    expect((await readJson(sourceCachePath("source-a"))).entries[0].name).toBe("A2");
    expect(await readFile(sourceCachePath("source-b"), "utf8")).toBe(bBytesBefore);
  });

  it("never writes the first-party cache path (CPHMTP-TC-061)", async () => {
    // Seed the first-party cache path with sentinel bytes; third-party caching
    // must leave it byte-identical.
    await mkdir(path.dirname(firstPartyCachePath()), { recursive: true });
    const firstPartySentinel = '{"catalog":"first-party-untouched"}\n';
    await writeFile(firstPartyCachePath(), firstPartySentinel, "utf8");

    const source = makeSource({ id: "third-party" });
    await clientFor(source, { fetchImpl: fetchReturning(sampleEntries()) }).getCatalog({
      forceRefresh: true,
    });

    // The third-party client wrote under its own namespace only.
    await expect(readFile(sourceCachePath("third-party"), "utf8")).resolves.toContain("acme-tool");
    // The first-party cache path is byte-identical.
    expect(await readFile(firstPartyCachePath(), "utf8")).toBe(firstPartySentinel);
  });
});
