import { execFileSync } from "node:child_process";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { resolveSpawn } from "./exec.js";
import {
  getProcessLogLines,
  getProcessStatus,
  runProcess,
  startProcess,
  stopProcess,
} from "./process-manager.js";

/**
 * Non-mocked companion to process-manager.test.ts (#836, AC5).
 *
 * Wrapping a component command in a shell adds a process layer between Roubo
 * and the real server, so the question the `shell` option raises is whether
 * stopping the component still reaps the GRANDCHILD or orphans a dev server on
 * its port. process-manager.test.ts mocks both `node:child_process` and
 * `tree-kill`, so it cannot answer that; this file spawns real processes and
 * drives the real tree-kill path.
 */

const isPosix = process.platform !== "win32";

function childPids(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" })
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits 1 with no output when nothing matches.
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe.skipIf(!isPosix)("shell-wrapped process lifecycle (#836, AC5)", () => {
  it("stopping a shell-wrapped component reaps the grandchild, leaving no orphan", async () => {
    const id = "shell-tree-test:1:web";
    // `; :` keeps the shell alive as a parent rather than letting it exec the
    // single command away, which is what produces the grandchild under test.
    const { file, args } = resolveSpawn("sleep 300 ; :", true);
    expect(file).toBe("/bin/sh");

    const { pid } = await startProcess(id, file, args, {}, os.tmpdir());
    expect(pid).toBeGreaterThan(0);

    const spawned = await waitFor(() => childPids(pid).length > 0);
    expect(spawned).toBe(true);
    const grandchildren = childPids(pid);
    expect(grandchildren.length).toBeGreaterThan(0);

    await stopProcess(id);

    expect(getProcessStatus(id).alive).toBe(false);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    for (const grandchild of grandchildren) {
      expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
    }
  }, 30_000);

  it("actually interprets shell syntax that argv mode leaves inert", async () => {
    const command = "echo one && echo two";
    const shellMode = resolveSpawn(command, true);
    const { exitCode } = await runProcess(
      "shell-tree-test:1:shellmode",
      shellMode.file,
      shellMode.args,
      {},
      os.tmpdir(),
      10_000,
    );

    expect(exitCode).toBe(0);
    expect(getProcessLogLines("shell-tree-test:1:shellmode").map((line) => line.text)).toEqual([
      "one",
      "two",
    ]);
    // The same string in argv mode would spawn `echo` with `&&` as a literal
    // argument, which is exactly the inert behaviour #836 is about.
    expect(resolveSpawn(command)).toEqual({ file: "echo", args: ["one", "&&", "echo", "two"] });
  }, 30_000);
});
