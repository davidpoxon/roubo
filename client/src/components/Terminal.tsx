import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { AgentLaunchFailure, SessionUnexpectedExit } from "@roubo/shared";
import { useTerminalConnection } from "../hooks/useTerminalConnection";
import ReconnectBanner from "./ReconnectBanner";
import WaitingBanner from "./WaitingBanner";
import AgentLaunchFailurePanel from "./AgentLaunchFailurePanel";
import AgentUnexpectedExitPanel from "./AgentUnexpectedExitPanel";
import { describeExitCause } from "../lib/unexpected-exit";
import { parseOsc52 } from "../lib/osc52";
import { writeClipboard } from "../lib/clipboard";

// Every colour is a DESIGN.md terminal role. design-tokens/semantic-dark.css
// switches each variable under `.dark`, but xterm parses its theme colours
// itself and cannot take a `var(...)` string the way CodeMirror can, so the
// roles are resolved to values here and re-resolved when the theme changes.
// The well in TerminalTabs paints the same `terminal-ground`, so the host
// padding shows no rim.
const TERMINAL_THEME_ROLES = {
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
} as const satisfies Partial<Record<keyof ITheme, string>>;

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const theme: ITheme = {};
  for (const [key, role] of Object.entries(TERMINAL_THEME_ROLES)) {
    theme[key as keyof typeof TERMINAL_THEME_ROLES] = style
      .getPropertyValue(`--color-${role}`)
      .trim();
  }
  return theme;
}

/**
 * The line written into the scrollback when the process ends. An unexpected exit
 * names its cause in red, so scrolling back to the end of a session that was
 * killed says so without the panel; any other end keeps the plain grey code.
 */
function exitLine(code: number | undefined, unexpected?: SessionUnexpectedExit): string {
  if (unexpected) {
    return `\r\n\x1b[31m[Process ended unexpectedly: ${describeExitCause(unexpected)}]\x1b[0m\r\n`;
  }
  return `\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`;
}

