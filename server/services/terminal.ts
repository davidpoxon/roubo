import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type { TerminalSession, PersistedTerminalSession, AgentLaunchFailure } from "@roubo/shared";
import type {
  AgentPosture,
  WaitingDetectionSpec,
} from "@roubo/shared/agent-launch-descriptor-schema";
import { AgentPostureSchema } from "@roubo/shared/agent-launch-descriptor-schema";
import { atomicWrite, getRouboDir } from "./state.js";
import { AgentCommandNotFoundError, getLoginShell, resolveAgentCommand } from "./env.js";
import { ensureNotifierInstalled } from "./agent-notifier.js";
import * as notificationService from "./notification.js";
import * as benchManager from "./bench-manager.js";
import { resolveTemplate, type ResolvedTemplateContext } from "./config-parser.js";
import {
  collectWorkspaceWrites,
  executeWorkspaceWrites,
  resolveWriteTemplates,
} from "./agent-launch-executor.js";
import {
  prepareAgentLaunch,
  type AgentConfigLayers,
  type LaunchPermissions,
} from "./agent-launch-pipeline.js";
import {
  AgentLaunchFailureError,
  classifyLaunchExit,
  compatibilityNotice,
  hostInstallBrokenFailure,
  missingBinaryFailure,
  type AgentLaunchContextInfo,
} from "./agent-launch-failure.js";
import type { AgentVersionProbeResult } from "./agent-version-probe.js";
import { withSpawnHelperDiagnosis } from "./pty-preflight.js";
import { UUID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

const MAX_BUFFER_CHUNKS = 5000;
/** Cap on the child's own bytes kept for the early-exit classifier (see registerSession). */
const PTY_CAPTURE_LIMIT = 8192;
const FLUSH_DEBOUNCE_MS = 500;
const QUIESCENCE_DEBOUNCE_MS = 2000;
// An agent TUI redraws continuously while it's working, so a short debounce
// would fire false positives between streamed chunks. The longer window is
// purely a fallback for the waiting states a hook doesn't cover (e.g. an
// in-terminal question the agent never reports). A hook-driven agent plugin can
// override it with `capabilities.waitingDetection.quiescenceFallbackMs`.
const HOOK_QUIESCENCE_FALLBACK_MS = 8000;
// Host-internal env vars that must not leak into bench sessions (issue #877).
// The packaged app sets ROUBO_PRODUCTION on its own process and publishes its
// bound ROUBO_PORT back into process.env; with ROUBO_PRODUCTION inherited, a dev
// or e2e server started inside a bench resolves state to the real ~/.roubo and
// mutates it at boot while the app is running. Both are consumed server-side
// only, so bench terminals never need them.
const HOST_INTERNAL_ENV_KEYS = new Set(["ROUBO_PRODUCTION", "ROUBO_PORT"]);
// The port `{{port}}` resolves to when the server has not published its bound
// port yet. It is exactly why ROUBO_PORT is stripped from every child env above:
// core tells the agent the port, the agent never inherits it.
const DEFAULT_ROUBO_PORT = "3335";

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
  // Notification wiring resolved once at launch from the agent's declared
  // capabilities (AP-FR-013). Core reads these instead of sniffing the command
  // name, so a hook POST correlates on live session identity and the quiescence
  // debounce is the agent's declared one.
  //
  // `hookNotification` is true when the agent POSTs waiting events to core's
  // hook endpoint (`capabilities.notification.kind === "http-hook"`).
  // `waitingDetection` is the agent's declared detection spec, absent when
  // the agent declares none.
  hookNotification: boolean;
  // The resolved correlation token for a `spawned-notifier` agent (issue #698),
  // absent for every other session. Unlike the http-hook path, whose
  // `correlation.source: "agent-native"` makes the session id itself the token,
  // this token is whatever the plugin's `correlation.template` resolved to, so
  // it is registered in `notifierTokens` and traded back for this session when
  // the spawned program calls home.
  notifierCorrelation?: string;
  waitingDetection?: WaitingDetectionSpec;
  // Set when this session's PTY exit was classified as a launch failure
  // (AP-FR-015). Replayed to every WebSocket that attaches afterwards, so the
  // error panel survives a reconnect rather than only reaching whoever happened
  // to be listening at the moment the process died.
  launchFailure?: AgentLaunchFailure;
}

