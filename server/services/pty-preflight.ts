import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Diagnosis for the one install defect that breaks every terminal at once
// (davidpoxon/roubo-development#685).
//
// node-pty posix_spawnp()s a small `spawn-helper` binary for every PTY it
// allocates. When the prebuild is extracted without its executable bit, every
// spawn fails, plain shells and agent sessions alike, and node-pty reports it
// as a bare `posix_spawnp failed` with no mention of the helper. The remedy is
// one `chmod +x`, so the point of this module is to say so: at boot, and again
// on the spawn paths in terminal.ts, which would otherwise tell the user to
// reinstall Roubo.
//
// `scripts/fix-node-pty-spawn-helper.mjs` repairs the bit on install. This is
// the diagnostic half, for a tree that install never touched (a packaged app,
// a copied node_modules) or a repair that could not be applied.

/** Owner/group/other execute bits: what `chmod +x` sets. */
const EXEC_BITS = 0o111;

export interface SpawnHelperTarget {
  /** node-pty package root; resolved from the running server when omitted. */
  nodePtyRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * The paths node-pty would try for `spawn-helper`, in its own order.
 *
 * Mirrors `loadNativeModule()` in node-pty's `lib/utils.js` (build/Release,
 * build/Debug, then the platform prebuild, each resolved relative to the
 * package root and then to `lib/`) plus the asar rewrites `lib/unixTerminal.js`
 * applies to the helper path it derives.
 */
export function spawnHelperCandidates(
  nodePtyRoot: string,
  target: SpawnHelperTarget = {},
): string[] {
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const dirs = ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`];
  // node-pty resolves each dir relative to its own `lib/`: ".." for an
  // unbundled layout, "." for a bundled one.
  const relative = ["..", "."];
  const candidates: string[] = [];
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

/** The installed node-pty package root, or undefined when it cannot be resolved. */
export function resolveNodePtyRoot(): string | undefined {
  try {
    return path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  } catch {
    return undefined;
  }
}

/**
 * The `spawn-helper` node-pty will actually run, or undefined when none of the
 * candidate paths exists (Windows uses conpty and ships no helper).
 */
export function findSpawnHelper(target: SpawnHelperTarget = {}): string | undefined {
  const root = target.nodePtyRoot ?? resolveNodePtyRoot();
  if (root === undefined) return undefined;
  return spawnHelperCandidates(root, target).find((candidate) => existsSync(candidate));
}

/**
 * A one-line, actionable diagnosis when node-pty's spawn helper exists but is
 * not executable, or undefined when the helper is fine (or absent, or this is
 * Windows, where there is no helper to check).
 *
 * Deliberately unmemoised: the check is two syscalls, it runs at boot and on
 * spawn failures only, and a cached "all clear" would outlive a `chmod -x` that
 * happens while the server is up.
 */
export function describeSpawnHelperProblem(target: SpawnHelperTarget = {}): string | undefined {
  const platform = target.platform ?? process.platform;
  if (platform === "win32") return undefined;

  const helper = findSpawnHelper(target);
  if (helper === undefined) return undefined;

  let mode: number;
  try {
    mode = statSync(helper).mode;
  } catch {
    return undefined;
  }
  // Any execute bit is enough to run the helper, so only a total absence is a
  // defect. The install-time repair sets all three (plain `chmod +x`), but a
  // hand-fixed 0700 helper works and must not be reported as broken.
  if ((mode & EXEC_BITS) !== 0) return undefined;

  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  return (
    `node-pty's spawn-helper is not executable (mode ${octal} at ${helper}), so every PTY spawn ` +
    `fails. Run \`chmod +x ${helper}\` (or \`npm rebuild node-pty\`) and try again.`
  );
}

/**
 * `detail`, with the spawn-helper diagnosis appended when one applies.
 *
 * The seam the spawn-failure paths use: `posix_spawnp failed` on its own tells
 * the user nothing, so when the helper is the cause the message carries the
 * exact `chmod` instead.
 */
export function withSpawnHelperDiagnosis(detail: string, target: SpawnHelperTarget = {}): string {
  const problem = describeSpawnHelperProblem(target);
  return problem === undefined ? detail : `${detail} ${problem}`;
}
