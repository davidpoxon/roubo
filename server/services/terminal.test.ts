import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockReaddirSync = vi.fn<() => string[]>().mockReturnValue([]);
const mockReadFileSync = vi.fn().mockReturnValue("{}");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
      readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    },
  };
});

const mockAtomicWrite = vi.fn();

vi.mock("./state.js", () => ({
  atomicWrite: (...args: unknown[]) => mockAtomicWrite(...args),
  getRouboDir: () => "/tmp/roubo-test",
}));

const mockWriteClaudeSettingsLocal = vi.fn();

vi.mock("./claude-settings-local.js", () => ({
  writeClaudeSettingsLocal: (...args: unknown[]) => mockWriteClaudeSettingsLocal(...args),
}));

const mockDismissBySession = vi.fn();
const mockCreateNotification = vi.fn();
const mockDismissWaitingForSession = vi.fn().mockReturnValue(false);

vi.mock("./notification.js", () => ({
  dismissBySession: (...args: unknown[]) => mockDismissBySession(...args),
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  dismissWaitingForSession: (...args: unknown[]) => mockDismissWaitingForSession(...args),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "claude-waiting"]),
}));

const mockGetBench = vi.fn();

vi.mock("./bench-manager.js", () => ({
  getBench: (...args: unknown[]) => mockGetBench(...args),
}));

vi.mock("./env.js", () => ({
  getClaudeBinary: () => "claude",
  cleanEnv: vi.fn(() => ({})),
}));

const mockSpawn = vi.fn();
vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createMockPty() {
  const emitter = new EventEmitter();
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (fn: (data: string) => void) => {
      emitter.on("data", fn);
      return { dispose: () => emitter.removeListener("data", fn) };
    },
    onExit: (fn: (e: { exitCode: number }) => void) => {
      emitter.on("exit", fn);
      return { dispose: () => emitter.removeListener("exit", fn) };
    },
    _emit: (event: string, data: unknown) => emitter.emit(event, data),
  };
}