const sessions = new Map<string, InternalSession>();
// Correlation token -> session id, for the `spawned-notifier` wiring only. The
// http-hook path needs no such registry: its token IS the session id.
const notifierTokens = new Map<string, string>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Drop a removed session's correlation token so it can never be traded again. */
function forgetNotifierToken(internal: InternalSession): void {
  const token = internal.notifierCorrelation;
  if (token !== undefined && notifierTokens.get(token) === internal.session.id) {
    notifierTokens.delete(token);
  }
}

/**
 * Whether a correlation token is currently held by a session that is still live.
 *
 * A registration only conflicts while the incumbent can actually be notified.
 * The map keeps an exited session's entry until that session record is destroyed,
 * so presence in the map is not ownership: the same liveness test
 * `isNotifierNotificationEligible` applies decides who really holds it.
 */
function isNotifierTokenHeldByLiveSession(token: string): boolean {
  const ownerId = notifierTokens.get(token);
  if (ownerId === undefined) return false;
  const owner = sessions.get(ownerId);
  if (!owner) return false;
  return owner.pty !== null && owner.exitCode === null;
}

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

/**
 * `displayName` is the agent's own name, taken from its plugin manifest. When it
 * is supplied the label is generic: nothing here knows which agent it is
 * labelling (AP-FR-011). Without one the session is a plain shell terminal.
 */
function generateLabel(
  projectName: string,
  benchId: number,
  command?: string,
  displayName?: string,
): string {
  const benchSessions = Array.from(sessions.values()).filter(
    (s) => s.session.benchKey.endsWith(`:${benchId}`) && s.session.command === command,
  );
  const index = benchSessions.length + 1;
  if (displayName) {
    return `${displayName} ${index} - ${projectName} #${benchId}`;
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
    // Best-effort persistence: don't crash if disk write fails
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
// onData whenever fresh PTY output arrives so an agent tab indicator clears
// the moment the agent resumes work, and an idle shell's indicator clears the
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
    // Best-effort: don't break terminal output on notification errors
  }
}

/**
 * The idle window after which a session is treated as waiting on the user.
 *
 * Descriptor-driven first (AP-FR-013): a `quiescence-only` agent gets exactly
 * the debounce it declared, and a `hook-driven` one gets its declared fallback
 * (quiescence is only a safety net behind its hook). An agent declaring no
 * waiting detection falls back on its wiring: a notification-wired one (a plugin
 * declaring `notification.kind` of either `http-hook` or `spawned-notifier`)
 * gets the same 8000ms fallback window, and anything else gets the generic
 * terminal debounce. A spawned-notifier agent counts because its own signal
 * fires on turn completion only, so quiescence is its fallback rather than its
 * primary mechanism, exactly as it is for a hook.
 */
function resolveQuiescenceDebounce(internal: InternalSession): number {
  const spec = internal.waitingDetection;
  if (spec?.kind === "quiescence-only") return spec.debounceMs;
  if (spec?.kind === "hook-driven") return spec.quiescenceFallbackMs ?? HOOK_QUIESCENCE_FALLBACK_MS;
  return isNotificationWiredSession(internal)
    ? HOOK_QUIESCENCE_FALLBACK_MS
    : QUIESCENCE_DEBOUNCE_MS;
}

/** Whether the agent signals core itself, by hook POST or by spawned notifier. */
function isNotificationWiredSession(internal: InternalSession): boolean {
  return internal.hookNotification || internal.notifierCorrelation !== undefined;
}

/**
 * Whether a quiescent session is an agent (`agent-waiting`) rather than a plain
 * terminal (`terminal-waiting`). An agent that declares neither notification
 * wiring nor waiting detection launches as a plain terminal session, which is
 * exactly what the descriptor schema says absence means.
 */
function isAgentWaitingSession(internal: InternalSession): boolean {
  return isNotificationWiredSession(internal) || internal.waitingDetection !== undefined;
}

