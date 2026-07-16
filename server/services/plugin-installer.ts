import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import semver from "semver";
import { fetch } from "undici";
import * as tar from "tar";
import {
  parseManifest,
  type InstallErrorCode,
  type InstallPreview,
  type InstallSource,
  type PluginManifest,
  type PluginProvenanceRecord,
  type PluginRecord,
} from "@roubo/shared";
import { runCommand } from "./exec.js";
import * as pluginManager from "./plugin-manager.js";
import * as pluginProvenanceState from "./plugin-provenance-state.js";
import { guardedFetch } from "./guarded-fetch.js";
import { verifyPackageIntegrity } from "./marketplace-integrity.js";
import { PLUGIN_ID_RE, UUID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

const STAGING_DIR_NAME = ".staging";
const STAGING_TOKEN_RE = UUID_RE;

const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

// Built-artifact install limits (issue #370). A Release asset tarball is
// untrusted input, so the download and unpack steps are bounded to fail closed
// on a runaway asset or a tar bomb. NFR-002 (p95 < 10s @ 10 Mbps) implies real
// artifacts are a few MB; these caps are conservative headroom, not tight
// budgets. They are `let` (not `const`) only so tests can shrink them via
// `__test.setLimits`; the production install path never mutates them.
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB on the wire
const DEFAULT_MAX_UNPACKED_BYTES = 100 * 1024 * 1024; // 100 MB unpacked
const DEFAULT_MAX_TARBALL_ENTRIES = 10_000;

let maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES;
let maxUnpackedBytes = DEFAULT_MAX_UNPACKED_BYTES;
let maxTarballEntries = DEFAULT_MAX_TARBALL_ENTRIES;

/**
 * The marketplace source an install was resolved from, carried from the preview
 * through to the commit so the install record can remember the consumer's explicit
 * pick-a-source choice (CPHMTP-FR-005 AC4 / CPHMTP-FR-006, issue #558).
 *
 * Recorded only at COMMIT: a staged install the consumer never confirmed must
 * leave no provenance behind, exactly as it leaves no plugin behind. Optional on
 * every entry point, so the raw git / local-directory install paths (which have no
 * marketplace source) stay behaviourally unchanged and write nothing.
 */
export interface InstallProvenance {
  /** The chosen source's id (`first-party`, or a registered source's slug). */
  sourceId: string;
  /** The chosen source's catalog URL. */
  sourceUrl: string;
  /** True when the chosen source is unsigned, i.e. any third-party source. */
  unverified: boolean;
}

interface StagedInstall {
  stagingDir: string;
  source: InstallSource;
  manifest: PluginManifest;
  createdAt: number;
  // When set, `commit` replaces the already-installed plugin with this id
  // (the marketplace update flow) rather than rejecting it as a duplicate.
  // The id must equal `manifest.id`; the installer uninstalls the existing
  // copy before moving the staged copy into place.
  replaceId?: string;
  // The marketplace source this install was resolved from, recorded to the
  // provenance ledger at commit (issue #558). Absent for non-marketplace installs.
  provenance?: InstallProvenance;
}

const staged = new Map<string, StagedInstall>();

export class InstallError extends Error {
  readonly code: InstallErrorCode;
  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "InstallError";
  }
}

export function isValidStagingToken(token: string): boolean {
  return STAGING_TOKEN_RE.test(token);
}

function stagingRoot(): string {
  return resolveWithin(pluginManager.getUserPluginsRoot(), STAGING_DIR_NAME);
}

async function ensureStagingRoot(): Promise<string> {
  const root = stagingRoot();
  await mkdir(root, { recursive: true });
  return root;
}

