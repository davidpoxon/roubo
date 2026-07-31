#!/usr/bin/env node
// Restore the executable bit on node-pty's prebuilt `spawn-helper`
// (davidpoxon/roubo-development#685).
//
// node-pty posix_spawnp()s that helper for every PTY it allocates, so a helper
// extracted mode -rw-r--r-- breaks every terminal in the app at once: plain
// shells and agent sessions alike fail with an opaque `posix_spawnp failed`.
// The prebuild ships with the bit set, but some install paths land it without.
//
// This runs as `postinstall`, so it must never fail an install: every arm
// returns a status instead of throwing, and main() always exits 0.
//
// Run with: node scripts/fix-node-pty-spawn-helper.mjs

import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Owner/group/other execute bits: what `chmod +x` sets. */
const EXEC_BITS = 0o111;

/**
 * The paths node-pty would try for `spawn-helper`, in its own order.
 *
 * Mirrors `loadNativeModule()` in node-pty's `lib/utils.js` (build/Release,
 * build/Debug, then the platform prebuild, each resolved relative to the
 * package root and then to `lib/`) plus the asar rewrites `lib/unixTerminal.js`
 * applies to the resulting helper path.
 *
 * @param {object} params
 * @param {string} params.nodePtyRoot Absolute path to the node-pty package root.
 * @param {string} [params.platform] `process.platform` value to resolve for.
 * @param {string} [params.arch] `process.arch` value to resolve for.
 * @returns {string[]} Absolute candidate paths, most-preferred first.
 */
export function spawnHelperCandidates({
  nodePtyRoot,
  platform = process.platform,
  arch = process.arch,
}) {
  const dirs = ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`];
  // node-pty resolves each dir relative to its own `lib/`: ".." for an
  // unbundled layout, "." for a bundled one.
  const relative = ["..", "."];
  const candidates = [];
  for (const dir of dirs) {
    for (const rel of relative) {
      const resolved = path.resolve(nodePtyRoot, "lib", rel, dir, "spawn-helper");
      candidates.push(
        resolved
          .replace("app.asar", "app.asar.unpacked")
          .replace("node_modules.asar", "node_modules.asar.unpacked"),
      );
    }
  }
  return candidates;
}

/**
 * The `spawn-helper` node-pty will actually run, or undefined when none of the
 * candidate paths exists (Windows ships conpty and has no helper at all).
 *
 * @param {object} params Same shape as {@link spawnHelperCandidates}.
 * @returns {string|undefined}
 */
export function findSpawnHelper(params) {
  return spawnHelperCandidates(params).find((candidate) => existsSync(candidate));
}

/**
 * Locate the installed node-pty package root, or undefined when it is absent.
 *
 * Resolution starts from the directory npm set as cwd for the lifecycle script,
 * so the nested install under `electron/` repairs its own copy rather than the
 * workspace root's, and falls back to this script's own location.
 *
 * @param {string} [fromDir] Directory to resolve from (defaults to cwd).
 * @returns {string|undefined}
 */
export function resolveNodePtyRoot(fromDir = process.cwd()) {
  const origins = [path.join(fromDir, "package.json"), fileURLToPath(import.meta.url)];
  for (const origin of origins) {
    try {
      return path.dirname(createRequire(origin).resolve("node-pty/package.json"));
    } catch {
      // Not resolvable from this origin; try the next.
    }
  }
  return undefined;
}

/**
 * Add the executable bits to node-pty's `spawn-helper` when they are missing.
 *
 * Idempotent: an already-executable helper is left untouched, and an absent
 * helper (or a Windows install, which has none) is a silent no-op.
 *
 * @param {object} [params]
 * @param {string} [params.nodePtyRoot] Package root; resolved when omitted.
 * @param {string} [params.platform] `process.platform` value to resolve for.
 * @param {string} [params.arch] `process.arch` value to resolve for.
 * @returns {{status: "unsupported-platform"|"node-pty-not-found"|"helper-not-found"|"already-executable"|"fixed"|"failed", path?: string, error?: string}}
 */
export function ensureSpawnHelperExecutable({
  nodePtyRoot,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  // Windows uses conpty/winpty and ships no spawn-helper.
  if (platform === "win32") return { status: "unsupported-platform" };

  const root = nodePtyRoot ?? resolveNodePtyRoot();
  if (root === undefined) return { status: "node-pty-not-found" };

  const helper = findSpawnHelper({ nodePtyRoot: root, platform, arch });
  if (helper === undefined) return { status: "helper-not-found" };

  try {
    const mode = statSync(helper).mode;
    // Any execute bit is enough to run the helper, so only a total absence is a
    // defect. Matching server/services/pty-preflight.ts keeps the repair and the
    // diagnosis from disagreeing, and leaves a deliberate 0700 helper untouched.
    if ((mode & EXEC_BITS) !== 0) return { status: "already-executable", path: helper };
    chmodSync(helper, mode | EXEC_BITS);
    return { status: "fixed", path: helper };
  } catch (err) {
    return { status: "failed", path: helper, error: /** @type {Error} */ (err).message };
  }
}

function main() {
  const result = ensureSpawnHelperExecutable();
  if (result.status === "fixed") {
    console.log(
      `Restored the executable bit on node-pty's spawn-helper (${result.path}). ` +
        "Without it every terminal fails with `posix_spawnp failed`.",
    );
  } else if (result.status === "failed") {
    // Advisory only: a postinstall that exits nonzero fails the whole install,
    // which is a far worse outcome than a helper we could not chmod.
    console.warn(
      `Could not restore the executable bit on node-pty's spawn-helper (${result.path}): ` +
        `${result.error}. If terminals fail to open, run \`chmod +x ${result.path}\`.`,
    );
  }
}

// Run the CLI only when invoked directly, not when imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("fix-node-pty-spawn-helper.mjs")) {
  main();
}
