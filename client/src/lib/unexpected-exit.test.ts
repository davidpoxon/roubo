import { describe, it, expect } from "vitest";
import type { SessionUnexpectedExit } from "@roubo/shared";
import { describeExitCause, formatRunTime, unexpectedExitHint } from "./unexpected-exit";

function exit(overrides: Partial<SessionUnexpectedExit> = {}): SessionUnexpectedExit {
  return {
    exitCode: 137,
    signal: "SIGKILL",
    timeToExitMs: 45 * 60 * 1000,
    endedAt: "2026-10-07T09:00:00.000Z",
    ...overrides,
  };
}

describe("describeExitCause", () => {
  it("names both the signal and the code a wrapper reported", () => {
    expect(describeExitCause(exit())).toBe("SIGKILL (exit 137)");
  });

  it("names a directly signalled child by its signal alone", () => {
    expect(describeExitCause(exit({ exitCode: null }))).toBe("SIGKILL");
  });

  it("names a plain nonzero exit by its code", () => {
    expect(describeExitCause(exit({ exitCode: 3, signal: null }))).toBe("exit code 3");
  });
});

describe("formatRunTime", () => {
  it.each([
    [0, "0 seconds"],
    [1000, "1 second"],
    [30_000, "30 seconds"],
    [60_000, "1 minute"],
    [45 * 60_000, "45 minutes"],
    [60 * 60_000, "1 hour"],
    [125 * 60_000, "2 hours 5 minutes"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatRunTime(ms)).toBe(expected);
  });
});

describe("unexpectedExitHint", () => {
  it("explains a SIGKILL without claiming a cause", () => {
    expect(unexpectedExitHint(exit())).toMatch(/often means the system ran out of memory/);
  });

  it("says nothing for any other cause", () => {
    expect(unexpectedExitHint(exit({ exitCode: 3, signal: null }))).toBeUndefined();
    expect(unexpectedExitHint(exit({ signal: "SIGSEGV", exitCode: 139 }))).toBeUndefined();
  });
});