async function rmStaging(stagingDir: string): Promise<void> {
  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

async function readStagingManifest(stagingDir: string): Promise<PluginManifest> {
  for (const filename of ["roubo-plugin.yaml", "roubo-plugin.yml"]) {
    const candidate = resolveWithin(stagingDir, filename);
    try {
      const text = await readFile(candidate, "utf8");
      const parsed = parseManifest(text, candidate);
      if (!parsed.ok) {
        throw new InstallError("invalid-manifest", parsed.error.message);
      }
      return parsed.manifest;
    } catch (err) {
      if (err instanceof InstallError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw err;
    }
  }
  throw new InstallError("missing-manifest", `No roubo-plugin.yaml found in ${stagingDir}`);
}

function assertCompatible(manifest: PluginManifest): void {
  if (!semver.validRange(manifest.roubo)) {
    throw new InstallError(
      "incompatible-host",
      `Manifest "roubo" field is not a valid semver range: ${manifest.roubo}`,
    );
  }
  if (
    !semver.satisfies(pluginManager.HOST_API_VERSION, manifest.roubo, {
      includePrerelease: false,
    })
  ) {
    throw new InstallError(
      "incompatible-host",
      `Plugin requires roubo "${manifest.roubo}" but host is ${pluginManager.HOST_API_VERSION}`,
    );
  }
}

/**
 * Identifies an install as coming from a REGISTERED THIRD-PARTY (unsigned)
 * marketplace source (CPHMTP-NFR-004, issue #559). Its presence is what makes the
 * per-artifact digest mandatory and scopes the artifact download to the source's
 * consented origin. It is deliberately optional on every preview entry point: the
 * first-party catalog and the raw git / local-directory paths pass no context and
 * are behaviourally unchanged.
 *
 * There is no production third-party install caller yet: the merged multi-source
 * listing that routes a third-party entry into install is issue #557. This is the
 * enforcement seam #557 adopts, kept minimal and additive so it needs no rework.
 */
export interface ThirdPartyInstallContext {
  /**
   * The registered source's consented origin ("scheme://host[:port]"), passed
   * straight to guardedFetch as the one allowed hop-0 origin and the only origin
   * the credential is ever attached to. Unused on the git path (a clone runs
   * through git's own transport, not guardedFetch), where the context serves only
   * to make the digest mandatory.
   */
  sourceOrigin: string;
  /** The source's keyring credential, if any. Attached per guardedFetch's origin rule. */
  credential?: string;
  /** The source's registration-time "allow http (intranet)" opt-in. Defaults to false. */
  allowHttp?: boolean;
}

// The exact shape computePackageDigest emits ("sha256-" + 64 lowercase hex).
const PACKAGE_DIGEST_RE = /^sha256-[0-9a-f]{64}$/;

/**
 * Whether `expected` is a digest this installer can actually verify against.
 * Absent, empty, and malformed values are all equally unusable (CPHMTP-NFR-004):
 * treating a malformed value as "present" would let it reach a comparison that
 * merely fails as a mismatch, muddling "the entry is unverifiable" with "the
 * artifact is tampered". Only the exact `computePackageDigest` shape passes.
 */
function hasUsableDigest(expected: string | null | undefined): boolean {
  return typeof expected === "string" && PACKAGE_DIGEST_RE.test(expected);
}

/**
 * Fail closed when a third-party (unsigned) install carries no usable digest
 * (CPHMTP-NFR-004, issue #559). An unsigned source has no signature chain, so the
 * per-artifact digest is the only integrity anchor; without one the entry is
 * simply uninstallable. Called BEFORE the artifact is fetched (and re-asserted at
 * verification time), so a missing, empty, or malformed digest is rejected with
 * nothing downloaded. A no-op for first-party / raw installs, which pass no
 * context.
 */
function assertThirdPartyDigestPresent(
  expected: string | null | undefined,
  thirdParty: ThirdPartyInstallContext | undefined,
): void {
  if (thirdParty === undefined) return;
  if (hasUsableDigest(expected)) return;
  throw new InstallError(
    "missing-integrity",
    "This plugin is uninstallable without a per-artifact digest: its unsigned source's catalog entry carries no usable sha256 integrity value. Nothing was fetched.",
  );
}

/**
 * Verify the staged package's content digest against the expected digest from
 * the catalog entry (CP-FR-021, issue #622). Called after the manifest is read
 * and compatibility is asserted, but before the staging entry is recorded, so a
 * mismatch throws `integrity-failed` and the caller's catch removes the staging
 * directory (no partial files, no plugin record; the existing version, if any, is
 * left untouched).
 *
 * A null/undefined `expected` skips the check ONLY for the non-catalog install
 * paths (raw git URL, local directory), which carry no catalog digest. On a
 * third-party install the skip is unreachable: the mandatory-digest rule is
 * re-asserted here rather than trusted from the distant pre-fetch guard, so the
 * recompute cannot be bypassed no matter how this is called (issue #559).
 */
async function assertPackageIntegrity(
  stagingDir: string,
  expected: string | null | undefined,
  thirdParty?: ThirdPartyInstallContext,
): Promise<void> {
  if (thirdParty !== undefined) {
    assertThirdPartyDigestPresent(expected, thirdParty);
  } else if (expected === null || expected === undefined) {
    return;
  }
  const ok = await verifyPackageIntegrity(stagingDir, expected);
  if (!ok) {
    throw new InstallError(
      "integrity-failed",
      "Plugin package failed integrity verification: its content digest does not match the digest published for this artifact.",
    );
  }
}

function assertNotDuplicate(manifestId: string): void {
  const existing = pluginManager.listInstalled().find((r) => r.id === manifestId);
  if (existing) {
    throw new InstallError("duplicate-id", `A plugin with id "${manifestId}" is already installed`);
  }
}

function tailLines(text: string, max = 2): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-max)
    .join(" ")
    .slice(0, 500);
}

function gitCloneError(code: number, stderr: string): InstallError {
  const tail = tailLines(stderr);
  const detail = tail.length > 0 ? `: ${tail}` : "";
  return new InstallError(
    "clone-failed",
    `Could not clone repository. git exited with code ${code}${detail}`,
  );
}

function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateGitUrl(url: string): string {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new InstallError("invalid-input", "Git URL is required");
  }
  const trimmed = url.trim();
  // Reject anything that could be parsed as a git CLI option. Without this
  // an attacker could pass e.g. `--upload-pack=...` and trigger second-order
  // command execution. We also reject control chars defensively.
  if (trimmed.startsWith("-")) {
    throw new InstallError("invalid-input", "Git URL must not start with '-'");
  }
  if (containsControlChar(trimmed)) {
    throw new InstallError("invalid-input", "Git URL contains control characters");
  }
  // Conservative allowlist: https, http, ssh, or scp-style git@host:path.
  // We deliberately reject things git itself accepts (file://, /abs/path) so
  // the local-directory tab is the only path for filesystem sources.
  const isUrl = /^(https?|ssh|git):\/\//i.test(trimmed);
  const isScp = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/.test(trimmed);
  if (!isUrl && !isScp) {
    throw new InstallError(
      "invalid-input",
      "Git URL must be an http(s), ssh, or git@host:path URL",
    );
  }
  return trimmed;
}

// Validate the Release asset URL before it reaches `fetch`. Only http(s) is
// allowed (the built-artifact install fetches over HTTP, no file:// or other
// schemes), control characters are rejected, and the value must parse as a URL.
function validateAssetUrl(url: string): string {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new InstallError("invalid-input", "Release asset URL is required");
  }
  const trimmed = url.trim();
  if (containsControlChar(trimmed)) {
    throw new InstallError("invalid-input", "Release asset URL contains control characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InstallError("invalid-input", "Release asset URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InstallError("invalid-input", "Release asset URL must be an http(s) URL");
  }
  return trimmed;
}

