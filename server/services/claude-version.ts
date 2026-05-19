import os from "node:os";
import { runCommand } from "./exec.js";

const MIN_VERSION = "2.1.83";

export interface ClaudeCodeVersionInfo {
  available: boolean;
  reason?: string;
}

let cached: ClaudeCodeVersionInfo | null = null;

/** Parse a semver string from arbitrary command output. Exported for testing. */
export function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** True if version >= minimum (both are "X.Y.Z"). Exported for testing. */
export function isAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [vMaj, vMin, vPat] = parse(version);
  const [mMaj, mMin, mPat] = parse(minimum);
  if (vMaj !== mMaj) return vMaj > mMaj;
  if (vMin !== mMin) return vMin > mMin;
  return vPat >= mPat;
}

/** Runs `claude --version`, updates cache, and returns result. */
export async function detectClaudeAutoMode(): Promise<ClaudeCodeVersionInfo> {
  let result = await runCommand("claude", ["--version"], os.homedir(), undefined, 5000);

  if (result.code !== 0) {
    // Direct spawn failed — retry through a login shell so the binary is found
    // even when PATH hasn't propagated to this process (common in Electron GUI
    // launches where shell profile scripts are not sourced).
    result = await runCommand("sh", ["-lc", "claude --version"], os.homedir(), undefined, 5000);
  }

  const { code, stdout } = result;

  if (code !== 0) {
    cached = { available: false, reason: "Claude Code is not installed or could not be run" };
    return cached;
  }

  const version = parseVersion(stdout);
  if (!version) {
    cached = { available: false, reason: "Claude Code version could not be determined" };
    return cached;
  }

  if (!isAtLeast(version, MIN_VERSION)) {
    cached = {
      available: false,
      reason: `Claude Code ${version} does not support auto mode (requires ${MIN_VERSION}+)`,
    };
    return cached;
  }

  cached = { available: true };
  return cached;
}

/** Returns cached result, or runs detection if cache is empty. */
export async function getClaudeAutoModeInfo(): Promise<ClaudeCodeVersionInfo> {
  if (cached !== null) return cached;
  return detectClaudeAutoMode();
}

/** Resets the cached detection result. */
export function resetCache(): void {
  cached = null;
}
