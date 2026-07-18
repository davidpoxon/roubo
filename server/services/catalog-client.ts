import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import type {
  KeyRingEntry,
  MarketplaceCatalogEntry,
  MarketplaceCatalogSource,
  MarketplaceSource,
  SignedKeyRing,
  SignedMarketplaceCatalog,
} from "@roubo/shared";
import { getRouboDir } from "./state.js";
import { guardedFetch } from "./guarded-fetch.js";
import {
  canonicalize,
  fingerprintKeyId,
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
// dependency (CPHM-NFR-006). SSRF stance (amended for the third-party-source
// increment, CPHMTP-NFR-005): no silent or env-derived URLs; consented and
// validated sources only. The first-party feed URLs still point at a fixed
// hosted feed and are overridable only via createCatalogClient options (tests /
// embedding), never from the environment, so the classic env-derived
// request-forgery (SSRF) vector stays closed. Every fetch now flows through the
// shared guardedFetch transport (issue #554), which validates the scheme and
// range table on every hop and blocks link-local / loopback / cloud-metadata
// targets before connecting.

/**
 * Where the served catalog came from. A re-export of the shared
 * `MarketplaceCatalogSource` (the single source-of-truth union, surfaced on
 * `MarketplaceCatalogResponse` so the client can render the offline / staleness
 * banner, issue #372); the value behaviour is unchanged.
 */
export type CatalogSource = MarketplaceCatalogSource;

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
// Size budget for a fetched catalog / key-ring payload (CPHM-NFR-002, issue #495).
// The network fetch is bounded to this many bytes, enforced both up front (declared
// content-length) and as bytes flow (mirroring the release-asset limiter in
// plugin-installer.ts). An oversized payload, even a validly signed one, is rejected
// fail-closed so it degrades to cache/seed rather than being buffered and served; it
// never reaches the verify chain, so no partial/unverified entries are listed. The
// same cap covers the far smaller key-ring fetch (a safe superset). The seed is
// verified locally, so this cap applies to the network path only.
const MAX_CATALOG_BYTES = 256 * 1024;
const CACHE_FILENAME = "catalog-cache.json";
// In-memory memo TTL: bound network refreshes (and search-as-you-type filtering)
// to at most one fetch + verify per window, rather than one per listCatalog call.
const MEMO_TTL_MS = 60_000;

export interface CatalogClientOptions {
  /** Catalog feed URL override (tests / embedding); defaults to the hosted feed. Not env-overridable. */
  catalogUrl?: string;
  /** Key-ring feed URL override (tests / embedding); defaults to the hosted feed. Not env-overridable. */
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
  /**
   * Network fetch size budget (bytes) for the catalog / key-ring payload
   * (CPHM-NFR-002). A fetched payload exceeding this is rejected fail-closed and
   * degrades to cache/seed. Tests inject a small value to exercise the guard.
   * Defaults to MAX_CATALOG_BYTES.
   */
  maxCatalogBytes?: number;
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

/**
 * Guarded, size-capped JSON fetch shared by the first-party envelope fetch
 * (fetchEnvelope, inside createCatalogClient) and the third-party per-source
 * fetch (createThirdPartyCatalogClient). Routes through the shared guardedFetch
 * transport (issue #554: SSRF / redirect guarding and per-hop range validation),
 * then bounds the payload to `maxBytes` the same two ways as the release-asset
 * limiter in plugin-installer.ts: reject a declared content-length over the cap
 * up front, and count bytes as they stream and stop the moment the cap is
 * exceeded. Any breach, network error, timeout, non-JSON body, or over-budget
 * stream abort returns null so the caller degrades rather than serving it.
 *
 * The caller owns what the parsed JSON means: a signed catalog / key-ring
 * envelope on the first-party path (which then runs the verify chain), a plain
 * per-source catalog on the third-party path (which has no verify chain by
 * construction). This helper only fetches, size-caps, and parses; it never
 * verifies. Extracting it changes neither the first-party guardedFetch options
 * (credential and allowHttp are left undefined, so it stays https-only with no
 * Authorization header) nor the byte-cap behaviour or degrade log lines.
 */
async function fetchGuardedJson<T>(
  url: string,
  opts: {
    fetchImpl: typeof fetch;
    maxBytes: number;
    log: (message: string) => void;
    credential?: string;
    allowHttp?: boolean;
  },
): Promise<T | null> {
  const { fetchImpl, maxBytes, log } = opts;
  try {
    const res = await guardedFetch(url, {
      sourceOrigin: new URL(url).origin,
      credential: opts.credential,
      allowHttp: opts.allowHttp,
      fetchImpl,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    // Reject a declared content-length over the cap up front; a server may lie
    // about or omit it, so also count bytes as they flow below.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      log(
        `marketplace: fetched payload from ${url} declares ${declared} bytes, over the ` +
          `${maxBytes}-byte size budget; rejecting and degrading`,
      );
      return null;
    }
    let text: string;
    if (res.body) {
      // undici's body is a WHATWG ReadableStream; a Node Readable (a test double)
      // exposes `.pipe`. Normalise to a Node stream either way (mirroring
      // plugin-installer.ts downloadAssetToFile), then count bytes as they arrive.
      const body = res.body as unknown;
      const source =
        typeof (body as { pipe?: unknown }).pipe === "function"
          ? (body as Readable)
          : Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of source as AsyncIterable<Buffer>) {
        received += chunk.length;
        if (received > maxBytes) {
          // Returning here ends the async iteration, which destroys the stream and
          // stops further reads. Fail closed: degrade rather than buffer the rest.
          log(
            `marketplace: fetched payload from ${url} exceeds the ` +
              `${maxBytes}-byte size budget; rejecting and degrading`,
          );
          return null;
        }
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } else {
      // Defensive fallback for a body-less response (a mock exposing neither
      // .body nor a streamable body): buffer via text() and enforce the cap
      // post-hoc so the budget still holds.
      text = await res.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        log(
          `marketplace: fetched payload from ${url} exceeds the ` +
            `${maxBytes}-byte size budget; rejecting and degrading`,
        );
        return null;
      }
    }
    return JSON.parse(text) as T;
  } catch {
    // Network error, timeout, non-JSON body, or an over-budget stream abort:
    // caught, never surfaced as an unhandled exception (CPHM-TC-044).
    return null;
  }
}

export function createCatalogClient(options: CatalogClientOptions = {}): CatalogClient {
  // SSRF stance (amended, CPHMTP-NFR-005): no silent or env-derived URLs;
  // consented and validated sources only. The fetch target is a fixed hosted
  // feed, overridable only via options (tests / embedding), never from the
  // environment, and every request runs through guardedFetch below so the scheme
  // and blocked-range table are enforced on the initial hop and each redirect.
  const catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;
  const keyRingUrl = options.keyRingUrl ?? DEFAULT_KEY_RING_URL;
  const cacheDir = options.cacheDir ?? path.join(getRouboDir(), "marketplace");
  const cacheFile = path.join(cacheDir, CACHE_FILENAME);
  const rootPublicKeyPem = options.rootPublicKeyPem;
  const seed = options.seed ?? (seedCatalog as SignedMarketplaceCatalog);
  // Default to npm undici's fetch (not Node's built-in global fetch) so the
  // guarded transport's connect-pinning dispatcher (issue #590), built from the
  // same undici, is protocol-compatible on this catalog path.
  const doFetch = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const log = options.log ?? ((message: string) => console.warn(message));
  const memoTtlMs = options.memoTtlMs ?? MEMO_TTL_MS;
  const maxCatalogBytes = options.maxCatalogBytes ?? MAX_CATALOG_BYTES;

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
    // Route through the shared guarded transport (issue #554) and the shared
    // size-capped JSON fetch. The first-party feed origin is the consented source
    // origin; this path attaches no credential and requires https (credential and
    // allowHttp are left unset), so the classic SSRF vector stays closed. doFetch
    // is the injected transport so the test / e2e seam is unchanged. A null return
    // flows through tryNetwork -> tryCache -> trySeed, so an oversized or
    // unreachable catalog is never verified or served.
    return fetchGuardedJson<T>(url, { fetchImpl: doFetch, maxBytes: maxCatalogBytes, log });
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

// ── Third-party (unsigned) source catalog client ─────────────────────────────
//
// createThirdPartyCatalogClient is a SEPARATE top-level factory, wholly distinct
// from createCatalogClient. The trust separation holds BY CONSTRUCTION, not by a
// runtime flag (CPHMTP-NFR-001, issue #555): the first-party signed verify chain
// (verifyEnvelopePair) is a closure INSIDE createCatalogClient, so a sibling
// top-level factory cannot reach it. There is no verifier / key-ring parameter,
// no signature step, and no seed floor here. The degrade chain is
// NETWORK -> CACHE only:
//   * network: guardedFetch the registered source URL, size-cap it, serve the
//     plain (unsigned) entries and warm a per-source cache;
//   * cache: on any network failure, serve this source's OWN per-source cache;
//   * total failure (no network payload, no usable cache): an empty per-source
//     result (never a first-party seed), with the degrade logged (CPHMTP-NFR-007).
// getCatalog never throws. Nothing here sets `verified`: only the first-party
// path can, and third-party entries pass through exactly as fetched.

/** A third-party per-source catalog result: the entries and where they came from. */
export interface ThirdPartyCatalogResult {
  entries: MarketplaceCatalogEntry[];
  /** Where the served entries came from. No `seed`: third-party sources have no seed floor. */
  source: "network" | "cache";
  /** ISO timestamp the served entries were fetched; null when served from an empty degrade. */
  fetchedAt: string | null;
}

/**
 * Per-source on-disk cache shape: the last network entries plus when they were
 * fetched. A plain, UNVERIFIED object: no signature envelope and no key ring
 * (unlike the first-party CachedCatalog), because third-party sources are
 * unsigned by construction (CPHMTP-NFR-001).
 */
interface ThirdPartyCache {
  entries: MarketplaceCatalogEntry[];
  fetchedAt: string;
}

export interface ThirdPartyCatalogClientOptions {
  /**
   * Directory the per-source cache file lives in. Defaults to
   * `<rouboDir>/marketplace/sources/<source.id>`, so each source is namespaced
   * under its own id and never collides with another source or the first-party
   * cache/seed (CPHMTP-TC-043 / TC-060 / TC-061).
   */
  cacheDir?: string;
  /**
   * The per-source credential, passed straight through to guardedFetch (attached
   * only as an Authorization header, and only on the source origin). A thin
   * pass-through: the credential-store lookup is a separate slice. Omitted means
   * no credential.
   */
  credential?: string;
  /** Fetch implementation (tests inject a fake); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Degrade-event logger; defaults to console.warn. Tests inject a sink. */
  log?: (message: string) => void;
  /**
   * Network fetch size budget (bytes). A fetched payload exceeding this is
   * rejected fail-closed and degrades to cache (CPHMTP-TC-040). Tests inject a
   * small value to exercise the guard. Defaults to MAX_CATALOG_BYTES.
   */
  maxCatalogBytes?: number;
  /**
   * In-memory memo TTL (ms): repeated getCatalog() calls without forceRefresh
   * reuse the last resolved result for this long before the degrade chain
   * re-runs. Defaults to MEMO_TTL_MS.
   */
  memoTtlMs?: number;
}

export interface ThirdPartyCatalogClient {
  /**
   * Resolve this source's catalog via the NETWORK -> CACHE degrade chain.
   * `forceRefresh` re-runs the chain (a fresh network fetch); otherwise the last
   * resolved result is reused in-memory for a short TTL. Never throws: a total
   * failure resolves to an empty per-source result.
   */
  getCatalog(opts?: { forceRefresh?: boolean }): Promise<ThirdPartyCatalogResult>;
}

export function createThirdPartyCatalogClient(
  source: MarketplaceSource,
  options: ThirdPartyCatalogClientOptions = {},
): ThirdPartyCatalogClient {
  const cacheDir =
    options.cacheDir ?? path.join(getRouboDir(), "marketplace", "sources", source.id);
  const cacheFile = path.join(cacheDir, CACHE_FILENAME);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? ((message: string) => console.warn(message));
  const maxCatalogBytes = options.maxCatalogBytes ?? MAX_CATALOG_BYTES;
  const memoTtlMs = options.memoTtlMs ?? MEMO_TTL_MS;
  const credential = options.credential;

  let lastResult: ThirdPartyCatalogResult | null = null;
  let lastResultAt = 0;

  async function writeCache(cache: ThirdPartyCache): Promise<void> {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch (err) {
      log(
        `marketplace: failed to write source ${source.id} catalog cache: ${(err as Error).message}`,
      );
    }
  }

  async function tryNetwork(): Promise<ThirdPartyCatalogResult | null> {
    // Every hop runs through guardedFetch with THIS source's origin and its
    // registration opt-ins: the credential is attached only on the source origin,
    // and a plain-http source is fetchable only when it consented to allowHttp.
    const payload = await fetchGuardedJson<{ entries?: unknown }>(source.url, {
      fetchImpl: doFetch,
      maxBytes: maxCatalogBytes,
      log,
      credential,
      allowHttp: source.allowHttp,
    });
    if (!payload) {
      log(`marketplace: source ${source.id} fetch failed, falling back to the per-source cache`);
      return null;
    }
    const entries = payload.entries;
    if (!Array.isArray(entries)) {
      // A reachable-but-malformed catalog is discarded and must NOT overwrite the
      // per-source cache: only writeCache below, after a shape-valid fetch.
      log(
        `marketplace: source ${source.id} catalog is malformed, falling back to the per-source cache`,
      );
      return null;
    }
    const typed = entries as MarketplaceCatalogEntry[];
    const fetchedAt = new Date().toISOString();
    await writeCache({ entries: typed, fetchedAt });
    return { entries: typed, source: "network", fetchedAt };
  }

  async function tryCache(): Promise<ThirdPartyCatalogResult | null> {
    let raw: string;
    try {
      raw = await readFile(cacheFile, "utf8");
    } catch {
      // No per-source cache on disk (a never-fetched source): degrade silently.
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log(`marketplace: source ${source.id} cache is unparseable, serving an empty listing`);
      return null;
    }
    // Fail-closed shape guard: a garbage / tampered / wrong-shape cache must
    // degrade to an empty result, never throw and never leak a partial listing
    // (CPHMTP-TC-057 fail-closed). There is no signature to check (third-party
    // caches are unsigned), so the guard is a structural shape check.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      log(`marketplace: source ${source.id} cache is malformed, serving an empty listing`);
      return null;
    }
    const cache = parsed as ThirdPartyCache;
    return {
      entries: cache.entries,
      source: "cache",
      fetchedAt: typeof cache.fetchedAt === "string" ? cache.fetchedAt : null,
    };
  }

  return {
    async getCatalog(opts = {}) {
      if (!opts.forceRefresh && lastResult && Date.now() - lastResultAt < memoTtlMs) {
        return lastResult;
      }
      const fromNetwork = await tryNetwork();
      if (fromNetwork) {
        lastResult = fromNetwork;
        lastResultAt = Date.now();
        return fromNetwork;
      }
      const fromCache = await tryCache();
      if (fromCache) {
        lastResult = fromCache;
        lastResultAt = Date.now();
        return fromCache;
      }
      // Total failure: no network payload and no usable per-source cache. Serve an
      // empty per-source listing (never a first-party seed) with the degrade
      // logged (CPHMTP-NFR-007); getCatalog never throws.
      log(
        `marketplace: source ${source.id} has no reachable catalog and no usable cache; ` +
          `serving an empty listing`,
      );
      const empty: ThirdPartyCatalogResult = { entries: [], source: "cache", fetchedAt: null };
      lastResult = empty;
      lastResultAt = Date.now();
      return empty;
    },
  };
}

let defaultClient: CatalogClient | null = null;

function getDefaultClient(): CatalogClient {
  // Lazy: defer getRouboDir() + the embedded root key to first use, so importing
  // this module never triggers a fetch or a cache-dir resolution.
  if (!defaultClient) {
    // Under the e2e harness (ROUBO_E2E=1), build the default client over the
    // runtime-togglable offline-journey seam below (injected fetch + a generated
    // test root key), so the marketplace-offline-journey spec can flip the
    // served `source` between network and cache/seed without real network. A
    // production build never takes this branch.
    defaultClient =
      process.env.ROUBO_E2E === "1"
        ? createCatalogClient({
            fetchImpl: e2eFetch as typeof fetch,
            rootPublicKeyPem: getE2ESeam().rootPublicKeyPem,
            // The injected fetch always serves the same re-signed seed envelopes,
            // so degrade-to-cache/seed logging during the offline leg would be
            // pure noise in the e2e server output; silence it under the gate.
            log: () => {},
          })
        : createCatalogClient();
  }
  return defaultClient;
}

export function getVerifiedCatalog(opts?: { forceRefresh?: boolean }): Promise<VerifiedCatalog> {
  return getDefaultClient().getVerifiedCatalog(opts);
}

export function prefetch(): Promise<void> {
  return getDefaultClient().prefetch();
}

// ── ROUBO_E2E offline-journey seam (issue #314, CPHM-TC-051) ──────────────────
//
// The marketplace-offline-journey e2e
// (e2e/e2e-flow/marketplace-offline-journey.spec.ts) walks the degrade journey
// end to end: go offline -> the seeded + already-fetched catalog still serve, a
// new install is paused with the clear `marketplace-unreachable` message,
// reconnect -> installs resume. To flip the catalog client between "reachable"
// (network source) and "unreachable" (degrade to cache/seed) at runtime WITHOUT
// real network, the default client (only when ROUBO_E2E=1) is built over an
// injected fetch backed by a generated test keypair: a re-signed copy of the
// bundled seed entries plus a matching key-ring, verifiable against a generated
// test ROOT key. Toggling `reachable` makes that injected fetch succeed or fail;
// __setE2EMarketplaceReachable busts the in-memory memo so the served `source`
// flips on the next read. This mirrors the dependency-injection fixture in
// catalog-client.test.ts; none of it is reachable in a production build.

interface E2EReachabilitySeam {
  /** When false, the injected fetch rejects, so the degrade chain falls to cache/seed. */
  reachable: boolean;
  /** Generated test ROOT public key the injected key-ring verifies against. */
  rootPublicKeyPem: string;
  /** Pre-signed catalog envelope body the injected fetch serves when reachable. */
  catalogBody: string;
  /** Pre-signed key-ring envelope body the injected fetch serves when reachable. */
  keyRingBody: string;
}

let e2eSeam: E2EReachabilitySeam | null = null;

function spkiPem(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function buildE2ESeam(): E2EReachabilitySeam {
  // A generated root + operational keypair (never the embedded bootstrap root,
  // whose private half is held out of band). The key-ring is signed by root; the
  // catalog is signed by the operational key whose fingerprint the catalog names.
  const root = generateKeyPairSync("ed25519");
  const op = generateKeyPairSync("ed25519");
  const keyId = fingerprintKeyId(op.publicKey);
  const generatedAt = new Date().toISOString();

  const ringEntries: KeyRingEntry[] = [
    { keyId, publicKeyPem: spkiPem(op.publicKey), status: "active" },
  ];
  const keyRingPayload = { keys: ringEntries, generatedAt };
  const keyRing: SignedKeyRing = {
    payload: keyRingPayload,
    signature: sign(
      null,
      Buffer.from(canonicalize(keyRingPayload), "utf8"),
      root.privateKey,
    ).toString("base64"),
  };

  // Re-sign the SAME bundled seed entries with the generated operational key, so
  // the reachable (network) listing matches the offline (seed/cache) listing
  // exactly: the journey degrades to the last-known catalog, never a different one.
  const entries = (seedCatalog as SignedMarketplaceCatalog).payload?.entries ?? [];
  const catalogPayload = { schemaVersion: 1, generatedAt, keyId, entries };
  const catalog: SignedMarketplaceCatalog = {
    payload: catalogPayload,
    signature: sign(
      null,
      Buffer.from(canonicalize(catalogPayload), "utf8"),
      op.privateKey,
    ).toString("base64"),
  };

  return {
    reachable: true,
    rootPublicKeyPem: spkiPem(root.publicKey),
    catalogBody: JSON.stringify(catalog),
    keyRingBody: JSON.stringify(keyRing),
  };
}

function getE2ESeam(): E2EReachabilitySeam {
  if (!e2eSeam) e2eSeam = buildE2ESeam();
  return e2eSeam;
}

/** Injected fetch for the e2e default client: serves the re-signed envelopes when
 * reachable, rejects (simulating an unreachable marketplace) when not. */
function e2eFetch(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const seam = getE2ESeam();
  if (!seam.reachable) {
    // fetchEnvelope() catches this and returns null, so tryNetwork() degrades to
    // the on-disk cache and then the bundled seed.
    return Promise.reject(new Error("e2e: marketplace unreachable"));
  }
  const url = typeof input === "string" ? input : input.toString();
  const body = url.includes("key-ring") ? seam.keyRingBody : seam.catalogBody;
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  );
}

/**
 * ROUBO_E2E-only: flip the default catalog client between reachable (network
 * source) and unreachable (degrade to cache/seed), then re-run the degrade chain
 * so the served `source` flips on the next read rather than after the memo TTL
 * (CPHM-TC-051). Returns the resolved source so the harness route can surface it.
 * A no-op outside the e2e gate (returns null). `POST /test/__set-marketplace-reachable`
 * drives this, and `/test/__reset` restores `true` so the toggle never leaks
 * into a later spec (NFR-018).
 */
export async function __setE2EMarketplaceReachable(
  reachable: boolean,
): Promise<CatalogSource | null> {
  if (process.env.ROUBO_E2E !== "1") return null;
  getE2ESeam().reachable = reachable;
  const resolved = await getDefaultClient().getVerifiedCatalog({ forceRefresh: true });
  return resolved.source;
}

// ── ROUBO_E2E third-party-source seam (issue #575, CPHMTP-TC-073) ──────────────
//
// The declared-source-consent-install-journey e2e
// (e2e/e2e-flow/declared-source-consent-install-journey.spec.ts) walks the
// fresh-clone journey where a project declares an unregistered ACME marketplace,
// the user consents/registers it, and a bench-start then resolves a component's
// binding to a plugin served ONLY by that ACME source. Registering the source is
// a pure write (CPHMTP-NFR-003), so nothing is fetched from the declared URL; the
// declared URL (ghe.acme.internal) is unreachable under the harness, so a live
// fetch would only degrade to this source's per-source CACHE.
//
// This seam seeds that per-source cache deterministically, so a registered ACME
// source resolves a catalog serving the declared plugin with NO real network:
// the third-party client's NETWORK -> CACHE degrade chain (createThirdPartyCatalogClient
// above) bottoms out at the file this writes, keyed to the same cache dir + filename
// + JSON shape the client reads. It mirrors the offline-journey `e2eFetch` seam in
// spirit (deterministic, no real network, ROUBO_E2E-only) but for the unsigned
// third-party path, which has no signature chain and degrades to cache rather than
// a seed floor. A no-op outside the e2e gate (returns null); none of this is
// reachable in a production build. Returns the written cache file path.
export async function seedThirdPartyCacheForE2E(
  sourceId: string,
  entries: MarketplaceCatalogEntry[],
  fetchedAt: string = new Date().toISOString(),
): Promise<string | null> {
  if (process.env.ROUBO_E2E !== "1") return null;
  const sourcesRoot = path.join(getRouboDir(), "marketplace", "sources");
  const cacheDir = path.join(sourcesRoot, sourceId);
  // Reject a sourceId whose joined path escapes the per-source cache root (path
  // traversal; CodeQL js/path-injection). Real generated source ids are flat
  // `[a-z0-9-]` slugs (marketplace-sources-schema.ts), so a well-formed caller
  // never trips this; a malformed one is rejected fail-closed before any write.
  if (!cacheDir.startsWith(sourcesRoot + path.sep)) return null;
  const cacheFile = path.join(cacheDir, CACHE_FILENAME);
  const cache: ThirdPartyCache = { entries, fetchedAt };
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cacheFile;
}