function scheduleQuiescenceCheck(id: string): void {
  const internal = sessions.get(id);
  if (!internal) return;

  if (internal.quiescenceTimer) clearTimeout(internal.quiescenceTimer);

  const debounce = resolveQuiescenceDebounce(internal);

  internal.quiescenceTimer = setTimeout(() => {
    internal.quiescenceTimer = null;
    // Guard: session may have been destroyed or exited since the timer was set
    if (!sessions.has(id)) return;
    if (internal.pty === null || internal.exitCode !== null) return;
    // Skip if no fresh output has arrived since the last notification we
    // created for this session. This is what makes a WS reconnect a no-op
    // after a user dismissal: without it, every reconnect would re-fire.
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
        const type = isAgentWaitingSession(internal) ? "agent-waiting" : "terminal-waiting";
        notificationService.createNotification(bench, type, internal.session.id, {
          label: internal.session.label,
        });
        internal.lastNotifiedAt = Date.now();
      }
    } catch {
      // Best-effort: don't break terminal output on notification errors
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

/**
 * Open a plain login-shell session in a bench workspace.
 *
 * This is the shell path and nothing else. Every agent launch goes through
 * `createAgentSession`, which reads a plugin's launch descriptor: since #521
 * core assembles no agent argv, resolves no agent binary, and writes no
 * agent-specific settings file of its own.
 */
export function createSession(
  projectId: string,
  benchId: number,
  workspacePath: string,
  projectName: string,
): TerminalSession {
  const id = randomUUID();
  const key = benchKey(projectId, benchId);
  const label = generateLabel(projectName, benchId);

  const shell = getLoginShell();

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workspacePath,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined && !HOST_INTERNAL_ENV_KEYS.has(e[0]),
        ),
      ),
    });
  } catch (err) {
    // A spawn throw is usually node-pty's own helper rather than the shell, so
    // carry the diagnosis when there is one (#685).
    throw new Error(
      withSpawnHelperDiagnosis(
        `Failed to spawn terminal (shell: ${shell}, cwd: ${workspacePath}): ${(err as Error).message}`,
      ),
      { cause: err },
    );
  }

  const session: TerminalSession = {
    id,
    benchKey: key,
    label,
    createdAt: new Date().toISOString(),
    status: "live",
  };

  registerSession(session, ptyProcess, {});

  return session;
}

/**
 * Put a freshly spawned PTY under session management: buffering, debounced
 * persistence, waiting-notification dismissal, quiescence scheduling, and exit
 * tracking. Shared by the shell `createSession` and the descriptor-driven
 * `createAgentSession` so both get identical session semantics.
 */
interface RegisterSessionOptions {
  onExit?: (sessionId: string) => void;
  /** The agent POSTs waiting events to core's hook endpoint. */
  hookNotification?: boolean;
  /**
   * The resolved correlation token a `spawned-notifier` agent's notifier program
   * will quote back (issue #698). Registered here so the token, minted at launch
   * from the same template context as the carrier argv, is the one core looks up.
   */
  notifierCorrelation?: string;
  /** The agent's declared waiting-detection spec, when it declares one. */
  waitingDetection?: WaitingDetectionSpec;
  /**
   * Arms launch-failure classification for an agent session (AP-FR-015). Absent
   * for the built-in shell path, which has no plugin to attribute a failure to.
   */
  launchContext?: AgentLaunchContextInfo;
  /** A non-blocking compatibility notice written into the scrollback at byte zero. */
  notice?: string;
}

