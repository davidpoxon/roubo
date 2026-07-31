/**
 * davidpoxon/roubo-development#685: node-pty's prebuilt spawn-helper can be
 * extracted without its executable bit, which breaks every terminal in the app
 * with an opaque `posix_spawnp failed`. These cover the diagnostic that turns
 * that into a `chmod +x` instruction.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeSpawnHelperProblem,
  findSpawnHelper,
  spawnHelperCandidates,
  withSpawnHelperDiagnosis,
} from "./pty-preflight.js";

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

function target(overrides: { platform?: NodeJS.Platform; arch?: string } = {}) {
  return { nodePtyRoot: root, platform: PLATFORM as NodeJS.Platform, arch: ARCH, ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pty-preflight-"));
  mkdirSync(join(root, "lib"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("spawnHelperCandidates", () => {
  it("mirrors node-pty's own resolution order", () => {
    expect(spawnHelperCandidates("/pkg/node-pty", { platform: PLATFORM, arch: ARCH })).toEqual([
      "/pkg/node-pty/build/Release/spawn-helper",
      "/pkg/node-pty/lib/build/Release/spawn-helper",
      "/pkg/node-pty/build/Debug/spawn-helper",
      "/pkg/node-pty/lib/build/Debug/spawn-helper",
      "/pkg/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "/pkg/node-pty/lib/prebuilds/darwin-arm64/spawn-helper",
    ]);
  });

  it("rewrites an asar path to its unpacked twin, as node-pty does", () => {
    const candidates = spawnHelperCandidates("/App/Resources/app.asar/node_modules/node-pty", {
      platform: PLATFORM,
      arch: ARCH,
    });
    for (const candidate of candidates) expect(candidate).toContain("app.asar.unpacked");
  });
});

describe("findSpawnHelper", () => {
  it("finds the platform prebuild helper", () => {
    const helper = seedPrebuild(0o644);
    expect(findSpawnHelper(target())).toBe(helper);
  });

  it("returns undefined when no candidate exists", () => {
    expect(findSpawnHelper(target())).toBeUndefined();
  });
});

describe("describeSpawnHelperProblem", () => {
  it("names the helper, its mode and the chmod that fixes it", () => {
    const helper = seedPrebuild(0o644);
    const problem = describeSpawnHelperProblem(target());
    expect(problem).toBeDefined();
    expect(problem).toContain(helper);
    expect(problem).toContain("mode 644");
    expect(problem).toContain(`chmod +x ${helper}`);
  });

  it("says nothing when the helper is executable", () => {
    seedPrebuild(0o755);
    expect(describeSpawnHelperProblem(target())).toBeUndefined();
  });

  it("says nothing when only the owner may execute it", () => {
    seedPrebuild(0o700);
    expect(describeSpawnHelperProblem(target())).toBeUndefined();
  });

  it("says nothing when there is no helper to check", () => {
    expect(describeSpawnHelperProblem(target())).toBeUndefined();
  });

  it("says nothing on Windows, which ships conpty and no helper", () => {
    seedPrebuild(0o644);
    expect(describeSpawnHelperProblem(target({ platform: "win32", arch: "x64" }))).toBeUndefined();
  });
});

describe("withSpawnHelperDiagnosis", () => {
  it("appends the diagnosis to an opaque spawn failure", () => {
    const helper = seedPrebuild(0o644);
    const detail = "Failed to spawn terminal (shell: /bin/zsh, cwd: /w): posix_spawnp failed.";
    const message = withSpawnHelperDiagnosis(detail, target());
    expect(message.startsWith(detail)).toBe(true);
    expect(message).toContain(`chmod +x ${helper}`);
  });

  it("leaves the detail untouched when the helper is fine", () => {
    seedPrebuild(0o755);
    const detail = "Failed to spawn terminal (shell: /bin/zsh, cwd: /w): ENOENT.";
    expect(withSpawnHelperDiagnosis(detail, target())).toBe(detail);
  });
});
