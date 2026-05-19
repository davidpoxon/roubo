import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "ended";

const MAX_AUTO_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const JITTER_FACTOR = 0.2;
const GHOST_CLOSE_CODE = 4410;

interface UseTerminalConnectionOptions {
  sessionId: string;
  onReplay: (lines: string[], exitCode?: number) => void;
  onMessage: (msg: { type: string; data?: string; code?: number }) => void;
}

function backoffDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
  const jitter = base * JITTER_FACTOR * (2 * Math.random() - 1);
  return Math.round(base + jitter);
}

export function useTerminalConnection({
  sessionId,
  onReplay,
  onMessage,
}: UseTerminalConnectionOptions) {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onReplayRef = useRef(onReplay);
  const onMessageRef = useRef(onMessage);
  const cleanedUpRef = useRef(false);

  useEffect(() => {
    onReplayRef.current = onReplay;
    onMessageRef.current = onMessage;
  });

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (cleanedUpRef.current) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (cleanedUpRef.current) return;
      setState("connected");
      setAttempt(0);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "replay") {
          onReplayRef.current(msg.lines, msg.exitCode);
        } else if (msg.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } else {
          onMessageRef.current(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      if (cleanedUpRef.current) return;

      wsRef.current = null;

      if (event.code === GHOST_CLOSE_CODE) {
        setState("ended");
        return;
      }

      setState((prev) => {
        if (prev === "ended") return "ended";
        return "reconnecting";
      });
    };

    ws.onerror = () => {
      console.warn("[ws] WebSocket error for session", sessionId);
    };
  }, [sessionId]);

  // Schedule reconnection
  useEffect(() => {
    if (state !== "reconnecting") return;
    if (cleanedUpRef.current) return;

    setAttempt((prev) => {
      const next = prev + 1;
      if (next > MAX_AUTO_ATTEMPTS) return next;

      const delay = backoffDelay(next);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setState("connecting");
        connect();
      }, delay);

      return next;
    });

    return () => clearReconnectTimer();
  }, [state, connect, clearReconnectTimer]);

  // Initial connection
  useEffect(() => {
    cleanedUpRef.current = false;
    connect();

    return () => {
      cleanedUpRef.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, connect, clearReconnectTimer]);

  const retry = useCallback(() => {
    if (state === "ended") return;
    clearReconnectTimer();
    setAttempt(0);
    setState("connecting");
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [state, connect, clearReconnectTimer]);

  return {
    wsRef,
    state,
    attempt,
    retry,
  };
}