function registerSession(
  session: TerminalSession,
  ptyProcess: pty.IPty,
  opts: RegisterSessionOptions = {},
): void {
  const id = session.id;
  // Time-to-exit is measured from here rather than from the request, so the 5s
  // early-exit window covers the child's own life and not the descriptor RPC
  // that preceded it.
  const spawnedAt = Date.now();
  // A correlation template is plugin-authored and only validated as non-empty,
  // so a plugin could declare a constant rather than something session-derived.
  // Refuse a token another live session already owns: two sessions sharing one
  // token would let either agent's notifier raise notifications against the
  // other. The launch itself is unaffected; that session simply falls back on
  // quiescence, which is the pre-#698 behaviour.
  //
  // Liveness, not mere presence: a session record outlives its PTY so the
  // scrollback stays readable, and its token is spent the moment the PTY exits
  // (isNotifierNotificationEligible). Testing `has` alone would let a dead
  // session hold a constant token for the rest of the process, so every later
  // launch declaring it would silently lose the wiring for no benefit.
  let notifierCorrelation = opts.notifierCorrelation;
  if (notifierCorrelation !== undefined && isNotifierTokenHeldByLiveSession(notifierCorrelation)) {
    console.warn(
      "[terminal] ignoring a correlation token already registered to another session for session %s",
      id,
    );
    notifierCorrelation = undefined;
  }
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
    hookNotification: opts.hookNotification === true,
    ...(notifierCorrelation !== undefined && { notifierCorrelation }),
    ...(opts.waitingDetection !== undefined && { waitingDetection: opts.waitingDetection }),
  };
  const onExit = opts.onExit;

  sessions.set(id, internal);
  if (notifierCorrelation !== undefined) notifierTokens.set(notifierCorrelation, id);

  // The notice is pushed BEFORE any PTY output so it reads as a preamble to the
  // session rather than as something the agent said (AP-TC-072, AP-TC-074).
  if (opts.notice) {
    internal.buffer.push(`\x1b[33m${opts.notice}\x1b[0m\r\n\r\n`);
  }

  // The child's OWN bytes, accumulated separately from `internal.buffer` because
  // that buffer also carries the host's compatibility notice above. Feeding the
  // notice to the classifier would count Roubo's own words as agent output, which
  // both prints our warning back to the user under "Captured agent output" and
  // flips a zero-output missing-binary exit into a launch-failure, since the
  // three-signal rule keys on the output being nonempty.
  //
  // Capped because this only ever feeds the early-exit classifier: `captureOutput`
  // truncates at 4096 bytes anyway, and a healthy session must not accumulate its
  // whole transcript twice.
  let ptyOutput = "";

  // Buffer all PTY output (WS forwarding happens in handleWebSocket)
  ptyProcess.onData((data) => {
    internal.buffer.push(data);
    if (ptyOutput.length < PTY_CAPTURE_LIMIT) ptyOutput += data;
    internal.lastOutputAt = Date.now();
    // Debounced flush: coalesces rapid output, also catches idle sessions
    scheduleBufferFlush(id);
    // Fresh output means this session is not currently waiting on the user.
    // Clear any pending agent-waiting/terminal-waiting notification so the tab
    // indicator (and any OS notification state) tracks the live session state.
    dismissWaitingNotificationsForSession(internal);
    // Schedule a quiescence check: if no further output arrives within the
    // debounce window the session is likely waiting for input. Agent sessions
    // use a longer window as a fallback for waiting events the hook misses;
    // hook-driven notifications still fire immediately.
    scheduleQuiescenceCheck(id);
  });

  // Track exit
  ptyProcess.onExit(({ exitCode }) => {
    internal.exitCode = exitCode;
    internal.session.status = "ended";
    internal.session.exitCode = exitCode;
    cancelQuiescenceCheck(internal);
    // Classified before persistence and before the caller's onExit hook, so
    // whatever runs next already sees the verdict. This registration is made at
    // session creation, ahead of handleWebSocket's own onExit listener, and
    // node-pty fires listeners in registration order: by the time the socket
    // sends its exit frame, `internal.launchFailure` is populated.
    if (opts.launchContext) {
      internal.launchFailure = classifyLaunchExit(opts.launchContext, {
        exitCode,
        timeToExitMs: Date.now() - spawnedAt,
        output: ptyOutput,
      });
    }
    persistSession(id);
    try {
      onExit?.(id);
    } catch {
      /* best-effort */
    }
  });

  persistSession(id);
}

export interface CreateAgentSessionOptions {
  projectId: string;
  benchId: number;
  workspacePath: string;
  projectName: string;
  /** The `agent`-kind plugin whose descriptor drives this launch. */
  agentPluginId: string;
  /** The two launch-time config layers above the stored app and project ones. */
  layers?: AgentConfigLayers;
  /**
   * The project's permissions model (AP-FR-016). Handed to the plugin so its
   * descriptor can carry the posture and, for a plugin declaring the rules
   * capability, the allow/ask/deny rules into the bench workspace at session
   * start (AP-TC-078, AP-TC-097).
   */
  permissions?: LaunchPermissions;
  initialInput?: string;
  onAgentExit?: (sessionId: string) => void;
}

