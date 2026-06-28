import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MarketplaceCatalogEntry,
  SignedKeyRing,
  SignedMarketplaceCatalog,
} from "@roubo/shared";
import { getRouboDir } from "./state.js";
import {
  resolveActiveKey,
  verifyCatalogSignature,
  verifyKeyRing,
} from "./marketplace-integrity.js";
import seedCatalog from "./marketplace-catalog.json";

// Marketplace catalog client (CPHM-FR-001 / FR-009 / NFR-003, issue #306).
//
// Replaces the embedded-JSON catalog with a network-fetched, signature-verified,
// disk-cached one that degrades fail-closed: NETWORK -> CACHE -> SEED so the
// plugin list is never zero, and a new install while the marketplace is
// unreachable is paused with a clear message rather than crashing.
//
// Trust chain (mirrors the producer publish gate in roubo-plugins
// scripts/release/verify-keyring.mjs, fail-closed at every step):
//   1. The fetched key-ring envelope verifies against the embedded bootstrap
//      ROOT public key (marketplace-integrity.verifyKeyRing).
//   2. The catalog's payload.keyId resolves to an `active` ring key
//      (resolveActiveKey): an unknown or revoked key is rejected.
//   3. The catalog signature verifies against that resolved operational key
//      (verifyCatalogSignature with the resolved PEM).
// Only on all three does the envelope become the served catalog and get written
// to the on-disk cache. A network failure, a fetched-but-unverifiable catalog,
// or a tampered cache all degrade to the next source; the bundled seed (the
// committed marketplace-catalog.json, verified against the bundled first-party
// key) is the always-available floor.
//
// node:crypto + Node fetch primitives only; adds no crypto/supply-chain
// dependency (CPHM-NFR-006). The fetch URLs are overridable via env so the
// hosted location can move without an app release.

/** Where the served catalog came from. */
export type CatalogSource = "network" | "cache" | "seed";

/** A verified catalog plus provenance: the entries to list and where they came from. */
export interface VerifiedCatalog {
  entries: MarketplaceCatalogEntry[];
  source: CatalogSource;
  /** ISO timestamp the served envelope was fetched (network/cache); null for the seed. */
  fetchedAt: string | null;
}

/** On-disk cache shape: the last network-verified envelopes plus when they were fetched. */
interface CachedCatalog {
  catalog: SignedMarketplaceCatalog;
  keyRing: SignedKeyRing;
  fetchedAt: string;
}

/**
 * Even the bundled seed catalog failed signature verification: a build defect.
 * The route maps this to the fail-closed catalog-unverified (502) response.
 */
export class CatalogUnverifiedError extends Error {
  readonly code = "catalog-unverified" as const;
  constructor(message = "The plugin catalog could not be verified and was rejected.") {
    super(message);
    this.name = "CatalogUnverifiedError";
  }
}

const DEFAULT_CATALOG_URL = "https://davidpoxon.github.io/roubo-plugins/catalog.json";
const DEFAULT_KEY_RING_URL = "https://davidpoxon.github.io/roubo-plugins/key-ring.json";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_FILENAME = "catalog-cache.json";
// In-memory memo TTL: bound network refreshes (and search-as-you-type filtering)
// to at most one fetch + verify per window, rather than one per listCatalog call.
const MEMO_TTL_MS = 60_000;

export interface CatalogClientOptions {
  catalogUrl?: string;
  keyRingUrl?: string;
  /** Directory the cache file lives in. Defaults to `<rouboDir>/marketplace`. */
  cacheDir?: string;
  /** Bootstrap root key override (tests only); defaults to the embedded key. */
  rootPublicKeyPem?: string;
  /** Bundled seed envelope override (tests only); defaults to the committed catalog. */
  seed?: SignedMarketplaceCatalog;
  /** Fetch implementation (tests inject a fake); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Degrade-event logger; defaults to console.warn. Tests inject a sink. */
  log?: (message: string) => void;
  /**
   * In-memory memo TTL (ms): repeated getVerifiedCatalog() calls without
   * forceRefresh reuse the last resolved result for this long before the degrade
   * chain re-runs. Bounds fetch-on-marketplace-open and search-as-you-type to one
   * refresh per window. Defaults to MEMO_TTL_MS.
   */
  memoTtlMs?: number;
}

export interface CatalogClient {
  /**
   * Resolve the verified catalog via the NETWORK -> CACHE -> SEED degrade chain.
   * `forceRefresh` re-runs the chain (a fresh network fetch); otherwise the last
   * resolved result is reused in-memory for a short TTL (memoTtlMs) before the
   * chain re-runs. Throws `CatalogUnverifiedError` only when even the bundled
   * seed fails verification.
   */
  getVerifiedCatalog(opts?: { forceRefresh?: boolean }): Promise<VerifiedCatalog>;
  /** Launch-time warm fetch: refresh the catalog and warm the cache. Never throws. */
  prefetch(): Promise<void>;
}

