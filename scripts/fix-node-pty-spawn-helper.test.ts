import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureSpawnHelperExecutable,
  findSpawnHelper,
  spawnHelperCandidates,
} from "./fix-node-pty-spawn-helper.mjs";

const PLATFORM = "darwin";
const ARCH = "arm64";

let root: string;

/** Lay down a node-pty package root carrying a prebuild helper at `mode`. */
function seedPrebuild(mode: number): string {
  const dir = join(root, "prebuilds", `${PLATFORM}-${ARCH}`);
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  chmodSync(helper, mode);
  return helper;
}

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "node-pty-helper-"));
  mkdirSync(join(root, "lib"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("spawnHelperCandidates", () => {
  it("mirrors node-pty's own resolution order", () => {
    const candidates = spawnHelperCandidates({
      nodePtyRoot: "/pkg/node-pty",
      platform: PLATFORM,
      arch: ARCH,
    });
    expect(candidates).toEqual([
      "/pkg/node-pty/build/Release/spawn-helper",
      "/pkg/node-pty/lib/build/Release/spawn-helper",
      "/pkg/node-pty/build/Debug/spawn-helper",
      "/pkg/node-pty/lib/build/Debug/spawn-helper",
      "/pkg/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "/pkg/node-pty/lib/prebuilds/darwin-arm64/spawn-helper",
    ]);
  });

  it("rewrites an asar path to its unpacked twin, as node-pty does", () => {
    const candidates = spawnHelperCandidates({
      nodePtyRoot: "/App/Resources/app.asar/node_modules/node-pty",
      platform: PLATFORM,
      arch: ARCH,
    });
    for (const candidate of candidates) {
      expect(candidate).toContain("app.asar.unpacked");
    }
  });
});

describe("findSpawnHelper", () => {
  it("finds the platform prebuild helper", () => {
    const helper = seedPrebuild(0o644);
    expect(findSpawnHelper({ nodePtyRoot: root, platform: PLATFORM, arch: ARCH })).toBe(helper);
  });

  it("returns undefined when no candidate exists", () => {
    expect(findSpawnHelper({ nodePtyRoot: root, platform: PLATFORM, arch: ARCH })).toBeUndefined();
  });
});

describe("ensureSpawnHelperExecutable", () => {
  it("adds the missing executable bit (the #685 defect)", () => {
    const helper = seedPrebuild(0o644);
    const result = ensureSpawnHelperExecutable({
      nodePtyRoot: root,
      platform: PLATFORM,
      arch: ARCH,
    });
    expect(result).toEqual({ status: "fixed", path: helper });
    expect(modeOf(helper)).toBe(0o755);
  });

  it("preserves the non-execute permission bits it found", () => {
    const helper = seedPrebuild(0o640);
    ensureSpawnHelperExecutable({ nodePtyRoot: root, platform: PLATFORM, arch: ARCH });
    expect(modeOf(helper)).toBe(0o751);
  });

  it("leaves an already-executable helper alone and is idempotent", () => {
    const helper = seedPrebuild(0o755);
    expect(
      ensureSpawnHelperExecutable({ nodePtyRoot: root, platform: PLATFORM, arch: ARCH }),
    ).toEqual({ status: "already-executable", path: helper });
    expect(modeOf(helper)).toBe(0o755);

    expect(
      ensureSpawnHelperExecutable({ nodePtyRoot: root, platform: PLATFORM, arch: ARCH }),
    ).toEqual({ status: "already-executable", path: helper });
    expect(modeOf(helper)).toBe(0o755);
  });

  it("is a silent no-op when the helper is absent", () => {
    expect(
      ensureSpawnHelperExecutable({ nodePtyRoot: root, platform: PLATFORM, arch: ARCH }),
    ).toEqual({ status: "helper-not-found" });
  });

  it("is a no-op on Windows, which ships conpty and no helper", () => {
    seedPrebuild(0o644);
    expect(
      ensureSpawnHelperExecutable({ nodePtyRoot: root, platform: "win32", arch: "x64" }),
    ).toEqual({ status: "unsupported-platform" });
  });
});
