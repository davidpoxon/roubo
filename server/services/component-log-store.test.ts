import { describe, it, expect, afterEach } from "vitest";
import {
  appendComponentLog,
  getComponentLogLines,
  hasComponentLogs,
  clearComponentLogs,
  _resetForTest,
} from "./component-log-store.js";
import { MAX_LOG_LINES } from "./process-manager.js";

const P = "proj";
const B = 1;
const C = "db";

afterEach(() => {
  _resetForTest();
});

describe("component-log-store", () => {
  it("returns an empty array and reports no logs for an unknown component", () => {
    expect(getComponentLogLines(P, B, C)).toEqual([]);
    expect(hasComponentLogs(P, B, C)).toBe(false);
  });

  it("appends structured lines and reads them back in order", () => {
    appendComponentLog(P, B, C, { source: "stdout", text: "a", ts: "2026-06-21T00:00:00.000Z" });
    appendComponentLog(P, B, C, { source: "stderr", text: "b", ts: "2026-06-21T00:00:01.000Z" });

    expect(hasComponentLogs(P, B, C)).toBe(true);
    expect(getComponentLogLines(P, B, C)).toEqual([
      { source: "stdout", text: "a", ts: "2026-06-21T00:00:00.000Z" },
      { source: "stderr", text: "b", ts: "2026-06-21T00:00:01.000Z" },
    ]);
  });

  it("keys logs independently per (projectId, benchId, componentName)", () => {
    appendComponentLog(P, B, C, { source: "stdout", text: "db-line", ts: "2026-06-21T00:00:00Z" });
    appendComponentLog(P, B, "api", {
      source: "stdout",
      text: "api-line",
      ts: "2026-06-21T00:00:00Z",
    });
    appendComponentLog("other", B, C, {
      source: "stdout",
      text: "other-line",
      ts: "2026-06-21T00:00:00Z",
    });

    expect(getComponentLogLines(P, B, C).map((l) => l.text)).toEqual(["db-line"]);
    expect(getComponentLogLines(P, B, "api").map((l) => l.text)).toEqual(["api-line"]);
    expect(getComponentLogLines("other", B, C).map((l) => l.text)).toEqual(["other-line"]);
  });

  it("honours the tail argument", () => {
    for (let i = 0; i < 10; i++) {
      appendComponentLog(P, B, C, {
        source: "stdout",
        text: `line-${i}`,
        ts: `2026-06-21T00:00:0${i}.000Z`,
      });
    }
    expect(getComponentLogLines(P, B, C, 3).map((l) => l.text)).toEqual([
      "line-7",
      "line-8",
      "line-9",
    ]);
  });

  it("evicts oldest lines past MAX_LOG_LINES (ring buffer)", () => {
    for (let i = 0; i < MAX_LOG_LINES + 5; i++) {
      appendComponentLog(P, B, C, {
        source: "stdout",
        text: `line-${i}`,
        ts: new Date(i).toISOString(),
      });
    }
    const all = getComponentLogLines(P, B, C, MAX_LOG_LINES + 100);
    expect(all.length).toBe(MAX_LOG_LINES);
    // First five lines were evicted; oldest retained is line-5.
    expect(all[0].text).toBe("line-5");
    expect(all[all.length - 1].text).toBe(`line-${MAX_LOG_LINES + 4}`);
  });

  it("clamps a backwards timestamp forward so the tail stays monotonic (AC4)", () => {
    appendComponentLog(P, B, C, {
      source: "stdout",
      text: "first",
      ts: "2026-06-21T00:00:05.000Z",
    });
    // A re-clocked line from before the last ts must not move the tail backwards.
    appendComponentLog(P, B, C, {
      source: "stdout",
      text: "second",
      ts: "2026-06-21T00:00:01.000Z",
    });

    const lines = getComponentLogLines(P, B, C);
    expect(lines.map((l) => l.ts)).toEqual([
      "2026-06-21T00:00:05.000Z",
      "2026-06-21T00:00:05.000Z",
    ]);
    // Timestamps are non-decreasing.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].ts >= lines[i - 1].ts).toBe(true);
    }
  });

  it("drops an exact consecutive duplicate (backlog replay on reconnect) (AC4)", () => {
    const line = { source: "stdout" as const, text: "boot", ts: "2026-06-21T00:00:00.000Z" };
    appendComponentLog(P, B, C, line);
    appendComponentLog(P, B, C, { ...line });

    expect(getComponentLogLines(P, B, C)).toEqual([line]);
  });

  it("keeps a non-consecutive repeat of the same text (not a dup)", () => {
    appendComponentLog(P, B, C, { source: "stdout", text: "tick", ts: "2026-06-21T00:00:00.000Z" });
    appendComponentLog(P, B, C, { source: "stdout", text: "tock", ts: "2026-06-21T00:00:01.000Z" });
    appendComponentLog(P, B, C, { source: "stdout", text: "tick", ts: "2026-06-21T00:00:02.000Z" });

    expect(getComponentLogLines(P, B, C).map((l) => l.text)).toEqual(["tick", "tock", "tick"]);
  });

  it("retains pre-restart logs across a Stop -> Start cycle and appends new ones monotonically (AC4)", () => {
    // Pre-restart output.
    appendComponentLog(P, B, C, {
      source: "stdout",
      text: "before-1",
      ts: "2026-06-21T00:00:00.000Z",
    });
    appendComponentLog(P, B, C, {
      source: "stdout",
      text: "before-2",
      ts: "2026-06-21T00:00:01.000Z",
    });

    // A Stop -> Start cycle does NOT clear the store (no clearComponentLogs call);
    // post-restart output appends to the same buffer.
    appendComponentLog(P, B, C, {
      source: "stdout",
      text: "after-1",
      ts: "2026-06-21T00:00:02.000Z",
    });

    const lines = getComponentLogLines(P, B, C);
    expect(lines.map((l) => l.text)).toEqual(["before-1", "before-2", "after-1"]);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].ts >= lines[i - 1].ts).toBe(true);
    }
  });

  it("clears logs explicitly (teardown), not on a restart", () => {
    appendComponentLog(P, B, C, { source: "stdout", text: "x", ts: "2026-06-21T00:00:00.000Z" });
    expect(hasComponentLogs(P, B, C)).toBe(true);

    clearComponentLogs(P, B, C);
    expect(hasComponentLogs(P, B, C)).toBe(false);
    expect(getComponentLogLines(P, B, C)).toEqual([]);
  });
});
