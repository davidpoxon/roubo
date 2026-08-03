import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { AgentLaunchFailure } from "@roubo/shared";
import { useTerminalConnection } from "../hooks/useTerminalConnection";
import ReconnectBanner from "./ReconnectBanner";
import WaitingBanner from "./WaitingBanner";
import AgentLaunchFailurePanel from "./AgentLaunchFailurePanel";

export default function Terminal({
  sessionId,
  active,
  waiting = false,
  launchFailure: initialLaunchFailure,
  onRetry,
}: {
  sessionId: string;
  active: boolean;
  /**
   * The session carries an agent-waiting/terminal-waiting notification. Latched
   * rather than read straight through: the tabs view dismisses the active tab's
   * notifications as soon as it polls them, so a strip driven directly off this
   * prop would flash for a single poll on the one session the user is looking
   * at (#1119).
   */
  waiting?: boolean;
  /**
   * A failure that happened before any session existed (a blocked below-floor
   * launch, a missing binary), so there is no socket to learn it from. A failure
   * detected after spawn arrives over the socket instead.
   */
  launchFailure?: AgentLaunchFailure;
  onRetry?: () => void;
}) {
  const [socketFailure, setSocketFailure] = useState<AgentLaunchFailure | null>(null);
  const launchFailure = socketFailure ?? initialLaunchFailure;
  // Latched on the rising edge of `waiting`, cleared only by the two signals
  // that mean the session is no longer waiting on the user: the user typing,
  // and fresh live output. That mirrors the server, which dismisses waiting
  // notifications the moment fresh PTY output arrives. The rising edge is
  // detected during render (React's "adjust state when a prop changes" pattern)
  // rather than in an effect, so the strip appears in the same commit as the
  // prop and never costs a second paint.
  const [waitingLatched, setWaitingLatched] = useState(waiting);
  const [lastWaiting, setLastWaiting] = useState(waiting);
  if (waiting !== lastWaiting) {
    setLastWaiting(waiting);
    if (waiting) setWaitingLatched(true);
  }
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Only fits when the container has non-zero dimensions: prevents sending
  // tiny cols to the PTY when mounted inside a display:none ancestor.
  const safeFitRef = useRef<(() => boolean) | null>(null);

  // Initialize xterm instance
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: "#09090b",
        foreground: "#d4d4d8",
        cursor: "#d4d4d8",
        selectionBackground: "#3f3f4680",
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#d4d4d8",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(webLinks);

    term.open(containerRef.current);

    const safeFit = () => {
      const el = containerRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      fit.fit();
      return true;
    };

    safeFit();

    termRef.current = term;
    fitRef.current = fit;
    safeFitRef.current = safeFit;

    const observer = new ResizeObserver(() => {
      safeFit();
    });
    observer.observe(containerRef.current);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") safeFit();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      safeFitRef.current = null;
    };
  }, [sessionId]);

  // Re-fit when tab becomes active
  useEffect(() => {
    if (active && safeFitRef.current) {
      const safeFit = safeFitRef.current;
      requestAnimationFrame(() => {
        safeFit();
      });
    }
  }, [active]);

  // The failure is replayed, not just pushed live, so reattaching to an already
  // dead session still shows the panel rather than a bare exit code.
  const onReplay = useCallback(
    (lines: string[], exitCode?: number, failure?: AgentLaunchFailure) => {
      const term = termRef.current;
      if (!term) return;
      for (const line of lines) {
        term.write(line);
      }
      if (exitCode !== undefined) {
        term.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
      if (failure) setSocketFailure(failure);
    },
    [],
  );

  const onMessage = useCallback(
    (msg: { type: string; data?: string; code?: number; launchFailure?: AgentLaunchFailure }) => {
      const term = termRef.current;
      if (!term) return;
      if (msg.type === "output" && msg.data) {
        // Live output only: `onReplay` deliberately does not clear the latch,
        // since a replay fires again on every WS reconnect and would otherwise
        // erase a legitimate waiting strip.
        setWaitingLatched(false);
        term.write(msg.data);
      } else if (msg.type === "exit") {
        term.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
        if (msg.launchFailure) setSocketFailure(msg.launchFailure);
      }
    },
    [],
  );

  const { wsRef, state, attempt, retry } = useTerminalConnection({
    sessionId,
    onReplay,
    onMessage,
  });

  // Send input and resize to server
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const inputDisposable = term.onData((data) => {
      // The user replying is the other end of "waiting for your input".
      setWaitingLatched(false);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
    };
  }, [sessionId, wsRef]);

  // Send initial resize when connected: only if container has real dimensions.
  // If not yet sized, the ResizeObserver will fit once layout settles and
  // term.onResize will forward the correct cols to the PTY automatically.
  useEffect(() => {
    if (state !== "connected") return;
    const fit = fitRef.current;
    const ws = wsRef.current;
    if (!fit || !ws) return;

    if (!safeFitRef.current?.()) return;
    const dims = fit.proposeDimensions();
    if (dims && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
    }
  }, [state, wsRef]);

  const showBanner = state === "reconnecting" || state === "ended";
  // Both strips are absolutely positioned at the top of the pane, so the
  // connection state wins and they never stack.
  const showWaiting = waitingLatched && !showBanner;
  const topStrip = showBanner || showWaiting;

  return (
    <div className="relative h-full w-full min-h-[300px]">
      <ReconnectBanner state={state} attempt={attempt} onRetry={retry} />
      {showWaiting && <WaitingBanner />}
      <div
        ref={containerRef}
        className={`h-full w-full ${topStrip ? "pt-8" : ""}`}
        style={{ padding: topStrip ? undefined : "4px" }}
      />
      {launchFailure && (
        <AgentLaunchFailurePanel
          failure={launchFailure}
          {...(onRetry !== undefined && { onRetry })}
        />
      )}
    </div>
  );
}
