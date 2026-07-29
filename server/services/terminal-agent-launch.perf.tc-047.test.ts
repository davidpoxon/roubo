/**
 * AP-TC-047 / AP-NFR-002: p95 launch-action-to-PTY-spawn is at most 500ms,
 * excluding the agent CLI's own startup.
 *
 * The test-case's stated measurement point is a click in the bench Terminal tab,
 * but the launch affordances it clicks (the split button, the built-in presets,
 * the All-agents list) are AP-WU-015 / AP-WU-016 / AP-WU-017 (#516, #517, #518)
 * and are explicitly out of scope for this slice. The in-scope proxy measured
 * here is the whole server-side launch path: availability gate, four-layer
 * effective-config resolution, the `translateLaunch` round trip, descriptor
 * validation, template resolution, path-validated workspace writes, and the call
 * into `pty.spawn`. The plugin's own compute and the agent binary's startup are
 * both excluded, matching the test case's exclusion.
 *
 * Gated behind RUN_PERF_HARNESS=1 (the cut-list-cache-overhead.perf.tc-012
 * shape), with a sentinel so the file always contributes a passing assertion
 * under the default coverage run, plus a non-gated structural test pinning the
 * ordering the budget rests on.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

// `terminal.ts` computes its sessions directory from getRouboDir() at MODULE
// LOAD, so the root has to be a real absolute path before any import runs (an
// empty one would make it relative and drop a directory in the repo). Built as
// a literal for that reason: a vi.hoisted factory runs before the fs/path/os
// imports are usable.
const stateMocks = vi.hoisted(() => ({
  root: `${process.env.TMPDIR?.replace(/\/$/, "") ?? "/tmp"}/roubo-ap-tc-047-${process.pid}`,
  atomicWrite: vi.fn((target: string, body: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }),
}));
vi.mock("./state.js", () => ({
  atomicWrite: stateMocks.atomicWrite,
  getRouboDir: () => stateMocks.root,
}));

// The plugin process is the one thing stubbed: AP-TC-047 excludes the agent's
// own startup, and a plugin's compute is on the far side of the same boundary.
const pluginManagerMocks = vi.hoisted(() => ({
  getConnection: vi.fn<(id: string) => JsonRpcConnection | null>(() => ({}) as JsonRpcConnection),
  getRecord: vi.fn<(id: string) => PluginRecord | undefined>(),
  getAgentManifests: vi.fn<() => PluginManifest[]>(() => []),
  invoke: vi.fn(),
  HOST_API_VERSION: "1.4.0",
}));
vi.mock("./plugin-manager.js", () => pluginManagerMocks);
vi.mock("./plugin-consent-state.js", () => ({ hasConsent: () => true }));

vi.mock("./claude-settings-local.js", () => ({ writeClaudeSettingsLocal: vi.fn() }));
vi.mock("./notification.js", () => ({
  dismissBySession: vi.fn(),
  createNotification: vi.fn(),
  dismissWaitingForSession: vi.fn().mockReturnValue(false),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "claude-waiting"]),
}));
vi.mock("./bench-manager.js", () => ({ getBench: vi.fn() }));
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
  // Identity: binary resolution (#645) is env.ts's job and is pinned in env.test.ts.
  resolveAgentCommand: (command: string) => command,
}));

const spawnedAt = vi.hoisted(() => ({ last: 0 }));
const spawnMock = vi.hoisted(() =>
  vi.fn(() => {
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
    };
  }),
);
vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => {
    // Stamped INSIDE the spawn call, so the measured window ends where the test
    // case says it ends: at PTY spawn, before the agent binary does anything.
    spawnedAt.last = performance.now();
    return spawnMock(...(args as []));
  },
}));

import { saveAgentConfig } from "./agent-overrides.js";
import { saveProjectAgentOverride } from "./agent-project-overrides.js";
import { createAgentSession, destroyAllSessions } from "./terminal.js";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const ITERATIONS = 100;
const LAUNCH_BUDGET_MS = 500;
// A launch this slow would read as a hang even if the p95 held (S001-O02).
const HANG_CEILING_MS = 2000;

const PLUGIN_ID = "agent-echo";
const PROJECT_ID = "roubo";

// The descriptor the `agent-echo` fixture plugin answers `translateLaunch` with
// (server/services/__fixtures__/plugins/agent-echo/index.cjs), plus the http-hook
// carrier write that makes the template-resolution and workspace-write legs of
// the path representative of a real agent.
function echoDescriptor(workspacePath: string) {
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: "echo-agent",
    args: ["--session-id", "{{sessionId}}", "--hook", "http://localhost:{{port}}/api/hooks"],
    cwd: workspacePath,
    capabilities: {
      workspaceWrites: [
        {
          relPath: ".agent/settings.local.json",
          format: "json",
          ops: [{ op: "set", path: "permissions.defaultMode", value: "plan" }],
        },
      ],
      notification: {
        kind: "http-hook",
        event: "waiting",
        carrier: {
          workspaceWrite: {
            relPath: ".agent/hooks.json",
            format: "json",
            ops: [
              {
                op: "set",
                path: "hooks.Notification",
                value: { url: "http://localhost:{{port}}/api/hooks/{{sessionId}}" },
              },
            ],
          },
        },
        correlation: { field: "session_id", source: "agent-native" },
      },
    },
  };
}

function makeRecord(): PluginRecord {
  return {
    id: PLUGIN_ID,
    manifest: {
      id: PLUGIN_ID,
      name: "Agent Echo Fixture",
      kind: "agent",
      roubo: "^1.4.0",
    } as PluginManifest,
    manifestPath: "/tmp/plugin/roubo-plugin.yaml",
    pluginDir: "/tmp/plugin",
    source: "bundled" as PluginRecord["source"],
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
  };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

let workspace: string;

beforeEach(() => {
  fs.rmSync(path.join(stateMocks.root, "agents"), { recursive: true, force: true });
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-ap-tc-047-ws-"));
  stateMocks.atomicWrite.mockClear();
  spawnMock.mockClear();
  pluginManagerMocks.getRecord.mockReset().mockReturnValue(makeRecord());
  pluginManagerMocks.invoke
    .mockReset()
    .mockImplementation(() => Promise.resolve(echoDescriptor(workspace)));
  saveAgentConfig(PLUGIN_ID, { model: "app-model", posture: "guarded", extraArgs: "--app" });
  saveProjectAgentOverride(PROJECT_ID, PLUGIN_ID, { model: "project-model" });
});

afterEach(() => {
  destroyAllSessions();
  fs.rmSync(workspace, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(stateMocks.root, { recursive: true, force: true });
});

async function launch() {
  const { session } = await createAgentSession({
    projectId: PROJECT_ID,
    benchId: 1,
    workspacePath: workspace,
    projectName: "My Project",
    agentPluginId: PLUGIN_ID,
    layers: { preset: { posture: "auto-edit" }, perLaunch: { model: "per-launch-model" } },
  });
  return session;
}

it.runIf(RUN)(
  "AP-TC-047: p95 launch-request-to-PTY-spawn stays at or below 500ms",
  async () => {
    await launch(); // warmup: first-call module and directory costs

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const started = performance.now();
      await launch();
      samples.push(spawnedAt.last - started);
    }

    const observedP95 = p95(samples);
    const worst = Math.max(...samples);

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "AP-TC-047",
          measurementPoint: "createAgentSession entry to pty.spawn",
          iterations: ITERATIONS,
          p95Ms: observedP95,
          worstMs: worst,
          budgetMs: LAUNCH_BUDGET_MS,
        },
        null,
        2,
      ),
    );

    expect(observedP95).toBeLessThanOrEqual(LAUNCH_BUDGET_MS); // S001-O01
    expect(worst).toBeLessThan(HANG_CEILING_MS); // S001-O02
  },
  180_000,
);

describe("AP-TC-047 harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("AP-TC-047: the launch path does exactly one round trip before spawning", () => {
  it("asks the plugin once, writes the workspace once, and spawns once", async () => {
    const session = await launch();

    // One translateLaunch per launch: nothing re-asks the plugin per argument or
    // per workspace write, which is what keeps the budget flat as a descriptor
    // grows.
    expect(pluginManagerMocks.invoke).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const targets = stateMocks.atomicWrite.mock.calls.map(([t]) => path.basename(String(t)));
    expect(targets).toContain("settings.local.json");
    expect(targets).toContain("hooks.json");

    // The carrier write and argv agree on the session id, and both resolved
    // before the spawn.
    const [, hooksBody] = stateMocks.atomicWrite.mock.calls.find(([t]) =>
      String(t).endsWith("hooks.json"),
    ) as [string, string];
    expect(JSON.parse(hooksBody).hooks.Notification.url).toContain(session.id);
    const args = spawnMock.mock.calls[0][1] as unknown as string[];
    expect(args).toContain(session.id);
  });

  it("resolves the four-layer config before asking the plugin to translate", async () => {
    await launch();

    const params = pluginManagerMocks.invoke.mock.calls[0][2] as {
      config: Record<string, unknown>;
    };
    expect(params.config).toEqual({
      model: "per-launch-model",
      posture: "auto-edit",
      extraArgs: "--app",
    });
  });
});
