import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { fetch as undiciFetch } from "undici";
import type { MarketplaceCatalogEntry } from "@roubo/shared";
import { computePackageDigest } from "./marketplace-integrity.js";
import { resolveWithin } from "../lib/safe-path.js";

// ── ROUBO_E2E fixture packages (HR-TC-012) ──────────────────────────────
//
// The e2e fixture catalog (catalog-client.ts) lists plugins whose digests are
// placeholders, so nothing it lists can be installed. A journey that installs
// or updates a plugin through the marketplace needs a package the installer can
// really fetch, unpack and verify. This module serves such packages, one
// directory per version under e2e/fixtures/catalog-packages/<id>/<version>/, as
// release assets:
//
//   - `catalogPackageEntry` turns a catalog entry into a release-sourced one at
//     a fixture version, with the asset URL below and the package's real
//     content digest, so the installer's integrity check runs for real.
//   - `catalogPackageFetch` is the transport the installer's asset download
//     uses under ROUBO_E2E=1. A URL on the fixture origin answers with a gzip
//     tarball of that package directory; any other URL goes to the network as
//     it would without the harness.
//
// The fixture origin is under `.invalid` (RFC 6761), a name that never resolves,
// so the URL can never reach a real host. The download still runs through
// guardedFetch, the size caps and the tar containment checks: only the
// transport under them is the fixture. None of this is reachable in a
// production build, which never sets ROUBO_E2E.

/** The origin every fixture package URL is on. Never resolves. */
export const E2E_PACKAGE_ORIGIN = "https://packages.roubo-e2e.invalid";

// Resolved from this module (server/services/ in source, server/dist/ once
// built), as marketplace.ts resolves the fixture manifests.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_ROOT = path.join(REPO_ROOT, "e2e", "fixtures", "catalog-packages");

const PACKAGE_ID_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const ASSET_PATH_RE = /^\/([a-z][a-z0-9-]*)\/(\d+\.\d+\.\d+)\.tgz$/;

/** Whether `id` and `version` have the shape of a fixture package. */
export function isCatalogPackageRef(id: unknown, version: unknown): boolean {
  return (
    typeof id === "string" &&
    PACKAGE_ID_RE.test(id) &&
    typeof version === "string" &&
    PACKAGE_VERSION_RE.test(version)
  );
}

/** The directory of one fixture package version, or null when there is none. */
async function packageDir(id: string, version: string): Promise<string | null> {
  if (!isCatalogPackageRef(id, version)) return null;
  let dir: string;
  try {
    dir = resolveWithin(PACKAGES_ROOT, id, version);
  } catch {
    return null;
  }
  try {
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** The release asset URL of one fixture package version. */
export function catalogPackageUrl(id: string, version: string): string {
  return `${E2E_PACKAGE_ORIGIN}/${id}/${version}.tgz`;
}

/**
 * `base` as a release-sourced entry at the fixture `version`, carrying the
 * package's content digest. Null when no fixture package has that version.
 */
export async function catalogPackageEntry(
  base: MarketplaceCatalogEntry,
  version: string,
): Promise<MarketplaceCatalogEntry | null> {
  const dir = await packageDir(base.id, version);
  if (dir === null) return null;
  return {
    ...base,
    version,
    source: { type: "release", assetUrl: catalogPackageUrl(base.id, version) },
    integrity: await computePackageDigest(dir),
  };
}

/**
 * A gzip tarball of the package directory, its files at the archive root as a
 * release asset carries them.
 */
async function packTarball(dir: string): Promise<Buffer> {
  const names = (await readdir(dir)).sort();
  const chunks: Buffer[] = [];
  for await (const chunk of tar.create({ gzip: true, cwd: dir, portable: true }, names)) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * The installer's asset transport under ROUBO_E2E=1: a fixture package URL is
 * answered with its tarball (404 for a version with no package), and any other
 * URL is fetched from the network.
 */
export async function catalogPackageFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(urlOf(input));
  if (url.origin !== E2E_PACKAGE_ORIGIN) {
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      init as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  }
  const match = ASSET_PATH_RE.exec(url.pathname);
  const dir = match ? await packageDir(match[1], match[2]) : null;
  if (dir === null) {
    return new Response("no such fixture package", { status: 404 });
  }
  const body = await packTarball(dir);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { "content-type": "application/gzip", "content-length": String(body.length) },
  });
}