function createMockWs(overrides: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)?.push(handler);
    },
    _sent: sent,
    _trigger: (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mockSpawn.mockReset();
  mockAtomicWrite.mockReset();
  mockMkdirSync.mockReset();
  mockUnlinkSync.mockReset();
  mockReaddirSync.mockReset().mockReturnValue([]);
  mockReadFileSync.mockReset().mockReturnValue("{}");
  mockWriteClaudeSettingsLocal.mockReset();
  mockDismissBySession.mockReset();
  mockCreateNotification.mockReset();
  mockDismissWaitingForSession.mockReset().mockReturnValue(false);
  mockGetBench.mockReset().mockReturnValue({ id: 1, projectId: "project1", notifications: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadModule() {
  return await import("./terminal.js");
}

describe("createSession", () => {
  it("creates a shell session and returns metadata", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");

    expect(session.id).toMatch(UUID_REGEX);
    expect(session.benchKey).toBe("project1:1");
    expect(session.label).toContain("Terminal");
    expect(session.label).toContain("My Project");
    expect(session.command).toBeUndefined();
    expect(session.status).toBe("live");
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        cwd: "/workspace",
        cols: 80,
        rows: 24,
      }),
    );
  });

  it('creates a claude session when command is "claude"', async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude");

    expect(session.command).toBe("claude");
    expect(session.label).toContain("Claude");
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--session-id", expect.stringMatching(UUID_REGEX)],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("passes initialInput as a CLI argument for claude sessions", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude", "Fix the bug");

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--session-id", expect.stringMatching(UUID_REGEX), "Fix the bug"],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("ignores initialInput for non-claude sessions", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", undefined, "some input");

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("truncates initialInput exceeding 100,000 characters", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const longJig = "x".repeat(150_000);
    createSession("project1", 1, "/workspace", "My Project", "claude", longJig);

    const passedArgs = mockSpawn.mock.calls[0][1] as string[];
    // args: ['--session-id', uuid, truncatedInput]
    expect(passedArgs[2]).toHaveLength(100_000);
  });

  it("prepends --enable-auto-mode when enableAutoMode is true", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: true,
      startInPlanMode: false,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--enable-auto-mode", "--session-id", expect.stringMatching(UUID_REGEX)],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("prepends --permission-mode plan when startInPlanMode is true", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: false,
      startInPlanMode: true,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--permission-mode", "plan", "--session-id", expect.stringMatching(UUID_REGEX)],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("passes both --enable-auto-mode and --permission-mode plan when both flags are enabled", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: true,
      startInPlanMode: true,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "--enable-auto-mode",
        "--permission-mode",
        "plan",
        "--session-id",
        expect.stringMatching(UUID_REGEX),
      ],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("prepends flags before initialInput", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude", "Fix the bug", {
      enableAutoMode: true,
      startInPlanMode: true,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "--enable-auto-mode",
        "--permission-mode",
        "plan",
        "--session-id",
        expect.stringMatching(UUID_REGEX),
        "Fix the bug",
      ],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("applies no flags when both are false", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude", "Fix the bug", {
      enableAutoMode: false,
      startInPlanMode: false,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--session-id", expect.stringMatching(UUID_REGEX), "Fix the bug"],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("calls writeClaudeSettingsLocal with workspace, settings, and projectPermissions before spawn", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const settings = { enableAutoMode: true, startInPlanMode: false };
    const permissions = { allow: ["Bash(*)", "Read(*)"], deny: [] };
    createSession(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      settings,
      permissions,
    );

    expect(mockWriteClaudeSettingsLocal).toHaveBeenCalledWith("/workspace", settings, permissions);
    const writeOrder = mockWriteClaudeSettingsLocal.mock.invocationCallOrder[0];
    const spawnOrder = mockSpawn.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(spawnOrder);
  });

  it("calls writeClaudeSettingsLocal with undefined settings and permissions when none provided", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude");

    expect(mockWriteClaudeSettingsLocal).toHaveBeenCalledWith("/workspace", undefined, undefined);
  });

  it("ignores claudeCodeSettings for non-claude sessions", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", undefined, undefined, {
      enableAutoMode: true,
      startInPlanMode: true,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(mockWriteClaudeSettingsLocal).not.toHaveBeenCalled();
  });

  it('sets claudeCodeMode to "auto" when enableAutoMode is true and startInPlanMode is false', async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: true,
      startInPlanMode: false,
    });

    expect(session.claudeCodeMode).toBe("auto");
  });

  it('sets claudeCodeMode to "plan-auto" when both flags are true', async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: true,
      startInPlanMode: true,
    });

    expect(session.claudeCodeMode).toBe("plan-auto");
  });

  it('sets claudeCodeMode to "plan" when only startInPlanMode is true', async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: false,
      startInPlanMode: true,
    });

    expect(session.claudeCodeMode).toBe("plan");
  });

  it("omits claudeCodeMode when both flags are false", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude", undefined, {
      enableAutoMode: false,
      startInPlanMode: false,
    });

    expect(session.claudeCodeMode).toBeUndefined();
  });

  it("omits claudeCodeMode for non-claude sessions", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", undefined, undefined, {
      enableAutoMode: true,
      startInPlanMode: true,
    });

    expect(session.claudeCodeMode).toBeUndefined();
  });

  it('omits claudeCodeMode when command is "claude" but claudeCodeSettings is undefined', async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
    );

    expect(session.claudeCodeMode).toBeUndefined();
  });

  it("continues session creation and warns if writeClaudeSettingsLocal throws", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    mockWriteClaudeSettingsLocal.mockImplementation(() => {
      throw new Error("disk full");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude");

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to write .claude/settings.local.json:",
      expect.any(Error),
    );
    expect(mockSpawn).toHaveBeenCalled();
    expect(session.id).toMatch(UUID_REGEX);
    warnSpy.mockRestore();
  });

  it("persists session on creation", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");

    expect(mockAtomicWrite).toHaveBeenCalled();
    const [filePath, content] = mockAtomicWrite.mock.calls[0];
    expect(filePath).toContain("terminal-sessions");
    const parsed = JSON.parse(content);
    expect(parsed.session.status).toBe("live");
    expect(parsed.buffer).toEqual([]);
  });
});

