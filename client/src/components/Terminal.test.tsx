// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Terminal from "./Terminal";

const mockTerminalInstance = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  dispose: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  cols: 80,
  rows: 24,
};
const mockFitAddonInstance = {
  fit: vi.fn(),
  proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  dispose: vi.fn(),
};

vi.mock("@xterm/xterm", () => ({
  Terminal: function MockXTerm() {
    return mockTerminalInstance;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: function MockFitAddon() {
    return mockFitAddonInstance;
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: function MockWebLinks() {
    return { dispose: vi.fn() };
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../hooks/useTerminalConnection");
vi.mock("./ReconnectBanner", () => ({
  default: ({ state }: { state: string }) =>
    state === "reconnecting" || state === "ended" ? <div data-testid="reconnect-banner" /> : null,
}));

import { useTerminalConnection } from "../hooks/useTerminalConnection";

const mockUseTerminalConnection = vi.mocked(useTerminalConnection);

// Stub offsetWidth/offsetHeight so safeFit allows fit() to proceed.
function stubDimensions(width = 200, height = 400) {
  const w = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  const h = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
  return () => {
    w.mockRestore();
    h.mockRestore();
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mockTerminalInstance.onData.mockReturnValue({ dispose: vi.fn() });
  mockTerminalInstance.onResize.mockReturnValue({ dispose: vi.fn() });
  mockFitAddonInstance.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
  mockUseTerminalConnection.mockReturnValue({
    wsRef: { current: null },
    state: "connected",
    attempt: 0,
    retry: vi.fn(),
  } as never);
});

describe("Terminal", () => {
  it("renders the terminal container div", () => {
    const { container } = render(<Terminal sessionId="sess-1" active />);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not show reconnect banner when connected", () => {
    render(<Terminal sessionId="sess-1" active />);
    expect(screen.queryByTestId("reconnect-banner")).not.toBeInTheDocument();
  });

  it("shows reconnect banner when reconnecting", () => {
    mockUseTerminalConnection.mockReturnValue({
      wsRef: { current: null },
      state: "reconnecting",
      attempt: 1,
      retry: vi.fn(),
    } as never);
    render(<Terminal sessionId="sess-1" active />);
    expect(screen.getByTestId("reconnect-banner")).toBeInTheDocument();
  });

  it("shows banner when ended", () => {
    mockUseTerminalConnection.mockReturnValue({
      wsRef: { current: null },
      state: "ended",
      attempt: 0,
      retry: vi.fn(),
    } as never);
    render(<Terminal sessionId="sess-1" active />);
    expect(screen.getByTestId("reconnect-banner")).toBeInTheDocument();
  });

  it("renders with inactive state", () => {
    const { container } = render(<Terminal sessionId="sess-1" active={false} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("calls fit when tab becomes active and container has dimensions", () => {
    const restore = stubDimensions();
    const { rerender } = render(<Terminal sessionId="sess-1" active={false} />);
    rerender(<Terminal sessionId="sess-1" active />);
    expect(mockFitAddonInstance.fit).toHaveBeenCalled();
    restore();
  });

  it("does not call fit when container has zero dimensions", () => {
    // jsdom returns 0 for offsetWidth/offsetHeight by default
    render(<Terminal sessionId="sess-1" active />);
    expect(mockFitAddonInstance.fit).not.toHaveBeenCalled();
  });

  it("does not send resize via WebSocket when container has zero dimensions on connect", () => {
    const mockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
    mockUseTerminalConnection.mockReturnValue({
      wsRef: { current: mockWs },
      state: "connected",
      attempt: 0,
      retry: vi.fn(),
    } as never);
    render(<Terminal sessionId="sess-1" active />);
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it("writes replay lines to terminal via onReplay", () => {
    let capturedOnReplay: (lines: string[], exitCode?: number) => void = () => {};
    mockUseTerminalConnection.mockImplementation(
      ({ onReplay }: { onReplay: (lines: string[], exitCode?: number) => void }) => {
        capturedOnReplay = onReplay;
        return { wsRef: { current: null }, state: "connected", attempt: 0, retry: vi.fn() };
      },
    );
    render(<Terminal sessionId="sess-1" active />);
    capturedOnReplay(["line1\r\n", "line2\r\n"]);
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("line1\r\n");
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("line2\r\n");
  });

  it("writes exit code message via onReplay when exitCode provided", () => {
    let capturedOnReplay: (lines: string[], exitCode?: number) => void = () => {};
    mockUseTerminalConnection.mockImplementation(
      ({ onReplay }: { onReplay: (lines: string[], exitCode?: number) => void }) => {
        capturedOnReplay = onReplay;
        return { wsRef: { current: null }, state: "connected", attempt: 0, retry: vi.fn() };
      },
    );
    render(<Terminal sessionId="sess-1" active />);
    capturedOnReplay([], 0);
    expect(mockTerminalInstance.write).toHaveBeenCalledWith(
      expect.stringContaining("[Process exited with code 0]"),
    );
  });

  it("writes output data via onMessage", () => {
    let capturedOnMessage: (msg: { type: string; data?: string; code?: number }) => void = () => {};
    mockUseTerminalConnection.mockImplementation(
      ({
        onMessage,
      }: {
        onMessage: (msg: { type: string; data?: string; code?: number }) => void;
      }) => {
        capturedOnMessage = onMessage;
        return { wsRef: { current: null }, state: "connected", attempt: 0, retry: vi.fn() };
      },
    );
    render(<Terminal sessionId="sess-1" active />);
    capturedOnMessage({ type: "output", data: "hello\r\n" });
    expect(mockTerminalInstance.write).toHaveBeenCalledWith("hello\r\n");
  });

  it("writes exit message via onMessage when type is exit", () => {
    let capturedOnMessage: (msg: { type: string; data?: string; code?: number }) => void = () => {};
    mockUseTerminalConnection.mockImplementation(
      ({
        onMessage,
      }: {
        onMessage: (msg: { type: string; data?: string; code?: number }) => void;
      }) => {
        capturedOnMessage = onMessage;
        return { wsRef: { current: null }, state: "connected", attempt: 0, retry: vi.fn() };
      },
    );
    render(<Terminal sessionId="sess-1" active />);
    capturedOnMessage({ type: "exit", code: 1 });
    expect(mockTerminalInstance.write).toHaveBeenCalledWith(
      expect.stringContaining("[Process exited with code 1]"),
    );
  });

  it("sends input via WebSocket when onData fires", () => {
    let capturedDataCallback: (data: string) => void = () => {};
    mockTerminalInstance.onData.mockImplementation(((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return { dispose: vi.fn() };
    }) as never);
    const mockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
    mockUseTerminalConnection.mockReturnValue({
      wsRef: { current: mockWs },
      state: "connected",
      attempt: 0,
      retry: vi.fn(),
    } as never);
    render(<Terminal sessionId="sess-1" active />);
    capturedDataCallback("a");
    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "a" }));
  });

  it("sends resize via WebSocket when connected and container has dimensions", () => {
    const restore = stubDimensions();
    const mockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
    mockUseTerminalConnection.mockReturnValue({
      wsRef: { current: mockWs },
      state: "connected",
      attempt: 0,
      retry: vi.fn(),
    } as never);
    render(<Terminal sessionId="sess-1" active />);
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
    );
    restore();
  });
});
