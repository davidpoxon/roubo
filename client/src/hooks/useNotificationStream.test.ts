// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderHookWithProviders, makeQueryClient } from "../test/renderWithProviders";
import { useNotificationStream } from "./useNotificationStream";
import { deliveryQueryKey, useDelivery } from "./useDelivery";
import {
  INPUT_SURFACES,
  type Bench,
  type BenchNotification,
  type InputChangedEvent,
} from "@roubo/shared";
import { subscribeInputChanged } from "../lib/input-changed";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchDelivery: vi.fn() };
});

interface MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  _fire: (data: unknown) => void;
  _fireError: (event?: Event) => void;
  _open: () => void;
}

function makeMockEventSource(): MockEventSource {
  const source: MockEventSource = {
    onmessage: null,
    onerror: null,
    onopen: null,
    readyState: 0,
    close: vi.fn(),
    _fire(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    },
    _fireError(event: Event = new Event("error")) {
      this.onerror?.(event);
    },
    _open() {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    },
  };
  return source;
}

// Each construction opens a new mock connection; `mockSource` is the latest.
let mockSource: MockEventSource;
const MockEventSource = vi.fn(function MockEventSourceCtor() {
  mockSource = makeMockEventSource();
  return mockSource;
});

const showNotification = vi.fn();