describe("output buffer", () => {
  it("buffers PTY output", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");

    // Emit data while no WS connected
    pty._emit("data", "line 1\r\n");
    pty._emit("data", "line 2\r\n");

    // Connect WS and check replay
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    const replay = JSON.parse(ws._sent[0]);
    expect(replay.type).toBe("replay");
    expect(replay.lines).toEqual(["line 1\r\n", "line 2\r\n"]);
  });

  it("evicts oldest entries when buffer exceeds max", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");

    // Fill buffer past 5000
    for (let i = 0; i < 5010; i++) {
      pty._emit("data", `line-${i}\n`);
    }

    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    const replay = JSON.parse(ws._sent[0]);
    expect(replay.lines).toHaveLength(5000);
    expect(replay.lines[0]).toBe("line-10\n");
    expect(replay.lines[4999]).toBe("line-5009\n");
  });

  it("forwards output to connected WebSocket in real time", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    // Clear replay message
    ws._sent.length = 0;

    pty._emit("data", "hello");
    expect(ws._sent).toHaveLength(1);
    expect(JSON.parse(ws._sent[0])).toEqual({ type: "output", data: "hello" });
  });
});

describe("getSessions", () => {
  it("returns sessions for a specific bench", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, getSessions } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");
    createSession("project1", 1, "/workspace", "My Project", "claude");
    createSession("project1", 2, "/workspace2", "My Project");

    const sessions = getSessions("project1", 1);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.benchKey === "project1:1")).toBe(true);
  });
});

describe("isLiveSession", () => {
  it("returns true for live sessions", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, isLiveSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    expect(isLiveSession(session.id)).toBe(true);
  });

  it("returns false for non-existent sessions", async () => {
    const { isLiveSession } = await loadModule();
    expect(isLiveSession("nonexistent")).toBe(false);
  });
});

describe("destroySession", () => {
  it("kills the pty, deletes persisted file, and returns true", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, destroySession, getSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const result = destroySession(session.id);

    expect(result).toBe(true);
    expect(pty.kill).toHaveBeenCalled();
    expect(getSession(session.id)).toBeUndefined();
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("returns false for non-existent session", async () => {
    const { destroySession } = await loadModule();
    expect(destroySession("nonexistent")).toBe(false);
  });
});

describe("destroyBenchSessions", () => {
  it("destroys all sessions for a bench and deletes persisted files", async () => {
    const ptys = [createMockPty(), createMockPty(), createMockPty()];
    let callIdx = 0;
    mockSpawn.mockImplementation(() => ptys[callIdx++]);
    const { createSession, destroyBenchSessions, getSessions } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");
    createSession("project1", 1, "/workspace", "My Project");
    createSession("project1", 2, "/workspace2", "My Project");

    mockUnlinkSync.mockClear();
    destroyBenchSessions("project1", 1);

    expect(getSessions("project1", 1)).toHaveLength(0);
    expect(getSessions("project1", 2)).toHaveLength(1);
    expect(ptys[0].kill).toHaveBeenCalled();
    expect(ptys[1].kill).toHaveBeenCalled();
    expect(ptys[2].kill).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
  });
});

describe("destroyAllSessions", () => {
  it("persists live sessions before killing", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, destroyAllSessions } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");
    mockAtomicWrite.mockClear();

    destroyAllSessions();

    // Should have persisted with status 'ended' before killing
    expect(mockAtomicWrite).toHaveBeenCalled();
    const content = JSON.parse(mockAtomicWrite.mock.calls[0][1]);
    expect(content.session.status).toBe("ended");
    expect(pty.kill).toHaveBeenCalled();
  });
});

describe("hasSession", () => {
  it("returns true for existing session", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, hasSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    expect(hasSession(session.id)).toBe(true);
  });

  it("returns false for non-existent session", async () => {
    const { hasSession } = await loadModule();
    expect(hasSession("nonexistent")).toBe(false);
  });
});

