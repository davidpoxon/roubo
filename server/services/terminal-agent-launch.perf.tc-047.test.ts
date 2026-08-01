/**
 * AP-TC-047 / AP-NFR-002: p95 launch-action-to-PTY-spawn is at most 500ms,
 * excluding the agent CLI's own startup.
 *
 * S001 asks for launches "across the split-button, built-in presets, and
 * All-agents items". Those are three client affordances, but all three converge
 * on a single server call, `createAgentSession`, and differ only in the agent
 * they name and the layer stack they hand it (`handleLaunchPreset` and
 * `handleLaunchAgentPlugin` in TerminalTabs.tsx). So the harness rotates its
 * iterations across those three shapes and measures each at the server
 * boundary: availability gate, four-layer effective-config resolution, the
 * `translateLaunch` round trip, descriptor validation, template resolution,
 * path-validated workspace writes, and the call into `pty.spawn`. The plugin's
 * own compute and the agent binary's startup are both excluded, matching the
 * test case's exclusion.
 *
 * Measuring at that boundary is a proxy for the click rather than a literal
 * reading of S001: the React event handling and paint that precede the request
 * are AP-TC-049's subject and are not counted here.
 *
 * Inside the gated budget test the PTY leg is real: the `node-pty` mock
 * delegates to the real module and stamps the end of the window when
 * `pty.spawn` RETURNS, so PTY allocation sits inside the measurement instead of
 * being excluded by construction. Everything else keeps the fake, so `pr-check`
 * (which never sets RUN_PERF_HARNESS) allocates no PTY at all and the structural
 * tests below stay hermetic in both arms. The mock records the call either way,
 * so those tests read the same argv whichever spawn ran.
 *
 * Gated behind RUN_PERF_HARNESS=1 (the cut-list-cache-overhead.perf.tc-012
 * shape), with a sentinel so the file always contributes a passing assertion
 * under the default coverage run, plus non-gated structural tests pinning the
 * ordering the budget rests on.
 *
 * Only the gated budget test carries the bare `AP-TC-047`, and it asserts both
 * of S001's observations. A second id-tagged entry (a skipped sentinel, or an
 * enclosing `describe` whose children inherit the id through `classname`) would
 * leave verify's suite mapper with a skipped or ambiguous winner and corroborate
 * nothing, so neither describe below may name the case (#680, #682).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";
import type { AgentConfigLayers } from "./agent-launch-pipeline.js";

// Read through vi.hoisted because the `node-pty` factory below needs it, and
// that factory runs during the hoisted imports, before any plain top-level
// const has been initialised.
const RUN = vi.hoisted(() => process.env.RUN_PERF_HARNESS === "1");

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

vi.mock("./notification.js", () => ({
  dismissBySession: vi.fn(),
  createNotification: vi.fn(),
  dismissWaitingForSession: vi.fn().mockReturnValue(false),
  WAITING_NOTIFICATION_TYPES: new Set(["terminal-waiting", "agent-waiting"]),
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
  getLoginShell: () => "/bin/zsh",
  cleanEnv: vi.fn(() => ({})),
  // Identity: binary resolution (#645) is env.ts's job and is pinned in env.test.ts.
  resolveAgentCommand: (command: string) => command,
}));

const spawnedAt = vi.hoisted(() => ({ last: 0 }));
// Delegation is opt-in per test, not per run: only the gated budget test wants
// a real PTY, and the structural tests below stay hermetic (and #685-proof) in
// both arms.
const realPty = vi.hoisted(() => ({ enabled: false }));
// Call recorder, armed in BOTH arms so the structural tests read the same argv
// whether the spawn behind it was faked or real.
const spawnMock = vi.hoisted(() => vi.fn());
const fakePtyProcess = vi.hoisted(() => () => {
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
});
vi.mock("node-pty", async (importOriginal) => {
  // The default arm is what `pr-check` runs, and it must not allocate a PTY, so
  // only the gated arm loads the real module.
  const real = RUN ? await importOriginal<typeof import("node-pty")>() : null;
  return {
    spawn: (...args: unknown[]) => {
      spawnMock(...(args as []));
      if (real === null || !realPty.enabled) {
        // Nothing is really allocated, so the stamp goes inside the call: the
        // measured window still ends where the test case says it ends.
        spawnedAt.last = performance.now();
        return fakePtyProcess();
      }
      const ptyProcess = (real.spawn as (...a: unknown[]) => unknown)(...args);
      // Stamped on RETURN, so PTY allocation is inside the measured window: the
      // window ends when the PTY exists, not when one was asked for.
      spawnedAt.last = performance.now();
      return ptyProcess;
    },
  };
});

import { AgentLaunchFailureError } from "./agent-launch-failure.js";
import { saveAgentConfig } from "./agent-overrides.js";
import { saveProjectAgentOverride } from "./agent-project-overrides.js";
import { createAgentSession, destroyAllSessions } from "./terminal.js";

const ITERATIONS = 100;
const LAUNCH_BUDGET_MS = 500;
// A launch this slow would read as a hang even if the p95 held (S001-O02).
const HANG_CEILING_MS = 2000;

const PLUGIN_ID = "agent-echo";
// An All-agents item names its agent directly, and it need not be the one the
// default-bound affordances resolve to, so that shape launches a second plugin.
const DIRECT_PLUGIN_ID = "agent-echo-alt";
const PROJECT_ID = "roubo";

/**
 * The command the fixture descriptor carries. While the PTY is real the
 * descriptor value reaches `pty.spawn` verbatim (`resolveAgentCommand` is
 * identity-mocked above), so it has to name a binary that is always present and
 * exits immediately. Everywhere else it keeps the fixture's own name, because
 * nothing there ever runs it.
 */
