/**
 * AP-TC-076: all three launch-failure classes are detected and surfaced, at
 * 100%, with zero silent dead terminals (AP-NFR-003, issue #519).
 *
 * Deliberately end to end through the real machinery rather than per-unit: the
 * version probe, the gate in `prepareAgentLaunch`, the binary resolution and
 * spawn in `createAgentSession`, and the post-spawn classifier all run for real.
 * Only the outside world is simulated: the plugin RPC, the agent CLI's own
 * `--version` output, the binary resolver, and node-pty.
 *
 * The tally at the end is the actual acceptance criterion. Each simulated class
 * must produce a structured, actionable failure; a class that produced nothing,
 * or produced a live session nobody was told about, is the dead terminal this
 * slice exists to remove.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { AgentLaunchFailure, PluginManifest, PluginRecord } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

const MANIFEST = {
  id: "acme-agent",
  name: "Acme Agent",
  kind: "agent",
  roubo: "^1.4.0",
} as PluginManifest;

const pluginManagerMocks = vi.hoisted(() => ({
  getConnection: vi.fn(() => ({}) as JsonRpcConnection),
  getRecord: vi.fn(),
  getAgentManifests: vi.fn(() => [] as PluginManifest[]),
  invoke: vi.fn(),
  HOST_API_VERSION: "1.4.0",
}));
vi.mock("./plugin-manager.js", () => pluginManagerMocks);
vi.mock("./plugin-consent-state.js", () => ({ hasConsent: vi.fn(() => true) }));
vi.mock("./agent-overrides.js", () => ({ getEffectiveAgentConfig: vi.fn(() => ({})) }));
vi.mock("./agent-project-overrides.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-project-overrides.js")>();
  return { ...actual, getProjectAgentOverrides: vi.fn(() => ({})) };
});

const stateMocks = vi.hoisted(() => ({
  atomicWrite: vi.fn(),
  getRouboDir: () => path.join(os.tmpdir(), "roubo-launch-failure-e2e"),
}));
vi.mock("./state.js", () => stateMocks);
vi.mock("./notification.js", () => ({
  dismissBySession: vi.fn(),
  createNotification: vi.fn(),
  dismissWaitingForSession: vi.fn().mockReturnValue(false),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "agent-waiting"]),
}));
vi.mock("./bench-manager.js", () => ({ getBench: vi.fn(() => undefined) }));

/** The agent CLI's own `--version` output, simulated. */
const execMocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("./exec.js", () => execMocks);

const envMocks = vi.hoisted(() => ({
  resolveAgentCommand: vi.fn((command: string) => command),
}));
vi.mock("./env.js", () => ({
  AgentCommandNotFoundError: class AgentCommandNotFoundError extends Error {
    constructor(
      public readonly command: string,
      public readonly tried: string[],
    ) {
      super(
        `Agent CLI "${command}" was not found on PATH or in any well-known install location. ` +
          `Tried: ${tried.join(", ")}`,
      );
      this.name = "AgentCommandNotFoundError";
    }
  },
  getLoginShell: () => "/bin/zsh",
  cleanEnv: vi.fn(() => ({})),
  resolveAgentCommand: envMocks.resolveAgentCommand,
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn: spawnMock }));

import { createAgentSession, destroyAllSessions, handleWebSocket } from "./terminal.js";
import { AgentLaunchFailureError } from "./agent-launch-failure.js";
import { resetAgentVersionProbeCache } from "./agent-version-probe.js";
import { AgentCommandNotFoundError } from "./env.js";

const VERSION_PROBE = {
  args: ["--version"],
  parse: "semver",
  minVersion: "2.1.111",
  testedCeiling: "2.1.205",
};