export function createCatalogClient(options: CatalogClientOptions = {}): CatalogClient {
  const catalogUrl =
    options.catalogUrl ?? process.env.ROUBO_MARKETPLACE_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const keyRingUrl =
    options.keyRingUrl ?? process.env.ROUBO_MARKETPLACE_KEY_RING_URL ?? DEFAULT_KEY_RING_URL;
  const cacheDir = options.cacheDir ?? path.join(getRouboDir(), "marketplace");
  const cacheFile = path.join(cacheDir, CACHE_FILENAME);
  const rootPublicKeyPem = options.rootPublicKeyPem;
  const seed = options.seed ?? (seedCatalog as SignedMarketplaceCatalog);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? ((message: string) => console.warn(message));
  const memoTtlMs = options.memoTtlMs ?? MEMO_TTL_MS;

  let lastVerified: VerifiedCatalog | null = null;
  let lastVerifiedAt = 0;

  /**
   * The full fail-closed verification of a catalog + key-ring envelope pair:
   * ring-against-root, keyId-resolves-active, catalog-against-operational-key.
   * Returns the entries on success, null on any failure.
   */
  function verifyEnvelopePair(
    catalog: SignedMarketplaceCatalog,
    keyRing: SignedKeyRing,
  ): MarketplaceCatalogEntry[] | null {
    const ring =
      rootPublicKeyPem !== undefined
        ? verifyKeyRing(keyRing, rootPublicKeyPem)
        : verifyKeyRing(keyRing);
    if (!ring) return null;
    const keyId = catalog?.payload?.keyId;
    if (typeof keyId !== "string") return null;
    const operationalKeyPem = resolveActiveKey(ring, keyId);
    if (!operationalKeyPem) return null;
    if (!verifyCatalogSignature(catalog.payload, catalog.signature, operationalKeyPem)) {
      return null;
    }
    const entries = catalog.payload?.entries;
    return Array.isArray(entries) ? entries : null;
  }

  async function fetchEnvelope<T>(url: string): Promise<T | null> {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      // Network error, timeout, or non-JSON body: caught, never surfaced as an
      // unhandled exception (CPHM-TC-044).
      return null;
    }
  }

  async function writeCache(cached: CachedCatalog): Promise<void> {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cacheFile, `${JSON.stringify(cached, null, 2)}\n`, "utf8");
    } catch (err) {
      log(`marketplace: failed to write catalog cache: ${(err as Error).message}`);
    }
  }

  async function tryNetwork(): Promise<VerifiedCatalog | null> {
    const [catalog, keyRing] = await Promise.all([
      fetchEnvelope<SignedMarketplaceCatalog>(catalogUrl),
      fetchEnvelope<SignedKeyRing>(keyRingUrl),
    ]);
    if (!catalog || !keyRing) {
      log("marketplace: catalog fetch failed, falling back to the on-disk cache");
      return null;
    }
    const entries = verifyEnvelopePair(catalog, keyRing);
    if (!entries) {
      // A fetched-but-unverifiable payload is discarded and must NOT overwrite
      // the trusted cache (CPHM-TC-049): we only write below, after success.
      log("marketplace: fetched catalog failed verification, falling back to the on-disk cache");
      return null;
    }
    const fetchedAt = new Date().toISOString();
    await writeCache({ catalog, keyRing, fetchedAt });
    return { entries, source: "network", fetchedAt };
  }

  async function tryCache(): Promise<VerifiedCatalog | null> {
    let raw: string;
    try {
      raw = await readFile(cacheFile, "utf8");
    } catch {
      // No cache on disk: degrade to the seed without logging (expected on a
      // never-fetched install).
      return null;
    }
    let parsed: CachedCatalog;
    try {
      parsed = JSON.parse(raw) as CachedCatalog;
    } catch {
      log("marketplace: catalog cache is unparseable, falling back to the seed");
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || !parsed.catalog || !parsed.keyRing) {
      log("marketplace: catalog cache is incomplete, falling back to the seed");
      return null;
    }
    const entries = verifyEnvelopePair(parsed.catalog, parsed.keyRing);
    if (!entries) {
      // A tampered cache stays fail-closed: it is rejected, not trusted
      // (CPHM-TC-046).
      log("marketplace: cached catalog failed verification, falling back to the seed");
      return null;
    }
    return {
      entries,
      source: "cache",
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
    };
  }

  function trySeed(): VerifiedCatalog {
    // The bundled seed is the always-available floor (CPHM-FR-009). It is the
    // committed, first-party catalog, verified against the bundled key (the
    // default key of verifyCatalogSignature). If even this fails, something is
    // structurally broken: fail closed.
    if (!verifyCatalogSignature(seed.payload, seed.signature)) {
      throw new CatalogUnverifiedError();
    }
    return { entries: seed.payload?.entries ?? [], source: "seed", fetchedAt: null };
  }

  const client: CatalogClient = {
    async getVerifiedCatalog(opts = {}) {
      if (!opts.forceRefresh && lastVerified && Date.now() - lastVerifiedAt < memoTtlMs) {
        return lastVerified;
      }
      const fromNetwork = await tryNetwork();
      if (fromNetwork) {
        lastVerified = fromNetwork;
        lastVerifiedAt = Date.now();
        return fromNetwork;
      }
      const fromCache = await tryCache();
      if (fromCache) {
        lastVerified = fromCache;
        lastVerifiedAt = Date.now();
        return fromCache;
      }
      const fromSeed = trySeed();
      lastVerified = fromSeed;
      lastVerifiedAt = Date.now();
      return fromSeed;
    },
    async prefetch() {
      try {
        await client.getVerifiedCatalog({ forceRefresh: true });
      } catch (err) {
        log(`marketplace: catalog prefetch failed: ${(err as Error).message}`);
      }
    },
  };
  return client;
}

let defaultClient: CatalogClient | null = null;

function getDefaultClient(): CatalogClient {
  // Lazy: defer getRouboDir() + the embedded root key to first use, so importing
  // this module never triggers a fetch or a cache-dir resolution.
  if (!defaultClient) defaultClient = createCatalogClient();
  return defaultClient;
}

export function getVerifiedCatalog(opts?: { forceRefresh?: boolean }): Promise<VerifiedCatalog> {
  return getDefaultClient().getVerifiedCatalog(opts);
}

export function prefetch(): Promise<void> {
  return getDefaultClient().prefetch();
}
