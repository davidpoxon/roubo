import { promises as fs } from "node:fs";
import path from "node:path";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginRecord } from "@roubo/shared";
import type { HostLogger } from "./plugin-host-api.js";

const PERMISSION_DENIED_CODE = -32001;

export type FilesystemDenyReason =
  | "path-not-in-allowlist"
  | "path-resolution-failed"
  | "invalid-params";

export interface FilesystemPermissionDeniedData {
  code: "permission-denied";
  category: "filesystem";
  path: string;
  reason: FilesystemDenyReason;
}

// Roots must be realpath'd because `assertPathAllowed` realpaths every target
// before the prefix check; if a root keeps an unresolved symlink ancestor
// (common when the install root sits under macOS `/var/folders/...` or a
// home directory on a symlinked mount), legitimate calls inside the plugin's
// own directory would be denied.
export async function resolveAllowedRoots(record: PluginRecord): Promise<string[]> {
  const pluginDir = path.resolve(record.pluginDir);
  const declared = record.manifest?.permissions.filesystem.paths ?? [];
  const absRoots = [
    pluginDir,
    ...declared.map((p) => path.resolve(path.isAbsolute(p) ? p : path.join(pluginDir, p))),
  ];
  return Promise.all(absRoots.map((root) => resolveRealPath(root)));
}

export function isPathAllowed(absPath: string, roots: string[]): boolean {
  const target = path.resolve(absPath);
  return roots.some((root) => {
    if (target === root) return true;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return target.startsWith(prefix);
  });
}

// Resolves symlinks on the deepest existing ancestor of the path so writes
// and reads alike are checked against the real filesystem location.
export async function resolveRealPath(absPath: string): Promise<string> {
  const target = path.resolve(absPath);
  try {
    return await fs.realpath(target);
  } catch {
    // Path may not exist (writeFile, mkdir). Walk up to the nearest ancestor
    // that does, realpath it, and re-attach the missing segments in order.
    let cursor = target;
    const tail: string[] = [];
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return target;
      try {
        const real = await fs.realpath(parent);
        const segments = [path.basename(cursor), ...tail.reverse()];
        return path.join(real, ...segments);
      } catch {
        tail.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }
}

export async function assertPathAllowed(
  pluginId: string,
  methodName: string,
  targetPath: string,
  roots: string[],
  log: HostLogger,
): Promise<string> {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    denyFs(pluginId, methodName, log, {
      code: "permission-denied",
      category: "filesystem",
      path: String(targetPath ?? ""),
      reason: "invalid-params",
    });
  }
  let resolved: string;
  try {
    resolved = await resolveRealPath(targetPath);
  } catch {
    denyFs(pluginId, methodName, log, {
      code: "permission-denied",
      category: "filesystem",
      path: targetPath,
      reason: "path-resolution-failed",
    });
  }
  if (!isPathAllowed(resolved, roots)) {
    denyFs(pluginId, methodName, log, {
      code: "permission-denied",
      category: "filesystem",
      path: resolved,
      reason: "path-not-in-allowlist",
    });
  }
  return resolved;
}

function denyFs(
  pluginId: string,
  methodName: string,
  log: HostLogger,
  data: FilesystemPermissionDeniedData,
): never {
  log("warn", `${pluginId}.${methodName} denied: path="${data.path}" reason="${data.reason}"`);
  throw new ResponseError<FilesystemPermissionDeniedData>(
    PERMISSION_DENIED_CODE,
    `Permission denied: ${data.reason} for path "${data.path}"`,
    data,
  );
}
