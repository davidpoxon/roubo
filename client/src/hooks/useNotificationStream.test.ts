// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useNotificationStream } from "./useNotificationStream";
import type { Bench, BenchNotification } from "@roubo/shared";

interface MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
  _fire: (data: unknown) => void;
  _fireError: (event?: Event) => void;
}

function makeMockEventSource(): MockEventSource {
  const source: MockEventSource = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    _fire(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    },
    _fireError(event: Event = new Event("error")) {
      this.onerror?.(event);
    },
  };
  return source;
}

let mockSource: MockEventSource;
const MockEventSource = vi.fn(function MockEventSourceCtor() {
  return mockSource;
});

const showNotification = vi.fn();

function makeNotification(priority: "action-needed" | "info", id = "n1"): BenchNotification {
  return { id, type: "claude-waiting", priority, createdAt: "2024-01-01" };
}

function makeClientBench(overrides?: Partial<Bench>): Bench {
  return {
    id: 1,
    projectId: "p1",
    branch: "bench-1",
    workspacePath: "/ws/p1/bench-1",
    status: "preparing",
    ports: { backend: 5001 },
    components: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    ...overrides,
  } as Bench;
}

beforeEach(() => {
  mockSource = makeMockEventSource();
  vi.stubGlobal("EventSource", MockEventSource);
  showNotification.mockClear();
  Object.defineProperty(window, "roubo", {
    configurable: true,
    value: { showNotification },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Object.defineProperty(window, "roubo", {
    configurable: true,
    value: undefined,
  });
});

describe("useNotificationStream", () => {
  it("opens an EventSource connection on mount", () => {
    renderHookWithProviders(() => useNotificationStream());
    expect(MockEventSource).toHaveBeenCalledWith("/api/notifications/stream");
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHookWithProviders(() => useNotificationStream());
    unmount();
    expect(mockSource.close).toHaveBeenCalled();
  });

  it("invalidates bench queries on notification event", () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHookWithProviders(() => useNotificationStream(), { queryClient });

    mockSource._fire({
      type: "notifications",
      projectId: "proj-1",
      benchId: 2,
      notifications: [],
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["benches"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["bench", "proj-1", 2],
    });
  });

  it("invalidates queries with correct bench and project from event data", () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHookWithProviders(() => useNotificationStream(), { queryClient });

    mockSource._fire({
      type: "notifications",
      projectId: "my-project",
      benchId: 5,
      notifications: [],
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["bench", "my-project", 5],
    });
  });

  it("silently ignores malformed SSE messages", () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHookWithProviders(() => useNotificationStream(), { queryClient });

    expect(() => {
      mockSource.onmessage?.({ data: "not-json" } as MessageEvent);
    }).not.toThrow();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("logs SSE connection errors to console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHookWithProviders(() => useNotificationStream());

    const errorEvent = new Event("error");
    mockSource._fireError(errorEvent);

    expect(consoleSpy).toHaveBeenCalledWith("[useNotificationStream] SSE error:", errorEvent);
    consoleSpy.mockRestore();
  });

  it("fires showNotification for new action-needed notification", () => {
    renderHookWithProviders(() => useNotificationStream());
    mockSource._fire({
      type: "notifications",
      projectId: "p1",
      benchId: 1,
      notifications: [makeNotification("action-needed", "n1")],
    });
    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        routeTo: "roubo://project/p1/bench/1",
      }),
    );
  });

  it("does not fire showNotification for info notifications", () => {
    renderHookWithProviders(() => useNotificationStream());
    mockSource._fire({
      type: "notifications",
      projectId: "p1",
      benchId: 1,
      notifications: [makeNotification("info", "n1")],
    });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("does not re-fire showNotification for the same notification id", () => {
    renderHookWithProviders(() => useNotificationStream());
    const payload = {
      type: "notifications" as const,
      projectId: "p1",
      benchId: 1,
      notifications: [makeNotification("action-needed", "n1")],
    };
    mockSource._fire(payload);
    mockSource._fire(payload);
    expect(showNotification).toHaveBeenCalledOnce();
  });

  it("fires showNotification for different notification ids separately", () => {
    renderHookWithProviders(() => useNotificationStream());
    mockSource._fire({
      type: "notifications",
      projectId: "p1",
      benchId: 1,
      notifications: [makeNotification("action-needed", "n1")],
    });
    mockSource._fire({
      type: "notifications",
      projectId: "p1",
      benchId: 1,
      notifications: [makeNotification("action-needed", "n2")],
    });
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it("does not fire showNotification when window.roubo is undefined", () => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: undefined,
    });
    renderHookWithProviders(() => useNotificationStream());
    expect(() => {
      mockSource._fire({
        type: "notifications",
        projectId: "p1",
        benchId: 1,
        notifications: [makeNotification("action-needed", "n1")],
      });
    }).not.toThrow();
    expect(showNotification).not.toHaveBeenCalled();
  });

  describe("bench-status events", () => {
    it("patches the bench detail cache to the new status without invalidating", () => {
      const queryClient = makeQueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      queryClient.setQueryData<Bench>(["bench", "p1", 1], makeClientBench({ status: "preparing" }));

      renderHookWithProviders(() => useNotificationStream(), { queryClient });

      mockSource._fire({
        type: "bench-status",
        projectId: "p1",
        benchId: 1,
        status: "idle",
      });

      const cached = queryClient.getQueryData<Bench>(["bench", "p1", 1]);
      expect(cached?.status).toBe("idle");
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it("patches the bench in the all-benches list cache to the new status", () => {
      const queryClient = makeQueryClient();
      queryClient.setQueryData<Bench[]>(
        ["benches"],
        [
          makeClientBench({ id: 1, projectId: "p1", status: "preparing" }),
          makeClientBench({ id: 2, projectId: "p1", status: "active" }),
        ],
      );

      renderHookWithProviders(() => useNotificationStream(), { queryClient });

      mockSource._fire({
        type: "bench-status",
        projectId: "p1",
        benchId: 1,
        status: "idle",
      });

      const cached = queryClient.getQueryData<Bench[]>(["benches"]);
      expect(cached?.find((b) => b.id === 1)?.status).toBe("idle");
      expect(cached?.find((b) => b.id === 2)?.status).toBe("active");
    });

    it("patches the per-project benches list cache too", () => {
      const queryClient = makeQueryClient();
      queryClient.setQueryData<Bench[]>(
        ["benches", "p1"],
        [makeClientBench({ id: 1, projectId: "p1", status: "preparing" })],
      );

      renderHookWithProviders(() => useNotificationStream(), { queryClient });

      mockSource._fire({
        type: "bench-status",
        projectId: "p1",
        benchId: 1,
        status: "idle",
      });

      const cached = queryClient.getQueryData<Bench[]>(["benches", "p1"]);
      expect(cached?.[0].status).toBe("idle");
    });

    it("does not fire showNotification on bench-status events", () => {
      renderHookWithProviders(() => useNotificationStream());

      mockSource._fire({
        type: "bench-status",
        projectId: "p1",
        benchId: 1,
        status: "idle",
      });

      expect(showNotification).not.toHaveBeenCalled();
    });

    it("is a no-op when there is no cached bench detail to patch", () => {
      const queryClient = makeQueryClient();

      renderHookWithProviders(() => useNotificationStream(), { queryClient });

      expect(() => {
        mockSource._fire({
          type: "bench-status",
          projectId: "p1",
          benchId: 99,
          status: "idle",
        });
      }).not.toThrow();
    });
  });
});