function makeNotification(priority: "action-needed" | "info", id = "n1"): BenchNotification {
  return { id, type: "agent-waiting", priority, createdAt: "2024-01-01" };
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

  describe("delivery frames", () => {
    function snapshot(seq: number): DeliverySnapshot {
      return { deliveryId: "d1", seq } as DeliverySnapshot;
    }

    function frame(seq: number, change: "snapshot" | "controls" = "snapshot") {
      return { type: "delivery", projectId: "p1", benchId: 1, change, seq };
    }

    it("SB-TC-037 a held snapshot is read again after a decision answer at the same seq", async () => {
      const queryClient = makeQueryClient();
      const fetchDelivery = vi.mocked(api.fetchDelivery);
      fetchDelivery.mockResolvedValue({ ...snapshot(7), controls: [] } as DeliverySnapshot);
      const { result } = renderHookWithProviders(
        () => {
          useNotificationStream();
          return useDelivery("p1", 1);
        },
        { queryClient },
      );
      await waitFor(() => expect(result.current.data?.seq).toBe(7));
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      // The answer adds no event, so the server's frame carries the seq the
      // client holds; a snapshot frame at that seq is skipped...
      act(() => mockSource._fire(frame(7)));
      expect(invalidateSpy).not.toHaveBeenCalled();

      // ...but the controls frame is not: the client reads the snapshot again
      // and shows the answer pending.
      const pending = { control_seq: 1, kind: "decision-answer", status: "pending" };
      fetchDelivery.mockResolvedValue({
        ...snapshot(7),
        controls: [pending],
      } as unknown as DeliverySnapshot);
      act(() => mockSource._fire(frame(7, "controls")));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: deliveryQueryKey("p1", 1) });
      await waitFor(() => expect(result.current.data?.controls).toEqual([pending]));
    });

    it("refetches the delivery snapshot for a frame past the held seq, and skips one it holds", () => {
      const queryClient = makeQueryClient();
      queryClient.setQueryData(deliveryQueryKey("p1", 1), snapshot(9));
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      renderHookWithProviders(() => useNotificationStream(), { queryClient });

      mockSource._fire(frame(9));
      expect(invalidateSpy).not.toHaveBeenCalled();

      mockSource._fire(frame(12));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: deliveryQueryKey("p1", 1) });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["benches"] });
      expect(showNotification).not.toHaveBeenCalled();
    });

    it("leaves the delivery queries alone on the first open", () => {
      const queryClient = makeQueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      renderHookWithProviders(() => useNotificationStream(), { queryClient });
      mockSource._open();
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it("lets a dropped connection reconnect on its own, and opens no second stream", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      renderHookWithProviders(() => useNotificationStream());
      mockSource.readyState = 0;
      mockSource._fireError();
      expect(MockEventSource).toHaveBeenCalledTimes(1);
    });

    it("SB-TC-054: The event stream reconnects automatically after a disconnect", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const queryClient = makeQueryClient();
      const fetchDelivery = vi.mocked(api.fetchDelivery);
      fetchDelivery.mockResolvedValue(snapshot(7));
      const { result } = renderHookWithProviders(
        () => {
          useNotificationStream();
          return useDelivery("p1", 1);
        },
        { queryClient },
      );
      const first = mockSource;
      first._open();
      await waitFor(() => expect(result.current.data?.seq).toBe(7));

      // Step 1: the server kills the connection and the browser gives it up;
      // the client opens the stream again within 5 seconds.
      const killedAt = Date.now();
      act(() => {
        first.readyState = 2;
        first._fireError();
      });
      expect(first.close).toHaveBeenCalled();
      await waitFor(() => expect(MockEventSource).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      expect(Date.now() - killedAt).toBeLessThan(5_000);
      const second = mockSource;
      expect(second).not.toBe(first);

      // Step 2: events were posted during the gap, so their frames never
      // arrived. On reconnect the client refetches the snapshot, which holds
      // every accepted event.
      fetchDelivery.mockResolvedValue(snapshot(10));
      act(() => second._open());
      await waitFor(() => expect(result.current.data?.seq).toBe(10));

      // A frame that jumps past the held seq is a gap: refetched as well.
      fetchDelivery.mockResolvedValue(snapshot(14));
      act(() => second._fire(frame(14)));
      await waitFor(() => expect(result.current.data?.seq).toBe(14));
    }, 10_000);

    it("stops reconnecting once unmounted", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = renderHookWithProviders(() => useNotificationStream());
        mockSource.readyState = 2;
        mockSource._fireError();
        unmount();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(MockEventSource).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("input-changed events", () => {
    // invalidateQueries refetches the active queries of its key itself, so a
    // refetchQueries call is not listed: it is the invalidation's own work.
    const OTHER_METHODS = [
      "clear",
      "resetQueries",
      "removeQueries",
      "cancelQueries",
      "setQueryData",
      "setQueriesData",
    ] as const;

    function fireAndCollect(event: InputChangedEvent) {
      const queryClient = makeQueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      const others = OTHER_METHODS.map((m) => vi.spyOn(queryClient, m));
      const seen: InputChangedEvent[] = [];
      const unsubscribe = subscribeInputChanged((e) => seen.push(e));
      renderHookWithProviders(() => useNotificationStream(), { queryClient });
      act(() => mockSource._fire(event));
      unsubscribe();
      return { invalidateSpy, others, seen };
    }

    it("HR-TC-035 invalidates only the projects, raw-config and benches keys of a project-config change and hands the event to the notices", () => {
      const event: InputChangedEvent = {
        type: "input-changed",
        surface: "project-config",
        outcome: "applied",
        projectId: "p1",
        benchIds: [1, 2],
        summary: "Project config applied",
      };
      const { invalidateSpy, others, seen } = fireAndCollect(event);

      expect(invalidateSpy.mock.calls.map(([arg]) => arg)).toEqual([
        { queryKey: ["projects"] },
        { queryKey: ["raw-config", "p1"] },
        { queryKey: ["benches"] },
      ]);
      for (const spy of others) expect(spy).not.toHaveBeenCalled();
      expect(showNotification).not.toHaveBeenCalled();
      expect(seen).toEqual([event]);
    });

    // The literal keys each surface refreshes, the per-surface map of the
    // spec, written out here rather than read from the client's own map, so a
    // change to the map fails this test.
    const EXPECTED_KEYS: Record<InputChangedEvent["surface"], unknown[][]> = {
      "project-config": [["projects"], ["raw-config", "p1"], ["benches"]],
      plugin: [["plugins"], ["project-integration"], ["benches"]],
      settings: [["settings"]],
      bench: [["benches"]],
      github: [["settings"], ["issues"]],
      environment: [["settings"]],
    };

    it("invalidates exactly the listed keys of each surface and nothing else", () => {
      expect(Object.keys(EXPECTED_KEYS).sort()).toEqual([...INPUT_SURFACES].sort());
      for (const surface of INPUT_SURFACES) {
        const { invalidateSpy, others } = fireAndCollect({
          type: "input-changed",
          surface,
          outcome: "applied",
          projectId: "p1",
          pluginId: "plug",
          benchIds: [4],
          summary: "change applied",
        });
        expect(invalidateSpy.mock.calls.map(([arg]) => arg)).toEqual(
          EXPECTED_KEYS[surface].map((queryKey) => ({ queryKey })),
        );
        for (const spy of others) expect(spy).not.toHaveBeenCalled();
      }
    });

    it("invalidates only projects and benches on a project-config change with no project", () => {
      const { invalidateSpy } = fireAndCollect({
        type: "input-changed",
        surface: "project-config",
        outcome: "applied",
        summary: "Project state applied.",
      });
      expect(invalidateSpy.mock.calls.map(([arg]) => arg)).toEqual([
        { queryKey: ["projects"] },
        { queryKey: ["benches"] },
      ]);
    });

    it("never invalidates the whole cache or the delivery keys on an input change", () => {
      const { invalidateSpy } = fireAndCollect({
        type: "input-changed",
        surface: "settings",
        outcome: "rejected",
        summary: "Settings change rejected",
        error: { path: "settings.json", first: "theme: invalid" },
      });
      expect(invalidateSpy.mock.calls.map(([arg]) => arg)).toEqual([{ queryKey: ["settings"] }]);
    });
  });
});