function validateLocalPath(absPath: string): string {
  if (typeof absPath !== "string" || absPath.trim().length === 0) {
    throw new InstallError("invalid-input", "Local path is required");
  }
  const trimmed = absPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new InstallError("invalid-input", "Local path must be absolute");
  }
  // Normalize to collapse `..` segments, then re-verify it's still absolute.
  // This both canonicalizes the path for subsequent fs calls and ensures the
  // sanitized value is what flows through every downstream filesystem call.
  const normalized = path.resolve(trimmed);
  if (!path.isAbsolute(normalized)) {
    throw new InstallError("invalid-input", "Local path must be absolute");
  }
  if (containsControlChar(normalized)) {
    throw new InstallError("invalid-input", "Local path contains control characters");
  }
  return normalized;
}

// A catalog entry's optional `directory` points at the subdirectory of the
// cloned repository that holds the plugin package (the monorepo-subdir source
// model, issue #750). It must be a relative path with no traversal; the final
// containment is enforced by resolveWithin when it is joined onto the clone dir.
function validateSubdir(directory: string): string {
  const trimmed = directory.trim();
  if (trimmed.length === 0) {
    throw new InstallError("invalid-input", "Source directory must not be empty");
  }
  if (path.isAbsolute(trimmed)) {
    throw new InstallError("invalid-input", "Source directory must be a relative path");
  }
  if (containsControlChar(trimmed)) {
    throw new InstallError("invalid-input", "Source directory contains control characters");
  }
  // Reject traversal up front (resolveWithin is the second barrier) so a `..`
  // segment surfaces as a clear invalid-input rather than a wrapped clone error.
  if (trimmed.split(/[\\/]/).includes("..")) {
    throw new InstallError("invalid-input", "Source directory must not contain '..' segments");
  }
  return trimmed;
}

async function runGitClone(safeUrl: string, destDir: string): Promise<void> {
  // `--` terminates option parsing so `safeUrl` and `destDir` cannot be
  // re-interpreted as flags even if the validator misses a case. The explicit
  // `-c protocol.allow=user` lockdown is a defence-in-depth layer on top of the
  // URL allowlist in validateGitUrl.
  const result = await runCommand(
    "git",
    [
      "-c",
      "protocol.allow=user",
      "-c",
      "protocol.file.allow=never",
      "clone",
      "--depth",
      "1",
      "--",
      safeUrl,
      destDir,
    ],
    stagingRoot(),
    undefined,
    GIT_CLONE_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw gitCloneError(result.code, result.stderr);
  }
}

// Clone `safeUrl` and leave the plugin package at `stagingDir`. With no
// `directory` the clone root IS the package (cloned straight into stagingDir,
// the original whole-repo behaviour). With a `directory` (the catalog
// monorepo-subdir model, #750) the repo is cloned into a sibling temp dir and
// only that subdirectory is copied into stagingDir, so the staged package, its
// integrity digest, and the installed plugin are the component, not the whole
// monorepo. The temp clone dir is always removed.
async function clonePackageInto(
  stagingDir: string,
  safeUrl: string,
  directory: string | undefined,
): Promise<void> {
  if (directory === undefined) {
    await runGitClone(safeUrl, stagingDir);
    return;
  }
  const sub = validateSubdir(directory);
  const cloneDir = resolveWithin(stagingRoot(), `${path.basename(stagingDir)}.clone`);
  try {
    await runGitClone(safeUrl, cloneDir);
    const pkgRoot = resolveWithin(cloneDir, sub);
    let s;
    try {
      s = await stat(pkgRoot);
    } catch {
      throw new InstallError(
        "missing-manifest",
        `Source directory "${sub}" not found in the cloned repository`,
      );
    }
    if (!s.isDirectory()) {
      throw new InstallError("invalid-input", `Source directory "${sub}" is not a directory`);
    }
    await cp(pkgRoot, stagingDir, { recursive: true });
  } finally {
    await rmStaging(cloneDir);
  }
}

// Stream a Release asset to `destFile`, failing closed on a non-200 response, a
// network error, or a body that exceeds the download cap. The size guard runs
// both up front (declared content-length) and as bytes flow (a server may lie
// about or omit content-length), so the cap holds either way (issue #370).
async function downloadAssetToFile(
  assetUrl: string,
  destFile: string,
  thirdParty?: ThirdPartyInstallContext,
): Promise<void> {
  let res: Response;
  try {
    // Route through the shared guarded transport (issue #554): SSRF / redirect
    // guarding, per-hop range re-validation, and the origin-scoped credential
    // rule live in guardedFetch. The undici fetch stays the injected transport so
    // the test seam is unchanged, timeoutMs null keeps the download bounded by its
    // byte cap rather than a wall-clock timeout, and the content-length +
    // streaming maxDownloadBytes guard below is untouched. A guard block surfaces
    // as a thrown error and maps to download-failed here, just like a transport
    // error.
    //
    // On a third-party install the scope comes from the REGISTERED SOURCE (issue
    // #559): its consented origin is the only hop-0 origin, its credential rides
    // only on that origin, and plain http needs its registration opt-in. Deriving
    // the origin from the asset URL instead (the first-party fallback below) is
    // self-consistent by construction and so scopes nothing; it is retained only
    // for the first-party catalog, whose entries come from a signed catalog and
    // carry no credential.
    res = await guardedFetch(assetUrl, {
      sourceOrigin: thirdParty?.sourceOrigin ?? new URL(assetUrl).origin,
      ...(thirdParty?.credential !== undefined ? { credential: thirdParty.credential } : {}),
      allowHttp: thirdParty?.allowHttp ?? false,
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: null,
    });
  } catch (err) {
    throw new InstallError(
      "download-failed",
      `Could not download the release asset: ${(err as Error).message}`,
    );
  }
  if (!res.ok || res.status !== 200 || res.body === null) {
    throw new InstallError(
      "download-failed",
      `Release asset download failed with HTTP status ${res.status}`,
    );
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxDownloadBytes) {
    throw new InstallError(
      "download-failed",
      `Release asset is ${declared} bytes, over the ${maxDownloadBytes}-byte download limit`,
    );
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > maxDownloadBytes) {
        cb(
          new InstallError(
            "download-failed",
            `Release asset exceeds the ${maxDownloadBytes}-byte download limit`,
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });
  // undici's body is a WHATWG ReadableStream; a Node Readable (the test double)
  // exposes `.pipe`. Normalise to a Node stream either way.
  const body = res.body as unknown;
  const source =
    typeof (body as { pipe?: unknown }).pipe === "function"
      ? (body as Readable)
      : Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    await pipeline(source, limiter, createWriteStream(destFile));
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError(
      "download-failed",
      `Could not download the release asset: ${(err as Error).message}`,
    );
  }
}