export default function Terminal({
  sessionId,
  active,
  waitingNotificationId,
  launchFailure: initialLaunchFailure,
  onRetry,
}: {
  sessionId: string;
  active: boolean;
  /**
   * The id of the agent-waiting/terminal-waiting notification the session
   * carries, or `undefined` when it carries none. Latched rather than read
   * straight through: the tabs view dismisses the active tab's notifications as
   * soon as it polls them, so a strip driven directly off this prop would flash
   * for a single poll on the one session the user is looking at (#1119).
   *
   * The id, not a boolean: the server dismisses a waiting notification on fresh
   * output and raises a fresh one after the quiescence debounce, and both can
   * land inside one poll gap. A boolean would stay continuously true across
   * that, so the latch would never re-arm and the strip would stay hidden while
   * the session really is waiting.
   */
  waitingNotificationId?: string;
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
  // An agent that launched fine and then died on its own. Like the failure above
  // it arrives on the replay and the exit frame, so a tab opened after the fact
  // (or after a server restart) still says why the session ended. The panel can
  // be dismissed locally: it overlays the top of the scrollback, which stays the
  // thing worth reading on a session that ran a long time.
  const [unexpectedExit, setUnexpectedExit] = useState<SessionUnexpectedExit | null>(null);
  const [unexpectedExitDismissed, setUnexpectedExitDismissed] = useState(false);
  // Armed whenever the session's waiting notification CHANGES to a real one
  // (including one waiting notification replacing another), cleared only by the
  // two signals that mean the session is no longer waiting on the user: the
  // user typing, and fresh live output. That mirrors the server, which
  // dismisses waiting notifications the moment fresh PTY output arrives. The
  // change is detected during render (React's "adjust state when a prop
  // changes" pattern) rather than in an effect, so the strip appears in the
  // same commit as the prop and never costs a second paint.
  const [waitingLatched, setWaitingLatched] = useState(waitingNotificationId !== undefined);
  const [lastWaitingId, setLastWaitingId] = useState(waitingNotificationId);
  if (waitingNotificationId !== lastWaitingId) {
    setLastWaitingId(waitingNotificationId);
    if (waitingNotificationId !== undefined) setWaitingLatched(true);
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
      theme: terminalTheme(),
      // The roles above only reach the sixteen ANSI colours. An agent left on
      // its own dark theme paints near-white truecolor on the light ground, so
      // xterm moves text under the 4.5:1 floor the roles are held to
      // (scripts/terminal-contrast.test.ts) toward it, against whatever theme
      // is current.
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      allowProposedApi: true,
      // An agent TUI turns on mouse reporting (DECSET ?1000/?1002/?1006),
      // after which xterm routes click-drag to the program instead of
      // selecting. Off macOS, Shift-drag always overrides that; on macOS the
      // override is Option-drag, and xterm gates it behind this option, which
      // defaults to false. Left at the default there is no modifier at all
      // that selects text in such a pane.
      macOptionClickForcesSelection: true,
    });

    const fit = new FitAddon();
    // The default handler calls `window.open()` with no arguments, then
    // assigns `location.href`. Electron's windowOpenHandler only resolves
    // `about:blank` (what a no-arg window.open produces) to a deny, so the
    // new window never navigates: links render but are never clickable.
    // Passing the real URL up front lets the host route it to the system
    // browser instead.
    const webLinks = new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
    term.loadAddon(fit);
    term.loadAddon(webLinks);

    term.open(containerRef.current);

    // xterm's core registers OSC handlers for 0, 1, 2, 4, 8, 10-12, 104 and
    // 110-112, but not 52, so an agent's `OSC 52 ; c ; <base64>` clipboard
    // write was consumed by the OSC state machine and dropped: the agent
    // reported a successful copy and nothing ever reached the clipboard.
    //
    // The callback is deliberately synchronous. xterm honours a returned
    // promise by suspending its parser until the promise settles, so awaiting
    // the clipboard round trip here would stall every following byte of PTY
    // output behind an IPC call.
    const oscDisposable = term.parser.registerOscHandler(52, (payload) => {
      const parsed = parseOsc52(payload);
      if (parsed.kind === "write") void writeClipboard(parsed.text);
      return parsed.kind !== "unhandled";
    });

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

    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      oscDisposable.dispose();
      observer.disconnect();
      themeObserver.disconnect();
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
    (
      lines: string[],
      exitCode?: number,
      failure?: AgentLaunchFailure,
      unexpected?: SessionUnexpectedExit,
    ) => {
      const term = termRef.current;
      if (!term) return;
      for (const line of lines) {
        term.write(line);
      }
      if (exitCode !== undefined) {
        // Only an exit-bearing replay clears the waiting latch: reattaching to
        // an already-dead session must not leave the strip pinned over a
        // terminal that has gone, but a plain reconnect replay (no exit code)
        // still leaves a legitimate waiting strip alone.
        setWaitingLatched(false);
        term.write(exitLine(exitCode, unexpected));
      }
      if (failure) setSocketFailure(failure);
      if (unexpected) setUnexpectedExit(unexpected);
    },
    [],
  );

  const onMessage = useCallback(
    (msg: {
      type: string;
      data?: string;
      code?: number;
      launchFailure?: AgentLaunchFailure;
      unexpectedExit?: SessionUnexpectedExit;
    }) => {
      const term = termRef.current;
      if (!term) return;
      if (msg.type === "output" && msg.data) {
        // Live output only: `onReplay` deliberately does not clear the latch,
        // since a replay fires again on every WS reconnect and would otherwise
        // erase a legitimate waiting strip.
        setWaitingLatched(false);
        term.write(msg.data);
      } else if (msg.type === "exit") {
        // A dead process is not waiting on anyone. The exit frame does not close
        // the socket, so the connection state stays `connected` and the
        // reconnect banner never takes the strip's place: without this the
        // waiting strip would stay pinned over a terminal that has gone.
        setWaitingLatched(false);
        term.write(exitLine(msg.code, msg.unexpectedExit));
        if (msg.launchFailure) setSocketFailure(msg.launchFailure);
        if (msg.unexpectedExit) setUnexpectedExit(msg.unexpectedExit);
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
      {unexpectedExit && !unexpectedExitDismissed && (
        <AgentUnexpectedExitPanel
          exit={unexpectedExit}
          onDismiss={() => setUnexpectedExitDismissed(true)}
        />
      )}
      {launchFailure && (
        <AgentLaunchFailurePanel
          failure={launchFailure}
          {...(onRetry !== undefined && { onRetry })}
        />
      )}
    </div>
  );
}
