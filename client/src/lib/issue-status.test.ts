import { describe, it, expect } from "vitest";
import { statusColor, isHiddenByDefault } from "./issue-status";

describe("statusColor", () => {
  it('returns blue colors for "in progress"', () => {
    const result = statusColor("in progress");
    expect(result.dot).toBe("bg-blue-400");
    expect(result.text).toBe("text-blue-400");
    expect(result.activeBg).toBe("bg-blue-400/10");
    expect(result.activeBorder).toBe("border-blue-400/30");
  });

  it('returns fuchsia colors for "ready"', () => {
    const result = statusColor("ready");
    expect(result.dot).toBe("bg-fuchsia-400");
    expect(result.text).toBe("text-fuchsia-400");
  });

  it('returns cyan colors for "todo"', () => {
    const result = statusColor("todo");
    expect(result.dot).toBe("bg-cyan-400");
    expect(result.text).toBe("text-cyan-400");
  });

  it('returns stone-600 colors for "done"', () => {
    const result = statusColor("done");
    expect(result.dot).toBe("bg-stone-600");
    expect(result.text).toBe("text-stone-600");
  });

  it("returns default stone-500 colors for unknown status", () => {
    const result = statusColor("unknown-status");
    expect(result.dot).toBe("bg-stone-500");
    expect(result.text).toBe("text-stone-500");
    expect(result.activeBg).toBe("bg-stone-500/10");
    expect(result.activeBorder).toBe("border-stone-500/30");
  });

  it("is case-insensitive", () => {
    expect(statusColor("IN PROGRESS").dot).toBe("bg-blue-400");
    expect(statusColor("READY").dot).toBe("bg-fuchsia-400");
    expect(statusColor("TODO").dot).toBe("bg-cyan-400");
    expect(statusColor("DONE").dot).toBe("bg-stone-600");
  });
});

describe("isHiddenByDefault", () => {
  it('returns true for "done"', () => {
    expect(isHiddenByDefault("done")).toBe(true);
  });

  it('returns true for "closed"', () => {
    expect(isHiddenByDefault("closed")).toBe(true);
  });

  it('returns true for "archived"', () => {
    expect(isHiddenByDefault("archived")).toBe(true);
  });

  it('returns true for "cancelled"', () => {
    expect(isHiddenByDefault("cancelled")).toBe(true);
  });

  it('returns false for "in progress"', () => {
    expect(isHiddenByDefault("in progress")).toBe(false);
  });

  it('returns false for "todo"', () => {
    expect(isHiddenByDefault("todo")).toBe(false);
  });

  it('returns false for "ready"', () => {
    expect(isHiddenByDefault("ready")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isHiddenByDefault("DONE")).toBe(true);
    expect(isHiddenByDefault("CLOSED")).toBe(true);
    expect(isHiddenByDefault("IN PROGRESS")).toBe(false);
  });
});