describe("handleWebSocket", () => {
  it("closes WebSocket for non-existent session", async () => {
    const { handleWebSocket } = await loadModule();
    const ws = createMockWs();

    handleWebSocket("nonexistent", ws);
    expect(ws.close).toHaveBeenCalledWith(4004, "Session not found");
  });

  it("sends replay on connect", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    pty._emit("data", "buffered");

    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    const replay = JSON.parse(ws._sent[0]);
    expect(replay.type).toBe("replay");
    expect(replay.lines).toEqual(["buffered"]);
    expect(replay.exitCode).toBeUndefined();
  });

  it("includes exitCode in replay when process has exited", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    pty._emit("data", "output");
    pty._emit("exit", { exitCode: 0 });

    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    const replay = JSON.parse(ws._sent[0]);
    expect(replay.exitCode).toBe(0);
  });

  it("replaces previous WebSocket on reconnect", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    handleWebSocket(session.id, ws1);
    handleWebSocket(session.id, ws2);

    expect(ws1.close).toHaveBeenCalled();
  });

  it("forwards input from WebSocket to pty", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "ls\n" })));
    expect(pty.write).toHaveBeenCalledWith("ls\n");
  });

  it("handles resize messages", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    ws._trigger("message", Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })));
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it("sends ping at interval", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);
    ws._sent.length = 0;

    vi.advanceTimersByTime(30_000);
    expect(ws._sent.some((m: string) => JSON.parse(m).type === "ping")).toBe(true);
  });

  it("closes WS on pong timeout", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    // Trigger ping
    vi.advanceTimersByTime(30_000);
    // No pong sent — wait for deadline (10s)
    vi.advanceTimersByTime(10_000);

    expect(ws.close).toHaveBeenCalled();
  });

  it("clears pong deadline when pong received", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    // Trigger ping
    vi.advanceTimersByTime(30_000);
    // Send pong
    ws._trigger("message", Buffer.from(JSON.stringify({ type: "pong" })));
    // Wait past deadline — should NOT close
    vi.advanceTimersByTime(10_000);

    expect(ws.close).not.toHaveBeenCalled();
  });
});

describe("ghost sessions", () => {
  it("closes ghost session WS with 4410 after replay", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, destroyAllSessions } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    pty._emit("data", "before shutdown");

    // Simulate shutdown creating ghost
    destroyAllSessions();

    // Reload module to simulate restart with persisted data
    mockReaddirSync.mockReturnValue([`${session.id}.json`]);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        session: { ...session, status: "ended" },
        buffer: ["before shutdown"],
        persistedAt: new Date().toISOString(),
      }),
    );

    const { loadPersistedSessions, handleWebSocket: handleWs2, isLiveSession } = await loadModule();
    loadPersistedSessions();

    expect(isLiveSession(session.id)).toBe(false);

    const ws = createMockWs();
    handleWs2(session.id, ws);

    const replay = JSON.parse(ws._sent[0]);
    expect(replay.type).toBe("replay");
    expect(replay.lines).toEqual(["before shutdown"]);
    expect(ws.close).toHaveBeenCalledWith(4410, "Session ended");
  });

  it("loadPersistedSessions marks sessions as ended", async () => {
    mockReaddirSync.mockReturnValue(["term-123.json"]);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        session: {
          id: "term-123",
          benchKey: "project1:1",
          label: "Terminal 1",
          createdAt: "2026-01-01",
          status: "live",
        },
        buffer: ["data"],
        persistedAt: "2026-01-01",
      }),
    );

    const { loadPersistedSessions, getSession } = await loadModule();
    loadPersistedSessions();

    const session = getSession("term-123");
    expect(session?.status).toBe("ended");
  });
});

describe("PTY exit", () => {
  it("updates session status and persists on exit", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, getSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    mockAtomicWrite.mockClear();

    pty._emit("exit", { exitCode: 42 });

    const updated = getSession(session.id);
    expect(updated?.status).toBe("ended");
    expect(updated?.exitCode).toBe(42);
    expect(mockAtomicWrite).toHaveBeenCalled();
  });

  it("sends exit message to connected WebSocket", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);
    ws._sent.length = 0;

    pty._emit("exit", { exitCode: 0 });

    // Only handleWebSocket's exitHandler sends to WS; createSession's onExit only persists
    const exitMsgs = ws._sent.filter((m: string) => JSON.parse(m).type === "exit");
    expect(exitMsgs).toHaveLength(1);
    expect(JSON.parse(exitMsgs[0])).toEqual({ type: "exit", code: 0 });
  });

  it("calls onClaudeExit callback when a claude session exits", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const onClaudeExit = vi.fn();
    const session = createSession(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
      undefined,
      onClaudeExit,
    );

    pty._emit("exit", { exitCode: 0 });

    expect(onClaudeExit).toHaveBeenCalledOnce();
    expect(onClaudeExit).toHaveBeenCalledWith(session.id);
  });

  it("does not call onClaudeExit callback when a plain shell session exits", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const onClaudeExit = vi.fn();
    createSession(
      "project1",
      1,
      "/workspace",
      "My Project",
      undefined,
      undefined,
      undefined,
      undefined,
      onClaudeExit,
    );

    pty._emit("exit", { exitCode: 0 });

    expect(onClaudeExit).not.toHaveBeenCalled();
  });
});

