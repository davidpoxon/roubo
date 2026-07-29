/**
 * `terminal.createAgentSession`: the PTY half of the agent launch pipeline
 * (issue #510, AP-FR-011, AP-NFR-001).
 *
 * Deliberately separate from `terminal.test.ts`, which module-mocks `node:fs`.
 * The whole point of AP-TC-082 is that a workspace write is path-validated
 * against a REAL directory, so this file uses a real temp workspace and mocks
 * only the pipeline (no plugin process), node-pty (no spawn), and the session
 * store's own `~/.roubo` writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { PluginManifest } from "@roubo/shared";
import type { AgentLaunchDescriptor } from "@roubo/shared/agent-launch-descriptor-schema";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const stateMocks = vi.hoisted(() => ({
  atomicWrite: vi.fn(),
  getRouboDir: () => path.join(os.tmpdir(), "roubo-agent-session-test"),
}));
vi.mock("./state.js", () => stateMocks);

vi.mock("./claude-settings-local.js", () => ({ writeClaudeSettingsLocal: vi.fn() }));
vi.mock("./notification.js", () => ({
  dismissBySession: vi.fn(),
  createNotification: vi.fn(),
  dismissWaitingForSession: vi.fn().mockReturnValue(false),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "claude-waiting"]),
}));
vi.mock("./bench-manager.js", () => ({ getBench: vi.fn() }));
vi.mock("./env.js", () => ({
  getClaudeBinary: () => "claude",
  getLoginShell: () => "/bin/zsh",
  cleanEnv: vi.fn(() => ({})),
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn: spawnMock }));

const pipelineMocks = vi.hoisted(() => ({ prepareAgentLaunch: vi.fn() }));
vi.mock("./agent-launch-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-launch-pipeline.js")>();
  return { ...actual, prepareAgentLaunch: pipelineMocks.prepareAgentLaunch };
});

import {
  createAgentSession,
  destroyAllSessions,
  getSession,
  isHookNotificationEligible,
} from "./terminal.js";
import * as notificationService from "./notification.js";
import * as benchManager from "./bench-manager.js";

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

const manifest = { id: "acme-agent", name: "Acme Agent", kind: "agent" } as PluginManifest;

function prepare(
  descriptor: Partial<AgentLaunchDescriptor>,
  effectiveConfig: Record<string, unknown> = {},
): void {
  pipelineMocks.prepareAgentLaunch.mockResolvedValue({
    pluginId: "acme-agent",
    manifest,
    effectiveConfig,
    descriptor: {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "acme",
      args: [],
      ...descriptor,
    } as AgentLaunchDescriptor,
  });
}

function spawnCall(): { command: string; args: string[]; opts: Record<string, unknown> } {
  const [command, args, opts] = spawnMock.mock.calls[0] as [
    string,
    string[],
    Record<string, unknown>,
  ];
  return { command, args, opts };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-agent-ws-"));
  spawnMock.mockReset().mockImplementation(() => createMockPty());
  stateMocks.atomicWrite.mockReset();
  pipelineMocks.prepareAgentLaunch.mockReset();
  vi.mocked(notificationService.createNotification).mockReset();
  vi.mocked(notificationService.dismissWaitingForSession).mockReset().mockReturnValue(false);
  vi.mocked(benchManager.getBench)
    .mockReset()
    .mockReturnValue({ id: 2, projectId: "roubo", notifications: [] } as never);
});

afterEach(() => {
  destroyAllSessions();
  vi.useRealTimers();
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** The full launch result, including what it did with the initial prompt. */
function launchWith(overrides: Record<string, unknown> = {}) {
  return createAgentSession({
    projectId: "roubo",
    benchId: 2,
    workspacePath: workspace,
    projectName: "My Project",
    agentPluginId: "acme-agent",
    ...overrides,
  });
}

async function launch(overrides: Record<string, unknown> = {}) {
  return (await launchWith(overrides)).session;
}