function mockPty() {
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
type MockPty = ReturnType<typeof mockPty>;

function lastPty(): MockPty {
  return spawnMock.mock.results[spawnMock.mock.results.length - 1].value as MockPty;
}

/** The failure a session ended up carrying, read the way the client reads it. */
function failureFor(sessionId: string): AgentLaunchFailure | undefined {
  const frames: Record<string, unknown>[] = [];
  handleWebSocket(sessionId, {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as Record<string, unknown>),
    close: () => {},
    on: () => {},
  } as never);
  const replay = frames.find((f) => f.type === "replay");
  return replay?.launchFailure as AgentLaunchFailure | undefined;
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-launch-failure-"));
  resetAgentVersionProbeCache();
  spawnMock.mockReset().mockImplementation(() => mockPty());
  envMocks.resolveAgentCommand.mockReset().mockImplementation((command: string) => command);
  execMocks.runCommand.mockReset().mockResolvedValue({ code: 0, stdout: "2.1.180", stderr: "" });
  stateMocks.atomicWrite.mockReset();
  pluginManagerMocks.getRecord.mockReset().mockReturnValue({
    id: "acme-agent",
    manifest: MANIFEST,
    manifestPath: "/tmp/plugin/roubo-plugin.yaml",
    pluginDir: "/tmp/plugin",
    source: "bundled",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
  } as PluginRecord);
  pluginManagerMocks.invoke.mockReset().mockResolvedValue({
    schemaVersion: 1,
    kind: "agent-launch",
    command: "acme",
    args: ["--session-id", "{{sessionId}}"],
    capabilities: { versionProbe: VERSION_PROBE },
  });
});

afterEach(() => {
  destroyAllSessions();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function launch() {
  return createAgentSession({
    projectId: "roubo",
    benchId: 2,
    workspacePath: workspace,
    projectName: "My Project",
    agentPluginId: "acme-agent",
  });
}

describe("AP-TC-076: every launch-failure class is detected and surfaced", () => {
  /** Every class detected in this run, keyed by the scenario that produced it. */
  const detected = new Map<string, AgentLaunchFailure>();

  it("S001: a missing binary is surfaced with an actionable error and no spawn", async () => {
    envMocks.resolveAgentCommand.mockImplementation(() => {
      throw new AgentCommandNotFoundError("acme", [
        "/usr/local/bin/acme",
        "/opt/homebrew/bin/acme",
      ]);
    });

    const err = (await launch().catch((e: unknown) => e)) as AgentLaunchFailureError;

    expect(err).toBeInstanceOf(AgentLaunchFailureError);
    expect(err.failure.class).toBe("missing-binary");
    expect(err.failure.guidance).toContain("/opt/homebrew/bin/acme");
    expect(err.failure.actions.length).toBeGreaterThan(0);
    expect(spawnMock).not.toHaveBeenCalled();
    detected.set("missing-binary", err.failure);
  });

  it("S002: a below-floor version is surfaced before spawn", async () => {
    execMocks.runCommand.mockResolvedValue({ code: 0, stdout: "2.1.100", stderr: "" });

    const err = (await launch().catch((e: unknown) => e)) as AgentLaunchFailureError;

    expect(err).toBeInstanceOf(AgentLaunchFailureError);
    expect(err.failure.class).toBe("below-floor-version");
    expect(err.failure.detectedVersion).toBe("2.1.100");
    expect(err.failure.minVersion).toBe("2.1.111");
    // Nothing spawned, nothing written: the refusal precedes both.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stateMocks.atomicWrite).not.toHaveBeenCalled();
    detected.set("below-floor-version", err.failure);
  });

  it("S003: an immediate post-spawn exit is surfaced with its stderr, inside 5s", async () => {
    const { session } = await launch();
    const startedAt = Date.now();

    lastPty()._emit("data", "error: unexpected argument '--yolo-mode' found");
    lastPty()._emit("exit", { exitCode: 2 });

    const failure = failureFor(session.id);
    expect(failure).toBeDefined();
    expect(failure?.class).toBe("launch-failure");
    expect(failure?.capturedOutput).toContain("--yolo-mode");
    // AP-TC-077: the verdict exists within the 5s window, not after it.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    if (failure) detected.set("launch-failure", failure);
  });

  it("S004: all three classes were detected, none silently", () => {
    expect([...detected.keys()].sort()).toEqual([
      "below-floor-version",
      "launch-failure",
      "missing-binary",
    ]);
    // 100% detection means every class produced a real, actionable surface:
    // a message, and at least one thing the user can do next.
    for (const [cls, failure] of detected) {
      expect(failure.message, cls).toBeTruthy();
      expect(failure.actions.length, cls).toBeGreaterThan(0);
    }
  });

  it("an in-range launch produces no failure at all (the control)", async () => {
    execMocks.runCommand.mockResolvedValue({ code: 0, stdout: "2.1.180", stderr: "" });

    const { session, compatibility } = await launch();

    expect(compatibility?.status).toBe("within-tested-range");
    expect(failureFor(session.id)).toBeUndefined();
  });
});
