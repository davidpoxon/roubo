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
import type {
  AgentPosture,
  WaitingDetectionSpec,
  WorkspaceWriteSpec,
  WriteOp,
} from "@roubo/shared/agent-launch-descriptor-schema";
import { AgentPostureSchema } from "@roubo/shared/agent-launch-descriptor-schema";
import { atomicWrite, getRouboDir } from "./state.js";
import { getClaudeBinary, getLoginShell, resolveAgentCommand } from "./env.js";
import { writeClaudeSettingsLocal } from "./claude-settings-local.js";
import * as notificationService from "./notification.js";
import * as benchManager from "./bench-manager.js";
import { resolveTemplate, type ResolvedTemplateContext } from "./config-parser.js";
import { collectWorkspaceWrites, executeWorkspaceWrites } from "./agent-launch-executor.js";
import { prepareAgentLaunch, type AgentConfigLayers } from "./agent-launch-pipeline.js";
import { UUID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

const MAX_BUFFER_CHUNKS = 5000;
const FLUSH_DEBOUNCE_MS = 500;
const QUIESCENCE_DEBOUNCE_MS = 2000;
// An agent TUI redraws continuously while it's working, so a short debounce
// would fire false positives between streamed chunks. The longer window is
// purely a fallback for the waiting states a hook doesn't cover (e.g. Claude
// Code's AskUserQuestion prompts in plan mode). A hook-driven agent plugin can
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
// port yet. Matches the fallback claude-settings-local.ts uses for the same hook
// URL, and is exactly why ROUBO_PORT is stripped from every child env above:
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
  // hook endpoint (`capabilities.notification.kind === "http-hook"`), and on the
  // legacy built-in `command === "claude"` path until AP-WU-020 (#521) removes
  // it. `waitingDetection` is the agent's declared detection spec, absent when
  // the agent declares none.
  hookNotification: boolean;
  waitingDetection?: WaitingDetectionSpec;
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

/**
 * `displayName` is the agent's own name, taken from its plugin manifest. When it
 * is supplied the label is generic: nothing here knows which agent it is
 * labelling (AP-FR-011). The `command === "claude"` branch below is the legacy
 * built-in path only, removed with the rest of it in AP-WU-020 (#521).
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
    // Best-effort: don't break terminal output on notification errors
  }
}

/**
 * The idle window after which a session is treated as waiting on the user.
 *
 * Descriptor-driven first (AP-FR-013): a `quiescence-only` agent gets exactly
 * the debounce it declared, and a `hook-driven` one gets its declared fallback
 * (quiescence is only a safety net behind its hook). An agent declaring no
 * waiting detection falls back on its wiring: a hook-wired one gets the same
 * 8000ms fallback window (a plugin declaring `notification.kind === "http-hook"`,
 * or the legacy built-in Claude path until AP-WU-020 (#521) removes it), and
 * anything else gets the generic terminal debounce.
 */
function resolveQuiescenceDebounce(internal: InternalSession): number {
  const spec = internal.waitingDetection;
  if (spec?.kind === "quiescence-only") return spec.debounceMs;
  if (spec?.kind === "hook-driven") return spec.quiescenceFallbackMs ?? HOOK_QUIESCENCE_FALLBACK_MS;
  return internal.hookNotification ? HOOK_QUIESCENCE_FALLBACK_MS : QUIESCENCE_DEBOUNCE_MS;
}

/**
 * Whether a quiescent session is an agent (`claude-waiting`) rather than a plain
 * terminal (`terminal-waiting`). An agent that declares neither notification
 * wiring nor waiting detection launches as a plain terminal session, which is
 * exactly what the descriptor schema says absence means.
 */
function isAgentWaitingSession(internal: InternalSession): boolean {
  return internal.hookNotification || internal.waitingDetection !== undefined;
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
        const type = isAgentWaitingSession(internal) ? "claude-waiting" : "terminal-waiting";
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

  const shell = command === "claude" ? getClaudeBinary() : getLoginShell();
  const args: string[] = [];
  if (command === "claude") {
    if (claudeCodeSettings?.enableAutoMode) args.push("--enable-auto-mode");
    if (claudeCodeSettings?.startInPlanMode) args.push("--permission-mode", "plan");
    args.push("--session-id", id);
    if (initialInput) args.push(initialInput.slice(0, MAX_CLI_PROMPT_LENGTH));
    try {
      writeClaudeSettingsLocal(workspacePath, claudeCodeSettings, projectPermissions);
    } catch (err) {
      // Best-effort: a failure here (e.g. disk full) should not prevent the session from starting
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
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined && !HOST_INTERNAL_ENV_KEYS.has(e[0]),
        ),
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

  registerSession(session, ptyProcess, {
    // The built-in Claude path is hook-wired by claude-settings-local.ts rather
    // than by a descriptor, so its eligibility is asserted here (AP-WU-020,
    // #521, removes this alongside the rest of the built-in).
    hookNotification: command === "claude",
    ...(command === "claude" && onClaudeExit !== undefined && { onExit: onClaudeExit }),
  });

  return session;
}

/**
 * Put a freshly spawned PTY under session management: buffering, debounced
 * persistence, waiting-notification dismissal, quiescence scheduling, and exit
 * tracking. Shared by the built-in `createSession` and the descriptor-driven
 * `createAgentSession` so both get identical session semantics.
 */
interface RegisterSessionOptions {
  onExit?: (sessionId: string) => void;
  /** The agent POSTs waiting events to core's hook endpoint. */
  hookNotification?: boolean;
  /** The agent's declared waiting-detection spec, when it declares one. */
  waitingDetection?: WaitingDetectionSpec;
}

function registerSession(
  session: TerminalSession,
  ptyProcess: pty.IPty,
  opts: RegisterSessionOptions = {},
): void {
  const id = session.id;
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
    ...(opts.waitingDetection !== undefined && { waitingDetection: opts.waitingDetection }),
  };
  const onExit = opts.onExit;

  sessions.set(id, internal);

  // Buffer all PTY output (WS forwarding happens in handleWebSocket)
  ptyProcess.onData((data) => {
    internal.buffer.push(data);
    internal.lastOutputAt = Date.now();
    // Debounced flush: coalesces rapid output, also catches idle sessions
    scheduleBufferFlush(id);
    // Fresh output means this session is not currently waiting on the user.
    // Clear any pending claude-waiting/terminal-waiting notification so the tab
    // indicator (and any OS notification state) tracks the live session state.
    dismissWaitingNotificationsForSession(internal);
    // Schedule a quiescence check: if no further output arrives within the
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
  });

  const { descriptor } = prepared;
  const ctx: ResolvedTemplateContext = {
    ports: {},
    portHttps: {},
    workspace: opts.workspacePath,
    components: {},
    sessionId: id,
    port: process.env.ROUBO_PORT || DEFAULT_ROUBO_PORT,
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

  // A descriptor's command is a bare name far more often than a path, so it is
  // resolved through the same well-known-binary fallback the built-in Claude Code
  // path uses before it reaches the PTY (#645). This runs OUTSIDE the try below
  // so an unresolvable command surfaces its own error, which names every location
  // tried, instead of being rewrapped as an opaque spawn failure. The child's own
  // PATH is used for the probe, since descriptor env may have changed it.
  const binary = resolveAgentCommand(command, env.PATH);

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
    throw new Error(
      `Failed to spawn agent session (command: ${binary}, cwd: ${cwd}): ${(err as Error).message}`,
      { cause: err },
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
  // is the only kind whose hook POSTs core will honour, and whichever waiting
  // detection it declared drives the quiescence debounce (AP-FR-013).
  const capabilities = descriptor.capabilities;
  registerSession(session, ptyProcess, {
    hookNotification: capabilities?.notification?.kind === "http-hook",
    ...(capabilities?.waitingDetection !== undefined && {
      waitingDetection: capabilities.waitingDetection,
    }),
    ...(opts.onAgentExit !== undefined && { onExit: opts.onAgentExit }),
  });

  return { session, promptInjection };
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

/**
 * Resolve `{{sessionId}}` / `{{port}}` / `{{workspace}}` through a descriptor's
 * workspace writes. Both the target path and every string reachable from a write
 * op's value are resolved, because an http-hook carrier write embeds the session
 * id and port inside the JSON value it sets, not in the path.
 */
function resolveWriteTemplates(
  writes: WorkspaceWriteSpec[],
  ctx: ResolvedTemplateContext,
): WorkspaceWriteSpec[] {
  return writes.map((write) => ({
    ...write,
    relPath: resolveTemplate(write.relPath, ctx),
    ops: write.ops.map((op): WriteOp => {
      if (op.op === "set") return { ...op, value: resolveJsonTemplates(op.value, ctx) };
      if (op.op === "unionArray") {
        return { ...op, values: op.values.map((v) => resolveTemplate(v, ctx)) };
      }
      return op;
    }),
  }));
}

type WriteOpJsonValue = Extract<WriteOp, { op: "set" }>["value"];

function resolveJsonTemplates(
  value: WriteOpJsonValue,
  ctx: ResolvedTemplateContext,
): WriteOpJsonValue {
  if (typeof value === "string") return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => resolveJsonTemplates(entry, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveJsonTemplates(entry, ctx)]),
    );
  }
  return value;
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
 * called. The legacy built-in Claude path has no descriptor, so `createSession`
 * asserts its eligibility directly; that is the last command-name gate, and it
 * goes with the rest of the built-in in AP-WU-020 (#521).
 */
export function isHookNotificationEligible(sessionId: string): boolean {
  const internal = sessions.get(sessionId);
  if (!internal) return false;
  return internal.pty !== null && internal.exitCode === null && internal.hookNotification;
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
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
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