/**
 * What the launch actually did with the initial prompt (the resolved jig
 * content), reported back so the caller never has to guess (AP-FR-012,
 * AP-FR-018).
 *
 * `mode` echoes the descriptor's declared injection capability, and is `"none"`
 * when the descriptor declares none. Core injects nothing then, so a caller that
 * meant to deliver jig content must neither claim it was injected nor fall back
 * to writing it into the PTY afterwards: an agent that declares no injection
 * capability launches with nothing injected, by design.
 */
export interface AgentPromptInjection {
  mode: "argv-positional" | "none";
  /** The prompt reached argv: `mode` is declared AND a prompt was supplied. */
  injected: boolean;
}

export interface AgentSessionLaunch {
  session: TerminalSession;
  promptInjection: AgentPromptInjection;
  /** The pre-spawn version probe, when the agent declared one (AP-FR-014). */
  compatibility?: AgentVersionProbeResult;
}

/**
 * Open a PTY session from a plugin-supplied `AgentLaunchDescriptor` (AP-FR-011).
 *
 * The ordering is the whole design. The session id is minted FIRST, before the
 * plugin is asked for anything, because the plugin receives it in its launch
 * context, the descriptor's argv embeds it as `{{sessionId}}`, and an http-hook
 * notification carrier writes it into a workspace settings file. One mint keeps
 * all three pointing at the same real session. Then, in order: resolve the
 * descriptor's templates, execute its workspace writes (path-validated,
 * core-side, and before the spawn so an escaping path aborts the launch rather
 * than leaving a half-configured agent running), then spawn.
 *
 * argv reaches `pty.spawn` as an array and is never joined into a shell string,
 * so shell metacharacters anywhere in the four-layer config, including a
 * free-form extra-arguments field, arrive at the agent as literal argv elements
 * (AP-NFR-001, AP-TC-083).
 */
