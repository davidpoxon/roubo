import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./state.js", () => ({
  updateBench: vi.fn(),
}));

vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
}));

import * as stateService from "./state.js";
import * as sseService from "./sse.js";
import { makeBench } from "../test/fixtures.js";
import {
  createNotification,
  dismissBenchLevelForBench,
  dismissBySession,
  dismissOne,
  dismissSyncErrorForWorkUnit,
  dismissWaitingForSession,
  getNotifications,
} from "./notification.js";

const mockUpdateBench = vi.mocked(stateService.updateBench);
const mockBroadcast = vi.mocked(sseService.broadcast);

beforeEach(() => {
  vi.clearAllMocks();
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

  it("assigns action-needed priority for claude-waiting", () => {
    const bench = makeBench();
    const result = createNotification(bench, "claude-waiting", "session-1");
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

  it("assigns action-needed priority for claude-exited", () => {
    const bench = makeBench();
    const result = createNotification(bench, "claude-exited", "session-1");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns info priority for bench-ready", () => {
    const bench = makeBench();
    const result = createNotification(bench, "bench-ready");
    expect(result.priority).toBe("info");
  });

  it("assigns info priority for inspection-complete", () => {
    const bench = makeBench();
    const result = createNotification(bench, "inspection-complete");
    expect(result.priority).toBe("info");
  });

  it("assigns action-needed priority for terminal-waiting", () => {
    const bench = makeBench();
    const result = createNotification(bench, "terminal-waiting", "session-1");
    expect(result.priority).toBe("action-needed");
  });

  it("assigns action-needed priority for sync-error", () => {
    const bench = makeBench();
    const result = createNotification(bench, "sync-error", "sync-error::api");
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

  it("deduplicates sync-error by submodule via sourceSessionId and updates error message in-place", () => {
    const bench = makeBench();

    const first = createNotification(bench, "sync-error", "sync-error::api", {
      submodule: "api",
      error: "rate limited",
    });
    vi.clearAllMocks();

    const second = createNotification(bench, "sync-error", "sync-error::api", {
      submodule: "api",
      error: "rate limited again",
    });

    expect(second).toBe(first);
    expect(bench.notifications).toHaveLength(1);
    expect(second.metadata).toEqual({ submodule: "api", error: "rate limited again" });
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("creates separate sync-error notifications for different submodules", () => {
    const bench = makeBench();

    createNotification(bench, "sync-error", "sync-error::api", {
      submodule: "api",
      error: "rate limited",
    });
    createNotification(bench, "sync-error", "sync-error::frontend", {
      submodule: "frontend",
      error: "auth failed",
    });

    expect(bench.notifications).toHaveLength(2);
  });

  it("stores metadata on the notification", () => {
    const bench = makeBench();
    const result = createNotification(bench, "inspection-complete", undefined, { passed: true });
    expect(result.metadata).toEqual({ passed: true });
  });

  it("deduplicates when same type and sourceSessionId exist", () => {
    const bench = makeBench();

    const first = createNotification(bench, "claude-waiting", "session-1");
    vi.clearAllMocks();

    const second = createNotification(bench, "claude-waiting", "session-1");

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

    createNotification(bench, "claude-exited", "session-1");
    createNotification(bench, "claude-waiting", "session-1");

    expect(bench.notifications).toHaveLength(2);
  });

  it("does not deduplicate when sourceSessionId differs", () => {
    const bench = makeBench();

    createNotification(bench, "claude-exited", "session-1");
    createNotification(bench, "claude-exited", "session-2");

    expect(bench.notifications).toHaveLength(2);
  });

  it("stores sourceSessionId on the notification", () => {
    const bench = makeBench();

    const result = createNotification(bench, "claude-waiting", "session-abc");

    expect(result.sourceSessionId).toBe("session-abc");
  });

  it("generates unique IDs for each notification", () => {
    const bench = makeBench();
    const first = createNotification(bench, "claude-exited", "session-1");
    const second = createNotification(bench, "bench-ready");

    expect(first.id).not.toBe(second.id);
  });

  it("forwards workUnits when persisting", () => {
    const workUnits = [
      {
        submodule: "api",
        branch: "feat/my-feature",
        workspacePath: "/workspace/api",
        pullRequest: {
          repoFullName: "acme/api",
          number: 42,
          title: "My feature",
          state: "open" as const,
          merged: false,
          url: "https://github.com/acme/api/pull/42",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ];
    const bench = makeBench({ workUnits });

    createNotification(bench, "bench-ready");

    expect(mockUpdateBench).toHaveBeenCalledWith(expect.objectContaining({ workUnits }));
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
});

describe("dismissBenchLevelForBench", () => {
  it("removes bench-level notifications and keeps session-scoped ones", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "claude-waiting",
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
        type: "claude-waiting",
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

  it("preserves sync-error notification so it is not silently auto-dismissed on bench open", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "sync-error",
        priority: "action-needed",
        sourceSessionId: "sync-error::api",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissBenchLevelForBench(bench);

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
  });
});

describe("dismissSyncErrorForWorkUnit", () => {
  it("removes the sync-error notification for the given submodule", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "sync-error",
        priority: "action-needed",
        sourceSessionId: "sync-error::api",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { id: "n2", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    dismissSyncErrorForWorkUnit(bench, "api");

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

  it("does not affect sync-error notifications for other submodules", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "sync-error",
        priority: "action-needed",
        sourceSessionId: "sync-error::api",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n2",
        type: "sync-error",
        priority: "action-needed",
        sourceSessionId: "sync-error::frontend",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    dismissSyncErrorForWorkUnit(bench, "api");

    expect(bench.notifications).toHaveLength(1);
    expect(bench.notifications[0].id).toBe("n2");
  });

  it("is a no-op when no sync-error notification exists for the submodule", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    dismissSyncErrorForWorkUnit(bench, "api");

    expect(bench.notifications).toHaveLength(1);
    expect(mockUpdateBench).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("dismissOne", () => {
  it("removes the notification with the matching ID", () => {
    const bench = makeBench();
    bench.notifications = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "n2",
        type: "claude-waiting",
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
        type: "claude-exited",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n2",
        type: "claude-waiting",
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
  it("removes only terminal-waiting and claude-waiting notifications for the session", () => {
    const bench = makeBench();
    bench.notifications = [
      {
        id: "n1",
        type: "claude-waiting",
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
        type: "claude-exited",
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
        type: "claude-waiting",
        priority: "action-needed",
        sourceSessionId: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "n2",
        type: "claude-waiting",
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
        type: "claude-exited",
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
