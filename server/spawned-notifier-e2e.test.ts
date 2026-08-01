// Integration-level E2E test for the `spawned-notifier` notification wiring
// (issue #698): a descriptor declares the variant, and a turn-complete
// notification arrives at the bench without quiescence being involved.
//
// Every unit around this is pinned elsewhere (terminal-agent-session.test.ts for
// the launch half, hooks.test.ts for the route, agent-notifier.test.ts for the
// program). What only an integrated run can show is that the four agree on one
// correlation token: the plugin declares a template, core resolves it into the
// carrier argv AND into its own registry, the shipped program quotes back
// whatever it was invoked with, and the route trades it for the same session.
// A mismatch anywhere is invisible to each unit on its own.
//
// Hermetic: the agent process is a mocked PTY (nothing real is launched), the
// notification service and bench store are fakes, and the Roubo state dir is
// redirected into a throwaway directory. What runs for real is the whole path
// under test: createAgentSession, agent-notifier's installed program (spawned as
// a real child, exactly as the agent would spawn it), and the hooks router
// behind a real Express listener.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AgentLaunchDescriptor } from "@roubo/shared/agent-launch-descriptor-schema";

const execFileAsync = promisify(execFile);

// Resolved in the hoisted factory, not in a hook: terminal.ts derives its
// sessions directory from getRouboDir() at MODULE LOAD, so a dir filled in later
// would have it writing `terminal-sessions/` into the checkout. Only globals are
// reachable this early, hence the bare process/pid path rather than mkdtemp.
const hoisted = vi.hoisted(() => ({
  rouboDir: `${process.env.TMPDIR ?? "/tmp"}/roubo-notifier-e2e-${process.pid}`,
}));
vi.mock("./services/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/state.js")>();
  return { ...actual, getRouboDir: () => hoisted.rouboDir };
});

const notifications: { type: string; sessionId?: string }[] = [];
vi.mock("./services/notification.js", () => ({
  createNotification: vi.fn((_bench: unknown, type: string, sessionId?: string) => {
    notifications.push({ type, sessionId });
    return { id: "notification-1", type, sourceSessionId: sessionId };
  }),
  dismissBySession: vi.fn(),
  dismissWaitingForSession: vi.fn().mockReturnValue(false),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "agent-waiting"]),
}));

const bench = { id: 2, projectId: "roubo", notifications: [] };
vi.mock("./services/bench-manager.js", () => ({ getBench: vi.fn(() => bench) }));
vi.mock("./services/claude-settings-local.js", () => ({ writeClaudeSettingsLocal: vi.fn() }));
vi.mock("./services/env.js", () => ({
  AgentCommandNotFoundError: class AgentCommandNotFoundError extends Error {},
  getClaudeBinary: () => "claude",
  getLoginShell: () => "/bin/sh",
  resolveAgentCommand: (command: string) => command,
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn: spawnMock }));

const pipelineMocks = vi.hoisted(() => ({ prepareAgentLaunch: vi.fn() }));
vi.mock("./services/agent-launch-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/agent-launch-pipeline.js")>();
  return { ...actual, prepareAgentLaunch: pipelineMocks.prepareAgentLaunch };
});

import { createAgentSession, destroyAllSessions } from "./services/terminal.js";
import hooksRouter from "./routes/hooks.js";

const rouboDir = hoisted.rouboDir;
fs.mkdirSync(rouboDir, { recursive: true });
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-notifier-ws-"));

/** A PTY stand-in: the agent process is never really launched. */
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

afterAll(() => {
  destroyAllSessions();
  fs.rmSync(rouboDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * The shape a real spawned-notifier plugin declares: the notifier program named
 * by bare name inside the agent's own config string, with the correlation token
 * as its one configured argument. The agent appends the event JSON at spawn time.
 */
const DESCRIPTOR: AgentLaunchDescriptor = {
  schemaVersion: 1,
  kind: "agent-launch",
  command: "acme",
  args: [],
  capabilities: {
    notification: {
      kind: "spawned-notifier",
      event: "turn-complete",
      carrier: { args: ["-c", 'notify=["roubo-notify","{{sessionId}}"]'] },
      payload: "json-arg",
      correlation: { source: "template", template: "{{sessionId}}" },
    },
  },
};

describe("spawned-notifier wiring, end to end (issue #698)", () => {
  it("turns a declared descriptor into a real turn-complete notification", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/hooks", hooksRouter);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = String((server.address() as AddressInfo).port);
    vi.stubEnv("ROUBO_PORT", port);

    spawnMock.mockImplementation(() => mockPty());
    pipelineMocks.prepareAgentLaunch.mockResolvedValue({
      pluginId: "acme-agent",
      manifest: { id: "acme-agent", name: "Acme Agent", kind: "agent" },
      effectiveConfig: {},
      descriptor: DESCRIPTOR,
    });

    const { session } = await createAgentSession({
      projectId: "roubo",
      benchId: 2,
      workspacePath: workspace,
      projectName: "My Project",
      agentPluginId: "acme-agent",
    });

    // What the agent was actually told: its own config string, with the token
    // substituted, plus a PATH on which the bare program name resolves.
    const [, args, spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args).toEqual(["-c", `notify=["roubo-notify","${session.id}"]`]);
    const [pathHead] = spawnOpts.env.PATH.split(path.delimiter);
    const program = path.join(pathHead, "roubo-notify");
    expect(fs.existsSync(program)).toBe(true);

    // Now play the agent's part: spawn the notifier with its configured argument
    // and the event JSON appended, which is the whole of what the agent does.
    await execFileAsync(program, [session.id, '{"type":"agent-turn-complete"}']);

    expect(notifications).toEqual([{ type: "agent-waiting", sessionId: session.id }]);

    await new Promise((resolve) => server.close(resolve));
  });
});
