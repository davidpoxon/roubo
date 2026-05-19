import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockChild } from "../test/fixtures.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runCommand, parseCommand } from "./exec.js";

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

  it("resolves with error when spawn fails with ENOENT", async () => {
    const proc = createMockChild();
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = runCommand("nonexistent-binary", [], "/tmp");
    proc.emit("error", new Error("spawn nonexistent-binary ENOENT"));

    const result = await promise;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENOENT");
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
