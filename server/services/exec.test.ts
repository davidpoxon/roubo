import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockChild } from "../test/fixtures.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runCommand, parseCommand, resolveSpawn, shellHintForCommand } from "./exec.js";

describe("runCommand", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves with stdout, stderr, and exit code", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("echo", ["hello"], "/tmp");

    if (!proc.stdout) throw new Error("expected stdout stream");
    if (!proc.stderr) throw new Error("expected stderr stream");
    proc.stdout.emit("data", Buffer.from("hello world"));
    proc.stderr.emit("data", Buffer.from("some warning"));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toEqual({ code: 0, stdout: "hello world", stderr: "some warning" });
  });

  it("passes cwd and merged env to spawn", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("git", ["status"], "/my/repo", { MY_VAR: "test" });
    proc.emit("close", 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith("git", ["status"], {
      cwd: "/my/repo",
      env: expect.objectContaining({ MY_VAR: "test" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("strips ROUBO_ env vars from spawned process environment", async () => {
    process.env = { ...originalEnv, ROUBO_PRODUCTION: "1", ROUBO_PORT: "3333", MY_VAR: "kept" };
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("git", ["status"], "/repo");
    proc.emit("close", 0);
    await promise;

    const spawnedEnv = vi.mocked(spawn).mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnedEnv.ROUBO_PRODUCTION).toBeUndefined();
    expect(spawnedEnv.ROUBO_PORT).toBeUndefined();
    expect(spawnedEnv.MY_VAR).toBe("kept");
  });

  it("defaults exit code to 1 when null", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("bad", [], "/tmp");
    proc.emit("close", null);

    const result = await promise;
    expect(result.code).toBe(1);
  });

  it("accumulates multiple data chunks", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("cmd", [], "/tmp");
    if (!proc.stdout) throw new Error("expected stdout stream");
    proc.stdout.emit("data", Buffer.from("line1\n"));
    proc.stdout.emit("data", Buffer.from("line2\n"));
    proc.emit("close", 0);

    const result = await promise;
    expect(result.stdout).toBe("line1\nline2\n");
  });

  it("kills process when timeout expires", async () => {
    vi.useFakeTimers();
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("slow", [], "/tmp", undefined, 5000);

    vi.advanceTimersByTime(5000);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    proc.emit("close", null);
    const result = await promise;

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Process timed out after 5000ms");
    vi.useRealTimers();
  });

  it("clears timeout when process completes before timeout", async () => {
    vi.useFakeTimers();
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("fast", [], "/tmp", undefined, 5000);

    proc.emit("close", 0);
    const result = await promise;

    expect(proc.kill).not.toHaveBeenCalled();
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("timed out");
    vi.useRealTimers();
  });

  it("does not set timeout when timeoutMs is undefined", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("cmd", [], "/tmp");
    proc.emit("close", 0);
    await promise;

    expect(proc.kill).not.toHaveBeenCalled();
  });

  describe("idleTimeoutMs (#1438)", () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      // The command runs in its own group, so the kill goes to process.kill(-pid).
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(() => {
      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("starts the command in its own process group", () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);

      void runCommand("git", [], "/tmp", undefined, undefined, undefined, { idleTimeoutMs: 1000 });

      expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({
        detached: process.platform !== "win32",
      });
      proc.emit("close", 0);
    });

    it("restarts the window on each stdout and stderr chunk", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);
      if (!proc.stdout || !proc.stderr) throw new Error("expected output streams");

      const promise = runCommand("git", [], "/tmp", undefined, undefined, undefined, {
        idleTimeoutMs: 1000,
      });
      vi.advanceTimersByTime(900);
      proc.stderr.emit("data", Buffer.from("Receiving objects:  10%\r"));
      vi.advanceTimersByTime(900);
      proc.stdout.emit("data", Buffer.from("Submodule path 'a': checked out\n"));
      vi.advanceTimersByTime(900);
      proc.emit("close", 0);

      const result = await promise;
      expect(killSpy).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
      expect(result.code).toBe(0);
      expect(result.idleTimedOut).toBeUndefined();
    });

    it.skipIf(process.platform === "win32")(
      "kills the group once the command is quiet for the whole window",
      async () => {
        const proc = createMockChild(4321);
        vi.mocked(spawn).mockReturnValue(proc);

        const promise = runCommand("git", [], "/tmp", undefined, undefined, undefined, {
          idleTimeoutMs: 1000,
        });
        vi.advanceTimersByTime(1000);
        expect(killSpy).toHaveBeenCalledWith(-4321, "SIGTERM");

        proc.emit("close", null);
        const result = await promise;
        expect(result.idleTimedOut).toBe(true);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Process produced no output for 1000ms");
      },
    );

    it("clears the window when the command exits", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);

      const promise = runCommand("git", [], "/tmp", undefined, undefined, undefined, {
        idleTimeoutMs: 1000,
      });
      proc.emit("close", 0);
      await promise;
      vi.advanceTimersByTime(5000);

      expect(killSpy).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
    });
  });

  it("pipes stdin into the spawned process when provided", async () => {
    const proc = createMockChild(1234, { withStdin: true });
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("cat", [], "/tmp", undefined, undefined, "hello-secret");
    proc.emit("close", 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith("cat", [], {
      cwd: "/tmp",
      env: expect.any(Object),
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(proc.stdin?.write).toHaveBeenCalledWith("hello-secret");
    expect(proc.stdin?.end).toHaveBeenCalled();
  });

  it("ignores stdin and uses ignore stdio when stdin is undefined", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("git", ["status"], "/repo");
    proc.emit("close", 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("resolves with error when spawn fails with ENOENT", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("nonexistent-binary", [], "/tmp");
    proc.emit("error", new Error("spawn nonexistent-binary ENOENT"));

    const result = await promise;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });

  describe("abort signal (#1433)", () => {
    const posix = process.platform !== "win32";

    it("spawns detached on POSIX only when a signal is passed", async () => {
      const proc = createMockChild();
      vi.mocked(spawn).mockReturnValue(proc);

      const promise = runCommand("git", ["clone"], "/repo", undefined, undefined, undefined, {
        signal: new AbortController().signal,
      });
      proc.emit("close", 0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        "git",
        ["clone"],
        expect.objectContaining({ detached: posix }),
      );
    });

    it("kills the whole process group on abort and resolves on close", async () => {
      const proc = createMockChild(4321);
      vi.mocked(spawn).mockReturnValue(proc);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const controller = new AbortController();

      const promise = runCommand("git", ["clone"], "/repo", undefined, undefined, undefined, {
        signal: controller.signal,
      });
      controller.abort();

      if (posix) {
        expect(killSpy).toHaveBeenCalledWith(-4321, "SIGTERM");
      } else {
        expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      }

      // The promise resolves only once the child has actually exited, so a
      // caller that awaits it never races a process still writing to disk.
      let settled = false;
      void promise.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      proc.emit("close", null);
      const result = await promise;
      expect(result.code).toBe(1);
      expect(result.aborted).toBe(true);
      killSpy.mockRestore();
    });

    it("escalates to SIGKILL when the group outlives the grace period", async () => {
      vi.useFakeTimers();
      const proc = createMockChild(4321);
      vi.mocked(spawn).mockReturnValue(proc);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const controller = new AbortController();

      const promise = runCommand("git", ["clone"], "/repo", undefined, undefined, undefined, {
        signal: controller.signal,
      });
      controller.abort();
      vi.advanceTimersByTime(5000);

      if (posix) {
        expect(killSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
      } else {
        expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      }
      proc.emit("close", null);
      await promise;
      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("does not spawn at all when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await runCommand("git", ["clone"], "/repo", undefined, undefined, undefined, {
        signal: controller.signal,
      });

      expect(spawn).not.toHaveBeenCalled();
      expect(result).toEqual({ code: 1, stdout: "", stderr: "Aborted", aborted: true });
    });
  });
});

describe("parseCommand", () => {
  it("splits simple commands on whitespace", () => {
    expect(parseCommand("npm ci")).toEqual(["npm", "ci"]);
  });

  it("handles double-quoted arguments", () => {
    expect(parseCommand('npm run "build prod"')).toEqual(["npm", "run", "build prod"]);
  });

  it("handles single-quoted arguments", () => {
    expect(parseCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("handles multiple arguments", () => {
    expect(parseCommand("dotnet run --project responda-service/Seeder")).toEqual([
      "dotnet",
      "run",
      "--project",
      "responda-service/Seeder",
    ]);
  });

  it("trims extra whitespace", () => {
    expect(parseCommand("  npm   ci  ")).toEqual(["npm", "ci"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCommand("")).toEqual([]);
  });

  it("handles mixed quoted and unquoted arguments", () => {
    expect(parseCommand('cmd --flag "spaced arg" plain')).toEqual([
      "cmd",
      "--flag",
      "spaced arg",
      "plain",
    ]);
  });
});

// #1218: resolveSpawn is the single owner of the argv-vs-shell branch every
// descriptor spawn site routes through.
describe("resolveSpawn", () => {
  it("splits the command into argv when shell is omitted (AC1)", () => {
    expect(resolveSpawn("npm run dev")).toEqual({ file: "npm", args: ["run", "dev"] });
  });

  it("splits the command into argv when shell is explicitly false", () => {
    expect(resolveSpawn("npm run dev", false)).toEqual({ file: "npm", args: ["run", "dev"] });
  });

  it("leaves shell metacharacters as literal argv entries in argv mode", () => {
    expect(resolveSpawn("nvm use && npm run dev")).toEqual({
      file: "nvm",
      args: ["use", "&&", "npm", "run", "dev"],
    });
  });

  it("returns an empty file for an empty command so callers own the error", () => {
    expect(resolveSpawn("")).toEqual({ file: "", args: [] });
  });

  it("runs the command through /bin/sh -c when shell is true (AC2)", () => {
    expect(resolveSpawn("cd web && npm run dev", true)).toEqual({
      file: "/bin/sh",
      args: ["-c", "cd web && npm run dev"],
    });
  });

  it("appends the command as -c to a string shell invocation (AC3)", () => {
    expect(resolveSpawn("nvm use && npm run dev", "zsh -i")).toEqual({
      file: "zsh",
      args: ["-i", "-c", "nvm use && npm run dev"],
    });
  });

  it("accepts a bare shell name with no flags", () => {
    expect(resolveSpawn("echo hi", "bash")).toEqual({ file: "bash", args: ["-c", "echo hi"] });
  });

  it("accepts an absolute shell path", () => {
    expect(resolveSpawn("echo hi", "/bin/zsh -ilc")).toEqual({
      file: "/bin/zsh",
      args: ["-ilc", "-c", "echo hi"],
    });
  });

  it("rejects a shell string that is only whitespace", () => {
    expect(() => resolveSpawn("echo hi", "   ")).toThrow(/shell is empty/);
  });

  it("rejects a shell whose executable carries unsafe characters", () => {
    expect(() => resolveSpawn("echo hi", "zsh;rm -rf /")).toThrow(/not a usable shell/);
  });
});

describe("shellHintForCommand", () => {
  it("names the metacharacter and suggests both shell forms", () => {
    const hint = shellHintForCommand("nvm use && npm run dev");
    expect(hint).toContain("'&'");
    expect(hint).toContain("shell: true");
    expect(hint).toContain("shell: zsh -i");
  });

  it.each(["cd web && npm run dev", "a; b", "cat x > y", "echo $HOME", "ls *.ts", "cd web"])(
    "detects shell syntax in %j",
    (command) => {
      expect(shellHintForCommand(command)).toBeDefined();
    },
  );

  it("returns undefined for a plain argv command line", () => {
    expect(shellHintForCommand("npm run dev -- --port 3000")).toBeUndefined();
  });
});