// Unpack a downloaded tarball into `destDir` under untrusted-input mitigations
// (issue #370): a first list pass validates every entry header before a single
// byte is written, so a malicious or oversized archive is rejected fail-closed
// with nothing left outside staging. The tar header carries each entry's
// declared (uncompressed) size, so a tar bomb is caught here, before extraction.
async function unpackTarball(tarballPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  let entryCount = 0;
  let totalBytes = 0;
  let violation: string | null = null;
  // Stream the tarball through a list pass that validates every entry header
  // before a single byte is written, and abort the parse the moment a cap or a
  // path/type rule is violated (issue #370). Aborting early matters: only the
  // on-the-wire download is capped, so without a mid-stream abort a tar/gzip
  // bomb within that cap could fully decompress before any limit is enforced.
  // `parser.abort` sets the parser's aborted flag (it stops consuming further
  // chunks) and rejects via the `error` listener below; we also destroy the
  // source so no more of the file is read.
  try {
    await new Promise<void>((resolve, reject) => {
      const source = createReadStream(tarballPath);
      const parser = tar.t({
        onentry: (entry) => {
          entryCount += 1;
          totalBytes += typeof entry.size === "number" ? entry.size : 0;
          if (violation === null) {
            const entryPath = String(entry.path);
            if (entry.type !== "File" && entry.type !== "Directory") {
              // Only plain files and directories belong in a built plugin
              // artifact: reject symlinks, hardlinks, devices, and FIFOs.
              violation = `unsupported entry type "${entry.type}" at "${entryPath}"`;
            } else if (path.isAbsolute(entryPath) || entryPath.split(/[\\/]/).includes("..")) {
              violation = `absolute or traversing path "${entryPath}"`;
            } else {
              // Zip-slip containment barrier: the entry must resolve inside destDir.
              try {
                resolveWithin(destDir, entryPath);
              } catch {
                violation = `path "${entryPath}" escapes the staging directory`;
              }
            }
          }
          if (violation === null && entryCount > maxTarballEntries) {
            violation = `over the ${maxTarballEntries}-entry limit`;
          }
          if (violation === null && totalBytes > maxUnpackedBytes) {
            violation = `unpacks to over the ${maxUnpackedBytes}-byte limit`;
          }
          if (violation !== null) {
            // Abort now: stop decompressing the rest of the archive.
            parser.abort(new Error(violation));
            source.destroy();
            return;
          }
          // Drain this entry's data so the parser advances to the next header.
          entry.resume();
        },
      });
      source.on("error", reject);
      parser.on("error", reject);
      parser.on("end", () => resolve());
      source.pipe(parser);
    });
  } catch (err) {
    if (violation !== null) {
      throw new InstallError("unpack-failed", `Rejected tarball: ${violation}`);
    }
    throw new InstallError(
      "unpack-failed",
      `Could not read the release asset tarball: ${(err as Error).message}`,
    );
  }

  // Pass 2: extract. Pass 1 validated every entry, so this writes only a safe
  // file set. The filter and `preservePaths: false` are defence in depth.
  try {
    await tar.x({
      file: tarballPath,
      cwd: destDir,
      preservePaths: false,
      filter: (entryPath, entry) => {
        // In extract mode `entry` is a ReadEntry (it carries `type`); the typed
        // union also admits a create-mode `Stats`, which has no `type`.
        if (!("type" in entry)) return false;
        if (entry.type !== "File" && entry.type !== "Directory") return false;
        if (path.isAbsolute(entryPath) || entryPath.split(/[\\/]/).includes("..")) return false;
        try {
          resolveWithin(destDir, entryPath);
          return true;
        } catch {
          return false;
        }
      },
    });
  } catch (err) {
    throw new InstallError(
      "unpack-failed",
      `Could not unpack the release asset tarball: ${(err as Error).message}`,
    );
  }
}

// Download and unpack a Release asset tarball into a fresh staging directory: the
// shared front half of the built-artifact install and update flows (issue #370).
// `assetUrl` is validated, streamed into a staging temp file under the download
// cap, unpacked with zip-slip containment plus size/entry-count limits, and the
// temp archive removed. On any failure the partial staging directory and the temp
// archive are removed before the error propagates, so nothing is left outside
// staging. No git clone and no build step run on the user's machine. Returns the
// staging token, the unpacked staging dir, and the validated asset URL so each
// caller can run its own staging tail (manifest read, host-compat, integrity,
// and either the duplicate check or the update id/replace handling).
async function stageReleaseAsset(
  assetUrl: string,
  thirdParty?: ThirdPartyInstallContext,
): Promise<{ token: string; stagingDir: string; safeUrl: string }> {
  const safeUrl = validateAssetUrl(assetUrl);
  await ensureStagingRoot();
  const token = randomUUID();
  assertSafeIdentifier(token, UUID_RE, "stagingToken");
  const stagingDir = resolveWithin(stagingRoot(), token);
  const tarballPath = resolveWithin(stagingRoot(), `${token}.tgz`);

  try {
    await downloadAssetToFile(safeUrl, tarballPath, thirdParty);
    await unpackTarball(tarballPath, stagingDir);
  } catch (err) {
    await rmStaging(stagingDir);
    await rmStaging(tarballPath);
    if (err instanceof InstallError) throw err;
    throw new InstallError("download-failed", (err as Error).message);
  }
  // The artifact is fully unpacked into stagingDir; the temp archive must not
  // linger in the staging root.
  await rmStaging(tarballPath);
  return { token, stagingDir, safeUrl };
}

