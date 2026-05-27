import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { deriveClaudeCodeMode } from "@roubo/shared";
import type {
  TerminalSession,
  PersistedTerminalSession,
  ClaudeCodeSettings,
  ProjectPermissions,
} from "@roubo/shared";
import { atomicWrite, getRouboDir } from "./state.js";
import { getClaudeBinary } from "./env.js";
import { writeClaudeSettingsLocal } from "./claude-settings-local.js";
import * as notificationService from "./notification.js";
import * as benchManager from "./bench-manager.js";
import { UUID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

const MAX_BUFFER_CHUNKS = 5000;
const FLUSH_DEBOUNCE_MS = 500;
const QUIESCENCE_DEBOUNCE_MS = 2000;
// Claude's TUI redraws continuously while it's working, so a short debounce
// would fire false positives between streamed chunks. The longer window is
// purely a fallback for cases Claude Code's Notification hooks don't cover
// (e.g. AskUserQuestion prompts in plan mode).
const CLAUDE_QUIESCENCE_DEBOUNCE_MS = 8000;

class CircularBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T): void {
    const index = (this.head + this.count) % this.capacity;
    if (this.count === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.count++;
    }
    this.items[index] = item;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.items[(this.head + i) % this.capacity] as T);
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  static from<T>(items: T[], capacity: number): CircularBuffer<T> {
    const buf = new CircularBuffer<T>(capacity);
    // If items exceed capacity, only keep the most recent
    const start = Math.max(0, items.length - capacity);
    for (let i = start; i < items.length; i++) {
      buf.push(items[i]);
    }
    return buf;
  }
}
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_CLI_PROMPT_LENGTH = 100_000;
const SESSIONS_DIR = path.join(getRouboDir(), "terminal-sessions");

interface InternalSession {
  session: TerminalSession;
  pty: pty.IPty | null;
  ws: WebSocket | null;
  buffer: CircularBuffer<string>;
  exitCode: number | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongDeadline: ReturnType<typeof setTimeout> | null;
  quiescenceTimer: ReturnType<typeof setTimeout> | null;
  // Timestamps used to gate quiescence-driven notifications: we only re-notify
  // for an idle window when fresh PTY output has arrived since the last
  // notification we created. Cleared on dismissal so the next idle window can
  // notify again.
  lastOutputAt: number | null;
  lastNotifiedAt: number | null;
}

const sessions = new Map<string, InternalSession>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionFilePath(id: string): string {
  // Terminal session ids are server-generated UUIDs (randomUUID), but they reach this
  // module via WebSocket URLs too. Regex-validate so CodeQL recognises the sanitizer
  // before the id flows into resolveWithin.
  assertSafeIdentifier(id, UUID_RE, "sessionId");
  return resolveWithin(SESSIONS_DIR, `${id}.json`);
}

function benchKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

export function parseBenchKey(key: string): { projectId: string; benchId: number } | null {
  const colonIdx = key.indexOf(":");
  if (colonIdx === -1) return null;
  const benchId = parseInt(key.slice(colonIdx + 1), 10);
  if (isNaN(benchId)) return null;
  return { projectId: key.slice(0, colonIdx), benchId };
}

function generateLabel(projectName: string, benchId: number, command?: string): string {
  const benchSessions = Array.from(sessions.values()).filter(
    (s) => s.session.benchKey.endsWith(`:${benchId}`) && s.session.command === command,
  );
  const index = benchSessions.length + 1;
  if (command === "claude") {
    return `Claude ${index} - ${projectName} #${benchId}`;
  }
  return `Terminal ${index} - ${projectName} #${benchId}`;
}

function persistSession(id: string): void {
  const internal = sessions.get(id);
  if (!internal) return;

  ensureSessionsDir();
  const data: PersistedTerminalSession = {
    session: internal.session,
    buffer: internal.buffer.toArray(),
    persistedAt: new Date().toISOString(),
  };
  try {
    atomicWrite(sessionFilePath(id), JSON.stringify(data, null, 2));
  } catch {
    // Best-effort persistence — don't crash if disk write fails
  }
}

function deletePersistedSession(id: string): void {
  try {
    fs.unlinkSync(sessionFilePath(id));
  } catch {
    // File may not exist
  }
}

function scheduleBufferFlush(id: string): void {
  const existing = flushTimers.get(id);
  if (existing) clearTimeout(existing);

  flushTimers.set(
    id,
    setTimeout(() => {
      flushTimers.delete(id);
      persistSession(id);
    }, FLUSH_DEBOUNCE_MS),
  );
}