export async function createAgentSession(
  opts: CreateAgentSessionOptions,
): Promise<AgentSessionLaunch> {
  const id = randomUUID();

  const prepared = await prepareAgentLaunch({
    pluginId: opts.agentPluginId,
    projectId: opts.projectId,
    benchId: opts.benchId,
    workspacePath: opts.workspacePath,
    sessionId: id,
    ...(opts.initialInput !== undefined && { initialPrompt: opts.initialInput }),
    ...(opts.layers !== undefined && { layers: opts.layers }),
    ...(opts.permissions !== undefined && { permissions: opts.permissions }),
  });

  const { descriptor } = prepared;
  const notification = descriptor.capabilities?.notification;
  const port = process.env.ROUBO_PORT || DEFAULT_ROUBO_PORT;
  // A spawned-notifier agent spawns a program core has to supply, so the program
  // is installed BEFORE templates resolve: `{{notifier}}` is an absolute path and
  // there is nothing to point at until it exists (issue #698). The endpoint it
  // POSTs to is baked in at that write, for the same reason the hook URL is baked
  // into the Claude settings write: ROUBO_PORT never reaches a child.
  const notifierPath =
    notification?.kind === "spawned-notifier" ? installNotifier(port) : undefined;
  const ctx: ResolvedTemplateContext = {
    ports: {},
    portHttps: {},
    workspace: opts.workspacePath,
    components: {},
    sessionId: id,
    port,
    ...(notifierPath !== undefined && { notifier: notifierPath }),
  };

  // A posture binding has two carriers, argv and workspace writes, and a
  // descriptor may use either. Both are applied here so the posture the
  // effective config selected is never half-applied: dropping the argv half
  // while honouring the file half would launch a session whose real permissions
  // disagree with the resolved config.
  const posture = readPosture(prepared.effectiveConfig);
  const postureBinding = posture
    ? descriptor.capabilities?.permissions?.postures[posture]
    : undefined;

  const command = resolveTemplate(descriptor.command, ctx);
  const args = descriptor.args.map((arg) => resolveTemplate(arg, ctx));
  for (const arg of postureBinding?.args ?? []) {
    args.push(resolveTemplate(arg, ctx));
  }
  // The spawned-notifier carrier rides argv, so its contribution is appended here
  // and, like the posture args, ahead of the positional prompt (issue #698). The
  // http-hook carrier rides a workspace write instead and contributes nothing to
  // argv, which is why this is the only notification arm with an argv branch.
  //
  // The correlation token is resolved from the SAME ctx, so whatever the carrier
  // argv tells the agent to quote back is exactly what core registers.
  let notifierCorrelation: string | undefined;
  if (notification?.kind === "spawned-notifier" && notifierPath !== undefined) {
    for (const arg of notification.carrier.args) {
      args.push(resolveTemplate(arg, ctx));
    }
    notifierCorrelation = resolveTemplate(notification.correlation.template, ctx);
  }
  // The initial prompt is positional, so it stays last, after every flag. The
  // descriptor's declared limit is capped by core's own MAX_CLI_PROMPT_LENGTH:
  // a plugin can ask for a shorter prompt than core would allow, never a longer
  // one (AP-FR-012).
  const promptInjection: AgentPromptInjection = {
    mode: descriptor.initialPrompt?.mode ?? "none",
    injected: false,
  };
  if (descriptor.initialPrompt?.mode === "argv-positional" && opts.initialInput) {
    const limit = Math.min(descriptor.initialPrompt.maxLength ?? Infinity, MAX_CLI_PROMPT_LENGTH);
    args.push(opts.initialInput.slice(0, limit));
    promptInjection.injected = true;
  }
  const cwd = descriptor.cwd ? resolveTemplate(descriptor.cwd, ctx) : opts.workspacePath;

  // Workspace writes run BEFORE the spawn: a descriptor whose relPath escapes
  // the bench workspace aborts the whole batch (and this launch) with nothing
  // written anywhere (AP-NFR-001, AP-TC-082).
  executeWorkspaceWrites(
    opts.workspacePath,
    resolveWriteTemplates(collectWorkspaceWrites(descriptor, posture ? { posture } : {}), ctx),
  );

  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !HOST_INTERNAL_ENV_KEYS.has(e[0]),
    ),
  );
  // Descriptor env is additive, layered on AFTER the host-internal strip so a
  // plugin can neither reinstate nor observe the keys core withholds. The strip
  // above only filters `process.env`, so the layering re-checks each descriptor
  // key against the same set: `env` is an unrestricted record in the descriptor
  // schema, and without this a descriptor declaring ROUBO_PRODUCTION would hand
  // the child the very key #877 removed, pointing a bench-started dev server at
  // the real ~/.roubo state (AP-NFR-001).
  for (const [key, value] of Object.entries(descriptor.env ?? {})) {
    if (HOST_INTERNAL_ENV_KEYS.has(key)) continue;
    env[key] = resolveTemplate(value, ctx);
  }
  // Prepended AFTER the descriptor's env layering so a descriptor cannot displace
  // it: a carrier naming the notifier by bare name has to resolve to the program
  // core just installed and to nothing else (issue #698). The directory holds
  // that one fixed-name program, so leading the PATH costs nothing else.
  if (notifierPath !== undefined) {
    const notifierDir = path.dirname(notifierPath);
    env.PATH = env.PATH ? `${notifierDir}${path.delimiter}${env.PATH}` : notifierDir;
  }

  // A descriptor's command is a bare name far more often than a path, so it is
  // resolved through the well-known-install-location fallback before it reaches
  // the PTY (#645). This runs OUTSIDE the try below
  // so an unresolvable command surfaces its own error, which names every location
  // tried, instead of being rewrapped as an opaque spawn failure. The child's own
  // PATH is used for the probe, since descriptor env may have changed it, and the
  // manifest's own `agentInstallLocations` supply the fallback candidates for
  // this agent's CLI when it declared any (#712).
  const launchContext: AgentLaunchContextInfo = {
    agentPluginId: opts.agentPluginId,
    agentName: prepared.manifest.name,
    command,
    ...(prepared.compatibility !== undefined && { compatibility: prepared.compatibility }),
  };

  let binary: string;
  try {
    binary = resolveAgentCommand(command, env.PATH, prepared.manifest.agentInstallLocations);
  } catch (err) {
    // The one launch-failure class that is knowable before the spawn. Raised as
    // a structured failure rather than a bare Error so the caller answers with
    // install guidance instead of opening a terminal that dies on its own
    // (AP-TC-058).
    if (err instanceof AgentCommandNotFoundError) {
      throw new AgentLaunchFailureError(missingBinaryFailure(launchContext, err.message));
    }
    throw err;
  }
  launchContext.command = binary;

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(binary, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });
  } catch (err) {
    // Spike #504: a spawn throw means node-pty's own spawn helper is unusable,
    // in which case EVERY spawn fails including known-good binaries. That is a
    // Roubo install problem, so it is attributed to the host rather than blamed
    // on the agent plugin. When the helper's executable bit is the cause (#685)
    // the guidance names the one-line `chmod` fix instead of stopping at the
    // generic "reinstall Roubo".
    throw new AgentLaunchFailureError(
      hostInstallBrokenFailure(
        launchContext,
        withSpawnHelperDiagnosis(
          `Failed to spawn agent session (command: ${binary}, cwd: ${cwd}): ${(err as Error).message}`,
        ),
      ),
    );
  }

  const session: TerminalSession = {
    id,
    benchKey: benchKey(opts.projectId, opts.benchId),
    label: generateLabel(opts.projectName, opts.benchId, command, prepared.manifest.name),
    createdAt: new Date().toISOString(),
    command,
    status: "live",
    agentPluginId: opts.agentPluginId,
  };

  // Notification wiring comes straight off the descriptor: an http-hook agent
  // is the only kind whose hook POSTs core will honour, a spawned-notifier one
  // is reachable only through the correlation token resolved above, and
  // whichever waiting detection it declared drives the quiescence debounce
  // (AP-FR-013, issue #698).
  const capabilities = descriptor.capabilities;
  // Above the tested ceiling, and a probe that could not decide, both launch:
  // agents ship weekly, so neither may block. They are surfaced as an in-terminal
  // notice and returned to the caller (AP-TC-072, AP-TC-074, AP-TC-100 S002).
  const notice = prepared.compatibility
    ? compatibilityNotice(prepared.manifest.name, prepared.compatibility)
    : undefined;
  registerSession(session, ptyProcess, {
    hookNotification: capabilities?.notification?.kind === "http-hook",
    ...(notifierCorrelation !== undefined && { notifierCorrelation }),
    ...(capabilities?.waitingDetection !== undefined && {
      waitingDetection: capabilities.waitingDetection,
    }),
    ...(opts.onAgentExit !== undefined && { onExit: opts.onAgentExit }),
    launchContext,
    ...(notice !== undefined && { notice }),
  });

  return {
    session,
    promptInjection,
    ...(prepared.compatibility !== undefined && { compatibility: prepared.compatibility }),
  };
}