/**
 * Stage a built-artifact install from a Release asset tarball (issue #370): the
 * download/unpack/verify front half of the install pipeline, joining the shared
 * staging tail (manifest read, host-compat, integrity, duplicate check) that the
 * git and local paths already use. `assetUrl` is streamed into a staging temp
 * file, unpacked with zip-slip containment plus size/entry-count limits, and the
 * unpacked artifact's digest is verified against `expectedIntegrity` (from the
 * signed catalog) BEFORE the staging entry is recorded, so verify-before-execute
 * holds. No git clone and no build step run on the user's machine. The atomic
 * commit (stage -> rename) is `commit()`, unchanged.
 *
 * Passing `thirdParty` marks this an install from a registered unsigned source
 * (issue #559): `expectedIntegrity` becomes mandatory and is checked before the
 * download, and the fetch is scoped to that source's origin and credential.
 */
export async function previewFromRelease(
  assetUrl: string,
  expectedIntegrity?: string | null,
  thirdParty?: ThirdPartyInstallContext,
  provenance?: InstallProvenance,
): Promise<InstallPreview> {
  // Pre-fetch: an unsigned entry with no usable digest is uninstallable, and must
  // be refused before a single artifact byte is fetched (CPHMTP-NFR-004).
  assertThirdPartyDigestPresent(expectedIntegrity, thirdParty);
  const { token, stagingDir, safeUrl } = await stageReleaseAsset(assetUrl, thirdParty);

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    await assertPackageIntegrity(stagingDir, expectedIntegrity, thirdParty);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = { type: "release", assetUrl: safeUrl };
    staged.set(token, { stagingDir, source, manifest, createdAt: Date.now(), provenance });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

/**
 * Stage an update for an already-installed plugin from a Release asset tarball
 * (the marketplace built-artifact update flow, issue #370). Mirrors
 * `previewUpdateFromGitUrl` (the update-target-missing guard, the bundled-rejected
 * guard, the manifest id must equal `expectedId`, integrity verified before the
 * staging entry is recorded, and NO duplicate-id rejection: the staged copy
 * replaces the existing one at `commit` time via `replaceId`), but uses the
 * download/unpack front half of `previewFromRelease` instead of a git clone. The
 * installed-plugin guard runs before any download, so an unknown or bundled target
 * is rejected without fetching. Throws `update-target-missing` if no updatable
 * plugin with `expectedId` is installed, or `invalid-input` if the unpacked
 * manifest id does not match `expectedId`.
 */
export async function previewUpdateFromRelease(
  assetUrl: string,
  expectedId: string,
  expectedIntegrity?: string | null,
  thirdParty?: ThirdPartyInstallContext,
  provenance?: InstallProvenance,
): Promise<InstallPreview> {
  // Pre-fetch (issue #559): refuse an unsigned entry with no usable digest before
  // any download. Ordered after the installed-plugin guard below only in that both
  // precede the fetch; neither reaches the network.
  assertThirdPartyDigestPresent(expectedIntegrity, thirdParty);
  const existing = pluginManager.listInstalled().find((r) => r.id === expectedId);
  if (!existing) {
    throw new InstallError(
      "update-target-missing",
      `No installed plugin with id "${expectedId}" to update`,
    );
  }
  if (existing.source === "bundled") {
    throw new InstallError(
      "update-target-missing",
      `Bundled plugin "${expectedId}" cannot be updated in place`,
    );
  }

  const { token, stagingDir, safeUrl } = await stageReleaseAsset(assetUrl, thirdParty);

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    if (manifest.id !== expectedId) {
      throw new InstallError(
        "invalid-input",
        `Update source declares id "${manifest.id}" but the catalog entry is "${expectedId}"`,
      );
    }
    await assertPackageIntegrity(stagingDir, expectedIntegrity, thirdParty);
    const source: InstallSource = { type: "release", assetUrl: safeUrl };
    staged.set(token, {
      stagingDir,
      source,
      manifest,
      createdAt: Date.now(),
      replaceId: expectedId,
      provenance,
    });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

/**
 * Install a single seed artifact from a LOCAL, already-built tarball (the
 * offline first-run seed path, davidpoxon/roubo-development#310). Unlike
 * `previewFromRelease` this performs no network fetch (the tarball ships under
 * the app's `resources/seed/`) and does NOT register or spawn the plugin: it
 * unpacks the tarball into staging under the same zip-slip / size / entry-count
 * guards, verifies the unpacked built artifact's digest against
 * `expectedIntegrity` (the seed catalog entry) fail-closed (CPHM-NFR-001),
 * confirms the unpacked manifest id matches `expectedId`, then atomically
 * renames staging into `~/.roubo/plugins/<id>`. It deliberately stops at the
 * on-disk placement: the seed runs in `plugin-manager.initialize()` BEFORE
 * user-root discovery, and the existing discovery pass picks the placed
 * directory up and spawns it, so the seed reuses discovery's spawn/supervision
 * verbatim (CPHM-NFR-005).
 *
 * Idempotent / no-clobber at the directory level: if `~/.roubo/plugins/<id>`
 * already exists (a prior seed, or a later marketplace update of a seeded
 * plugin) it is left untouched and `{ installed: false }` is returned, so a
 * seed pass never overwrites an install. On any failure the staging directory
 * is discarded (nothing left outside staging) and an `InstallError` is thrown.
 */
export async function installSeedArtifact(
  tarballPath: string,
  expectedId: string,
  expectedIntegrity: string,
): Promise<{ installed: boolean }> {
  assertSafeIdentifier(expectedId, PLUGIN_ID_RE, "pluginId");
  const target = resolveWithin(pluginManager.getUserPluginsRoot(), expectedId);

  // No-clobber: an existing install (a prior seed, or a marketplace update) is
  // authoritative and must never be overwritten by the seed.
  try {
    await stat(target);
    return { installed: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new InstallError("internal", (err as Error).message);
    }
  }

  // `validateLocalPath` normalizes + sanitizes the absolute path; the seed
  // artifact must additionally be an existing regular file.
  const safeTarball = validateLocalPath(tarballPath);
  try {
    const s = await stat(safeTarball);
    if (!s.isFile()) {
      throw new InstallError("invalid-input", `Seed artifact is not a file: ${safeTarball}`);
    }
  } catch (err) {
    if (err instanceof InstallError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstallError("invalid-input", `Seed artifact not found: ${safeTarball}`);
    }
    throw new InstallError("internal", (err as Error).message);
  }

  await ensureStagingRoot();
  const token = randomUUID();
  assertSafeIdentifier(token, UUID_RE, "stagingToken");
  const stagingDir = resolveWithin(stagingRoot(), token);

  try {
    await unpackTarball(safeTarball, stagingDir);
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    if (manifest.id !== expectedId) {
      throw new InstallError(
        "invalid-input",
        `Seed artifact declares id "${manifest.id}" but the seed catalog entry is "${expectedId}"`,
      );
    }
    // Fail-closed: the seed ALWAYS requires a digest. Verify directly rather
    // than via `assertPackageIntegrity`, which intentionally SKIPS a null/empty
    // digest for the raw-git / local-directory paths; for a seed a missing
    // digest must be rejected, and `verifyPackageIntegrity` returns false for an
    // empty/null expected value.
    const ok = await verifyPackageIntegrity(stagingDir, expectedIntegrity);
    if (!ok) {
      throw new InstallError(
        "integrity-failed",
        "Seed plugin package failed integrity verification: its content digest does not match the seed catalog entry.",
      );
    }
    await rename(stagingDir, target);
    return { installed: true };
  } catch (err) {
    await rmStaging(stagingDir);
    if (err instanceof InstallError) throw err;
    throw new InstallError("internal", (err as Error).message);
  }
}

export async function previewFromGitUrl(
  url: string,
  expectedIntegrity?: string | null,
  directory?: string,
  thirdParty?: ThirdPartyInstallContext,
  provenance?: InstallProvenance,
): Promise<InstallPreview> {
  // Pre-clone (issue #559): an unsigned entry with no usable digest is refused
  // before the repository is fetched.
  assertThirdPartyDigestPresent(expectedIntegrity, thirdParty);
  const safeUrl = validateGitUrl(url);
  await ensureStagingRoot();
  const token = randomUUID();
  assertSafeIdentifier(token, UUID_RE, "stagingToken");
  const stagingDir = resolveWithin(stagingRoot(), token);

  try {
    await clonePackageInto(stagingDir, safeUrl, directory);
  } catch (err) {
    await rmStaging(stagingDir);
    if (err instanceof InstallError) throw err;
    throw new InstallError("clone-failed", (err as Error).message);
  }

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    await assertPackageIntegrity(stagingDir, expectedIntegrity, thirdParty);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = {
      type: "git",
      url: safeUrl,
      ...(directory !== undefined ? { directory } : {}),
    };
    staged.set(token, { stagingDir, source, manifest, createdAt: Date.now(), provenance });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

/**
 * Stage an update for an already-installed plugin from a Git URL (the
 * marketplace update flow, issue #621). Identical to `previewFromGitUrl`
 * except it expects the cloned plugin's id to match an installed plugin and
 * skips the duplicate-id rejection: the staged copy will replace the existing
 * one at `commit` time. Throws `update-target-missing` if no plugin with
 * `expectedId` is installed, or `invalid-input` if the cloned manifest id does
 * not match `expectedId` (the catalog and the source must agree on the id).
 */
export async function previewUpdateFromGitUrl(
  url: string,
  expectedId: string,
  expectedIntegrity?: string | null,
  directory?: string,
  thirdParty?: ThirdPartyInstallContext,
  provenance?: InstallProvenance,
): Promise<InstallPreview> {
  // Pre-clone (issue #559): an unsigned entry with no usable digest is refused
  // before the repository is fetched.
  assertThirdPartyDigestPresent(expectedIntegrity, thirdParty);
  const existing = pluginManager.listInstalled().find((r) => r.id === expectedId);
  if (!existing) {
    throw new InstallError(
      "update-target-missing",
      `No installed plugin with id "${expectedId}" to update`,
    );
  }
  if (existing.source === "bundled") {
    throw new InstallError(
      "update-target-missing",
      `Bundled plugin "${expectedId}" cannot be updated in place`,
    );
  }

  const safeUrl = validateGitUrl(url);
  await ensureStagingRoot();
  const token = randomUUID();
  assertSafeIdentifier(token, UUID_RE, "stagingToken");
  const stagingDir = resolveWithin(stagingRoot(), token);

  try {
    await clonePackageInto(stagingDir, safeUrl, directory);
  } catch (err) {
    await rmStaging(stagingDir);
    if (err instanceof InstallError) throw err;
    throw new InstallError("clone-failed", (err as Error).message);
  }

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    if (manifest.id !== expectedId) {
      throw new InstallError(
        "invalid-input",
        `Update source declares id "${manifest.id}" but the catalog entry is "${expectedId}"`,
      );
    }
    await assertPackageIntegrity(stagingDir, expectedIntegrity, thirdParty);
    const source: InstallSource = {
      type: "git",
      url: safeUrl,
      ...(directory !== undefined ? { directory } : {}),
    };
    staged.set(token, {
      stagingDir,
      source,
      manifest,
      createdAt: Date.now(),
      replaceId: expectedId,
      provenance,
    });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

export async function previewFromLocalPath(absPath: string): Promise<InstallPreview> {
  // `safePath` is the normalized, validated absolute path. Every downstream
  // filesystem call uses `safePath` rather than the raw `absPath` argument
  // so the sanitization step is always on the call path.
  const safePath = validateLocalPath(absPath);

  let s;
  try {
    s = await stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new InstallError("invalid-input", `Path does not exist: ${safePath}`);
    }
    throw new InstallError("invalid-input", (err as Error).message);
  }
  if (!s.isDirectory()) {
    throw new InstallError("invalid-input", `Path is not a directory: ${safePath}`);
  }

  // Probe the source dir for a manifest before staging anything, so a bad
  // local path doesn't leave a half-copied staging directory behind.
  let sourceManifestPath: string | null = null;
  for (const filename of ["roubo-plugin.yaml", "roubo-plugin.yml"]) {
    const candidate = resolveWithin(safePath, filename);
    try {
      await stat(candidate);
      sourceManifestPath = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!sourceManifestPath) {
    throw new InstallError("missing-manifest", `No roubo-plugin.yaml found in ${safePath}`);
  }

  await ensureStagingRoot();
  const token = randomUUID();
  assertSafeIdentifier(token, UUID_RE, "stagingToken");
  const stagingDir = resolveWithin(stagingRoot(), token);

  try {
    await cp(safePath, stagingDir, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    await rmStaging(stagingDir);
    throw new InstallError(
      "internal",
      `Failed to copy ${safePath} into staging: ${(err as Error).message}`,
    );
  }

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = { type: "local", path: safePath };
    staged.set(token, { stagingDir, source, manifest, createdAt: Date.now() });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

export async function commit(stagingToken: string): Promise<PluginRecord> {
  const entry = staged.get(stagingToken);
  if (!entry) {
    throw new InstallError("unknown-token", `Unknown staging token: ${stagingToken}`);
  }

  // Update flow (issue #621) is handled separately: it must preserve the
  // existing copy until the new one is in place (no data loss) and must not go
  // through the active-integration guard `uninstall` enforces. The install path
  // below is unchanged.
  if (entry.replaceId !== undefined) {
    return commitUpdate(stagingToken, entry, entry.replaceId);
  }

  // Re-check duplicate id at commit time: another install could have raced
  // through preview → commit in the meantime.
  if (pluginManager.listInstalled().some((r) => r.id === entry.manifest.id)) {
    await rmStaging(entry.stagingDir);
    staged.delete(stagingToken);
    throw new InstallError(
      "duplicate-id",
      `A plugin with id "${entry.manifest.id}" is already installed`,
    );
  }

  assertSafeIdentifier(entry.manifest.id, PLUGIN_ID_RE, "pluginId");
  const target = resolveWithin(pluginManager.getUserPluginsRoot(), entry.manifest.id);
  try {
    await stat(target);
    // Target already exists on disk (orphaned dir from a prior install attempt).
    await rmStaging(entry.stagingDir);
    staged.delete(stagingToken);
    throw new InstallError("duplicate-id", `Plugin directory already exists at ${target}`);
  } catch (err) {
    if (err instanceof InstallError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      await rmStaging(entry.stagingDir);
      staged.delete(stagingToken);
      throw new InstallError("internal", (err as Error).message);
    }
  }

  try {
    await rename(entry.stagingDir, target);
  } catch (err) {
    throw new InstallError("internal", `Failed to install plugin: ${(err as Error).message}`);
  }

  // Record the chosen marketplace source BEFORE registering, so the record the
  // registry builds already carries its provenance (issue #558, AC4).
  // registerInstalled reads the ledger while building the record from disk, so
  // writing after it would leave this install's record unstamped until the next
  // reload.
  recordInstallProvenance(entry);

  let record: PluginRecord;
  try {
    record = await pluginManager.registerInstalled(target);
  } catch (err) {
    // Best-effort rollback: remove the moved directory so the user can retry
    // without manual cleanup. Drop the provenance row too, so a failed install
    // leaves no ledger entry claiming a plugin that is not installed.
    await rmStaging(target);
    if (entry.provenance !== undefined) {
      pluginProvenanceState.removeProvenance(entry.manifest.id);
    }
    staged.delete(stagingToken);
    throw new InstallError("internal", (err as Error).message);
  }

  staged.delete(stagingToken);
  return record;
}

/**
 * Persist the source a marketplace install was resolved from (issue #558, AC4).
 * A no-op for the raw git / local-directory paths, which carry no marketplace
 * provenance and must leave the ledger untouched.
 */
function recordInstallProvenance(entry: StagedInstall): void {
  if (entry.provenance === undefined) return;
  pluginProvenanceState.recordProvenance({
    pluginId: entry.manifest.id,
    ...entry.provenance,
  });
}

/**
 * Best-effort restore of the pre-update plugin after a failed update (issue
 * #621), so the consumer is never left with a working plugin destroyed. Clears
 * any partial new copy at `target`, moves the backup back into place, and
 * re-registers it. Errors here are swallowed: we are already on a failure path,
 * the directory is what matters for recovery, and the original InstallError must
 * be the one that surfaces.
 */
async function restoreUpdateBackup(backupDir: string, target: string): Promise<void> {
  try {
    await stat(target);
    // A partial/broken new copy may occupy the target; clear it first.
    await rmStaging(target);
  } catch {
    // ENOENT (target absent) is the normal case; nothing to clear.
  }
  try {
    await rename(backupDir, target);
  } catch {
    return;
  }
  try {
    await pluginManager.registerInstalled(target);
  } catch {
    // Registry restore failed (e.g. the prior entry was never torn down); the
    // directory is back on disk, so a later host restart re-discovers it.
  }
}

/**
 * Commit an UPDATE of an already-installed plugin (issue #621). Unlike the
 * install path, this must not lose the existing plugin: it moves the current
 * directory aside as a backup, tears down the old runtime WITHOUT the
 * active-integration guard (`uninstallForUpdate`), swaps the staged copy into
 * place, and registers it. Any failure after the backup restores the previous
 * plugin so the consumer keeps a working install. The id was pinned to the
 * installed plugin at preview time, so `manifest.id === replaceId`.
 */
async function commitUpdate(
  stagingToken: string,
  entry: StagedInstall,
  replaceId: string,
): Promise<PluginRecord> {
  // Re-check the target still exists: another flow could have removed it
  // between preview and commit.
  if (!pluginManager.listInstalled().some((r) => r.id === replaceId)) {
    await rmStaging(entry.stagingDir);
    staged.delete(stagingToken);
    throw new InstallError(
      "update-target-missing",
      `No installed plugin with id "${replaceId}" to update`,
    );
  }

  assertSafeIdentifier(entry.manifest.id, PLUGIN_ID_RE, "pluginId");
  const target = resolveWithin(pluginManager.getUserPluginsRoot(), entry.manifest.id);
  const backupDir = resolveWithin(stagingRoot(), `${stagingToken}-prev`);

  // 1. Preserve the existing copy by moving it aside (same filesystem as the
  //    staged copy, so this is the same atomic rename the install path relies
  //    on). After this the original is recoverable from `backupDir`.
  try {
    await rename(target, backupDir);
  } catch (err) {
    await rmStaging(entry.stagingDir);
    staged.delete(stagingToken);
    throw new InstallError(
      "internal",
      `Failed to back up existing plugin: ${(err as Error).message}`,
    );
  }

  // 2. Tear down the old runtime/registry without deleting the directory
  //    (already backed up) and without the active-integration guard (the id is
  //    unchanged, so project bindings stay valid).
  try {
    await pluginManager.uninstallForUpdate(replaceId);
  } catch (err) {
    await restoreUpdateBackup(backupDir, target);
    await rmStaging(entry.stagingDir);
    staged.delete(stagingToken);
    throw new InstallError("internal", (err as Error).message);
  }

  // 3. Move the staged copy into place.
  try {
    await rename(entry.stagingDir, target);
  } catch (err) {
    await restoreUpdateBackup(backupDir, target);
    await rmStaging(entry.stagingDir);
    staged.delete(stagingToken);
    throw new InstallError("internal", `Failed to install plugin: ${(err as Error).message}`);
  }

  // 4. Re-stamp the provenance to the source this update was resolved from, then
  //    register the new copy (registerInstalled reads the ledger, so the write
  //    precedes it). The previous row is captured first: an update that fails at
  //    registration restores the old plugin, so its provenance must be restored
  //    with it rather than left describing a copy that was rolled back.
  const previousProvenance = pluginProvenanceState.getProvenance(replaceId);
  recordInstallProvenance(entry);

  let record: PluginRecord;
  try {
    record = await pluginManager.registerInstalled(target);
  } catch (err) {
    // The new copy is broken: discard it and restore the backup.
    await rmStaging(target);
    await restoreUpdateBackup(backupDir, target);
    restoreProvenance(replaceId, previousProvenance, entry);
    staged.delete(stagingToken);
    throw new InstallError("internal", (err as Error).message);
  }

  // 5. Success: drop the backup and the staging entry.
  await rmStaging(backupDir);
  staged.delete(stagingToken);
  return record;
}

/**
 * Put the pre-update provenance back after a rolled-back update (issue #558), so
 * the ledger keeps describing the copy that is actually on disk. A no-op when this
 * update carried no provenance of its own (nothing was overwritten). When there
 * was no previous row, the stamp this update wrote is removed rather than left
 * behind describing the restored, differently-sourced copy.
 */
function restoreProvenance(
  pluginId: string,
  previous: PluginProvenanceRecord | null,
  entry: StagedInstall,
): void {
  if (entry.provenance === undefined) return;
  if (previous === null) {
    pluginProvenanceState.removeProvenance(pluginId);
    return;
  }
  pluginProvenanceState.recordProvenance({
    pluginId,
    sourceId: previous.sourceId,
    sourceUrl: previous.sourceUrl,
    unverified: previous.unverified,
  });
}

export async function cancel(stagingToken: string): Promise<void> {
  const entry = staged.get(stagingToken);
  if (!entry) return;
  await rmStaging(entry.stagingDir);
  staged.delete(stagingToken);
}

export const __test = {
  reset(): void {
    staged.clear();
    maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES;
    maxUnpackedBytes = DEFAULT_MAX_UNPACKED_BYTES;
    maxTarballEntries = DEFAULT_MAX_TARBALL_ENTRIES;
  },
  listTokens(): string[] {
    return Array.from(staged.keys());
  },
  stagingRoot,
  // Shrink the built-artifact limits so the over-size / over-entry-count paths
  // can be exercised without producing huge fixtures. Reset by `reset()`.
  setLimits(limits: {
    maxDownloadBytes?: number;
    maxUnpackedBytes?: number;
    maxTarballEntries?: number;
  }): void {
    if (limits.maxDownloadBytes !== undefined) maxDownloadBytes = limits.maxDownloadBytes;
    if (limits.maxUnpackedBytes !== undefined) maxUnpackedBytes = limits.maxUnpackedBytes;
    if (limits.maxTarballEntries !== undefined) maxTarballEntries = limits.maxTarballEntries;
  },
};
