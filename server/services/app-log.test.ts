import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAppLogging, __test } from "./app-log.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-app-log-"));
  process.env.ROUBO_APP_LOG_DIR = dir;
  // Silence the console underneath before installAppLogging captures it: these
  // tests assert on the log file, and the rotation test's 6MB line, printed as
  // CI captures it, stalled the GitHub Actions log stream and hung the job.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __test.reset();
  delete process.env.ROUBO_APP_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function currentLog(): string {
  return fs.readFileSync(path.join(dir, "current.log"), "utf8");
}

describe("installAppLogging", () => {
  it("tees console.warn and console.error to current.log under the Roubo directory", () => {
    installAppLogging();

    console.warn("worktree provisioning is slow");
    console.error("agent session could not be spawned");

    const text = currentLog();
    expect(text).toContain("[warn] worktree provisioning is slow");
    expect(text).toContain("[error] agent session could not be spawned");
    // Each record is its own line, timestamped.
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T.*\[warn\] worktree provisioning is slow$/m);
  });

  it("still calls through to the real console method underneath", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installAppLogging();

    console.warn("still visible in the terminal");

    expect(warnSpy).toHaveBeenCalledWith("still visible in the terminal");
    expect(currentLog()).toContain("still visible in the terminal");
  });

  it("joins multiple arguments and serializes an Error's stack", () => {
    installAppLogging();

    console.warn("bench", 3, "failed:", new Error("boom"));

    const text = currentLog();
    expect(text).toContain("bench 3 failed:");
    expect(text).toContain("Error: boom");
  });

  it("redacts secrets before writing to disk (NFR-004)", () => {
    installAppLogging();

    console.warn("Authorization: Bearer ghp_1234567890abcdef1234567890abcdef1234");

    const text = currentLog();
    expect(text).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");
    expect(text).toContain("[REDACTED]");
  });

  it("is idempotent: a second install does not double-write a line", () => {
    installAppLogging();
    installAppLogging();

    console.warn("one line");

    const lines = currentLog().trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("rotates current.log to previous.log once it crosses the rotation threshold", () => {
    installAppLogging();

    // One line comfortably past LOG_ROTATION_BYTES (5MB) forces an immediate
    // rotation on this same write, which is cheaper to assert than growing the
    // file to the threshold over many writes.
    console.warn("x".repeat(6 * 1024 * 1024));

    const previousPath = path.join(dir, "previous.log");
    const currentPath = path.join(dir, "current.log");
    expect(fs.existsSync(previousPath)).toBe(true);
    expect(fs.statSync(previousPath).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(fs.existsSync(currentPath)).toBe(false);

    console.warn("fresh line after rotation");
    expect(currentLog()).toContain("fresh line after rotation");
  });

  it("counts an existing current.log from an earlier run toward rotation", () => {
    // A previous launch left the log just under the threshold; a fresh process
    // must rotate on its first write past it rather than start counting at zero.
    fs.writeFileSync(path.join(dir, "current.log"), "x".repeat(5 * 1024 * 1024 - 10));
    installAppLogging();

    console.warn("first line of a new run");

    expect(fs.existsSync(path.join(dir, "previous.log"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "current.log"))).toBe(false);
  });

  it("observes an uncaught exception without changing crash behaviour", () => {
    installAppLogging();
    const err = new Error("simulated crash");

    process.emit("uncaughtExceptionMonitor", err, "uncaughtException");

    expect(currentLog()).toContain("Error: simulated crash");
  });

  it("does not write when NODE_ENV=test and no ROUBO_APP_LOG_DIR override is set", () => {
    delete process.env.ROUBO_APP_LOG_DIR;
    const before = console.warn;

    installAppLogging();

    expect(console.warn).toBe(before);
  });

  it("a write failure (e.g. an unwritable directory) never throws out of console.warn", () => {
    installAppLogging();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, ""); // a file where the log directory used to be: mkdirSync must fail

    expect(() => console.warn("still must not throw")).not.toThrow();

    fs.rmSync(dir, { force: true });
  });
});
