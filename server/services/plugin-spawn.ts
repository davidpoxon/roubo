import path from "node:path";
import { ResponseError } from "vscode-jsonrpc/node";
import type { PluginManifest } from "@roubo/shared";
import { isInside } from "../lib/safe-path.js";
import { resolveRealPath } from "./plugin-fs.js";
import type { HostLogger } from "./plugin-host-api.js";

const PERMISSION_DENIED_CODE = -32001;

export type ProcessesDenyReason =
  | "all-spawning-denied"
  | "executable-not-declared"
  | "invalid-params"
  | "output-too-large"
  | "cwd-not-in-plugin-dir"
  | "workspace-path-denied";

export interface ProcessesPermissionDeniedData {
  code: "permission-denied";
  category: "processes";
  executable: string;
  reason: ProcessesDenyReason;
  // Set only for the path-shaped denials (`cwd-not-in-plugin-dir`,
  // `workspace-path-denied`), where the offending value is a path rather than
  // the executable itself.
  path?: string;
}

// Returns the declared executables list, or `null` when `processes` is `false`
// (meaning every spawn is denied).
export function resolveAllowedExecutables(manifest: PluginManifest): string[] | null {
  const processes = manifest.permissions.processes;
  if (processes === false) return null;
  return processes.executables;
}

export function isExecutableAllowed(executable: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  const requested = executable;
  const requestedBase = path.basename(executable);
  return allowed.some((entry) => {
    if (entry.includes("/") || entry.includes("\\")) {
      // Absolute or path-bearing declaration: require exact path match.
      return path.resolve(entry) === path.resolve(requested);
    }
    // Bare-name declaration: match by basename.
    return entry === requestedBase;
  });
}

export function assertSpawnAllowed(
  pluginId: string,
  methodName: string,
  executable: string,
  allowed: string[] | null,
  log: HostLogger,
): void {
  if (typeof executable !== "string" || executable.length === 0) {
    denyProcesses(pluginId, methodName, log, {
      code: "permission-denied",
      category: "processes",
      executable: String(executable ?? ""),
      reason: "invalid-params",
    });
  }
  if (allowed === null) {
    denyProcesses(pluginId, methodName, log, {
      code: "permission-denied",
      category: "processes",
      executable,
      reason: "all-spawning-denied",
    });
  }
  if (!isExecutableAllowed(executable, allowed)) {
    denyProcesses(pluginId, methodName, log, {
      code: "permission-denied",
      category: "processes",
      executable,
      reason: "executable-not-declared",
    });
  }
}

// A child process is confined to the plugin's own directory: the executable
// allowlist says what may run, this says where it may run. `cwd` is pinned to
// `pluginDir` (an omitted cwd keeps that default), so a path declared in
// `permissions.filesystem.paths` is no longer a legal working directory even
// though `host.fs.*` may still read it. A bench workspace is denied outright on
// top of that, matching the confinement agent-launch-executor applies to the
// declarative write path. Returns the resolved cwd to hand to spawn.
export async function assertSpawnCwdConfined(
  pluginId: string,
  methodName: string,
  executable: string,
  rawCwd: string | undefined,
  pluginDir: string,
  workspacesRoot: string,
  log: HostLogger,
): Promise<string> {
  if (rawCwd !== undefined && (typeof rawCwd !== "string" || rawCwd.length === 0)) {
    denyProcesses(pluginId, methodName, log, {
      code: "permission-denied",
      category: "processes",
      executable,
      reason: "invalid-params",
      path: String(rawCwd ?? ""),
    });
  }
  // Symlink-aware on both sides so a symlinked plugin dir (macOS
  // /var/folders -> /private/var) still matches, and a symlink inside it that
  // points out does not. Same realpath-to-realpath shape as
  // safe-path.assertRealpathWithin.
  const root = await resolveRealPath(pluginDir);
  const resolved = await resolveRealPath(rawCwd ?? pluginDir);
  if (!isInside(root, resolved)) {
    denyProcesses(pluginId, methodName, log, {
      code: "permission-denied",
      category: "processes",
      executable,
      reason: "cwd-not-in-plugin-dir",
      path: resolved,
    });
  }
  await assertNotInWorkspaces(pluginId, methodName, executable, resolved, workspacesRoot, log);
  return resolved;
}

// Second barrier: a bench-workspace path handed to the child as an argument is
// denied even though the child's cwd is already pinned to the plugin directory.
// This is defence in depth, not a guarantee: it inspects discrete arguments and
// cannot see a workspace path composed inside a string the child itself
// interprets (a shell snippet, a config file, an environment variable).
export async function assertNoWorkspacePathArgs(
  pluginId: string,
  methodName: string,
  executable: string,
  args: string[],
  cwd: string,
  workspacesRoot: string,
  log: HostLogger,
): Promise<void> {
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length === 0) continue;
    for (const candidate of pathShapedParts(arg)) {
      const resolved = await resolveRealPath(path.resolve(cwd, candidate));
      await assertNotInWorkspaces(pluginId, methodName, executable, resolved, workspacesRoot, log);
    }
  }
}

// The path-shaped parts of a single argument: the argument itself, plus the
// value half of a `--flag=<value>` pair. An argument with no path separator
// (`status`, `-rf`) is not a path and is left alone.
function pathShapedParts(arg: string): string[] {
  const parts: string[] = [];
  const consider = (value: string): void => {
    if (value.length === 0) return;
    if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) parts.push(value);
  };
  consider(arg);
  const eq = arg.indexOf("=");
  if (eq >= 0) consider(arg.slice(eq + 1));
  return parts;
}

async function assertNotInWorkspaces(
  pluginId: string,
  methodName: string,
  executable: string,
  resolvedPath: string,
  workspacesRoot: string,
  log: HostLogger,
): Promise<void> {
  const root = await resolveRealPath(workspacesRoot);
  if (isInside(root, resolvedPath)) {
    denyProcesses(pluginId, methodName, log, {
      code: "permission-denied",
      category: "processes",
      executable,
      reason: "workspace-path-denied",
      path: resolvedPath,
    });
  }
}

export function denyProcesses(
  pluginId: string,
  methodName: string,
  log: HostLogger,
  data: ProcessesPermissionDeniedData,
): never {
  const subject =
    data.path === undefined ? `executable "${data.executable}"` : `path "${data.path}"`;
  log(
    "warn",
    `${pluginId}.${methodName} denied: executable="${data.executable}"${
      data.path === undefined ? "" : ` path="${data.path}"`
    } reason="${data.reason}"`,
  );
  throw new ResponseError<ProcessesPermissionDeniedData>(
    PERMISSION_DENIED_CODE,
    `Permission denied: ${data.reason} for ${subject}`,
    data,
  );
}
