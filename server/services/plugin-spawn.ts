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
      // No `path`: the offending cwd is empty or not a string, so there is no
      // path worth naming and the message falls back to the executable.
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

// The executable is the third path the caller controls, alongside cwd and the
// arguments. `isExecutableAllowed` matches a bare-name declaration such as
// `node` by basename, so an absolute path would otherwise satisfy the allowlist
// while naming a binary that lives in a bench workspace. Deny that outright, the
// same way a workspace cwd or argument is denied. A bare name resolves against
// the pinned cwd and so lands in the plugin directory, which is never a
// workspace; the real executable resolution stays with spawn and PATH.
export async function assertExecutableNotInWorkspace(
  pluginId: string,
  methodName: string,
  executable: string,
  cwd: string,
  workspacesRoot: string,
  log: HostLogger,
): Promise<void> {
  const resolved = await resolveRealPath(path.resolve(cwd, executable));
  await assertNotInWorkspaces(pluginId, methodName, executable, resolved, workspacesRoot, log);
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

// Every part of a single argument that could name a path: the argument itself,
// plus each `=`-separated segment, so a workspace path hidden in a
// `--flag=<value>` (or a `--flag=<key>=<value>`) pair is seen too.
//
// A bare token carrying no separator is deliberately included rather than
// skipped. `cwd` is pinned to the plugin directory, so a non-path token such as
// `status` resolves to a plugin-directory sibling that is not inside
// `workspacesRoot` and passes harmlessly, whereas a bare symlink name sitting in
// the plugin directory (`bench-link`) resolves through to whatever it points at.
// Requiring a separator would let exactly that name slip past the barrier.
function pathShapedParts(arg: string): string[] {
  const parts: string[] = [arg];
  if (arg.includes("=")) {
    for (const segment of arg.split("=")) {
      if (segment.length > 0) parts.push(segment);
    }
  }
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