describe("createAgentSession (AP-FR-011)", () => {
  it("spawns the descriptor's command with argv resolved from the descriptor", async () => {
    prepare({ command: "acme", args: ["--model", "opus", "--session-id", "{{sessionId}}"] });

    const session = await launch();

    expect(session.id).toMatch(UUID_REGEX);
    expect(session.benchKey).toBe("roubo:2");
    expect(session.status).toBe("live");
    expect(session.agentPluginId).toBe("acme-agent");

    const { command, args, opts } = spawnCall();
    expect(command).toBe("acme");
    // The host-minted id reaches argv, and it is the id the session carries.
    expect(args).toEqual(["--model", "opus", "--session-id", session.id]);
    expect(opts.cwd).toBe(workspace);
  });

  it("mints the session id once, so argv, the workspace write and the session agree", async () => {
    prepare({
      args: ["--session-id", "{{sessionId}}"],
      capabilities: {
        workspaceWrites: [
          {
            relPath: ".acme/hook.json",
            format: "json",
            ops: [{ op: "set", path: "session", value: "{{sessionId}}" }],
          },
        ],
      },
    });

    const session = await launch();

    expect(spawnCall().args[1]).toBe(session.id);
    const [, body] = stateMocks.atomicWrite.mock.calls.find(([target]) =>
      String(target).endsWith("hook.json"),
    ) as [string, string];
    expect(JSON.parse(body)).toEqual({ session: session.id });
  });

  it("resolves {{port}} from the bound server port and {{workspace}} from the bench", async () => {
    vi.stubEnv("ROUBO_PORT", "51234");
    prepare({ args: ["--hook", "http://localhost:{{port}}/api/hooks", "--cwd", "{{workspace}}"] });

    await launch();

    expect(spawnCall().args).toEqual([
      "--hook",
      "http://localhost:51234/api/hooks",
      "--cwd",
      workspace,
    ]);
  });

  it("falls back to the default port when the server has not published one", async () => {
    vi.stubEnv("ROUBO_PORT", "");
    prepare({ args: ["{{port}}"] });

    await launch();

    expect(spawnCall().args).toEqual(["3335"]);
  });

  it("appends the initial prompt as a positional argv element when the descriptor asks for one", async () => {
    prepare({ args: ["--print"], initialPrompt: { mode: "argv-positional", maxLength: 5 } });

    const { promptInjection } = await launchWith({ initialInput: "abcdefghij" });

    expect(spawnCall().args).toEqual(["--print", "abcde"]);
    expect(promptInjection).toEqual({ mode: "argv-positional", injected: true });
  });

  it("does not append an initial prompt when the descriptor declares no mode for one", async () => {
    prepare({ args: ["--print"] });

    const { promptInjection } = await launchWith({ initialInput: "hello" });

    expect(spawnCall().args).toEqual(["--print"]);
    // The declared mode is reported back so the caller can tell "nothing to
    // inject" apart from "this agent cannot be injected into" (AP-TC-063).
    expect(promptInjection).toEqual({ mode: "none", injected: false });
  });

  it("reports the declared mode with nothing injected when the launch carries no prompt", async () => {
    prepare({ args: ["--print"], initialPrompt: { mode: "argv-positional", maxLength: 5 } });

    const { promptInjection } = await launchWith();

    expect(spawnCall().args).toEqual(["--print"]);
    expect(promptInjection).toEqual({ mode: "argv-positional", injected: false });
  });

  // AP-TC-062: the declared limit is a boundary, not an approximation. Content
  // of exactly maxLength goes through whole; one character more loses exactly
  // that one character.
  it("passes content of exactly the declared maxLength through untruncated", async () => {
    prepare({ args: ["--print"], initialPrompt: { mode: "argv-positional", maxLength: 64 } });
    const content = "x".repeat(64);

    await launch({ initialInput: content });

    expect(spawnCall().args[1]).toBe(content);
  });

  it("truncates content of maxLength + 1 by exactly one character", async () => {
    prepare({ args: ["--print"], initialPrompt: { mode: "argv-positional", maxLength: 64 } });
    const content = `${"x".repeat(64)}y`;

    await launch({ initialInput: content });

    const prompt = spawnCall().args[1];
    expect(prompt).toHaveLength(64);
    expect(prompt).toBe(content.slice(0, 64));
    expect(prompt.endsWith("y")).toBe(false);
  });

  it("caps a declared maxLength above core's own prompt ceiling at 100,000", async () => {
    prepare({
      args: ["--print"],
      initialPrompt: { mode: "argv-positional", maxLength: 500_000 },
    });

    await launch({ initialInput: "x".repeat(150_000) });

    expect(spawnCall().args[1]).toHaveLength(100_000);
  });

  it("caps an undeclared maxLength at core's own prompt ceiling too", async () => {
    prepare({ args: ["--print"], initialPrompt: { mode: "argv-positional" } });

    await launch({ initialInput: "x".repeat(150_000) });

    expect(spawnCall().args[1]).toHaveLength(100_000);
  });
});

