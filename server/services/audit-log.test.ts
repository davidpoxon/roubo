import { describe, it, expect } from "vitest";
import type { AuditEntry } from "@roubo/shared";
import { AuditLog } from "./audit-log.js";

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    pluginId: "plugin-a",
    benchId: 1,
    method: "host.process.start",
    params: { id: "web" },
    outcome: "allowed",
    ...overrides,
  };
}

describe("AuditLog (CP-TC-070/086/092/093/099)", () => {
  it("records an entry and returns it via an unfiltered query (CP-TC-070)", () => {
    const log = new AuditLog();
    const e = entry();
    log.record(e);
    expect(log.query()).toEqual([e]);
  });

  it("filters by plugin (CP-TC-086)", () => {
    const log = new AuditLog();
    const a = entry({ pluginId: "plugin-a", method: "host.process.start" });
    const b = entry({ pluginId: "plugin-b", method: "host.docker.composeUp" });
    log.record(a);
    log.record(b);
    expect(log.query({ pluginId: "plugin-a" })).toEqual([a]);
    expect(log.query({ pluginId: "plugin-b" })).toEqual([b]);
  });

  it("filters by bench (CP-TC-092)", () => {
    const log = new AuditLog();
    const b1 = entry({ benchId: 1, method: "host.ports.get" });
    const b2 = entry({ benchId: 2, method: "host.docker.composeDown" });
    log.record(b1);
    log.record(b2);
    expect(log.query({ benchId: 1 })).toEqual([b1]);
    expect(log.query({ benchId: 2 })).toEqual([b2]);
  });

  it("filters by plugin and bench together", () => {
    const log = new AuditLog();
    const match = entry({ pluginId: "plugin-a", benchId: 1 });
    const wrongBench = entry({ pluginId: "plugin-a", benchId: 2 });
    const wrongPlugin = entry({ pluginId: "plugin-b", benchId: 1 });
    log.record(match);
    log.record(wrongBench);
    log.record(wrongPlugin);
    expect(log.query({ pluginId: "plugin-a", benchId: 1 })).toEqual([match]);
  });

  it("records a denied outcome (CP-TC-093)", () => {
    const log = new AuditLog();
    const denied = entry({ outcome: "denied", method: "host.docker.composeUp" });
    log.record(denied);
    const [recorded] = log.query();
    expect(recorded.outcome).toBe("denied");
  });

  it("returns entries in chronological (insertion) order (CP-TC-099)", () => {
    const log = new AuditLog();
    const first = entry({ ts: "2026-01-01T00:00:01.000Z", method: "host.process.start" });
    const second = entry({ ts: "2026-01-01T00:00:02.000Z", method: "host.docker.composeUp" });
    const third = entry({ ts: "2026-01-01T00:00:03.000Z", method: "host.ports.get" });
    log.record(first);
    log.record(second);
    log.record(third);
    expect(log.query().map((e) => e.method)).toEqual([
      "host.process.start",
      "host.docker.composeUp",
      "host.ports.get",
    ]);
  });

  it("preserves chronological order within a filtered result", () => {
    const log = new AuditLog();
    const a1 = entry({ pluginId: "plugin-a", method: "host.process.start" });
    const b1 = entry({ pluginId: "plugin-b", method: "host.docker.composeUp" });
    const a2 = entry({ pluginId: "plugin-a", method: "host.ports.get" });
    log.record(a1);
    log.record(b1);
    log.record(a2);
    expect(log.query({ pluginId: "plugin-a" })).toEqual([a1, a2]);
  });

  it("returns a copy so callers cannot mutate the store", () => {
    const log = new AuditLog();
    log.record(entry());
    const result = log.query();
    result.pop();
    expect(log.query()).toHaveLength(1);
  });
});
