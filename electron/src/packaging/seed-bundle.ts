import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Package-time seed bundle (CPHM-FR-004 / FR-005, issue davidpoxon/roubo-development#309).
//
// The packaged app ships NO plugin source. Instead, at package time, this step
// downloads the pinned first-party seed artifacts (built, signed Release asset
// tarballs) plus the signed catalog snapshot into `electron/resources/seed/`.
// The first-run seed step (issue davidpoxon/roubo-development#10, out of scope
// here) later installs those three tarballs into `~/.roubo/plugins`, re-verifying
// each artifact's sha256 digest fail-closed against the shipped seed-catalog
// snapshot (digest only; it does NOT re-check the catalog's ed25519 signature).
//
// Seeded set: github-com, process, database. ghe and jira-self-hosted are
// deliberately marketplace-only and are NOT seeded.
//
// Verification (NFR-001, fail-closed; NFR-006, no new dependency): each
// downloaded tarball's sha256 is recomputed with node:crypto and matched against
// the catalog entry's asset digest. A mismatch (or a missing/revoked/non-release
// entry, or a version that drifts from the pin) aborts the build with nothing
// written. The signed catalog envelope is persisted verbatim so the seed bundle
// is self-describing, but the first-run seed step verifies ONLY each artifact's
// sha256 digest against this snapshot (fail-closed, offline); it does NOT
// re-verify the catalog's ed25519 signature at seed time. The signed/notarized
// app package is the seed-time signature trust anchor, and the roubo-plugins
// publish gate is the catalog-signature backstop at package time. node:crypto
// only; no third-party crypto or supply-chain dependency.

/** One pinned seed plugin: a stable id at a fixed version (reproducible build). */
export interface SeedPin {
  id: string;
  version: string;
}

/**
 * The pinned seed set. The packaged app seeds exactly these three first-party
 * plugins. ghe and jira-self-hosted are marketplace-only and are deliberately
 * absent. Versions are pinned for a reproducible build and MUST track the hosted
 * `roubo-plugins` catalog: this is a coupled pin, so a published version bump is
 * matched here in the same change (a fetched entry whose version differs fails
 * the build closed).
 */
export const SEED_PLUGIN_PINS: readonly SeedPin[] = [
  { id: "github-com", version: "0.1.0" },
  { id: "process", version: "0.1.0" },
  { id: "database", version: "0.1.0" },
] as const;

/** Hosted signed catalog feed (GitHub Pages). Overridable for tests / embedding. */
const DEFAULT_CATALOG_URL = "https://davidpoxon.github.io/roubo-plugins/catalog.json";

/**
 * Minimal Response shape the seed step consumes. `globalThis.fetch`'s `Response`
 * satisfies it structurally, so the real default needs no adapter; tests inject a
 * fake that returns the catalog JSON and the asset bytes without any network.
 */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Injectable fetcher. Defaults to the real `fetch`; tests pass an offline stub. */
export type FetchLike = (url: string) => Promise<FetchLikeResponse>;

export interface SeedBundleOptions {
  /** The electron package root; the seed cache is written under `<electronRoot>/resources/seed`. */
  electronRoot: string;
  /** Catalog feed URL override (tests / embedding); defaults to the hosted feed. */
  catalogUrl?: string;
  /** Fetcher override (tests inject an offline stub); defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

// Local catalog shapes: only the fields the seed step reads. Declared here rather
// than imported from `@roubo/shared` so the packaging module stays self-contained
// (node builtins only), mirroring the zero-import discipline of the server-side
// marketplace-integrity verifier.
interface CatalogSource {
  type: string;
  assetUrl?: string;
  sha256?: string;
}

interface CatalogEntry {
  id: string;
  version: string;
  source: CatalogSource;
  revoked?: boolean;
}

interface SignedCatalog {
  payload: { entries: CatalogEntry[] };
  signature: string;
}

const defaultFetch: FetchLike = (url) => globalThis.fetch(url);

/**
 * Download and verify the pinned seed artifacts plus the signed catalog snapshot
 * into `<electronRoot>/resources/seed/`. Idempotent: the seed directory is
 * recreated fresh on every run. Fails closed on the first verification failure,
 * leaving no partial bundle that could be packaged.
 */
export async function seedBundle({
  electronRoot,
  catalogUrl = DEFAULT_CATALOG_URL,
  fetchImpl = defaultFetch,
}: SeedBundleOptions): Promise<void> {
  const seedDir = path.join(electronRoot, "resources", "seed");
  // Drop any stale seed cache so a rebuilt package never carries leftover
  // artifacts from a previous (or differently-pinned) run.
  await rm(seedDir, { recursive: true, force: true });
  await mkdir(seedDir, { recursive: true });

  const catalog = await fetchCatalog(fetchImpl, catalogUrl);

  for (const pin of SEED_PLUGIN_PINS) {
    const entry = resolveSeedEntry(catalog, pin);
    const { assetUrl, sha256 } = releaseAsset(entry, pin);
    const bytes = await fetchAsset(fetchImpl, assetUrl, pin);
    verifyAssetDigest(bytes, sha256, pin);
    await writeFile(path.join(seedDir, `${pin.id}-${pin.version}.tgz`), bytes);
  }

  // Ship the signed catalog envelope verbatim so the seed bundle is
  // self-describing. The first-run seed step verifies each artifact's sha256
  // digest fail-closed against this snapshot offline; it does NOT re-verify the
  // catalog's ed25519 signature (the signed/notarized app package is the
  // seed-time signature trust anchor).
  await writeFile(
    path.join(seedDir, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8",
  );
}

async function fetchCatalog(fetchImpl: FetchLike, catalogUrl: string): Promise<SignedCatalog> {
  let res: FetchLikeResponse;
  try {
    res = await fetchImpl(catalogUrl);
  } catch (err) {
    throw new Error(`seed-bundle: could not fetch the catalog: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!res.ok || res.status !== 200) {
    throw new Error(`seed-bundle: catalog fetch failed with HTTP status ${res.status}`);
  }
  const body = (await res.json()) as Partial<SignedCatalog> | null;
  const entries = body?.payload?.entries;
  if (body === null || typeof body !== "object" || !Array.isArray(entries)) {
    throw new Error("seed-bundle: catalog payload is missing its entries array");
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    throw new Error("seed-bundle: catalog is not signed (missing signature)");
  }
  return body as SignedCatalog;
}

function resolveSeedEntry(catalog: SignedCatalog, pin: SeedPin): CatalogEntry {
  const entry = catalog.payload.entries.find((e) => e.id === pin.id);
  if (!entry) {
    throw new Error(`seed-bundle: no catalog entry for seed plugin "${pin.id}"`);
  }
  if (entry.revoked === true) {
    throw new Error(`seed-bundle: seed plugin "${pin.id}" is revoked and cannot be seeded`);
  }
  if (entry.version !== pin.version) {
    throw new Error(
      `seed-bundle: seed plugin "${pin.id}" is pinned to ${pin.version} but the catalog has ${entry.version} (bump the pin and the published version together)`,
    );
  }
  return entry;
}

function releaseAsset(entry: CatalogEntry, pin: SeedPin): { assetUrl: string; sha256: string } {
  if (entry.source.type !== "release") {
    throw new Error(
      `seed-bundle: seed plugin "${pin.id}" must be a built release artifact, not a "${entry.source.type}" source`,
    );
  }
  const { assetUrl, sha256 } = entry.source;
  if (typeof assetUrl !== "string" || assetUrl.length === 0) {
    throw new Error(`seed-bundle: seed plugin "${pin.id}" has no release asset URL`);
  }
  if (typeof sha256 !== "string" || sha256.length === 0) {
    throw new Error(`seed-bundle: seed plugin "${pin.id}" has no asset digest to verify against`);
  }
  return { assetUrl, sha256 };
}

async function fetchAsset(fetchImpl: FetchLike, assetUrl: string, pin: SeedPin): Promise<Buffer> {
  let res: FetchLikeResponse;
  try {
    res = await fetchImpl(assetUrl);
  } catch (err) {
    throw new Error(
      `seed-bundle: could not download the "${pin.id}" asset: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (!res.ok || res.status !== 200) {
    throw new Error(
      `seed-bundle: "${pin.id}" asset download failed with HTTP status ${res.status}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Strip an optional `sha256-` / `sha256:` prefix and lowercase the hex digest. */
function normalizeDigest(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sha256[-:]/, "");
}

function verifyAssetDigest(bytes: Buffer, expected: string, pin: SeedPin): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (normalizeDigest(expected) !== actual) {
    throw new Error(
      `seed-bundle: "${pin.id}" asset failed integrity verification: its sha256 does not match the signed catalog entry`,
    );
  }
}
