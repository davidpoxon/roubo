import { describe, it, expect } from "vitest";
import {
  getHighestPriority,
  hasActionNeeded,
  collectActionNeeded,
  formatNotification,
  notificationRouteTo,
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
    "agent-exited-unexpectedly",
    "delivery-jam",
    "delivery-decision",
  ];
  const infoTypes: NotificationType[] = ["bench-ready"];

  it("SB-TC-036: shows the question of a delivery-decision notification", () => {
    const n = {
      ...makeNotification("action-needed", "delivery-decision"),
      metadata: { decisionId: "decision-1", question: "One file per unit or one per stack?" },
    };
    expect(formatNotification(n)).toEqual({
      title: "Delivery decision decision-1",
      body: "One file per unit or one per stack?",
    });
  });

  it("a delivery-decision notification names its decision and links to the pile", () => {
    const n = {
      ...makeNotification("action-needed", "delivery-decision"),
      metadata: { decisionId: "decision-1", question: "One file per unit or one per stack?" },
    };
    expect(formatNotification(n).title).toBe("Delivery decision decision-1");
    expect(notificationRouteTo("p1", 2, n)).toBe("roubo://project/p1/bench/2/decisions");
    // A review call waits on the same pile.
    const review = {
      ...makeNotification("action-needed", "delivery-decision"),
      metadata: { review: true, count: 2 },
    };
    expect(notificationRouteTo("p1", 2, review)).toBe("roubo://project/p1/bench/2/decisions");
    // Every other notification leads to the bench.
    expect(notificationRouteTo("p1", 2, makeNotification("action-needed", "delivery-jam"))).toBe(
      "roubo://project/p1/bench/2",
    );
  });

  it("SB-TC-081: composes a review call's notification from its count alone", () => {
    const n = {
      ...makeNotification("action-needed", "delivery-decision"),
      dedupeKey: "review:demo-delivery-1:boundary:D-1",
      metadata: { review: true, count: 3 },
    };
    expect(formatNotification(n)).toEqual({
      title: "Delivery review",
      body: "3 agent decisions wait for your review",
    });
  });

  it("SB-TC-103: carries the count 100 in a review call's notification", () => {
    const n = {
      ...makeNotification("action-needed", "delivery-decision"),
      metadata: { review: true, count: 100 },
    };
    expect(formatNotification(n).body).toBe("100 agent decisions wait for your review");
  });

  it("SB-TC-047: names the jammed unit in a delivery-jam notification", () => {
    const n = {
      ...makeNotification("action-needed", "delivery-jam"),
      metadata: { unitId: "B", status: "jammed" },
    };
    expect(formatNotification(n)).toEqual({
      title: "Delivery unit jammed",
      body: "Unit B of the delivery is jammed and waits for you",
    });
  });

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
    // product-neutral (docs/brand.md). Since #1114 there is no built-in path
    // left to raise a product-specific one.
    for (const type of [
      "agent-waiting",
      "agent-exited",
      "agent-exited-unexpectedly",
    ] as NotificationType[]) {
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