describe("createAgentSession env handling", () => {
  it("strips host-internal env vars and layers the descriptor's additive env on top", async () => {
    vi.stubEnv("ROUBO_PRODUCTION", "1");
    vi.stubEnv("ROUBO_PORT", "51234");
    prepare({ env: { ACME_TOKEN_PATH: "{{workspace}}/.acme", ACME_MODE: "batch" } });

    await launch();

    const env = spawnCall().opts.env as Record<string, string>;
    expect(env).not.toHaveProperty("ROUBO_PRODUCTION");
    expect(env).not.toHaveProperty("ROUBO_PORT");
    expect(env.ACME_TOKEN_PATH).toBe(`${workspace}/.acme`);
    expect(env.ACME_MODE).toBe("batch");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("does not let a descriptor reinstate a host-internal key", async () => {
    vi.stubEnv("ROUBO_PRODUCTION", "1");
    vi.stubEnv("ROUBO_PORT", "51234");
    // The descriptor itself declares the keys core withholds. `env` is an
    // unrestricted record in the schema, so this is a shape a plugin can really
    // emit; the additive layering has to re-check it rather than trusting that
    // the host-env strip alone kept them out.
    prepare({
      args: [],
      env: { ROUBO_PRODUCTION: "1", ROUBO_PORT: "9999", ACME_MODE: "batch" },
    });

    await launch();

    const env = spawnCall().opts.env as Record<string, string>;
    expect(env).not.toHaveProperty("ROUBO_PRODUCTION");
    expect(env).not.toHaveProperty("ROUBO_PORT");
    // The rest of the descriptor's additive env still lands, so the guard is a
    // targeted skip and not a blanket drop of the descriptor's env.
    expect(env.ACME_MODE).toBe("batch");
  });
});

describe("AP-TC-083: argv is never shell-interpreted", () => {
  it("passes shell metacharacters through as literal argv elements", async () => {
    const hostile = "--fallback-model sonnet ; $(touch /tmp/pwned)";
    prepare({ args: ["--extra", hostile, "`whoami`", "$HOME", "a|b>c"] });

    await launch();

    const { args } = spawnCall();
    // Each token is one element of a real argv array: node-pty receives the
    // array, never a joined string, so there is no shell to expand any of this.
    expect(args).toEqual(["--extra", hostile, "`whoami`", "$HOME", "a|b>c"]);
    expect(Array.isArray(args)).toBe(true);
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it("leaves an unknown {{...}} token literal rather than expanding it to anything", async () => {
    prepare({ args: ["{{notAVariable}}"] });

    await launch();

    expect(spawnCall().args).toEqual(["{{notAVariable}}"]);
  });
});

describe("AP-TC-082: workspace writes are path-validated core-side", () => {
  it("writes a declared file under the bench workspace", async () => {
    prepare({
      capabilities: {
        workspaceWrites: [
          {
            relPath: ".acme/settings.json",
            format: "json",
            ops: [{ op: "set", path: "permissions.defaultMode", value: "plan" }],
          },
        ],
      },
    });

    await launch();

    const [target, body] = stateMocks.atomicWrite.mock.calls.find(([t]) =>
      String(t).endsWith("settings.json"),
    ) as [string, string];
    expect(target).toBe(path.join(workspace, ".acme/settings.json"));
    expect(JSON.parse(body)).toEqual({ permissions: { defaultMode: "plan" } });
  });

  it("rejects a relative path escaping the workspace, spawning nothing and writing nothing", async () => {
    prepare({
      capabilities: {
        workspaceWrites: [
          {
            relPath: "../../.ssh/config",
            format: "text",
            ops: [{ op: "set", path: ".", value: "Host evil\n" }],
          },
        ],
      },
    });

    await expect(launch()).rejects.toThrow(/escapes the bench workspace/);
    expect(stateMocks.atomicWrite).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects an absolute path, spawning nothing and writing nothing", async () => {
    prepare({
      capabilities: {
        workspaceWrites: [
          {
            relPath: "/etc/hosts",
            format: "text",
            ops: [{ op: "set", path: ".", value: "127.0.0.1 evil\n" }],
          },
        ],
      },
    });

    await expect(launch()).rejects.toThrow(/must be relative to the bench workspace/);
    expect(stateMocks.atomicWrite).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("aborts the whole batch when one of several writes escapes", async () => {
    prepare({
      capabilities: {
        workspaceWrites: [
          {
            relPath: "ok.json",
            format: "json",
            ops: [{ op: "set", path: "a", value: 1 }],
          },
          {
            relPath: "../../.ssh/config",
            format: "text",
            ops: [{ op: "set", path: ".", value: "Host evil\n" }],
          },
        ],
      },
    });

    await expect(launch()).rejects.toThrow(/escapes the bench workspace/);
    // The write sink is `atomicWrite`, which this file mocks, so assert against
    // it rather than the filesystem: an `fs.existsSync` check would hold even if
    // the in-workspace write had been applied before the escaping one threw,
    // which is exactly the regression AP-TC-082 is here to catch.
    expect(stateMocks.atomicWrite).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("writes the selected posture's binding as well as the plain writes", async () => {
    prepare(
      {
        capabilities: {
          workspaceWrites: [
            { relPath: "base.json", format: "json", ops: [{ op: "set", path: "a", value: 1 }] },
          ],
          permissions: {
            postures: {
              "read-only": {
                workspaceWrites: [
                  {
                    relPath: "posture.json",
                    format: "json",
                    ops: [{ op: "set", path: "mode", value: "read-only" }],
                  },
                ],
              },
            },
          },
        },
      },
      { posture: "read-only" },
    );

    await launch();

    const targets = stateMocks.atomicWrite.mock.calls.map(([t]) => path.basename(String(t)));
    expect(targets).toContain("base.json");
    expect(targets).toContain("posture.json");
  });

  it("applies the selected posture's argv binding as well as its writes", async () => {
    prepare(
      {
        args: ["--print"],
        capabilities: {
          permissions: {
            postures: {
              "read-only": {
                args: ["--permission-mode", "plan", "--session", "{{sessionId}}"],
                workspaceWrites: [
                  {
                    relPath: "posture.json",
                    format: "json",
                    ops: [{ op: "set", path: "mode", value: "read-only" }],
                  },
                ],
              },
            },
          },
        },
      },
      { posture: "read-only" },
    );

    const session = await launch();

    // Both carriers of the binding land: the argv half after the descriptor's
    // own args, and the file half through the write batch.
    expect(spawnCall().args).toEqual([
      "--print",
      "--permission-mode",
      "plan",
      "--session",
      session.id,
    ]);
    expect(stateMocks.atomicWrite.mock.calls.map(([t]) => path.basename(String(t)))).toContain(
      "posture.json",
    );
  });

  it("keeps the initial prompt positional after the posture's argv binding", async () => {
    prepare(
      {
        args: ["--print"],
        initialPrompt: { mode: "argv-positional" },
        capabilities: {
          permissions: {
            postures: { guarded: { args: ["--permission-mode", "acceptEdits"] } },
          },
        },
      },
      { posture: "guarded" },
    );

    await launch({ initialInput: "do the thing" });

    expect(spawnCall().args).toEqual([
      "--print",
      "--permission-mode",
      "acceptEdits",
      "do the thing",
    ]);
  });

  it("adds no argv when the selected posture declares only writes", async () => {
    prepare(
      {
        args: ["--print"],
        capabilities: {
          permissions: {
            postures: {
              "read-only": {
                workspaceWrites: [
                  {
                    relPath: "posture.json",
                    format: "json",
                    ops: [{ op: "set", path: "m", value: 1 }],
                  },
                ],
              },
            },
          },
        },
      },
      { posture: "read-only" },
    );

    await launch();

    expect(spawnCall().args).toEqual(["--print"]);
  });

  it("ignores a posture value the descriptor schema does not recognise", async () => {
    prepare(
      {
        capabilities: {
          permissions: {
            postures: {
              guarded: {
                workspaceWrites: [
                  {
                    relPath: "posture.json",
                    format: "json",
                    ops: [{ op: "set", path: "mode", value: "guarded" }],
                  },
                ],
              },
            },
          },
        },
      },
      { posture: "yolo" },
    );

    await launch();

    expect(stateMocks.atomicWrite.mock.calls.map(([t]) => path.basename(String(t)))).not.toContain(
      "posture.json",
    );
  });
});

describe("createAgentSession labelling and persistence (AC5)", () => {
  it("labels from the plugin manifest, with no Claude-specific logic", async () => {
    prepare({ command: "acme" });

    const session = await launch();

    expect(session.label).toBe("Acme Agent 1 - My Project #2");
    expect(session.label).not.toMatch(/claude/i);
  });

  it("labels a Claude-command agent from its manifest name too", async () => {
    pipelineMocks.prepareAgentLaunch.mockResolvedValue({
      pluginId: "claude-code",
      manifest: { id: "claude-code", name: "Claude Code", kind: "agent" } as PluginManifest,
      effectiveConfig: {},
      descriptor: {
        schemaVersion: 1,
        kind: "agent-launch",
        command: "claude",
        args: [],
      } as AgentLaunchDescriptor,
    });

    const session = await launch({ agentPluginId: "claude-code" });

    expect(session.label).toBe("Claude Code 1 - My Project #2");
  });

  it("numbers successive sessions of the same agent in the same bench", async () => {
    prepare({ command: "acme" });

    const first = await launch();
    const second = await launch();

    expect(first.label).toBe("Acme Agent 1 - My Project #2");
    expect(second.label).toBe("Acme Agent 2 - My Project #2");
  });

  it("persists the session, including which agent plugin launched it", async () => {
    prepare({ command: "acme" });

    const session = await launch();

    expect(getSession(session.id)?.agentPluginId).toBe("acme-agent");
    const [, body] = stateMocks.atomicWrite.mock.calls.find(([t]) =>
      String(t).endsWith(`${session.id}.json`),
    ) as [string, string];
    const persisted = JSON.parse(body);
    expect(persisted.session.agentPluginId).toBe("acme-agent");
    expect(persisted.session.label).toBe("Acme Agent 1 - My Project #2");
  });

  it("reports a spawn failure with the command and cwd that failed", async () => {
    prepare({ command: "missing-agent" });
    spawnMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await expect(launch()).rejects.toThrow(
      /Failed to spawn agent session \(command: missing-agent/,
    );
  });
});

// ── Notifications: hook eligibility, per-agent debounce, exit (AP-FR-013) ──

const HTTP_HOOK_NOTIFICATION = {
  kind: "http-hook",
  event: "waiting",
  carrier: {
    workspaceWrite: {
      relPath: ".acme/settings.json",
      format: "json",
      ops: [
        {
          op: "set",
          path: "hooks.Notification",
          value: [{ hooks: [{ type: "http", url: "http://localhost:{{port}}/api/hooks/x" }] }],
        },
      ],
    },
  },
  correlation: { field: "session_id", source: "agent-native" },
} as const;

/** The PTY the last spawn handed back, so a test can drive its data/exit events. */
function lastPty(): ReturnType<typeof createMockPty> {
  const results = spawnMock.mock.results;
  return results[results.length - 1].value as ReturnType<typeof createMockPty>;
}

describe("hook notification eligibility (AP-TC-069, AP-TC-084)", () => {
  it("makes a session whose descriptor declares an http-hook eligible", async () => {
    prepare({ capabilities: { notification: HTTP_HOOK_NOTIFICATION } });

    const session = await launch();

    expect(isHookNotificationEligible(session.id)).toBe(true);
  });

  it("leaves a session declaring no notification wiring ineligible, whatever its command is", async () => {
    prepare({ command: "claude" });

    const session = await launch();

    expect(isHookNotificationEligible(session.id)).toBe(false);
  });

  it("leaves a spawned-notifier agent ineligible for the http hook endpoint", async () => {
    prepare({
      capabilities: {
        notification: {
          kind: "spawned-notifier",
          event: "turn-complete",
          carrier: { args: ["--notify", "roubo-notify"] },
          payload: "json-arg",
          correlation: { source: "template", template: "{{sessionId}}" },
        },
      },
    });

    const session = await launch();

    expect(isHookNotificationEligible(session.id)).toBe(false);
  });

  it("expires the correlation token once the agent exits", async () => {
    prepare({ capabilities: { notification: HTTP_HOOK_NOTIFICATION } });

    const session = await launch();
    expect(isHookNotificationEligible(session.id)).toBe(true);

    lastPty()._emit("exit", { exitCode: 0 });

    // The record survives so the scrollback is still readable, but the token
    // it carried is spent.
    expect(getSession(session.id)?.status).toBe("ended");
    expect(isHookNotificationEligible(session.id)).toBe(false);
  });

  it("reports an unknown session id as ineligible", () => {
    expect(isHookNotificationEligible("00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe("per-agent quiescence debounce (AP-TC-065)", () => {
  it("honours a quiescence-only agent's declared debounce", async () => {
    prepare({ capabilities: { waitingDetection: { kind: "quiescence-only", debounceMs: 3500 } } });

    const session = await launch();
    vi.useFakeTimers();
    lastPty()._emit("data", "waiting for you");

    vi.advanceTimersByTime(3499);
    expect(notificationService.createNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "roubo" }),
      "claude-waiting",
      session.id,
      { label: session.label },
    );
  });

  it("honours a hook-driven agent's declared quiescence fallback", async () => {
    prepare({
      capabilities: {
        notification: HTTP_HOOK_NOTIFICATION,
        waitingDetection: { kind: "hook-driven", quiescenceFallbackMs: 12_000 },
      },
    });

    const session = await launch();
    vi.useFakeTimers();
    lastPty()._emit("data", "thinking");

    // The default 8000ms fallback must not fire for an agent that declared its own.
    vi.advanceTimersByTime(11_999);
    expect(notificationService.createNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.anything(),
      "claude-waiting",
      session.id,
      { label: session.label },
    );
  });

  it("falls back to 8000ms for a hook-driven agent that declares no fallback", async () => {
    prepare({
      capabilities: {
        notification: HTTP_HOOK_NOTIFICATION,
        waitingDetection: { kind: "hook-driven" },
      },
    });

    await launch();
    vi.useFakeTimers();
    lastPty()._emit("data", "thinking");

    vi.advanceTimersByTime(7999);
    expect(notificationService.createNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic 2000ms terminal debounce when no capability is declared", async () => {
    prepare({ command: "acme" });

    const session = await launch();
    vi.useFakeTimers();
    lastPty()._emit("data", "$ ");

    vi.advanceTimersByTime(2000);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.anything(),
      "terminal-waiting",
      session.id,
      { label: session.label },
    );
  });
});

describe("agent exit notification (AP-TC-066)", () => {
  it("invokes onAgentExit with the session id when the agent process exits", async () => {
    prepare({ capabilities: { notification: HTTP_HOOK_NOTIFICATION } });
    const onAgentExit = vi.fn();

    const session = await launch({ onAgentExit });
    lastPty()._emit("exit", { exitCode: 137 });

    expect(onAgentExit).toHaveBeenCalledWith(session.id);
    expect(getSession(session.id)?.exitCode).toBe(137);
  });

  it("does not throw when no exit callback was supplied", async () => {
    prepare({ command: "acme" });

    const session = await launch();
    expect(() => lastPty()._emit("exit", { exitCode: 0 })).not.toThrow();
    expect(getSession(session.id)?.status).toBe("ended");
  });
});
