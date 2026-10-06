import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./state.js", async (importOriginal) => ({
  updateBench: vi.fn(),
  toPersistedBench: (await importOriginal<typeof import("./state.js")>()).toPersistedBench,
}));

vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
}));

// Notifications persist through a background guard on the in-memory bench map.
// Mock the bench-manager boundary so the guard is controllable and the real,
// heavy module stays out of these unit tests. Default: the bench is live.
const benchManagerMocks = vi.hoisted(() => ({
  isBenchLive: vi.fn<(projectId: string, benchId: number) => boolean>(() => true),
}));
vi.mock("./bench-manager.js", () => benchManagerMocks);

import * as stateService from "./state.js";
import * as sseService from "./sse.js";
import { makeBench } from "../test/fixtures.js";
import {
  createNotification,
  dismissBenchLevelForBench,
  dismissBySession,
  dismissOne,
  dismissWaitingForSession,
  getNotifications,
} from "./notification.js";

const mockUpdateBench = vi.mocked(stateService.updateBench);
const mockBroadcast = vi.mocked(sseService.broadcast);

beforeEach(() => {
  vi.clearAllMocks();
  benchManagerMocks.isBenchLive.mockReturnValue(true);
});

describe("createNotification", () => {
  it("creates a notification, adds it to bench, and persists", () => {
    const bench = makeBench();

    const result = createNotification(bench, "bench-ready");

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0]).toBe(result);
    expect(result.type).toBe("bench-ready");
    expect(result.priority).toBe("info");
    expect(result.id).toBeTypeOf("string");
    expect(result.createdAt).toBeTypeOf("string");
    expect(result.sourceSessionId).toBeUndefined();
    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({ notifications: bench.notifications }),
    );
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notifications",
      projectId: "test-project",
      benchId: 1,
      notifications: bench.notifications,
    });
  });

  it("preserves benchSetupComplete when persisting (#997)", () => {
    // updateBench replaces the whole record, so omitting the flag would erase it
    // from state.json, and initialize hydrates an absent flag as `true`. The
    // bench-error notification fires on the failed-setup path that must stay
    // retryable, so a dropped `false` would make a failed setup look complete.
    const bench = makeBench({ benchSetupComplete: false });

    createNotification(bench, "bench-error");

    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({ benchSetupComplete: false }),
    );
  });

  it("does not persist a bench teardown already cleared (#1191)", () => {
    // A late PTY-driven notification must not write the bench back into
    // state.json: the record would outlive the cleared bench, block unregister
    // and hydrate back into the UI on the next launch.
    benchManagerMocks.isBenchLive.mockReturnValue(false);
    const bench = makeBench();

    const result = createNotification(bench, "terminal-waiting", "session-1");

    expect(result).toBeDefined();
    expect(mockUpdateBench).not.toHaveBeenCalled();
    // The in-memory notification and its SSE broadcast still happen; only the
    // durable write is suppressed.
    expect(bench.notifications).toHaveLength(1);
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it("assigns action-needed priority for agent-waiting", () => {
    const bench = makeBench();
    const result = createNotification(bench, "agent-waiting", "session-1");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns action-needed priority for bench-error", () => {
    const bench = makeBench();
    const result = createNotification(bench, "bench-error");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns action-needed priority for component-error", () => {
    const bench = makeBench();
    const result = createNotification(bench, "component-error");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns action-needed priority for agent-exited", () => {
    const bench = makeBench();
    const result = createNotification(bench, "agent-exited", "session-1");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns info priority for bench-ready", () => {
    const bench = makeBench();
    const result = createNotification(bench, "bench-ready");
    expect(result.priority).toBe("info");
  });

  it("assigns action-needed priority for terminal-waiting", () => {
    const bench = makeBench();
    const result = createNotification(bench, "terminal-waiting", "session-1");
    expect(result.priority).toBe("action-needed");
  });

  it("deduplicates terminal-waiting for the same session", () => {
    const bench = makeBench();

    const first = createNotification(bench, "terminal-waiting", "session-1");
    vi.clearAllMocks();

    const second = createNotification(bench, "terminal-waiting", "session-1");

    expect(second).toBe(first);
    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("stores metadata on the notification", () => {
    const bench = makeBench();
    const result = createNotification(bench, "bench-error", undefined, { step: "setup" });
    expect(result.metadata).toEqual({ step: "setup" });
  });

  it("deduplicates when same type and sourceSessionId exist", () => {
    const bench = makeBench();

    const first = createNotification(bench, "agent-waiting", "session-1");
    vi.clearAllMocks();

    const second = createNotification(bench, "agent-waiting", "session-1");

    expect(second).toBe(first);
    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("deduplicates when same type and both sourceSessionId are undefined", () => {
    const bench = makeBench();

    const first = createNotification(bench, "bench-ready");
    vi.clearAllMocks();

    const second = createNotification(bench, "bench-ready");

    expect(second).toBe(first);
    expect(bench.notifications).toHaveLength(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("does not deduplicate when type differs", () => {
    const bench = makeBench();

    createNotification(bench, "agent-exited", "session-1");
    createNotification(bench, "agent-waiting", "session-1");

    expect(bench.notifications).toHaveLength(2);
  });

  it("does not deduplicate when sourceSessionId differs", () => {
    const bench = makeBench();

    createNotification(bench, "agent-exited", "session-1");
    createNotification(bench, "agent-exited", "session-2");

    expect(bench.notifications).toHaveLength(2);
  });

  it("stores sourceSessionId on the notification", () => {
    const bench = makeBench();

    const result = createNotification(bench, "agent-waiting", "session-abc");

    expect(result.sourceSessionId).toBe("session-abc");
  });

  it("generates unique IDs for each notification", () => {
    const bench = makeBench();
    const first = createNotification(bench, "agent-exited", "session-1");
    const second = createNotification(bench, "bench-ready");

    expect(first.id).not.toBe(second.id);
  });

  it("preserves injectedJigId when persisting", () => {
    const bench = makeBench({ injectedJigId: "my-jig" });

    createNotification(bench, "bench-ready");

    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigId: "my-jig" }),
    );
  });

  it("preserves injectedJigSource when persisting", () => {
    const bench = makeBench({
      injectedJigId: "my-jig",
      injectedJigSource: "issue-type-mapping",
    });

    createNotification(bench, "bench-ready");

    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "issue-type-mapping" }),
    );
  });

  it("assigns action-needed priority for agent-launch-failed", () => {
    const bench = makeBench();
    const result = createNotification(bench, "agent-launch-failed");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns info priority for agent-fallback", () => {
    const bench = makeBench();
    const result = createNotification(bench, "agent-fallback");
    expect(result.priority).toBe("info");
  });

  it("stores launchFailure on the notification", () => {
    const bench = makeBench();
    const failure = {
      class: "missing-binary" as const,
      message: 'Acme Agent could not start: the "acme" CLI was not found.',
      guidance: "Install the agent CLI. Tried: /usr/bin/acme, /opt/acme/bin/acme.",
      actions: ["open-plugin-settings" as const, "retry" as const],
    };

    const result = createNotification(bench, "agent-launch-failed", undefined, undefined, failure);

    expect(result.launchFailure).toEqual(failure);
  });

  it("redacts captured output in launchFailure before persisting (NFR-004)", () => {
    const bench = makeBench();
    const failure = {
      class: "launch-failure" as const,
      message: "Acme Agent failed to launch: exited in 0.2s.",
      actions: [] as const,
      capturedOutput: "Authorization: Bearer ghp_1234567890abcdef1234567890abcdef1234",
    };

    const result = createNotification(bench, "agent-launch-failed", undefined, undefined, failure);

    expect(result.launchFailure?.capturedOutput).not.toContain(
      "ghp_1234567890abcdef1234567890abcdef1234",
    );
    expect(result.launchFailure?.capturedOutput).toContain("[REDACTED]");
  });

  it("overwrites the stale launchFailure on a repeat failure and persists it (dedupe fix)", () => {
    const bench = makeBench();
    const first = createNotification(bench, "agent-launch-failed", undefined, undefined, {
      class: "missing-binary" as const,
      message: "first failure",
      actions: [] as const,
    });
    vi.clearAllMocks();

    const second = createNotification(bench, "agent-launch-failed", undefined, undefined, {
      class: "launch-failure" as const,
      message: "second failure",
      actions: [] as const,
    });

    // Previously this branch mutated the in-memory record but never called
    // updateBench or broadcast, so a second failure's detail never reached
    // state.json or an already-open dashboard.
    expect(second).toBe(first);
    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].launchFailure?.message).toBe("second failure");
    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: expect.arrayContaining([
          expect.objectContaining({
            launchFailure: expect.objectContaining({ message: "second failure" }),
          }),
        ]),
      }),
    );
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it("clears a stale launchFailure when a repeat carries only a message", () => {
    const bench = makeBench();
    createNotification(bench, "agent-launch-failed", undefined, undefined, {
      class: "missing-binary" as const,
      message: "structured failure",
      actions: [] as const,
    });

    createNotification(bench, "agent-launch-failed", undefined, { message: "no agent resolved" });

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].launchFailure).toBeUndefined();
    expect(bench.notifications[0].metadata).toEqual({ message: "no agent resolved" });
  });

  it("does not persist or broadcast a repeat whose payload is unchanged", () => {
    // terminal.ts repeats agent-waiting with the same label on every idle tick.
    const bench = makeBench();
    createNotification(bench, "agent-waiting", "s1", { label: "Claude" });
    vi.clearAllMocks();

    createNotification(bench, "agent-waiting", "s1", { label: "Claude" });

    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("persists the full bench record on a repeat, not a hand-listed subset", () => {
    // updateBench replaces the whole record, so any field left out of the write
    // is erased from state.json.
    const bench = makeBench({ variant: "testbench", focusedSpecPath: "specs/a" });
    createNotification(bench, "agent-waiting", "s1", { label: "first" });
    vi.clearAllMocks();

    createNotification(bench, "agent-waiting", "s1", { label: "second" });

    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "testbench",
        focusedSpecPath: "specs/a",
        componentSetupState: { backend: true },
      }),
    );
  });
});

