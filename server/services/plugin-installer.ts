import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
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
  type PluginRecord,
} from "@roubo/shared";
import { runCommand } from "./exec.js";
import * as pluginManager from "./plugin-manager.js";
import { verifyPackageIntegrity } from "./marketplace-integrity.js";
import { PLUGIN_ID_RE, UUID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

const STAGING_DIR_NAME = ".staging";
const STAGING_TOKEN_RE = UUID_RE;

const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

// Built-artifact install limits (issue #773). A Release asset tarball is
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
 * Verify the staged package's content digest against the expected digest from
 * the signed catalog entry (CP-FR-021, issue #622). Called after the manifest is
 * read and compatibility is asserted, but before the staging entry is recorded,
 * so a mismatch throws `integrity-failed` and the caller's catch removes the
 * staging directory (no partial files; the existing version, if any, is left
 * untouched). A null/undefined `expected` skips the check: the non-marketplace
 * install paths (raw git URL, local directory) carry no catalog digest.
 */
async function assertPackageIntegrity(
  stagingDir: string,
  expected: string | null | undefined,
): Promise<void> {
  if (expected === null || expected === undefined) return;
  const ok = await verifyPackageIntegrity(stagingDir, expected);
  if (!ok) {
    throw new InstallError(
      "integrity-failed",
      "Plugin package failed integrity verification: its content digest does not match the signed catalog entry.",
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
// about or omit content-length), so the cap holds either way (issue #773).
async function downloadAssetToFile(assetUrl: string, destFile: string): Promise<void> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(assetUrl, { redirect: "follow" });
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
// (issue #773): a first list pass validates every entry header before a single
// byte is written, so a malicious or oversized archive is rejected fail-closed
// with nothing left outside staging. The tar header carries each entry's
// declared (uncompressed) size, so a tar bomb is caught here, before extraction.
async function unpackTarball(tarballPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  let entryCount = 0;
  let totalBytes = 0;
  let violation: string | null = null;
  try {
    await tar.t({
      file: tarballPath,
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
        // Drain the entry's data so the parser advances to the next header.
        entry.resume();
      },
    });
  } catch (err) {
    throw new InstallError(
      "unpack-failed",
      `Could not read the release asset tarball: ${(err as Error).message}`,
    );
  }

  if (violation !== null) {
    throw new InstallError("unpack-failed", `Rejected tarball entry: ${violation}`);
  }
  if (entryCount > maxTarballEntries) {
    throw new InstallError(
      "unpack-failed",
      `Tarball has ${entryCount} entries, over the ${maxTarballEntries}-entry limit`,
    );
  }
  if (totalBytes > maxUnpackedBytes) {
    throw new InstallError(
      "unpack-failed",
      `Tarball unpacks to ${totalBytes} bytes, over the ${maxUnpackedBytes}-byte limit`,
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

/**
 * Stage a built-artifact install from a Release asset tarball (issue #773): the
 * download/unpack/verify front half of the install pipeline, joining the shared
 * staging tail (manifest read, host-compat, integrity, duplicate check) that the
 * git and local paths already use. `assetUrl` is streamed into a staging temp
 * file, unpacked with zip-slip containment plus size/entry-count limits, and the
 * unpacked artifact's digest is verified against `expectedIntegrity` (from the
 * signed catalog) BEFORE the staging entry is recorded, so verify-before-execute
 * holds. No git clone and no build step run on the user's machine. The atomic
 * commit (stage -> rename) is `commit()`, unchanged.
 */
export async function previewFromRelease(
  assetUrl: string,
  expectedIntegrity?: string | null,
): Promise<InstallPreview> {
  const safeUrl = validateAssetUrl(assetUrl);
  await ensureStagingRoot();
  const token = randomUUID();
  assertSafeIdentifier(token, UUID_RE, "stagingToken");
  const stagingDir = resolveWithin(stagingRoot(), token);
  const tarballPath = resolveWithin(stagingRoot(), `${token}.tgz`);

  try {
    await downloadAssetToFile(safeUrl, tarballPath);
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

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    await assertPackageIntegrity(stagingDir, expectedIntegrity);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = { type: "release", assetUrl: safeUrl };
    staged.set(token, { stagingDir, source, manifest, createdAt: Date.now() });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

export async function previewFromGitUrl(
  url: string,
  expectedIntegrity?: string | null,
  directory?: string,
): Promise<InstallPreview> {
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
    await assertPackageIntegrity(stagingDir, expectedIntegrity);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = {
      type: "git",
      url: safeUrl,
      ...(directory !== undefined ? { directory } : {}),
    };
    staged.set(token, { stagingDir, source, manifest, createdAt: Date.now() });
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
): Promise<InstallPreview> {
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
    await assertPackageIntegrity(stagingDir, expectedIntegrity);
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

  let record: PluginRecord;
  try {
    record = await pluginManager.registerInstalled(target);
  } catch (err) {
    // Best-effort rollback: remove the moved directory so the user can retry
    // without manual cleanup.
    await rmStaging(target);
    staged.delete(stagingToken);
    throw new InstallError("internal", (err as Error).message);
  }

  staged.delete(stagingToken);
  return record;
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

  // 4. Register the new copy.
  let record: PluginRecord;
  try {
    record = await pluginManager.registerInstalled(target);
  } catch (err) {
    // The new copy is broken: discard it and restore the backup.
    await rmStaging(target);
    await restoreUpdateBackup(backupDir, target);
    staged.delete(stagingToken);
    throw new InstallError("internal", (err as Error).message);
  }

  // 5. Success: drop the backup and the staging entry.
  await rmStaging(backupDir);
  staged.delete(stagingToken);
  return record;
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
