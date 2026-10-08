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