describe("parseBenchKey", () => {
  it("parses a valid bench key into projectId and benchId", async () => {
    const { parseBenchKey } = await loadModule();
    expect(parseBenchKey("project1:1")).toEqual({
      projectId: "project1",
      benchId: 1,
    });
  });

  it("returns null when benchId portion after first colon is not a number", async () => {
    const { parseBenchKey } = await loadModule();
    // The first colon splits: projectId='proj', benchId=parseInt('with:colon:2')=NaN → returns null
    expect(parseBenchKey("proj:with:colon:2")).toBeNull();
  });

  it("returns null when there is no colon", async () => {
    const { parseBenchKey } = await loadModule();
    expect(parseBenchKey("nocolon")).toBeNull();
  });

  it("returns null when benchId is not a number", async () => {
    const { parseBenchKey } = await loadModule();
    expect(parseBenchKey("project1:abc")).toBeNull();
  });
});

describe("auto-clear claude-waiting notifications on input", () => {
  it("calls dismissBySession when a claude session receives input", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "y\n" })));

    expect(mockGetBench).toHaveBeenCalledWith("project1", 1);
    expect(mockDismissBySession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      session.id,
    );
  });

  it("calls dismissBySession for non-claude sessions on input", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "ls\n" })));

    expect(mockGetBench).toHaveBeenCalledWith("project1", 1);
    expect(mockDismissBySession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      session.id,
    );
  });

  it("does not break terminal input when dismissBySession throws (claude session)", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    mockDismissBySession.mockImplementation(() => {
      throw new Error("bench gone");
    });
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    // Should not throw
    expect(() => {
      ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "y\n" })));
    }).not.toThrow();
    expect(pty.write).toHaveBeenCalledWith("y\n");
  });

  it("does not break terminal input when dismissBySession throws (non-claude session)", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    mockDismissBySession.mockImplementation(() => {
      throw new Error("bench gone");
    });
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    // Should not throw — error handling is symmetric for all terminal types
    expect(() => {
      ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "ls\n" })));
    }).not.toThrow();
    expect(pty.write).toHaveBeenCalledWith("ls\n");
  });
});

