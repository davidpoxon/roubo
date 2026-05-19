// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTerminalConnection } from "./useTerminalConnection";

let mockInstances: MockWebSocket[] = [];

let autoOpen = true;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    mockInstances.push(this);
    if (autoOpen) {
      setTimeout(() => this.onopen?.(new Event("open")), 0);
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  mockInstances = [];
  autoOpen = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderConnectionHook(sessionId = "term-1") {
  const onReplay = vi.fn();
  const onMessage = vi.fn();
  const hook = renderHook(
    ({ sid }) => useTerminalConnection({ sessionId: sid, onReplay, onMessage }),
    { initialProps: { sid: sessionId } },
  );
  return { hook, onReplay, onMessage };
}

describe("useTerminalConnection", () => {
  it("connects and transitions to connected state", async () => {
    const { hook } = renderConnectionHook();

    expect(hook.result.current.state).toBe("connecting");

    // Trigger async onopen
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(hook.result.current.state).toBe("connected");
    expect(hook.result.current.attempt).toBe(0);
  });

  it("creates WebSocket with correct URL", async () => {
    renderConnectionHook("term-42");
    expect(mockInstances[0].url).toContain("/ws/terminal/term-42");
  });

  it("calls onReplay when replay message received", async () => {
    const { onReplay } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      mockInstances[0].simulateMessage({ type: "replay", lines: ["hello\n", "world\n"] });
    });

    expect(onReplay).toHaveBeenCalledWith(["hello\n", "world\n"], undefined);
  });

  it("calls onReplay with exitCode for ended sessions", async () => {
    const { onReplay } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      mockInstances[0].simulateMessage({ type: "replay", lines: ["data"], exitCode: 0 });
    });

    expect(onReplay).toHaveBeenCalledWith(["data"], 0);
  });

  it("calls onMessage for output messages", async () => {
    const { onMessage } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      mockInstances[0].simulateMessage({ type: "output", data: "hello" });
    });

    expect(onMessage).toHaveBeenCalledWith({ type: "output", data: "hello" });
  });

  it("responds to ping with pong", async () => {
    renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      mockInstances[0].simulateMessage({ type: "ping" });
    });

    const pongMessages = mockInstances[0].sent.filter((m) => JSON.parse(m).type === "pong");
    expect(pongMessages).toHaveLength(1);
  });

  it("transitions to reconnecting on WS close", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(hook.result.current.state).toBe("connected");

    act(() => {
      mockInstances[0].simulateClose(1006);
    });

    expect(hook.result.current.state).toBe("reconnecting");
  });

  it("transitions to ended on 4410 close code", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      mockInstances[0].simulateClose(4410);
    });

    expect(hook.result.current.state).toBe("ended");
  });

  it("auto-reconnects with backoff", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    // Disconnect
    act(() => {
      mockInstances[0].simulateClose();
    });
    expect(hook.result.current.state).toBe("reconnecting");
    expect(hook.result.current.attempt).toBe(1);

    // Wait for backoff (first attempt ~1000ms)
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    // Should have created a new WebSocket
    expect(mockInstances.length).toBe(2);
  });

  it("stops auto-reconnecting after 5 attempts", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    // Simulate server going down — connections fail without opening
    autoOpen = false;

    // First disconnect triggers reconnection
    act(() => {
      mockInstances[mockInstances.length - 1].simulateClose();
    });

    // Each backoff fires, creates new WS, which immediately closes (server down)
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      // Simulate the new WS failing to connect
      const latest = mockInstances[mockInstances.length - 1];
      if (latest.onclose) {
        act(() => {
          latest.simulateClose();
        });
      }
    }

    const instanceCountBefore = mockInstances.length;
    // Wait plenty — should NOT create any more connections
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(hook.result.current.attempt).toBeGreaterThan(5);
    expect(mockInstances.length).toBe(instanceCountBefore);
  });

  it("manual retry resets attempt count and reconnects", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    // Disconnect
    act(() => {
      mockInstances[0].simulateClose();
    });
    expect(hook.result.current.attempt).toBe(1);

    const countBefore = mockInstances.length;

    // Manual retry
    act(() => {
      hook.result.current.retry();
    });
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(mockInstances.length).toBe(countBefore + 1);
    expect(hook.result.current.attempt).toBe(0);
  });

  it("does not retry when state is ended", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    act(() => {
      mockInstances[0].simulateClose(4410);
    });
    expect(hook.result.current.state).toBe("ended");

    const countBefore = mockInstances.length;
    act(() => {
      hook.result.current.retry();
    });
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(mockInstances.length).toBe(countBefore); // No new connection
  });

  it("cleans up WebSocket on unmount", async () => {
    const { hook } = renderConnectionHook();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    const ws = mockInstances[0];
    hook.unmount();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});
