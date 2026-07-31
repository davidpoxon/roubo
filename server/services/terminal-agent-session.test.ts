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
// Binary resolution itself is env.ts's job and is pinned in env.test.ts; here the
// resolver is a recorder so the wiring (#645) can be asserted: what the descriptor
// asked for goes in, what comes out is what reaches the PTY.
const envMocks = vi.hoisted(() => ({
  resolveAgentCommand: vi.fn((command: string) => command),
}));
vi.mock("./env.js", () => ({
  // terminal.ts branches on this class to word the missing-binary failure, so a
  // mocked env module must still carry it.
  AgentCommandNotFoundError: class AgentCommandNotFoundError extends Error {
    constructor(
      public readonly command: string,
      public readonly tried: string[],
    ) {
      super(`Agent CLI "${command}" was not found. Tried: ${tried.join(", ")}`);
      this.name = "AgentCommandNotFoundError";
    }
  },
  getClaudeBinary: () => "claude",
  getLoginShell: () => "/bin/zsh",
  cleanEnv: vi.fn(() => ({})),
  resolveAgentCommand: envMocks.resolveAgentCommand,
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn: spawnMock }));

// The spawn-helper diagnosis (#685) reads the real node_modules, so it is
// stubbed here to keep these assertions about the wiring rather than about the
// machine the suite happens to run on. pty-preflight.test.ts owns the diagnosis
// itself.
const preflightMocks = vi.hoisted(() => ({
  withSpawnHelperDiagnosis: vi.fn((detail: string) => detail),
}));
vi.mock("./pty-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pty-preflight.js")>();
  return { ...actual, withSpawnHelperDiagnosis: preflightMocks.withSpawnHelperDiagnosis };
});

const pipelineMocks = vi.hoisted(() => ({ prepareAgentLaunch: vi.fn() }));
vi.mock("./agent-launch-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-launch-pipeline.js")>();
  return { ...actual, prepareAgentLaunch: pipelineMocks.prepareAgentLaunch };
});