describe("terminal-waiting quiescence detection", () => {
  it("emits terminal-waiting notification after output quiesces for a non-claude session", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");

    pty._emit("data", "some output\r\n");
    expect(mockCreateNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(mockGetBench).toHaveBeenCalledWith("project1", 1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      "terminal-waiting",
      session.id,
      { label: session.label },
    );
  });

  it("resets the quiescence timer when more output arrives", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");

    pty._emit("data", "first chunk\r\n");
    vi.advanceTimersByTime(1000);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    // More output resets the timer
    pty._emit("data", "second chunk\r\n");
    vi.advanceTimersByTime(1000);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    // Full debounce after last output
    vi.advanceTimersByTime(1000);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("does not emit terminal-waiting for claude sessions", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude");

    pty._emit("data", "Claude output\r\n");
    // Non-claude debounce (2s) must not fire for a claude session.
    vi.advanceTimersByTime(2000);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("emits claude-waiting after the longer claude debounce window", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude");

    pty._emit("data", "Claude streaming output\r\n");
    vi.advanceTimersByTime(7999);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      "claude-waiting",
      session.id,
      { label: session.label },
    );
  });

  it("resets the claude quiescence timer when more output arrives", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project", "claude");

    pty._emit("data", "first stream chunk\r\n");
    vi.advanceTimersByTime(5000);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    pty._emit("data", "second stream chunk\r\n");
    vi.advanceTimersByTime(5000);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.anything(),
      "claude-waiting",
      expect.any(String),
      expect.anything(),
    );
  });

  it("does not emit terminal-waiting after the session exits", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");

    pty._emit("data", "some output\r\n");
    pty._emit("exit", { exitCode: 0 });

    vi.advanceTimersByTime(2000);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("does not emit terminal-waiting after the session is destroyed", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, destroySession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");

    pty._emit("data", "some output\r\n");
    destroySession(session.id);

    vi.advanceTimersByTime(2000);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("cancels the quiescence timer and dismisses notifications when input is received", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    pty._emit("data", "prompt: ");

    // User types before quiescence timer fires
    ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "answer\n" })));

    // Timer would have fired here — but it was cancelled by input
    vi.advanceTimersByTime(2000);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    expect(mockDismissBySession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      session.id,
    );
  });

  it("re-arms the quiescence timer when the WebSocket reconnects on an idle session", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws1 = createMockWs();
    handleWebSocket(session.id, ws1);

    // Terminal emits output then goes idle
    pty._emit("data", "prompt: ");

    // User navigates away before quiescence timer fires — first WS disconnects
    // and a new WS connects (handleWebSocket cancels timers then re-arms)
    vi.advanceTimersByTime(1000);
    expect(mockCreateNotification).not.toHaveBeenCalled();

    const ws2 = createMockWs();
    handleWebSocket(session.id, ws2);

    // Quiescence timer was re-armed; it fires 2s after reconnect
    vi.advanceTimersByTime(2000);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      "terminal-waiting",
      session.id,
      { label: session.label },
    );
  });

  it("does not break terminal output on notification errors", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    mockGetBench.mockImplementation(() => {
      throw new Error("bench gone");
    });
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");

    // Should not throw
    expect(() => {
      pty._emit("data", "some output\r\n");
      vi.advanceTimersByTime(2000);
    }).not.toThrow();
  });

  it("does not re-fire on WS reconnect when no fresh output has arrived since the last notification", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws1 = createMockWs();
    handleWebSocket(session.id, ws1);

    // Terminal emits output, then the quiescence timer fires once.
    pty._emit("data", "prompt: ");
    vi.advanceTimersByTime(2000);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);

    // Simulate WS reconnect with no further output — the user may have dismissed
    // the notification, but the underlying state has not changed. The reconnect
    // must not fire a fresh notification.
    const ws2 = createMockWs();
    handleWebSocket(session.id, ws2);
    vi.advanceTimersByTime(2000);

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("re-fires after a reconnect when fresh output has arrived since the last notification", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws1 = createMockWs();
    handleWebSocket(session.id, ws1);

    pty._emit("data", "prompt: ");
    vi.advanceTimersByTime(2000);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);

    // Step the clock so the next output's timestamp is strictly later than
    // the notification's lastNotifiedAt (the strict-greater guard treats ties
    // as "no fresh output").
    vi.advanceTimersByTime(1);

    // Fresh output arrives after the previous notification (e.g. background
    // process printed). The next idle window should be eligible to re-notify.
    pty._emit("data", "more output\r\n");

    const ws2 = createMockWs();
    handleWebSocket(session.id, ws2);
    vi.advanceTimersByTime(2000);

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it("dismisses waiting notifications when fresh PTY output arrives", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project", "claude");

    // Wire a bench with a matching claude-waiting notification only after the
    // session id is known, so the pre-check finds something to dismiss.
    mockGetBench.mockReturnValue({
      id: 1,
      projectId: "project1",
      notifications: [
        {
          id: "notif-1",
          type: "claude-waiting",
          priority: "action-needed",
          sourceSessionId: session.id,
          createdAt: "2026-01-01",
        },
      ],
    });

    pty._emit("data", "Claude resumes work\r\n");

    expect(mockDismissWaitingForSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project1" }),
      session.id,
    );
  });

  it("skips the dismiss path when the bench has no waiting notifications", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    // Default mockGetBench returns notifications: [] — nothing to dismiss
    const { createSession } = await loadModule();

    createSession("project1", 1, "/workspace", "My Project");

    pty._emit("data", "some output\r\n");

    expect(mockDismissWaitingForSession).not.toHaveBeenCalled();
  });

  it("resets the notify-gate after user input so the next idle window with fresh output fires", async () => {
    const pty = createMockPty();
    mockSpawn.mockReturnValue(pty);
    const { createSession, handleWebSocket } = await loadModule();

    const session = createSession("project1", 1, "/workspace", "My Project");
    const ws = createMockWs();
    handleWebSocket(session.id, ws);

    // First idle window: notification fires.
    pty._emit("data", "prompt: ");
    vi.advanceTimersByTime(2000);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);

    // User types — this resets lastNotifiedAt so the next idle window can fire
    // even though the gate would otherwise still be held by the prior notify.
    ws._trigger("message", Buffer.from(JSON.stringify({ type: "input", data: "x" })));

    // Fresh output arrives (e.g. shell echo), then the shell idles again.
    vi.advanceTimersByTime(1);
    pty._emit("data", "x\r\nprompt: ");
    vi.advanceTimersByTime(2000);

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });
});