function agentCommand(): string {
  return realPty.enabled ? "/bin/echo" : "echo-agent";
}

/** One Terminal-tab launch affordance, as it reaches the server (S001). */
interface LaunchShape {
  affordance: string;
  agentPluginId: string;
  layers: AgentConfigLayers;
}

const LAUNCH_SHAPES: readonly LaunchShape[] = [
  // The split button fires the built-in default preset, whose params are empty,
  // so it contributes no preset layer at all.
  { affordance: "split-button", agentPluginId: PLUGIN_ID, layers: {} },
  // A built-in preset that actually overrides something ("Agent (Plan)") is the
  // only one of the three that adds layer three.
  {
    affordance: "built-in-preset",
    agentPluginId: PLUGIN_ID,
    layers: { preset: { posture: "auto-edit" } },
  },
  // An All-agents item names its agent directly and passes no preset, so it is
  // also the shape whose agent carries no project-level override.
  { affordance: "all-agents", agentPluginId: DIRECT_PLUGIN_ID, layers: {} },
];

/**
 * The widest stack any affordance can produce: the per-launch override dialog
 * adds a transient top layer over a preset (AP-FR-011). It is not one of the
 * three affordances S001 names, so it stays out of the timed rotation, but the
 * structural tests use it because it exercises every layer at once.
 */
const FULL_STACK: LaunchShape = {
  affordance: "override-dialog",
  agentPluginId: PLUGIN_ID,
  layers: { preset: { posture: "auto-edit" }, perLaunch: { model: "per-launch-model" } },
};

