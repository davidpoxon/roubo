import { describe, it, expect } from "vitest";
import {
  getHighestPriority,
  hasActionNeeded,
  collectActionNeeded,
  formatNotification,
} from "./notifications";
import type {
  Bench,
  BenchNotification,
  NotificationType,
  NotificationPriority,
} from "@roubo/shared";

function makeNotification(
  priority: BenchNotification["priority"],
  type: BenchNotification["type"] = "agent-waiting",
  id = "1",
): BenchNotification {
  return { id, type, priority, createdAt: new Date().toISOString() };
}

function makeBench(notifications: BenchNotification[]): Bench {
  return {
    id: 1,
    projectId: "p1",
    branch: "main",
    workspacePath: "/tmp",
    status: "active",
    ports: {},
    components: {},
    createdAt: "2024-01-01",
    provisioningSteps: [],
    teardownSteps: [],
    notifications,
  };
}

describe("getHighestPriority", () => {
  it("returns null for empty array", () => {
    expect(getHighestPriority([])).toBeNull();
  });

  it("returns action-needed when any notification has action-needed priority", () => {
    expect(getHighestPriority([makeNotification("action-needed")])).toBe("action-needed");
  });

  it("returns info when all notifications have info priority", () => {
    expect(getHighestPriority([makeNotification("info", "bench-ready")])).toBe("info");
  });

  it("returns action-needed when mixed priorities exist", () => {
    expect(
      getHighestPriority([
        makeNotification("info", "bench-ready"),
        makeNotification("action-needed"),
      ]),
    ).toBe("action-needed");
  });

  it("returns null for non-empty array with unrecognized priority", () => {
    const n = {
      ...makeNotification("info"),
      priority: "unknown" as unknown as NotificationPriority,
    };
    expect(getHighestPriority([n])).toBeNull();
  });
});

describe("hasActionNeeded", () => {
  it("returns false for empty array", () => {
    expect(hasActionNeeded([])).toBe(false);
  });

  it("returns false when all are info", () => {
    expect(hasActionNeeded([makeNotification("info", "bench-ready")])).toBe(false);
  });

  it("returns true when any is action-needed", () => {
    expect(
      hasActionNeeded([makeNotification("info", "bench-ready"), makeNotification("action-needed")]),
    ).toBe(true);
  });
});

describe("collectActionNeeded", () => {
  it("returns empty array for benches with no notifications", () => {
    expect(collectActionNeeded([makeBench([])])).toEqual([]);
  });

  it("filters to action-needed only", () => {
    const n1 = makeNotification("action-needed", "agent-waiting", "a");
    const n2 = makeNotification("info", "bench-ready", "b");
    expect(collectActionNeeded([makeBench([n1, n2])])).toEqual([n1]);
  });

  it("collects across multiple benches", () => {
    const n1 = makeNotification("action-needed", "agent-waiting", "a");
    const n2 = makeNotification("action-needed", "terminal-waiting", "b");
    expect(collectActionNeeded([makeBench([n1]), makeBench([n2])])).toEqual([n1, n2]);
  });

  it("returns empty array for empty benches list", () => {
    expect(collectActionNeeded([])).toEqual([]);
  });
});

describe("formatNotification", () => {
  const actionNeededTypes: NotificationType[] = [
    "agent-waiting",
    "terminal-waiting",
    "bench-error",
    "component-error",
    "agent-exited",
  ];
  const infoTypes: NotificationType[] = ["bench-ready", "inspection-complete"];

  for (const type of [...actionNeededTypes, ...infoTypes]) {
    it(`returns title and body for ${type}`, () => {
      const n = makeNotification(actionNeededTypes.includes(type) ? "action-needed" : "info", type);
      const result = formatNotification(n);
      expect(typeof result.title).toBe("string");
      expect(result.title.length).toBeGreaterThan(0);
      expect(typeof result.body).toBe("string");
      expect(result.body.length).toBeGreaterThan(0);
    });
  }

  it("names no specific AI coding tool in agent-session copy", () => {
    // Any agent plugin's session raises these, so their copy must stay
    // product-neutral (docs/brand.md). Since #521 there is no built-in path
    // left to raise a product-specific one.
    for (const type of ["agent-waiting", "agent-exited"] as NotificationType[]) {
      const { title, body } = formatNotification(makeNotification("action-needed", type));
      expect(`${title} ${body}`).not.toMatch(/claude|codex|gemini|copilot/i);
    }
  });

  it("returns fallback for unknown notification type", () => {
    const n = {
      ...makeNotification("info"),
      type: "unknown-future-type" as NotificationType,
    };
    const result = formatNotification(n);
    expect(result.title).toBe("Notification");
    expect(result.body).toBe("");
  });
});
