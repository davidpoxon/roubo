import path from "node:path";
import { ResponseError } from "vscode-jsonrpc/node";
import type { PluginManifest } from "@roubo/shared";
import type { HostLogger } from "./plugin-host-api.js";

const PERMISSION_DENIED_CODE = -32001;

export type ProcessesDenyReason =
  | "all-spawning-denied"
  | "executable-not-declared"
  | "invalid-params"
  | "output-too-large";

export interface ProcessesPermissionDeniedData {
  code: "permission-denied";
  category: "processes";
  executable: string;
  reason: ProcessesDenyReason;
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

export function denyProcesses(
  pluginId: string,
  methodName: string,
  log: HostLogger,
  data: ProcessesPermissionDeniedData,
): never {
  log(
    "warn",
    `${pluginId}.${methodName} denied: executable="${data.executable}" reason="${data.reason}"`,
  );
  throw new ResponseError<ProcessesPermissionDeniedData>(
    PERMISSION_DENIED_CODE,
    `Permission denied: ${data.reason} for executable "${data.executable}"`,
    data,
  );
}