// The descriptor the `agent-echo` fixture plugin answers `translateLaunch` with
// (server/services/__fixtures__/plugins/agent-echo/index.cjs), plus the http-hook
// carrier write that makes the template-resolution and workspace-write legs of
// the path representative of a real agent.
function echoDescriptor(workspacePath: string) {
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: agentCommand(),
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

function makeRecord(id: string): PluginRecord {
  return {
    id,
    manifest: {
      id,
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
  pluginManagerMocks.getRecord.mockReset().mockImplementation((id: string) => makeRecord(id));
  pluginManagerMocks.invoke
    .mockReset()
    .mockImplementation(() => Promise.resolve(echoDescriptor(workspace)));
  saveAgentConfig(PLUGIN_ID, { model: "app-model", posture: "guarded", extraArgs: "--app" });
  saveAgentConfig(DIRECT_PLUGIN_ID, { model: "app-model", posture: "guarded", extraArgs: "--app" });
  saveProjectAgentOverride(PROJECT_ID, PLUGIN_ID, { model: "project-model" });
});

afterEach(() => {
  destroyAllSessions();
  fs.rmSync(workspace, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(stateMocks.root, { recursive: true, force: true });
});

async function launch(shape: LaunchShape) {
  const { session } = await createAgentSession({
    projectId: PROJECT_ID,
    benchId: 1,
    workspacePath: workspace,
    projectName: "My Project",
    agentPluginId: shape.agentPluginId,
    layers: shape.layers,
  });
  return session;
}

/**
 * Warm the path up, and turn node-pty's opaque `posix_spawnp failed` into the
 * diagnosis it actually has: davidpoxon/roubo-development#685, the platform
 * prebuild's `spawn-helper` extracted without its executable bit. Without this
 * a harness run on a fresh `npm install` reports a perf failure for what is an
 * install problem.
 */
async function warmUp(): Promise<void> {
  try {
    for (const shape of LAUNCH_SHAPES) await launch(shape);
  } catch (err) {
    const guidance = err instanceof AgentLaunchFailureError ? err.failure.guidance : "";
    if (guidance.includes("posix_spawnp failed")) {
      throw new Error(
        "node-pty could not allocate a PTY (posix_spawnp failed), so the AP-TC-047 budget was " +
          "not measured. This is davidpoxon/roubo-development#685: the platform prebuild's " +
          "spawn-helper can be extracted without its executable bit. Run `chmod +x " +
          "node_modules/node-pty/prebuilds/<platform>/spawn-helper` (or `npm rebuild node-pty`) " +
          "and re-run.",
        { cause: err },
      );
    }
    throw err;
  }
}

it.runIf(RUN)(
  "AP-TC-047: p95 launch-request-to-PTY-spawn stays at or below 500ms across every launch affordance",
  async () => {
    // The one test that spawns for real, so the PTY-allocation leg is measured
    // rather than mocked away.
    realPty.enabled = true;
    try {
      await warmUp(); // first-call module and directory costs, plus the #685 preflight

      const samples: number[] = [];
      const byAffordance = new Map<string, number[]>(
        LAUNCH_SHAPES.map((shape) => [shape.affordance, []]),
      );
      for (let i = 0; i < ITERATIONS; i++) {
        const shape = LAUNCH_SHAPES[i % LAUNCH_SHAPES.length];
        const started = performance.now();
        await launch(shape);
        const elapsed = spawnedAt.last - started;
        samples.push(elapsed);
        byAffordance.get(shape.affordance)?.push(elapsed);
      }

      const observedP95 = p95(samples);
      const worst = Math.max(...samples);

      console.log(
        JSON.stringify(
          {
            kind: "perf-evidence",
            tc: "AP-TC-047",
            measurementPoint: "createAgentSession entry to pty.spawn return",
            ptySpawn: "real",
            iterations: ITERATIONS,
            p95Ms: observedP95,
            worstMs: worst,
            budgetMs: LAUNCH_BUDGET_MS,
            byAffordance: [...byAffordance].map(([affordance, values]) => ({
              affordance,
              iterations: values.length,
              p95Ms: p95(values),
              worstMs: Math.max(...values),
            })),
          },
          null,
          2,
        ),
      );

      expect(observedP95).toBeLessThanOrEqual(LAUNCH_BUDGET_MS); // S001-O01
      expect(worst).toBeLessThan(HANG_CEILING_MS); // S001-O02
    } finally {
      realPty.enabled = false;
    }
  },
  180_000,
);

describe("launch perf harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("the launch path does exactly one round trip before spawning", () => {
  it("asks the plugin once, writes the workspace once, and spawns once", async () => {
    const session = await launch(FULL_STACK);

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
    await launch(FULL_STACK);

    const params = pluginManagerMocks.invoke.mock.calls[0][2] as {
      config: Record<string, unknown>;
    };
    expect(params.config).toEqual({
      model: "per-launch-model",
      posture: "auto-edit",
      extraArgs: "--app",
    });
  });

  // The rotation is only worth timing if the three affordances really do reach
  // the server as three different resolutions; otherwise the harness would be
  // measuring one entry point three times over (#682).
  it("resolves a distinct effective config per launch affordance", async () => {
    const configs: Record<string, unknown>[] = [];
    for (const shape of LAUNCH_SHAPES) {
      pluginManagerMocks.invoke.mockClear();
      await launch(shape);
      const params = pluginManagerMocks.invoke.mock.calls[0][2] as {
        config: Record<string, unknown>;
      };
      configs.push(params.config);
    }

    // Split button: app and project layers only, so the app posture survives.
    expect(configs[0]).toEqual({ model: "project-model", posture: "guarded", extraArgs: "--app" });
    // Built-in preset: layer three overrides the posture.
    expect(configs[1]).toEqual({
      model: "project-model",
      posture: "auto-edit",
      extraArgs: "--app",
    });
    // All-agents: a different agent, which carries no project override.
    expect(configs[2]).toEqual({ model: "app-model", posture: "guarded", extraArgs: "--app" });
  });
});
