import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
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

const STAGING_DIR_NAME = ".staging";
const STAGING_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

interface StagedInstall {
  stagingDir: string;
  source: InstallSource;
  manifest: PluginManifest;
  createdAt: number;
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
  return path.join(pluginManager.getUserPluginsRoot(), STAGING_DIR_NAME);
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
    const candidate = path.join(stagingDir, filename);
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

function validateGitUrl(url: string): void {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new InstallError("invalid-input", "Git URL is required");
  }
  // Conservative allowlist: https, http, ssh, or scp-style git@host:path.
  // We deliberately reject things git itself accepts (file://, /abs/path) so
  // the local-directory tab is the only path for filesystem sources.
  const trimmed = url.trim();
  const isUrl = /^(https?|ssh|git):\/\//i.test(trimmed);
  const isScp = /^[^\s@]+@[^\s:]+:.+$/.test(trimmed);
  if (!isUrl && !isScp) {
    throw new InstallError(
      "invalid-input",
      "Git URL must be an http(s), ssh, or git@host:path URL",
    );
  }
}

function validateLocalPath(absPath: string): void {
  if (typeof absPath !== "string" || absPath.trim().length === 0) {
    throw new InstallError("invalid-input", "Local path is required");
  }
  if (!path.isAbsolute(absPath)) {
    throw new InstallError("invalid-input", "Local path must be absolute");
  }
}

export async function previewFromGitUrl(url: string): Promise<InstallPreview> {
  validateGitUrl(url);
  await ensureStagingRoot();
  const token = randomUUID();
  const stagingDir = path.join(stagingRoot(), token);

  try {
    const result = await runCommand(
      "git",
      ["clone", "--depth", "1", url, stagingDir],
      stagingRoot(),
      undefined,
      GIT_CLONE_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      await rmStaging(stagingDir);
      throw gitCloneError(result.code, result.stderr);
    }
  } catch (err) {
    if (err instanceof InstallError) throw err;
    await rmStaging(stagingDir);
    throw new InstallError("clone-failed", (err as Error).message);
  }

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = { type: "git", url: url.trim() };
    staged.set(token, { stagingDir, source, manifest, createdAt: Date.now() });
    return { stagingToken: token, manifest, source };
  } catch (err) {
    await rmStaging(stagingDir);
    throw err;
  }
}

export async function previewFromLocalPath(absPath: string): Promise<InstallPreview> {
  validateLocalPath(absPath);

  let s;
  try {
    s = await stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new InstallError("invalid-input", `Path does not exist: ${absPath}`);
    }
    throw new InstallError("invalid-input", (err as Error).message);
  }
  if (!s.isDirectory()) {
    throw new InstallError("invalid-input", `Path is not a directory: ${absPath}`);
  }

  // Probe the source dir for a manifest before staging anything, so a bad
  // local path doesn't leave a half-copied staging directory behind.
  let sourceManifestPath: string | null = null;
  for (const filename of ["roubo-plugin.yaml", "roubo-plugin.yml"]) {
    const candidate = path.join(absPath, filename);
    try {
      await stat(candidate);
      sourceManifestPath = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!sourceManifestPath) {
    throw new InstallError("missing-manifest", `No roubo-plugin.yaml found in ${absPath}`);
  }

  await ensureStagingRoot();
  const token = randomUUID();
  const stagingDir = path.join(stagingRoot(), token);

  try {
    await cp(absPath, stagingDir, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    await rmStaging(stagingDir);
    throw new InstallError(
      "internal",
      `Failed to copy ${absPath} into staging: ${(err as Error).message}`,
    );
  }

  try {
    const manifest = await readStagingManifest(stagingDir);
    assertCompatible(manifest);
    assertNotDuplicate(manifest.id);
    const source: InstallSource = { type: "local", path: absPath };
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

  const target = path.join(pluginManager.getUserPluginsRoot(), entry.manifest.id);
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

export async function cancel(stagingToken: string): Promise<void> {
  const entry = staged.get(stagingToken);
  if (!entry) return;
  await rmStaging(entry.stagingDir);
  staged.delete(stagingToken);
}

export const __test = {
  reset(): void {
    staged.clear();
  },
  listTokens(): string[] {
    return Array.from(staged.keys());
  },
  stagingRoot,
};
