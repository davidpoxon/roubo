import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A killed child can still be exiting, or not yet reaped, when the command it
// belongs to has already closed, and a signal check counts it alive until then
// (#1643). So the test waits for it to go, up to a deadline well past the few
// milliseconds that takes.
async function isGoneWithin(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

// The shell creates the pid file before `echo` writes to it, so the file can
// exist and still be empty. An empty read is pid 0, which signals the test's
// own process group and always reads alive.
async function readChildPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf-8").trim() : "";
    const pid = Number(text);
    if (Number.isInteger(pid) && pid > 0) return pid;
    if (Date.now() > deadline) throw new Error(`no child pid in ${pidFile}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Real processes, no mocks: an abort must reach the command's own children, the
// way `git submodule update` runs `git clone` (#1433). exec.test.ts mocks spawn,
// so it cannot show this.
describe.skipIf(process.platform === "win32")("runCommand abort on a real process group", () => {
  it("kills the command's children as well as the command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-pgrp-"));
    const pidFile = path.join(dir, "child.pid");
    const controller = new AbortController();

    try {
      const pending = runCommand(
        "sh",
        ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
        dir,
        undefined,
        undefined,
        undefined,
        { signal: controller.signal },
      );
      const childPid = await readChildPid(pidFile);
      expect(isAlive(childPid)).toBe(true);

      controller.abort();
      const result = await pending;

      expect(result.aborted).toBe(true);
      expect(await isGoneWithin(childPid)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A no-output timeout for a long network transfer such as a first submodule
// clone (#1438): a command that keeps writing runs as long as it needs, and one
// that goes quiet is killed with its children, with no abort signal involved.
describe.skipIf(process.platform === "win32")("runCommand idle timeout on a real process", () => {
  it("does not kill a command that keeps writing past the idle window", async () => {
    const result = await runCommand(
      "sh",
      ["-c", "for i in 1 2 3 4 5 6 7; do echo tick >&2; sleep 0.2; done"],
      os.tmpdir(),
      undefined,
      undefined,
      undefined,
      { idleTimeoutMs: 600 },
    );

    expect(result.code).toBe(0);
    expect(result.idleTimedOut).toBeUndefined();
  });

  it("kills a quiet command and its children, and says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-idle-"));
    const pidFile = path.join(dir, "child.pid");

    try {
      const result = await runCommand(
        "sh",
        ["-c", 'echo start; sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
        dir,
        undefined,
        undefined,
        undefined,
        { idleTimeoutMs: 300 },
      );
      const childPid = await readChildPid(pidFile);

      expect(result.idleTimedOut).toBe(true);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Process produced no output for 300ms");
      expect(await isGoneWithin(childPid)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
