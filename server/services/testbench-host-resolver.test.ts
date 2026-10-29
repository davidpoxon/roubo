import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBench } from "../test/fixtures.js";
import {
  getTestbenchHostProvider,
  registerTestbenchHostProvider,
  resolveTestbenchHost,
  testbenchHostProvider,
  unregisterTestbenchHostProvider,
  type TestbenchHostPurpose,
} from "./testbench-host-resolver.js";

let tmp: string;
let repoPath: string;
let focusedSpecPath: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-testbench-host-")));
  repoPath = path.join(tmp, "repo");
  const specFolder = path.join(repoPath, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  focusedSpecPath = path.join(specFolder, "test-cases.json");
  fs.writeFileSync(focusedSpecPath, "{}");
});

afterEach(() => {
  unregisterTestbenchHostProvider("specbench");
  registerTestbenchHostProvider("testbench", testbenchHostProvider);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function testbench(overrides: Parameters<typeof makeBench>[0] = {}) {
  return makeBench({
    variant: "testbench",
    workspacePath: path.join(tmp, "ws", "bench-1"),
    focusedSpecPath,
    ...overrides,
  });
}

const NOT_A_TESTBENCH = "Bench is not a testbench or has no focused spec";
const rootPurposes = ["read", "mark", "gate"] as const satisfies readonly TestbenchHostPurpose[];

describe("resolveTestbenchHost: a testbench bench", () => {
  it("resolves the bench worktree, the focused slug and both permissions for read, mark and gate", () => {
    const bench = testbench();
    for (const purpose of rootPurposes) {
      expect(resolveTestbenchHost(bench, purpose, repoPath)).toEqual({
        ok: true,
        host: {
          rootPath: bench.workspacePath,
          slug: "fixture-spec",
          refocusable: true,
          markable: true,
        },
      });
    }
  });

  it("allows focus without a repoPath, a usable workspace or a valid current focus", () => {
    const bench = testbench({ workspacePath: "", focusedSpecPath: "/elsewhere/x.json" });
    expect(resolveTestbenchHost(bench, "focus")).toEqual({
      ok: true,
      host: { refocusable: true, markable: true },
    });
  });

  it("refuses a missing focused spec, a blank workspace and a malformed focus with the old 400s", () => {
    for (const purpose of rootPurposes) {
      expect(
        resolveTestbenchHost(testbench({ focusedSpecPath: undefined }), purpose, repoPath),
      ).toEqual({ ok: false, status: 400, error: NOT_A_TESTBENCH });
      expect(resolveTestbenchHost(testbench({ workspacePath: "  " }), purpose, repoPath)).toEqual({
        ok: false,
        status: 400,
        error: "Bench has no workspace path",
      });
      const malformed = resolveTestbenchHost(
        testbench({ focusedSpecPath: path.join(tmp, "outside.json") }),
        purpose,
        repoPath,
      );
      expect(malformed.ok).toBe(false);
      expect(malformed.ok === false && malformed.status).toBe(400);
      expect(malformed.ok === false && malformed.error).toMatch(/^Invalid focusedSpecPath: /);
    }
  });
});

describe("resolveTestbenchHost: a variant with no registered provider", () => {
  it("gives a normal bench and an unregistered variant the old 400 for every purpose", () => {
    const plain = makeBench({ focusedSpecPath });
    const specbench = makeBench({ variant: "specbench", focusedSpecPath });
    expect(getTestbenchHostProvider("specbench")).toBeUndefined();
    for (const bench of [plain, specbench]) {
      for (const purpose of rootPurposes) {
        expect(resolveTestbenchHost(bench, purpose, repoPath)).toEqual({
          ok: false,
          status: 400,
          error: NOT_A_TESTBENCH,
        });
      }
      expect(resolveTestbenchHost(bench, "focus")).toEqual({
        ok: false,
        status: 400,
        error: "Bench is not a testbench variant",
        code: "NOT_TESTBENCH",
      });
    }
  });

  it("refuses a testbench bench once its provider is removed", () => {
    unregisterTestbenchHostProvider("testbench");
    expect(resolveTestbenchHost(testbench(), "read", repoPath)).toEqual({
      ok: false,
      status: 400,
      error: NOT_A_TESTBENCH,
    });
  });
});

describe("resolveTestbenchHost: a registered provider", () => {
  it("routes a second variant through its provider, honouring its permissions", () => {
    const pinRoot = path.join(tmp, "pin");
    registerTestbenchHostProvider("specbench", {
      refocusable: false,
      markable: false,
      rootPath: () => pinRoot,
      focusedSpecPath: () => focusedSpecPath,
    });
    const bench = makeBench({ variant: "specbench" });
    expect(resolveTestbenchHost(bench, "read", repoPath)).toEqual({
      ok: true,
      host: { rootPath: pinRoot, slug: "fixture-spec", refocusable: false, markable: false },
    });
    expect(resolveTestbenchHost(bench, "mark", repoPath)).toEqual({
      ok: false,
      status: 400,
      error: "Bench does not accept marks",
    });
    const focus = resolveTestbenchHost(bench, "focus");
    expect(focus.ok).toBe(false);
    expect(focus.ok === false && focus.code).toBe("NOT_TESTBENCH");
  });
});