import {
  createAgentSession,
  destroyAllSessions,
  getSession,
  handleWebSocket,
  isHookNotificationEligible,
} from "./terminal.js";
import * as notificationService from "./notification.js";
import * as benchManager from "./bench-manager.js";
import { AgentCommandNotFoundError } from "./env.js";
import { AgentLaunchFailureError } from "./agent-launch-failure.js";

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
  compatibility?: Record<string, unknown>,
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
    ...(compatibility !== undefined && { compatibility }),
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
  preflightMocks.withSpawnHelperDiagnosis
    .mockReset()
    .mockImplementation((detail: string) => detail);
  envMocks.resolveAgentCommand.mockReset().mockImplementation((command: string) => command);
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

  it("attributes a spawn throw to a broken host install, with the command and cwd (#519)", async () => {
    prepare({ command: "missing-agent" });
    spawnMock.mockImplementation(() => {
      throw new Error("posix_spawnp failed.");
    });

    const err = (await launch().catch((e: unknown) => e)) as AgentLaunchFailureError;
    expect(err).toBeInstanceOf(AgentLaunchFailureError);
    // Spike #504: a spawn throw means node-pty's own helper is unusable, so
    // every spawn fails. That is Roubo's problem, not the agent plugin's.
    expect(err.failure.class).toBe("host-install-broken");
    expect(err.failure.guidance).toMatch(/Failed to spawn agent session \(command: missing-agent/);
  });

  it("carries the spawn-helper diagnosis into the guidance when there is one (#685)", async () => {
    prepare({ command: "acme" });
    spawnMock.mockImplementation(() => {
      throw new Error("posix_spawnp failed.");
    });
    preflightMocks.withSpawnHelperDiagnosis.mockImplementation(
      (detail: string) => `${detail} Run \`chmod +x /pkg/node-pty/prebuilds/x/spawn-helper\`.`,
    );

    const err = (await launch().catch((e: unknown) => e)) as AgentLaunchFailureError;

    // "Reinstall Roubo" alone sent a user down the wrong path in #685; the real
    // fix is one chmod, so the guidance has to name it.
    expect(err.failure.class).toBe("host-install-broken");
    expect(err.failure.guidance).toContain("chmod +x /pkg/node-pty/prebuilds/x/spawn-helper");
  });

  it("spawns what the shared resolver returns, not the descriptor's bare command (#645)", async () => {
    prepare({ command: "claude", env: { PATH: "/child/bin" } });
    envMocks.resolveAgentCommand.mockReturnValue("/home/dev/.claude/local/claude");

    await launch();

    // Resolution runs on the templated command, against the child's own PATH.
    expect(envMocks.resolveAgentCommand).toHaveBeenCalledWith("claude", "/child/bin");
    expect(spawnCall().command).toBe("/home/dev/.claude/local/claude");
  });

  it("turns an unresolvable command into an actionable missing-binary failure (#645, AP-TC-058)", async () => {
    prepare({ command: "claude" });
    envMocks.resolveAgentCommand.mockImplementation(() => {
      throw new AgentCommandNotFoundError("claude", ["/usr/bin/claude"]);
    });

    const err = (await launch().catch((e: unknown) => e)) as AgentLaunchFailureError;
    expect(err).toBeInstanceOf(AgentLaunchFailureError);
    expect(err.failure.class).toBe("missing-binary");
    // The resolver's own list of locations tried survives into the guidance,
    // and nothing was spawned, so there is no dead terminal to leave behind.
    expect(err.failure.guidance).toContain("/usr/bin/claude");
    expect(err.failure.actions).toContain("open-plugin-settings");
    expect(err.failure.message).not.toContain("Failed to spawn agent session");
    expect(spawnMock).not.toHaveBeenCalled();
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

// -- Launch-failure detection after spawn (AP-FR-015, issue #519) --

/** A minimal WebSocket stand-in that records every frame the server sends. */
function fakeSocket() {
  const frames: Record<string, unknown>[] = [];
  const handlers = new Map<string, (arg: unknown) => void>();
  return {
    frames,
    ws: {
      OPEN: 1,
      readyState: 1,
      send: (raw: string) => frames.push(JSON.parse(raw) as Record<string, unknown>),
      close: () => {},
      on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
    },
  };
}

function replayFor(sessionId: string): Record<string, unknown> {
  const socket = fakeSocket();
  handleWebSocket(sessionId, socket.ws as never);
  return socket.frames.find((f) => f.type === "replay") ?? {};
}

describe("post-spawn launch-failure detection (AP-FR-015)", () => {
  it("classifies an immediate nonzero exit with output as a launch failure and captures it (AP-TC-075, AP-TC-077)", async () => {
    prepare({ command: "acme" });
    const session = await launch();

    lastPty()._emit("data", "\u001b[31merror: unexpected argument '--yolo-mode' found\u001b[0m");
    lastPty()._emit("exit", { exitCode: 2 });

    const failure = replayFor(session.id).launchFailure as Record<string, unknown>;
    expect(failure.class).toBe("launch-failure");
    expect(failure.capturedOutput).toBe("error: unexpected argument '--yolo-mode' found");
    expect(failure.agentName).toBe("Acme Agent");
    expect(failure.actions).toEqual(["open-plugin-settings", "retry"]);
  });

  it("sends the failure on the live exit frame as well as the replay", async () => {
    prepare({ command: "acme" });
    const session = await launch();

    const socket = fakeSocket();
    handleWebSocket(session.id, socket.ws as never);
    lastPty()._emit("data", "error: unknown option '--nope'");
    lastPty()._emit("exit", { exitCode: 1 });

    const exitFrame = socket.frames.find((f) => f.type === "exit");
    expect((exitFrame?.launchFailure as Record<string, unknown>).class).toBe("launch-failure");
  });

  it("classifies a silent immediate nonzero exit as a missing binary (AP-TC-058)", async () => {
    prepare({ command: "acme" });
    const session = await launch();

    lastPty()._emit("exit", { exitCode: 1 });

    const failure = replayFor(session.id).launchFailure as Record<string, unknown>;
    expect(failure.class).toBe("missing-binary");
  });

  it("does not flag a clean exit as a failure, however fast it was", async () => {
    prepare({ command: "acme" });
    const session = await launch();

    lastPty()._emit("data", "2.1.207 (Claude Code)");
    lastPty()._emit("exit", { exitCode: 0 });

    expect(replayFor(session.id).launchFailure).toBeUndefined();
  });

  it("does not flag a session that outlives the early window as a launch failure", async () => {
    prepare({ command: "acme" });
    const session = await launch();

    // Time is advanced by moving Date.now, not the timer queue: the classifier
    // reads elapsed wall time rather than waiting on a timer.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6000);
    lastPty()._emit("exit", { exitCode: 3 });
    vi.mocked(Date.now).mockRestore();

    expect(replayFor(session.id).launchFailure).toBeUndefined();
  });
});

describe("compatibility notice in the session scrollback (AP-FR-014)", () => {
  it("prepends an above-ceiling warning without blocking the launch (AP-TC-072, AP-TC-100 S002)", async () => {
    prepare(
      { command: "acme" },
      {},
      { status: "above-tested-ceiling", detectedVersion: "2.1.207", testedCeiling: "2.1.205" },
    );

    const result = await launchWith();

    expect(result.session.status).toBe("live");
    expect(spawnMock).toHaveBeenCalled();
    expect(result.compatibility).toMatchObject({ status: "above-tested-ceiling" });
    const lines = (replayFor(result.session.id).lines as string[]).join("");
    expect(lines).toContain("2.1.207");
    expect(lines).toContain("2.1.205");
  });

  it("says nothing for an in-range launch (AP-TC-070, AP-TC-100 S003)", async () => {
    prepare({ command: "acme" }, {}, { status: "within-tested-range", detectedVersion: "2.1.180" });

    const session = await launch();

    expect((replayFor(session.id).lines as string[]).length).toBe(0);
  });

  it("says the version check did not run when the probe failed (AP-TC-074)", async () => {
    prepare(
      { command: "acme" },
      {},
      { status: "probe-failed", reason: "no recognisable version number" },
    );

    const session = await launch();

    const lines = (replayFor(session.id).lines as string[]).join("");
    expect(lines).toContain("could not be determined");
  });

  it("attributes a launch failure above the ceiling to a stale argument map", async () => {
    prepare(
      { command: "acme" },
      {},
      { status: "above-tested-ceiling", detectedVersion: "2.1.207", testedCeiling: "2.1.205" },
    );
    const session = await launch();

    lastPty()._emit("data", "error: unknown option '--effort'");
    lastPty()._emit("exit", { exitCode: 1 });

    const failure = replayFor(session.id).launchFailure as Record<string, unknown>;
    expect(failure.guidance).toContain("stale");
    expect(failure.detectedVersion).toBe("2.1.207");
  });

  it("does not present the host's own notice as captured agent output", async () => {
    prepare(
      { command: "acme" },
      {},
      { status: "above-tested-ceiling", detectedVersion: "2.1.207", testedCeiling: "2.1.205" },
    );
    const session = await launch();

    lastPty()._emit("data", "error: unknown option '--effort'");
    lastPty()._emit("exit", { exitCode: 1 });

    const failure = replayFor(session.id).launchFailure as Record<string, unknown>;
    // The notice is a preamble in the replay buffer, not something the agent said.
    expect(failure.capturedOutput).toBe("error: unknown option '--effort'");
    expect(failure.capturedOutput).not.toContain("newer than the highest version");
    // It still reaches the user, via the replay, as a session preamble.
    expect((replayFor(session.id).lines as string[]).join("")).toContain(
      "newer than the highest version",
    );
  });

  it("classifies a silent early exit as missing-binary even when a notice was shown", async () => {
    prepare(
      { command: "acme" },
      {},
      { status: "probe-failed", reason: "no recognisable version number" },
    );
    const session = await launch();

    // Zero bytes from the child: spike #504's direct-spawn exec-failure arm. The
    // notice must not satisfy the classifier's nonempty-output signal and turn
    // this into a launch-failure attributed to the agent's arguments.
    lastPty()._emit("exit", { exitCode: 1 });

    const failure = replayFor(session.id).launchFailure as Record<string, unknown>;
    expect(failure.class).toBe("missing-binary");
    expect(failure.capturedOutput).toBeUndefined();
  });
});