function cancelBufferFlush(id: string): void {
  const timer = flushTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(id);
  }
}

// Best-effort dismissal of session-scoped waiting notifications. Called from
// onData whenever fresh PTY output arrives so a Claude tab indicator clears
// the moment Claude resumes work, and an idle shell's indicator clears the
// moment output starts flowing again.
function dismissWaitingNotificationsForSession(internal: InternalSession): void {
  const parsed = parseBenchKey(internal.session.benchKey);
  if (!parsed) return;
  try {
    const bench = benchManager.getBench(parsed.projectId, parsed.benchId);
    if (!bench) return;
    // Cheap pre-check so the hot output path doesn't allocate a filtered array
    // when there's nothing to dismiss.
    if (
      !bench.notifications.some(
        (n) =>
          n.sourceSessionId === internal.session.id &&
          notificationService.WAITING_NOTIFICATION_TYPES.has(n.type),
      )
    ) {
      return;
    }
    if (notificationService.dismissWaitingForSession(bench, internal.session.id)) {
      // The notification cycle has been reset; allow the next idle window to
      // re-notify even though the WS may rearm without further output changes.
      internal.lastNotifiedAt = null;
    }
  } catch {
    // Best-effort — don't break terminal output on notification errors
  }
}

function scheduleQuiescenceCheck(id: string): void {
  const internal = sessions.get(id);
  if (!internal) return;

  if (internal.quiescenceTimer) clearTimeout(internal.quiescenceTimer);

  const isClaude = internal.session.command === "claude";
  const debounce = isClaude ? CLAUDE_QUIESCENCE_DEBOUNCE_MS : QUIESCENCE_DEBOUNCE_MS;

  internal.quiescenceTimer = setTimeout(() => {
    internal.quiescenceTimer = null;
    // Guard: session may have been destroyed or exited since the timer was set
    if (!sessions.has(id)) return;
    if (internal.pty === null || internal.exitCode !== null) return;
    // Skip if no fresh output has arrived since the last notification we
    // created for this session. This is what makes a WS reconnect a no-op
    // after a user dismissal — without it, every reconnect would re-fire.
    if (
      internal.lastNotifiedAt !== null &&
      (internal.lastOutputAt ?? 0) <= internal.lastNotifiedAt
    ) {
      return;
    }

    const parsed = parseBenchKey(internal.session.benchKey);
    if (!parsed) return;
    try {
      const bench = benchManager.getBench(parsed.projectId, parsed.benchId);
      if (bench) {
        const type = isClaude ? "claude-waiting" : "terminal-waiting";
        notificationService.createNotification(bench, type, internal.session.id, {
          label: internal.session.label,
        });
        internal.lastNotifiedAt = Date.now();
      }
    } catch {
      // Best-effort — don't break terminal output on notification errors
    }
  }, debounce);
}

function cancelQuiescenceCheck(internal: InternalSession): void {
  if (internal.quiescenceTimer) {
    clearTimeout(internal.quiescenceTimer);
    internal.quiescenceTimer = null;
  }
}

function clearTimers(internal: InternalSession): void {
  if (internal.pingTimer) {
    clearInterval(internal.pingTimer);
    internal.pingTimer = null;
  }
  if (internal.pongDeadline) {
    clearTimeout(internal.pongDeadline);
    internal.pongDeadline = null;
  }
  cancelQuiescenceCheck(internal);
}

