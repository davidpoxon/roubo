import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./exec.js");

import { runCommand } from "./exec.js";
import {
  parseVersion,
  isAtLeast,
  detectClaudeAutoMode,
  getClaudeAutoModeInfo,
  resetCache,
} from "./claude-version.js";

describe("parseVersion", () => {
  it('extracts version from "Claude Code X.Y.Z" format', () => {
    expect(parseVersion("Claude Code 2.1.83\n")).toBe("2.1.83");
  });

  it("extracts a bare version string", () => {
    expect(parseVersion("2.1.83")).toBe("2.1.83");
  });

  it("extracts version embedded in longer output", () => {
    expect(parseVersion("claude/2.1.83 node/20.0.0")).toBe("2.1.83");
  });

  it("returns null when no version found", () => {
    expect(parseVersion("no version here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseVersion("")).toBeNull();
  });
});

describe("isAtLeast", () => {
  it("returns true when version equals minimum", () => {
    expect(isAtLeast("2.1.83", "2.1.83")).toBe(true);
  });

  it("returns true when patch is higher", () => {
    expect(isAtLeast("2.1.84", "2.1.83")).toBe(true);
  });

  it("returns true when minor is higher", () => {
    expect(isAtLeast("2.2.0", "2.1.83")).toBe(true);
  });

  it("returns true when major is higher", () => {
    expect(isAtLeast("3.0.0", "2.1.83")).toBe(true);
  });

  it("returns false when patch is lower", () => {
    expect(isAtLeast("2.1.82", "2.1.83")).toBe(false);
  });

  it("returns false when minor is lower", () => {
    expect(isAtLeast("2.0.99", "2.1.83")).toBe(false);
  });

  it("returns false when major is lower", () => {
    expect(isAtLeast("1.99.99", "2.1.83")).toBe(false);
  });
});

describe("detectClaudeAutoMode", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
    resetCache();
  });

  it("returns unavailable when both direct and login-shell attempts fail", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 1, stdout: "", stderr: "command not found" });

    const result = await detectClaudeAutoMode();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not installed/i);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "claude",
      ["--version"],
      expect.any(String),
      undefined,
      5000,
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "sh",
      ["-lc", "claude --version"],
      expect.any(String),
      undefined,
      5000,
    );
  });

  it("succeeds via login-shell fallback when direct spawn fails", async () => {
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "command not found" })
      .mockResolvedValueOnce({ code: 0, stdout: "Claude Code 2.1.83", stderr: "" });

    const result = await detectClaudeAutoMode();
    expect(result.available).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable when output contains no version", async () => {
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: "some malformed output",
      stderr: "",
    });

    const result = await detectClaudeAutoMode();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/could not be determined/i);
  });

  it("returns unavailable when version is below minimum", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "Claude Code 2.1.82", stderr: "" });

    const result = await detectClaudeAutoMode();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/does not support auto mode/i);
    expect(result.reason).toContain("2.1.82");
  });

  it("returns available when version equals the minimum", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "Claude Code 2.1.83", stderr: "" });

    const result = await detectClaudeAutoMode();
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns available when version is newer than minimum", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "Claude Code 3.0.0", stderr: "" });

    const result = await detectClaudeAutoMode();
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("calls runCommand with claude --version", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "2.1.83", stderr: "" });

    await detectClaudeAutoMode();
    expect(runCommand).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.any(String),
      undefined,
      5000,
    );
  });

  it("propagates errors thrown by runCommand", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("spawn error"));
    await expect(detectClaudeAutoMode()).rejects.toThrow("spawn error");
  });
});

describe("getClaudeAutoModeInfo", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
    resetCache();
  });

  it("returns cached result without re-running after detectClaudeAutoMode", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "2.1.83", stderr: "" });

    await detectClaudeAutoMode();
    await getClaudeAutoModeInfo();

    // runCommand should only have been called once (by detectClaudeAutoMode)
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("runs detection when cache is empty", async () => {
    // Cache is reset in beforeEach — getClaudeAutoModeInfo must call detectClaudeAutoMode internally
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: "2.1.83", stderr: "" });

    const result = await getClaudeAutoModeInfo();
    expect(result.available).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