describe("dismissBenchLevelForBench", () => {
  it("removes bench-level notifications and keeps session-scoped ones", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "s1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissBenchLevelForBench(bench);

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
    expect(mockUpdateBench).toHaveBeenCalledWith(
      expect.objectContaining({ notifications: bench.notifications }),
    );
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notifications",
      projectId: "test-project",
      benchId: 1,
      notifications: bench.notifications,
    });
  });

  it("is a no-op when only session-scoped notifications exist", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "s1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissBenchLevelForBench(bench);

    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("is a no-op when no notifications exist", () => {
    const bench = makeBench();

    dismissBenchLevelForBench(bench);

    expect(bench.notifications).toHaveLength(0);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("preserves session-scoped notifications so they are not silently auto-dismissed on bench open", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "component-error",
        priority: "action-needed",
        sourceSessionId: "component-error::api",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissBenchLevelForBench(bench);

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
  });

  // AP-NFR-003: a failed auto-launch has to stay visible until the user
  // dismisses it explicitly, so opening the bench (which calls this) must not
  // clear it the way an ordinary bench-level notice is cleared.
  it("keeps an agent-launch-failed notification when bench-level notifications are dismissed", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "agent-launch-failed",
        priority: "action-needed",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissBenchLevelForBench(bench);

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
  });

  it("keeps an agent-fallback notification, which is sticky until dismissed explicitly", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "agent-fallback", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    dismissBenchLevelForBench(bench);

    expect(bench.notifications.map((n) => n.id)).toEqual(["n1"]);
  });
});
describe("dismissOne", () => {
  it("removes the notification with the matching ID", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "s1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissOne(bench, "n1");

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
    expect(mockUpdateBench).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notifications",
      projectId: "test-project",
      benchId: 1,
      notifications: bench.notifications,
    });
  });

  it("is a no-op when ID does not match", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    dismissOne(bench, "nonexistent");

    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("dismissBySession", () => {
  it("removes all notifications with matching sourceSessionId", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "agent-exited",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n2",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { id: "n3", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    dismissBySession(bench, "session-1");

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n3");
    expect(mockUpdateBench).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notifications",
      projectId: "test-project",
      benchId: 1,
      notifications: bench.notifications,
    });
  });

  it("is a no-op when no notifications match the session", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    dismissBySession(bench, "session-x");

    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("is a no-op when bench has no notifications", () => {
    const bench = makeBench();

    dismissBySession(bench, "session-x");

    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("dismissWaitingForSession", () => {
  it("removes only terminal-waiting and agent-waiting notifications for the session", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n2",
        type: "terminal-waiting",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n3",
        type: "agent-exited",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { id: "n4", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    const result = dismissWaitingForSession(bench, "session-1");

    expect(result).toBe(true);
    expect(bench.notifications.map((n) => n.id)).toEqual(["n3", "n4"]);
    expect(mockUpdateBench).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: "notifications",
      projectId: "test-project",
      benchId: 1,
      notifications: bench.notifications,
    });
  });

  it("does not affect waiting notifications for other sessions", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n2",
        type: "agent-waiting",
        priority: "action-needed",
        sourceSessionId: "session-2",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const result = dismissWaitingForSession(bench, "session-1");

    expect(result).toBe(true);
    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
  });

  it("returns false and does not persist or broadcast when nothing matches", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "agent-exited",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const result = dismissWaitingForSession(bench, "session-1");

    expect(result).toBe(false);
    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("getNotifications", () => {
  it("returns a copy of the notifications array from the bench", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    const result = getNotifications(bench);

    expect(result).not.toBe(bench.notifications);
    expect(result).toEqual(bench.notifications);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when bench has no notifications", () => {
    const bench = makeBench();

    const result = getNotifications(bench);

    expect(result).toEqual([]);
  });
});
