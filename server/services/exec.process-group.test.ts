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
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const childPid = Number(fs.readFileSync(pidFile, "utf-8").trim());
      expect(isAlive(childPid)).toBe(true);

      controller.abort();
      const result = await pending;

      expect(result.aborted).toBe(true);
      expect(isAlive(childPid)).toBe(false);
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
      const childPid = Number(fs.readFileSync(pidFile, "utf-8").trim());

      expect(result.idleTimedOut).toBe(true);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Process produced no output for 300ms");
      expect(isAlive(childPid)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
