import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { runCommand } from "./exec.js";

/**
 * Non-mocked companion to exec.test.ts (#1488, AC4).
 *
 * Bench setup runs through the login shell, which for zsh is `zsh -ilc`, and an
 * interactive zsh ignores SIGTERM. exec.test.ts mocks `node:child_process`, so
 * it cannot show that a timed-out command really settles; this file spawns a
 * real zsh and drives the real timeout path.
 */

function hasZsh(): boolean {
  try {
    execFileSync("zsh", ["-c", ":"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Mirrors ABORT_KILL_GRACE_MS in exec.ts. */
const KILL_GRACE_MS = 5000;
const TIMEOUT_MS = 300;

describe.skipIf(process.platform === "win32" || !hasZsh())(
  "runCommand timeout under an interactive zsh (#1488, AC4)",
  () => {
    let zdotdir: string;

    beforeEach(() => {
      // An empty ZDOTDIR keeps the developer's own rc files out of the test.
      // The shell is still interactive, so it still ignores SIGTERM.
      zdotdir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-exec-zsh-"));
    });

    afterEach(() => {
      fs.rmSync(zdotdir, { recursive: true, force: true });
    });

    it("settles a command that outlives timeoutMs within the timeout plus the grace period", async () => {
      const started = Date.now();
      // zsh stays the parent of a sleep that holds the output pipes. The group
      // SIGTERM ends the first sleep, but zsh ignores it and starts the second,
      // which only the SIGKILL that follows can stop.
      const result = await runCommand(
        "zsh",
        ["-ilc", "sleep 30 ; sleep 30"],
        zdotdir,
        { ZDOTDIR: zdotdir },
        TIMEOUT_MS,
      );
      const elapsed = Date.now() - started;

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`Process timed out after ${TIMEOUT_MS}ms`);
      expect(elapsed).toBeLessThan(TIMEOUT_MS + KILL_GRACE_MS + 2000);
    }, 15_000);
  },
);
