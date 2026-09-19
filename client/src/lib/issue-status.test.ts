import { describe, it, expect } from "vitest";
import { statusColor, isHiddenByDefault } from "./issue-status";

describe("statusColor", () => {
  it('returns the in-progress project-status token for "in progress"', () => {
    const result = statusColor("in progress");
    expect(result.dot).toBe("bg-project-status-in-progress");
    expect(result.text).toBe("text-text-secondary");
    expect(result.activeBg).toBe("bg-project-status-in-progress/10");
    expect(result.activeBorder).toBe("border-project-status-in-progress/30");
  });

  it('returns the ready project-status token for "ready"', () => {
    expect(statusColor("ready").dot).toBe("bg-project-status-ready");
  });

  it('returns the todo project-status token for "todo"', () => {
    expect(statusColor("todo").dot).toBe("bg-project-status-todo");
  });

  it('returns the idle status token for "done"', () => {
    expect(statusColor("done").dot).toBe("bg-status-idle");
  });

  it("never lets a categorical hue carry text", () => {
    for (const status of ["in progress", "ready", "todo", "done", "unknown-status"]) {
      expect(statusColor(status).text).toBe("text-text-secondary");
    }
  });

  it("returns the idle status token for an unknown status", () => {
    const result = statusColor("unknown-status");
    expect(result.dot).toBe("bg-status-idle");
    expect(result.activeBg).toBe("bg-status-idle/10");
    expect(result.activeBorder).toBe("border-status-idle/30");
  });

  it("is case-insensitive", () => {
    expect(statusColor("IN PROGRESS").dot).toBe("bg-project-status-in-progress");
    expect(statusColor("READY").dot).toBe("bg-project-status-ready");
    expect(statusColor("TODO").dot).toBe("bg-project-status-todo");
    expect(statusColor("DONE").dot).toBe("bg-status-idle");
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
