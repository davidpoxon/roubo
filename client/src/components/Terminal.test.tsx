// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import Terminal from "./Terminal";

const xtermOptions = vi.hoisted(() => [] as { theme?: Record<string, string> }[]);

const mockTerminalInstance = {
  options: {} as { theme?: Record<string, string> },
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
  Terminal: function MockXTerm(options: { theme?: Record<string, string> }) {
    xtermOptions.push(options);
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
  xtermOptions.length = 0;
  mockTerminalInstance.options = {};
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

describe("Terminal: waiting affordance (#1119)", () => {
  /** Capture the connection callbacks so live frames can be driven by hand. */
  function captureConnection() {
    const captured: {
      onReplay: (lines: string[], exitCode?: number) => void;
      onMessage: (msg: { type: string; data?: string; code?: number }) => void;
    } = { onReplay: () => {}, onMessage: () => {} };
    mockUseTerminalConnection.mockImplementation(
      ({
        onReplay,
        onMessage,
      }: {
        onReplay: (lines: string[], exitCode?: number) => void;
        onMessage: (msg: { type: string; data?: string; code?: number }) => void;
      }) => {
        captured.onReplay = onReplay;
        captured.onMessage = onMessage;
        return { wsRef: { current: null }, state: "connected", attempt: 0, retry: vi.fn() };
      },
    );
    return captured;
  }

  it("shows no waiting strip when the session is not waiting", () => {
    render(<Terminal sessionId="sess-1" active />);
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();
  });

  it("shows the waiting strip for the active session when it is waiting", () => {
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();
  });

  it("keeps the strip after the waiting notification goes, since the active tab's is dismissed on poll", () => {
    const { rerender } = render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);
    rerender(<Terminal sessionId="sess-1" active />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();
  });

  it("re-arms when a fresh waiting notification replaces the old one inside one poll gap", () => {
    const captured = captureConnection();
    const { rerender } = render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);

    // Live output clears the strip locally, exactly as the server dismisses n1.
    act(() => captured.onMessage({ type: "output", data: "working...\r\n" }));
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();

    // The next poll never sampled the gap: n1 was dismissed and n2 raised in
    // between, so a boolean prop would have read `true` throughout and the
    // strip would have stayed hidden while the session really was waiting.
    rerender(<Terminal sessionId="sess-1" active waitingNotificationId="n2" />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();
  });

  it("clears the strip when the user types", () => {
    let capturedDataCallback: (data: string) => void = () => {};
    mockTerminalInstance.onData.mockImplementation(((cb: (data: string) => void) => {
      capturedDataCallback = cb;
      return { dispose: vi.fn() };
    }) as never);
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();

    act(() => capturedDataCallback("y"));
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();
  });

  it("clears the strip on fresh live output, mirroring the server-side dismissal", () => {
    const captured = captureConnection();
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();

    act(() => captured.onMessage({ type: "output", data: "thinking...\r\n" }));
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();
  });

  it("clears the strip when the process exits, since a dead session waits on nobody", () => {
    const captured = captureConnection();
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();

    // The exit frame leaves the socket open, so the reconnect banner never
    // takes over and nothing else would clear the strip.
    act(() => captured.onMessage({ type: "exit", code: 0 }));
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();
  });

  it("does not clear the strip on a replay, which fires again on every reconnect", () => {
    const captured = captureConnection();
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);

    act(() => captured.onReplay(["scrollback\r\n"]));
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();
  });

  it("clears the strip on a replay that carries an exit code, for an already-dead session", () => {
    const captured = captureConnection();
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);

    // Attaching to a session that died before the socket opened: no live exit
    // frame ever arrives, so the replay is the only signal there is.
    act(() => captured.onReplay(["scrollback\r\n"], 0));
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();
  });

  it("yields the top of the pane to the reconnect banner", () => {
    mockUseTerminalConnection.mockReturnValue({
      wsRef: { current: null },
      state: "reconnecting",
      attempt: 1,
      retry: vi.fn(),
    } as never);
    render(<Terminal sessionId="sess-1" active waitingNotificationId="n1" />);
    expect(screen.getByTestId("reconnect-banner")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your input")).not.toBeInTheDocument();
  });
});

// Each xterm theme key and the DESIGN.md role it reads (#1323).
const THEME_ROLES: Record<string, string> = {
  background: "terminal-ground",
  foreground: "terminal-text",
  cursor: "terminal-cursor",
  selectionBackground: "terminal-selection",
  black: "terminal-ansi-black",
  red: "terminal-ansi-red",
  green: "terminal-ansi-green",
  yellow: "terminal-ansi-yellow",
  blue: "terminal-ansi-blue",
  magenta: "terminal-ansi-magenta",
  cyan: "terminal-ansi-cyan",
  white: "terminal-ansi-white",
  brightBlack: "terminal-ansi-bright-black",
  brightRed: "terminal-ansi-bright-red",
  brightGreen: "terminal-ansi-bright-green",
  brightYellow: "terminal-ansi-bright-yellow",
  brightBlue: "terminal-ansi-bright-blue",
  brightMagenta: "terminal-ansi-bright-magenta",
  brightCyan: "terminal-ansi-bright-cyan",
  brightWhite: "terminal-ansi-bright-white",
};

// A distinct stand-in value per role and theme, so a key wired to the wrong
// role, or a theme that did not switch, fails on the exact key.
function roleValue(index: number, dark: boolean): string {
  return `#${(dark ? 0x800000 : 0x100000) + index}`.toUpperCase();
}

function expectedTheme(dark: boolean): Record<string, string> {
  return Object.fromEntries(Object.keys(THEME_ROLES).map((key, i) => [key, roleValue(i, dark)]));
}

describe("Terminal: theme from the DESIGN.md terminal roles (#1323)", () => {
  let sheet: HTMLStyleElement;

  beforeEach(() => {
    const decls = (dark: boolean) =>
      Object.values(THEME_ROLES)
        .map((role, i) => `--color-${role}: ${roleValue(i, dark)};`)
        .join(" ");
    sheet = document.createElement("style");
    sheet.textContent = `:root { ${decls(false)} } :root.dark { ${decls(true)} }`;
    document.head.appendChild(sheet);
  });

  afterEach(() => {
    sheet.remove();
    document.documentElement.classList.remove("dark");
  });

  it("builds the xterm theme from the light roles", () => {
    render(<Terminal sessionId="sess-1" active />);
    expect(xtermOptions[0]?.theme).toEqual(expectedTheme(false));
  });

  it("builds the xterm theme from the dark roles when the app is dark", () => {
    document.documentElement.classList.add("dark");
    render(<Terminal sessionId="sess-1" active />);
    expect(xtermOptions[0]?.theme).toEqual(expectedTheme(true));
  });

  it("re-themes the open terminal when the app theme switches", async () => {
    render(<Terminal sessionId="sess-1" active />);
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    expect(mockTerminalInstance.options.theme).toEqual(expectedTheme(true));
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    expect(mockTerminalInstance.options.theme).toEqual(expectedTheme(false));
  });

  it("stops following the theme once unmounted", async () => {
    const { unmount } = render(<Terminal sessionId="sess-1" active />);
    unmount();
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    expect(mockTerminalInstance.options.theme).toBeUndefined();
  });
});