export function createSession(
  projectId: string,
  benchId: number,
  workspacePath: string,
  projectName: string,
  command?: string,
  initialInput?: string,
  claudeCodeSettings?: ClaudeCodeSettings,
  projectPermissions?: ProjectPermissions,
  onClaudeExit?: (sessionId: string) => void,
): TerminalSession {
  const id = randomUUID();
  const key = benchKey(projectId, benchId);
  const label = generateLabel(projectName, benchId, command);

  const shell = command === "claude" ? getClaudeBinary() : (process.env.SHELL ?? "/bin/sh");
  const args: string[] = [];
  if (command === "claude") {
    if (claudeCodeSettings?.enableAutoMode) args.push("--enable-auto-mode");
    if (claudeCodeSettings?.startInPlanMode) args.push("--permission-mode", "plan");
    args.push("--session-id", id);
    if (initialInput) args.push(initialInput.slice(0, MAX_CLI_PROMPT_LENGTH));
    try {
      writeClaudeSettingsLocal(workspacePath, claudeCodeSettings, projectPermissions);
    } catch (err) {
      // Best-effort — a failure here (e.g. disk full) should not prevent the session from starting
      console.warn("Failed to write .claude/settings.local.json:", err);
    }
  }

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workspacePath,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn terminal (shell: ${shell}, cwd: ${workspacePath}): ${(err as Error).message}`,
      { cause: err },
    );
  }

  const claudeCodeMode =
    command === "claude" ? deriveClaudeCodeMode(claudeCodeSettings) : undefined;

  const session: TerminalSession = {
    id,
    benchKey: key,
    label,
    createdAt: new Date().toISOString(),
    command,
    status: "live",
    ...(claudeCodeMode !== undefined && { claudeCodeMode }),
  };

  const internal: InternalSession = {
    session,
    pty: ptyProcess,
    ws: null,
    buffer: new CircularBuffer(MAX_BUFFER_CHUNKS),
    exitCode: null,
    pingTimer: null,
    pongDeadline: null,
    quiescenceTimer: null,
    lastOutputAt: null,
    lastNotifiedAt: null,
  };

  sessions.set(id, internal);

  // Buffer all PTY output (WS forwarding happens in handleWebSocket)
  ptyProcess.onData((data) => {
    internal.buffer.push(data);
    internal.lastOutputAt = Date.now();
    // Debounced flush — coalesces rapid output, also catches idle sessions
    scheduleBufferFlush(id);
    // Fresh output means this session is not currently waiting on the user.
    // Clear any pending claude-waiting/terminal-waiting notification so the tab
    // indicator (and any OS notification state) tracks the live session state.
    dismissWaitingNotificationsForSession(internal);
    // Schedule a quiescence check — if no further output arrives within the
    // debounce window the session is likely waiting for input. Claude sessions
    // use a longer window as a fallback for Notification events the hook misses
    // (e.g. AskUserQuestion); hook-driven notifications still fire immediately.
    scheduleQuiescenceCheck(id);
  });

  // Track exit
  ptyProcess.onExit(({ exitCode }) => {
    internal.exitCode = exitCode;
    internal.session.status = "ended";
    internal.session.exitCode = exitCode;
    cancelQuiescenceCheck(internal);
    persistSession(id);
    if (internal.session.command === "claude") {
      try {
        onClaudeExit?.(id);
      } catch {
        /* best-effort */
      }
    }
  });

  persistSession(id);

  return session;
}

export function getSession(sessionId: string): TerminalSession | undefined {
  return sessions.get(sessionId)?.session;
}

export function getSessions(projectId: string, benchId: number): TerminalSession[] {
  const key = benchKey(projectId, benchId);
  return Array.from(sessions.values())
    .filter((s) => s.session.benchKey === key)
    .map((s) => s.session);
}

export function isLiveSession(sessionId: string): boolean {
  const internal = sessions.get(sessionId);
  return internal !== undefined && internal.pty !== null;
}

export function destroySession(sessionId: string): boolean {
  const internal = sessions.get(sessionId);
  if (!internal) return false;

  clearTimers(internal);
  cancelBufferFlush(sessionId);

  if (internal.pty) {
    try {
      internal.pty.kill();
    } catch {
      // Process may have already exited
    }
  }

  if (internal.ws) {
    try {
      internal.ws.close();
    } catch {
      // WebSocket may be already closed
    }
  }

  sessions.delete(sessionId);
  deletePersistedSession(sessionId);
  return true;
}

export function destroyBenchSessions(projectId: string, benchId: number): void {
  const key = benchKey(projectId, benchId);
  for (const [id, internal] of sessions) {
    if (internal.session.benchKey === key) {
      clearTimers(internal);
      cancelBufferFlush(id);
      if (internal.pty) {
        try {
          internal.pty.kill();
        } catch {
          /* ignore */
        }
      }
      if (internal.ws) {
        try {
          internal.ws.close();
        } catch {
          /* ignore */
        }
      }
      sessions.delete(id);
      deletePersistedSession(id);
    }
  }
}

export function destroyAllSessions(): void {
  // Persist all live sessions before killing (so scrollback survives restart)
  for (const [id, internal] of sessions) {
    if (internal.pty) {
      internal.session.status = "ended";
      persistSession(id);
    }
    clearTimers(internal);
    cancelBufferFlush(id);
    if (internal.pty) {
      try {
        internal.pty.kill();
      } catch {
        /* ignore */
      }
    }
    if (internal.ws) {
      try {
        internal.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  sessions.clear();
}

export function loadPersistedSessions(): void {
  ensureSessionsDir();

  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
      const persisted: PersistedTerminalSession = JSON.parse(raw);

      // Mark as ended — the PTY is gone after a server restart
      persisted.session.status = "ended";

      const internal: InternalSession = {
        session: persisted.session,
        pty: null,
        ws: null,
        buffer: CircularBuffer.from(persisted.buffer, MAX_BUFFER_CHUNKS),
        exitCode: persisted.session.exitCode ?? null,
        pingTimer: null,
        pongDeadline: null,
        quiescenceTimer: null,
        lastOutputAt: null,
        lastNotifiedAt: null,
      };

      sessions.set(persisted.session.id, internal);

      // Re-persist with corrected status
      persistSession(persisted.session.id);
    } catch {
      // Skip corrupt files
    }
  }
}

export function handleWebSocket(sessionId: string, ws: WebSocket): void {
  const internal = sessions.get(sessionId);
  if (!internal) {
    ws.close(4004, "Session not found");
    return;
  }

  // Close any previously connected WebSocket and clean up its timers
  clearTimers(internal);
  if (internal.ws) {
    try {
      internal.ws.close();
    } catch {
      /* ignore */
    }
  }
  internal.ws = ws;

  // Send buffered output replay
  ws.send(
    JSON.stringify({
      type: "replay",
      lines: internal.buffer.toArray(),
      exitCode: internal.exitCode ?? undefined,
    }),
  );

  // Ghost session: replay then close
  if (!internal.pty) {
    ws.close(4410, "Session ended");
    internal.ws = null;
    return;
  }

  // Arm (or re-arm on reconnect) the quiescence timer for non-claude sessions.
  // clearTimers above cancelled any pending timer. On reconnect, if the shell is
  // already idle at a prompt no new PTY output will arrive so the onData handler
  // won't reschedule — we do it here to ensure a waiting terminal still notifies.
  //
  // Skip the rearm when we have already notified for the current idle window
  // (no fresh output since lastNotifiedAt). Without this, a reconnect after a
  // user dismissal would repeatedly fire fresh notifications for the same
  // unchanged idle state. scheduleQuiescenceCheck applies the same guard
  // inside the timer callback as a second line of defence.
  if (
    internal.session.command !== "claude" &&
    (internal.lastNotifiedAt === null || (internal.lastOutputAt ?? 0) > internal.lastNotifiedAt)
  ) {
    scheduleQuiescenceCheck(sessionId);
  }

  // Send live pty output to WebSocket
  const dataHandler = internal.pty.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  const exitHandler = internal.pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
    }
  });

  // Ping/pong heartbeat
  internal.pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
      if (internal.pongDeadline) clearTimeout(internal.pongDeadline);
      internal.pongDeadline = setTimeout(() => {
        // No pong received — close to trigger client reconnect
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, PONG_TIMEOUT_MS);
    }
  }, PING_INTERVAL_MS);

  // Handle messages from WebSocket
  ws.on("message", (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      if (msg.type === "input" && typeof msg.data === "string") {
        internal.pty?.write(msg.data);
        // Cancel the quiescence timer so active typing doesn't trigger a notification
        cancelQuiescenceCheck(internal);
        // User has engaged — reset the notify-gate so the next idle window can
        // fire a fresh notification instead of being suppressed by the
        // reconnect/quiescence guards.
        internal.lastNotifiedAt = null;
        const parsed = parseBenchKey(internal.session.benchKey);
        if (parsed) {
          try {
            const bench = benchManager.getBench(parsed.projectId, parsed.benchId);
            if (bench) notificationService.dismissBySession(bench, internal.session.id);
          } catch {
            // Best-effort — don't break terminal input on notification errors
          }
        }
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        internal.pty?.resize(msg.cols, msg.rows);
      } else if (msg.type === "pong") {
        if (internal.pongDeadline) {
          clearTimeout(internal.pongDeadline);
          internal.pongDeadline = null;
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    dataHandler.dispose();
    exitHandler.dispose();
    clearTimers(internal);
    internal.ws = null;
  });
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function writeToSession(sessionId: string, data: string): boolean {
  const internal = sessions.get(sessionId);
  if (!internal?.pty) return false;
  internal.pty.write(data);
  return true;
}
