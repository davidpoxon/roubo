import { useCallback, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminalConnection } from "../hooks/useTerminalConnection";
import ReconnectBanner from "./ReconnectBanner";

export default function Terminal({ sessionId, active }: { sessionId: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Only fits when the container has non-zero dimensions — prevents sending
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

  const onReplay = useCallback((lines: string[], exitCode?: number) => {
    const term = termRef.current;
    if (!term) return;
    for (const line of lines) {
      term.write(line);
    }
    if (exitCode !== undefined) {
      term.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
    }
  }, []);

  const onMessage = useCallback((msg: { type: string; data?: string; code?: number }) => {
    const term = termRef.current;
    if (!term) return;
    if (msg.type === "output" && msg.data) {
      term.write(msg.data);
    } else if (msg.type === "exit") {
      term.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
    }
  }, []);

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

  // Send initial resize when connected — only if container has real dimensions.
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

  return (
    <div className="relative h-full w-full min-h-[300px]">
      <ReconnectBanner state={state} attempt={attempt} onRetry={retry} />
      <div
        ref={containerRef}
        className={`h-full w-full ${showBanner ? "pt-8" : ""}`}
        style={{ padding: showBanner ? undefined : "4px" }}
      />
    </div>
  );
}