/**
 * Install the notifier program, or give up on the wiring (issue #698).
 *
 * Best-effort for the same reason the built-in hook settings write is: a
 * notification carrier is a convenience, not the launch. A disk that refuses the
 * write costs the turn-complete signal and nothing else, and the caller drops
 * the whole wiring rather than pointing the agent at a program that is not
 * there, leaving the session on quiescence exactly as it was before #698.
 */
function installNotifier(port: string): string | undefined {
  try {
    return ensureNotifierInstalled(port);
  } catch (err) {
    console.warn("Failed to install the agent notifier program:", err);
    return undefined;
  }
}

/**
 * The permission posture the effective config selects, when it selects a valid
 * one. Core never interprets it beyond picking the descriptor's matching posture
 * binding; the posture vocabulary is the descriptor schema's, not core's.
 */
function readPosture(effectiveConfig: Record<string, unknown>): AgentPosture | undefined {
  const parsed = AgentPostureSchema.safeParse(effectiveConfig.posture);
  return parsed.success ? parsed.data : undefined;
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

/**
 * Whether a hook POST quoting this session id may raise a waiting notification
 * (AP-FR-013, AP-FR-018).
 *
 * Two conditions, both required. The session must still be live, which is what
 * expires a correlation token: an exited session and one restored from disk
 * after a server restart both keep their record so their scrollback survives,
 * and a POST quoting either is a forged or stale token rather than a live agent
 * asking for attention (AP-TC-084). And its agent must actually be hook-wired:
 * for a plugin agent that is a property of the launch descriptor rather than of
 * the command name, so no plugin is privileged by what its binary happens to be
 * called. A plain shell session has no descriptor and is never eligible.
 */
export function isHookNotificationEligible(sessionId: string): boolean {
  const internal = sessions.get(sessionId);
  if (!internal) return false;
  return internal.pty !== null && internal.exitCode === null && internal.hookNotification;
}

/**
 * The session a spawned notifier's correlation token belongs to (issue #698).
 *
 * The `spawned-notifier` counterpart to addressing a session by its own id. That
 * shortcut is what `correlation.source: "agent-native"` buys the http-hook path:
 * the agent already knows the Roubo session id, so the id IS the token. An agent
 * with no session-id concept of its own cannot do that, so the token is whatever
 * the plugin's `correlation.template` resolved to at launch and core has to hold
 * the mapping.
 */
export function resolveNotifierSession(token: string): TerminalSession | undefined {
  const sessionId = notifierTokens.get(token);
  if (sessionId === undefined) return undefined;
  return sessions.get(sessionId)?.session;
}

/**
 * Whether a notifier POST quoting this correlation token may raise a
 * notification (issue #698).
 *
 * The same three-part rule `isHookNotificationEligible` applies, read through
 * the token: the token must be registered, the session it names must still be
 * live, and that session must be the one that registered it. A token outlives
 * nothing: the session record survives an exit so its scrollback stays readable,
 * but the token it carried is spent the moment the PTY does (AP-TC-084).
 */
export function isNotifierNotificationEligible(token: string): boolean {
  const sessionId = notifierTokens.get(token);
  if (sessionId === undefined) return false;
  const internal = sessions.get(sessionId);
  if (!internal) return false;
  return (
    internal.pty !== null && internal.exitCode === null && internal.notifierCorrelation === token
  );
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

  forgetNotifierToken(internal);
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
      forgetNotifierToken(internal);
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
  notifierTokens.clear();
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

      // Mark as ended: the PTY is gone after a server restart
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
        // A restored session has no PTY and no live agent behind it, so its
        // correlation token is spent: a hook POST quoting it is rejected
        // (AP-TC-084). Nothing is re-derived from the descriptor here because
        // there is nothing left to notify about.
        hookNotification: false,
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
      // A failure that already happened is replayed, so a reconnect (or a tab
      // opened after the fact) still shows the error panel rather than a bare
      // exit code (AP-NFR-003: never a silent dead terminal).
      launchFailure: internal.launchFailure,
    }),
  );

  // Ghost session: replay then close
  if (!internal.pty) {
    ws.close(4410, "Session ended");
    internal.ws = null;
    return;
  }

  // Arm (or re-arm on reconnect) the quiescence timer for sessions whose
  // waiting state is not hook-driven. clearTimers above cancelled any pending
  // timer. On reconnect, if the shell is already idle at a prompt no new PTY
  // output will arrive so the onData handler won't reschedule: we do it here to
  // ensure a waiting terminal still notifies. A hook-wired agent is skipped
  // because its hook, not the reconnect, is what says it is waiting.
  //
  // Skip the rearm when we have already notified for the current idle window
  // (no fresh output since lastNotifiedAt). Without this, a reconnect after a
  // user dismissal would repeatedly fire fresh notifications for the same
  // unchanged idle state. scheduleQuiescenceCheck applies the same guard
  // inside the timer callback as a second line of defence.
  if (
    !internal.hookNotification &&
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
      ws.send(
        JSON.stringify({ type: "exit", code: exitCode, launchFailure: internal.launchFailure }),
      );
    }
  });

  // Ping/pong heartbeat
  internal.pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
      if (internal.pongDeadline) clearTimeout(internal.pongDeadline);
      internal.pongDeadline = setTimeout(() => {
        // No pong received: close to trigger client reconnect
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
        // User has engaged: reset the notify-gate so the next idle window can
        // fire a fresh notification instead of being suppressed by the
        // reconnect/quiescence guards.
        internal.lastNotifiedAt = null;
        const parsed = parseBenchKey(internal.session.benchKey);
        if (parsed) {
          try {
            const bench = benchManager.getBench(parsed.projectId, parsed.benchId);
            if (bench) notificationService.dismissBySession(bench, internal.session.id);
          } catch {
            // Best-effort: don't break terminal input on notification errors
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
