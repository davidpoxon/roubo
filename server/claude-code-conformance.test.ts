// Claude Code parity conformance suite (spike #503, AP-FR-018, AP-WU-002).
//
// Pins every behavior of the built-in Claude Code integration enumerated in the
// parity matrix at .specifications/agent-plugins/spikes/spike-503-claude-code-
// parity-matrix.md (meta-repo). Each test title carries its matrix row id
// (CC-<AREA>-<NN>); the matrix maps every row back to the test(s) covering it.
//
// Implementation-agnostic by construction: assertions target only the five
// observable seams the future Claude Code plugin must reproduce, never the
// built-in modules' internals. The seams are:
//
//   S1 HTTP route contract   - the REAL Express routers (terminal, hooks,
//                              permissions, settings) driven via supertest.
//   S2 workspace filesystem  - .claude/settings.local.json bytes written into a
//                              real temp bench workspace directory.
//   S3 agent process boundary- the node-pty spawn call (binary, argv, cwd) and
//                              PTY writes; plus exec.runCommand for the
//                              `claude --version` probe. Both are the borders
//                              to the external Claude Code binary and are
//                              replaced with recorders.
//   S4 notification records  - the bench's notification list (what the
//                              notifications API serves and SSE broadcasts).
//   S5 scheduling clock      - vitest fake timers pin the debounce and
//                              startup-delay windows deterministically.
//
// Host-side context providers (project registry, bench manager, jig manager,
// config parser, issue formatting) are fixture-mocked: they are Roubo host
// surfaces that exist on both sides of the built-in/plugin swap, not Claude
// Code integration behavior. State persistence (state.ts) is REAL, isolated
// into a throwaway home dir (the component-plugins-e2e.test.ts precedent).
//
// Run: npx vitest run server/claude-code-conformance.test.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── State isolation: pin ~/.roubo into a throwaway HOME ──
//
// state.ts freezes ROUBO_DIR at module-load time from os.homedir() (under
// ROUBO_PRODUCTION). The hoisted node:os mock redirects it before any
// state-touching module resolves its dir, so the real dev/user state is never
// read or written. ROUBO_PORT is cleared so the forced-hook URL rows are
// deterministic even when the suite itself runs inside a Roubo bench terminal.
const isolation = vi.hoisted(() => {
  process.env.ROUBO_PRODUCTION = "1";
  delete process.env.ROUBO_PORT;
  return { tmpHome: "" };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  isolation.tmpHome = fs.mkdtempSync(actual.tmpdir() + "/cc-conformance-home-");
  return {
    ...actual,
    default: { ...actual, homedir: () => isolation.tmpHome },
    homedir: () => isolation.tmpHome,
  };
});

// ── S3: the agent process boundary (node-pty spawn recorder + fake PTY) ──

interface FakePty {
  writes: string[];
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (fn: (data: string) => void) => { dispose: () => void };
  onExit: (fn: (e: { exitCode: number }) => void) => { dispose: () => void };
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
}

interface SpawnRecord {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  settingsFileExistedAtSpawn: boolean;
  pty: FakePty;
}

const spawnState = vi.hoisted(() => ({ records: [] as unknown[] }));
const spawnRecords = spawnState.records as SpawnRecord[];

vi.mock("node-pty", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    spawn: (
      file: string,
      args: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): FakePty => {
      const emitter = new EventEmitter();
      const pty: FakePty = {
        writes: [],
        write: (data: string) => {
          pty.writes.push(data);
        },
        resize: () => {},
        kill: () => {},
        onData: (fn: (data: string) => void) => {
          emitter.on("data", fn);
          return { dispose: () => emitter.removeListener("data", fn) };
        },
        onExit: (fn: (e: { exitCode: number }) => void) => {
          emitter.on("exit", fn);
          return { dispose: () => emitter.removeListener("exit", fn) };
        },
        emitData: (data: string) => emitter.emit("data", data),
        emitExit: (exitCode: number) => emitter.emit("exit", { exitCode }),
      };
      spawnState.records.push({
        file,
        args,
        cwd: opts.cwd,
        env: opts.env,
        settingsFileExistedAtSpawn: fs.existsSync(
          path.join(opts.cwd, ".claude", "settings.local.json"),
        ),
        pty,
      });
      return pty;
    },
  };
});

// ── S3: the `claude --version` probe boundary (exec recorder) ──

const execState = vi.hoisted(() => ({
  script: [] as Array<{ code: number; stdout: string; stderr: string }>,
  calls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock("./services/exec.js", () => ({
  runCommand: (cmd: string, args: string[]) => {
    execState.calls.push({ cmd, args });
    const next = execState.script.shift() ?? { code: 1, stdout: "", stderr: "" };
    return Promise.resolve(next);
  },
}));

// ── Host-context fixtures (exist unchanged on both sides of the swap) ──

vi.mock("./services/env.js", () => ({
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
  cleanEnv: () => ({}),
  getEnvFileKeys: () => [],
  getContextWindow: () => 200_000,
  loadEnvFile: () => {},
  resolveShellPath: () => {},
  resolveAgentCommand: (command: string) => command,
}));

const benchFixtures = vi.hoisted(() => ({ benches: new Map<string, unknown>() }));

vi.mock("./services/bench-manager.js", () => ({
  getBench: (projectId: string, benchId: number) =>
    benchFixtures.benches.get(`${projectId}:${benchId}`),
  getBenches: (projectId?: string) =>
    Array.from(benchFixtures.benches.values()).filter(
      (b) => !projectId || (b as { projectId: string }).projectId === projectId,
    ),
}));

const projectFixtures = vi.hoisted(() => ({ projects: new Map<string, unknown>() }));

vi.mock("./services/project-registry.js", () => ({
  getProject: (projectId: string) => projectFixtures.projects.get(projectId),
}));

const jigFixtures = vi.hoisted(() => ({ jigs: new Map<string, unknown>() }));

vi.mock("./services/jig-manager.js", () => ({
  getJig: (_projectId: string, jigId: string) => jigFixtures.jigs.get(jigId) ?? null,
  getDefaultJigId: () => undefined,
  // Template resolution is host behavior shared by every agent integration;
  // identity keeps the conformance assertions about injection mechanics only.
  resolveJigContent: (content: string) => content,
}));

// Partial: only the two bench-context providers are fixtured. `resolveTemplate`
// stays REAL because the agent-plugin launch path resolves a descriptor's
// {{sessionId}} / {{port}} / {{workspace}} through it, and faking that would
// hide the very seam the AP-TC-096 and CC-NOTIFY-PARITY rows assert.
vi.mock("./services/config-parser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/config-parser.js")>()),
  buildTemplateContext: () => ({ ports: {}, portHttps: {}, workspace: "/ws", components: {} }),
  applyContainerOverrides: () => {},
}));

vi.mock("./services/issue-formatting.js", () => ({
  fetchIssueContext: () => Promise.resolve({}),
  buildPluginIssueContext: () => ({}),
}));

// ── S3 (agent-plugin variant): the plugin process boundary (AP-TC-096) ──
//
// An agent plugin's process is external in exactly the way the agent binary
// behind node-pty is, so it is replaced with a fixture that answers
// `translateLaunch` with a descriptor. Nothing else on the plugin path is
// stubbed: the availability gate, the four-layer effective-config resolution,
// descriptor validation, template resolution and the spawn are all real, which
// is what lets the plugin rows assert the same observable seams as the built-in
// ones. The CC-NOTIFY-PARITY rows ride the same fixture, declaring notification
// and waiting-detection capabilities on the descriptor instead of an
// `initialPrompt`. `installed` defaults to false, which since #521 means a
// launch resolves no agent at all and fails rather than falling back.
const agentFixture = vi.hoisted(() => ({
  pluginId: "acme-agent",
  installed: false,
  descriptor: undefined as unknown,
}));

vi.mock("./services/plugin-manager.js", () => ({
  HOST_API_VERSION: "1.4.0",
  getConnection: () => ({}),
  getRecord: (id: string) =>
    agentFixture.installed && id === agentFixture.pluginId
      ? {
          id,
          manifest: { id, name: "Acme Agent", kind: "agent", roubo: "^1.4.0" },
          manifestPath: "/tmp/acme/roubo-plugin.yaml",
          pluginDir: "/tmp/acme",
          source: "bundled",
          status: "enabled",
          lastError: null,
          restartHistory: [],
          pid: null,
        }
      : undefined,
  getAgentManifests: () =>
    agentFixture.installed
      ? [{ id: agentFixture.pluginId, name: "Acme Agent", kind: "agent", roubo: "^1.4.0" }]
      : [],
  invoke: () => Promise.resolve(agentFixture.descriptor),
}));
vi.mock("./services/plugin-consent-state.js", () => ({ hasConsent: () => true }));

import terminalRouter from "./routes/terminal.js";
import hooksRouter from "./routes/hooks.js";
import permissionsRouter from "./routes/permissions.js";
import settingsRouter from "./routes/settings.js";
import {
  collectWorkspaceWrites,
  executeWorkspaceWrites,
  resolveWriteTemplates,
  validateDescriptor,
} from "./services/agent-launch-executor.js";

// The app under test mounts the REAL routers exactly as server/index.ts does.
const app = express();
app.use(express.json());
app.use("/api/projects", terminalRouter);
app.use("/api/projects", permissionsRouter);
app.use("/api/hooks", hooksRouter);
app.use("/api/settings", settingsRouter);

// ── Fixture helpers ──

const PROJECT_ID = "cc-parity";
const HOOK_URL_DEFAULT = "http://localhost:3335/api/hooks/claude-notification";
const FORCED_NOTIFICATION_HOOK = (url: string) => [{ hooks: [{ type: "http", url }] }];

interface FixtureBench {
  id: number;
  projectId: string;
  branch: string;
  workspacePath: string;
  ports: Record<string, number>;
  createdAt: string;
  assignedContainers: Record<string, string>;
  notifications: Array<{
    id: string;
    type: string;
    sourceSessionId?: string;
    metadata?: Record<string, unknown>;
  }>;
  components: Record<string, unknown>;
  status: string;
}

let benchSeq = 0;
const tmpWorkspaces: string[] = [];

function seedProject(projectId: string): void {
  projectFixtures.projects.set(projectId, {
    id: projectId,
    repoPath: "/repo",
    config: {
      project: { name: projectId, displayName: "CC Parity" },
      components: {},
    },
  });
}

function seedBench(
  projectId = PROJECT_ID,
  overrides: Partial<FixtureBench> = {},
): { bench: FixtureBench; benchId: number; workspacePath: string } {
  const benchId = ++benchSeq;
  const workspacePath = mkdtempSync(join(realOs.tmpdir(), "cc-conformance-ws-"));
  tmpWorkspaces.push(workspacePath);
  const bench: FixtureBench = {
    id: benchId,
    projectId,
    branch: `bench-${benchId}`,
    workspacePath,
    ports: {},
    createdAt: new Date().toISOString(),
    assignedContainers: {},
    notifications: [],
    components: {},
    status: "idle",
    ...overrides,
  };
  benchFixtures.benches.set(`${projectId}:${bench.id}`, bench);
  return { bench, benchId: bench.id, workspacePath };
}

function seedJig(id: string, content: string, sizeWarning = false): void {
  jigFixtures.jigs.set(id, {
    id,
    name: id,
    description: id,
    icon: "wrench",
    source: "app",
    content,
    sizeBytes: content.length,
    sizeWarning,
  });
}

function writeUserSettings(settings: Record<string, unknown>): void {
  const rouboDir = join(isolation.tmpHome, ".roubo");
  mkdirSync(rouboDir, { recursive: true });
  writeFileSync(join(rouboDir, "settings.json"), JSON.stringify({ theme: "dark", ...settings }));
}

function readWorkspaceSettings(workspacePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(workspacePath, ".claude", "settings.local.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function workspaceSettingsPath(workspacePath: string): string {
  return join(workspacePath, ".claude", "settings.local.json");
}

const createdSessions: Array<{ projectId: string; benchId: number; sessionId: string }> = [];

async function createTerminal(
  benchId: number,
  body: Record<string, unknown>,
  projectId = PROJECT_ID,
): Promise<request.Response> {
  const res = await request(app)
    .post(`/api/projects/${projectId}/benches/${benchId}/terminals`)
    .send(body);
  if (res.status === 201) {
    createdSessions.push({ projectId, benchId, sessionId: res.body.sessionId as string });
  }
  return res;
}

// A descriptor-declared http-hook carrier, structurally what the future Claude
// Code plugin emits: core writes the hook file and correlates on session_id.
const HTTP_HOOK_WIRING = {
  kind: "http-hook",
  event: "waiting",
  carrier: {
    workspaceWrite: {
      relPath: ".claude/settings.local.json",
      format: "json",
      ops: [
        {
          op: "set",
          path: "hooks.Notification",
          value: FORCED_NOTIFICATION_HOOK(
            "http://localhost:{{port}}/api/hooks/claude-notification",
          ),
        },
      ],
    },
  },
  correlation: { field: "session_id", source: "agent-native" },
} as const;

/**
 * Launch a descriptor-driven agent session through the real terminal route,
 * with `capabilities` supplied by the test. Only the plugin process is a
 * fixture; everything downstream (the availability gate, descriptor validation,
 * template resolution, workspace writes, spawn, session registration,
 * notifications) is the real host path.
 */
async function createAgentTerminal(
  benchId: number,
  capabilities: Record<string, unknown>,
  projectId = PROJECT_ID,
): Promise<request.Response> {
  agentFixture.installed = true;
  agentFixture.descriptor = {
    schemaVersion: 1,
    kind: "agent-launch",
    command: "acme",
    args: ["--session-id", "{{sessionId}}"],
    capabilities,
  };
  return createTerminal(benchId, { agentPluginId: agentFixture.pluginId }, projectId);
}

function lastSpawn(): SpawnRecord {
  const record = spawnRecords[spawnRecords.length - 1];
  expect(record).toBeDefined();
  return record;
}

function sessionIdArg(record: SpawnRecord): string {
  const idx = record.args.indexOf("--session-id");
  expect(idx).toBeGreaterThanOrEqual(0);
  return record.args[idx + 1];
}

function notificationsOfType(bench: FixtureBench, type: string): FixtureBench["notifications"] {
  return bench.notifications.filter((n) => n.type === type);
}

async function setProjectRules(
  rules: { allow?: string[]; deny?: string[]; ask?: string[] },
  projectId = PROJECT_ID,
): Promise<void> {
  const res = await request(app).put(`/api/projects/${projectId}/permissions`).send(rules);
  expect(res.status).toBe(200);
}

beforeEach(() => {
  spawnState.records.length = 0;
  execState.calls.length = 0;
  execState.script.length = 0;
  benchFixtures.benches.clear();
  projectFixtures.projects.clear();
  jigFixtures.jigs.clear();
  agentFixture.installed = false;
  agentFixture.descriptor = undefined;
  seedProject(PROJECT_ID);
  // Reset the app settings file to defaults (autoExecute true, auto mode off).
  writeUserSettings({});
});

afterEach(async () => {
  vi.useRealTimers();
  // Tear sessions down through the public route so no timers leak across tests.
  for (const s of createdSessions.splice(0)) {
    await request(app).delete(
      `/api/projects/${s.projectId}/benches/${s.benchId}/terminals/${s.sessionId}`,
    );
  }
  // Project rules persist in real state; reset to the empty set between tests.
  await setProjectRules({ allow: [], deny: [], ask: [] });
});

afterAll(() => {
  delete process.env.ROUBO_PRODUCTION;
  for (const ws of tmpWorkspaces) rmSync(ws, { recursive: true, force: true });
  rmSync(isolation.tmpHome, { recursive: true, force: true });
});

// ── Area 1: jig injection ──
//
// #521 removed the built-in launch path, so every CC-JIG row is now proved on
// the agent-plugin path in Area 1b. What stays here are the rows that are about
// the ROUTE rather than the agent: a bad jig id, and a launch that resolves no
// agent at all.

describe("jig injection route contract (CC-JIG)", () => {
  it("CC-JIG-05: a launch that resolves no agent fails outright, never a silent shell (AP-TC-103)", async () => {
    const { benchId, workspacePath } = seedBench();
    seedJig("push", "Do the thing");

    const res = await createTerminal(benchId, { jigId: "push" });

    // There is no built-in path left to fall through to, and no fallback is
    // permitted: the launch fails with guidance instead.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no ai coding agent is available/i);
    expect(spawnRecords).toHaveLength(0);
    expect(existsSync(workspaceSettingsPath(workspacePath))).toBe(false);
  });

  it("CC-JIG-05: a plain terminal (no jig, no agent) is still a plain shell with no argv", async () => {
    const { benchId, workspacePath } = seedBench();

    const res = await createTerminal(benchId, {});

    expect(res.status).toBe(201);
    const spawn = lastSpawn();
    expect(spawn.file).toBe("/bin/zsh");
    expect(spawn.args).toEqual([]);
    // Core writes no agent-specific settings file of its own (AP-TC-104).
    expect(existsSync(workspaceSettingsPath(workspacePath))).toBe(false);
  });

  it("CC-JIG-06: unknown jigId returns 404 and spawns nothing; malformed jigId returns 400", async () => {
    const { benchId } = seedBench();

    const missing = await createTerminal(benchId, { jigId: "no-such-jig" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/jig not found/i);

    const malformed = await createTerminal(benchId, { jigId: "../evil" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/invalid jig id/i);

    expect(spawnRecords).toHaveLength(0);
  });
});

// ── Area 1b: jig injection through an agent plugin (AP-TC-096) ──
//
// The same CC-JIG rows, re-run against the agent-plugin launch path with a
// fixture plugin that DECLARES the injection capability the built-in path
// hardcodes. Every assertion targets the same observable seams as its built-in
// twin (S1 the route response, S3 argv and PTY writes, S5 the 1500ms clock), so
// a divergence between the two paths fails here rather than in production.

describe("jig injection through the agent plugin (AP-TC-096)", () => {
  /** What a Claude-parity agent plugin answers `translateLaunch` with. */
  function installAgent(initialPrompt?: { mode: "argv-positional"; maxLength?: number }): void {
    agentFixture.installed = true;
    agentFixture.descriptor = {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "claude",
      args: ["--session-id", "{{sessionId}}"],
      ...(initialPrompt !== undefined && { initialPrompt }),
    };
  }

  const CLAUDE_PARITY = { mode: "argv-positional", maxLength: 100_000 } as const;

  function launchWithJig(benchId: number, jigId: string): Promise<request.Response> {
    return createTerminal(benchId, {
      command: "claude",
      jigId,
      agentPluginId: agentFixture.pluginId,
    });
  }

  it("CC-JIG-01 (plugin): autoExecute on passes the resolved jig as the final positional argument and reports jigInjected", async () => {
    installAgent(CLAUDE_PARITY);
    const { benchId, workspacePath } = seedBench();
    seedJig("push", "Push my branch to GitHub");
    writeUserSettings({ jigs: { autoInject: true, autoExecute: true } });

    const res = await launchWithJig(benchId, "push");

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(res.body.jigScheduled).toBeUndefined();
    const spawn = lastSpawn();
    expect(spawn.file).toBe("claude");
    expect(spawn.cwd).toBe(workspacePath);
    expect(spawn.args[spawn.args.length - 1]).toBe("Push my branch to GitHub");
    expect(sessionIdArg(spawn)).toBe(res.body.sessionId);
  });

  it("CC-JIG-02 (plugin): autoExecute off omits the positional argument and writes the jig to the PTY 1500ms after creation", async () => {
    vi.useFakeTimers();
    installAgent(CLAUDE_PARITY);
    const { benchId } = seedBench();
    seedJig("push", "Push my branch to GitHub");
    writeUserSettings({ jigs: { autoInject: true, autoExecute: false } });

    const res = await launchWithJig(benchId, "push");

    expect(res.status).toBe(201);
    expect(res.body.jigScheduled).toBe(true);
    expect(res.body.jigInjected).toBeUndefined();
    const spawn = lastSpawn();
    // No positional prompt: argv ends at the session id.
    expect(spawn.args).toEqual(["--session-id", res.body.sessionId]);

    vi.advanceTimersByTime(1499);
    expect(spawn.pty.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(spawn.pty.writes).toEqual(["Push my branch to GitHub"]);
  });

  it("CC-JIG-03 (plugin): the positional prompt argument is truncated to the declared 100,000 characters", async () => {
    installAgent(CLAUDE_PARITY);
    const { benchId } = seedBench();
    seedJig("huge", "x".repeat(150_000));

    const res = await launchWithJig(benchId, "huge");

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(lastSpawn().args[lastSpawn().args.length - 1]).toHaveLength(100_000);
  });

  it("CC-JIG-03 (plugin): the scheduled PTY write path delivers the full content untruncated", async () => {
    vi.useFakeTimers();
    installAgent(CLAUDE_PARITY);
    const { benchId } = seedBench();
    seedJig("huge", "x".repeat(150_000));
    writeUserSettings({ jigs: { autoInject: true, autoExecute: false } });

    const res = await launchWithJig(benchId, "huge");

    expect(res.status).toBe(201);
    const spawn = lastSpawn();
    vi.advanceTimersByTime(1500);
    expect(spawn.pty.writes[0]).toHaveLength(150_000);
  });

  it("CC-JIG-07 (plugin): a jig flagged sizeWarning propagates sizeWarning: true in the response", async () => {
    installAgent(CLAUDE_PARITY);
    const { benchId } = seedBench();
    seedJig("big", "large content", true);

    const res = await launchWithJig(benchId, "big");

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(res.body.sizeWarning).toBe(true);
  });

  it("CC-JIG-04 (plugin): the posture binding's argv precedes --session-id and the positional prompt", async () => {
    agentFixture.installed = true;
    agentFixture.descriptor = {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "claude",
      args: ["--session-id", "{{sessionId}}"],
      initialPrompt: CLAUDE_PARITY,
      capabilities: {
        permissions: {
          postures: { "read-only": { args: ["--permission-mode", "plan"] } },
          rules: { carrier: "workspace-write", resync: true },
        },
      },
    };
    const { benchId } = seedBench();
    seedJig("push", "Do the thing");
    await setProjectRules({ allow: [], deny: [], ask: [], posture: "read-only" } as never);

    const res = await launchWithJig(benchId, "push");

    expect(res.status).toBe(201);
    // Strict, whole-argv: the descriptor's own args, then the posture binding,
    // then the positional prompt. Core contributes no flag of its own, so the
    // removed --enable-auto-mode form the built-in emitted has no way back in
    // (AP-FR-017, AP-TC-092, AP-TC-104).
    expect(lastSpawn().args).toEqual([
      "--session-id",
      res.body.sessionId,
      "--permission-mode",
      "plan",
      "Do the thing",
    ]);
    await setProjectRules({ allow: [], deny: [], ask: [] });
  });

  it("AP-TC-063: an agent that declares no injection capability launches with nothing injected and no error", async () => {
    vi.useFakeTimers();
    installAgent(); // no `initialPrompt` in the descriptor
    const { benchId } = seedBench();
    seedJig("push", "Push my branch to GitHub");

    const res = await launchWithJig(benchId, "push");

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBeUndefined();
    expect(res.body.jigScheduled).toBeUndefined();
    const spawn = lastSpawn();
    expect(spawn.args).toEqual(["--session-id", res.body.sessionId]);

    vi.advanceTimersByTime(10_000);
    expect(spawn.pty.writes).toEqual([]);
  });

  it("AP-TC-063: the same agent with autoExecute off gets no scheduled PTY write either", async () => {
    vi.useFakeTimers();
    installAgent();
    const { benchId } = seedBench();
    seedJig("push", "Push my branch to GitHub");
    writeUserSettings({ jigs: { autoInject: true, autoExecute: false } });

    const res = await launchWithJig(benchId, "push");

    expect(res.status).toBe(201);
    expect(res.body.jigScheduled).toBeUndefined();
    const spawn = lastSpawn();

    vi.advanceTimersByTime(10_000);
    expect(spawn.pty.writes).toEqual([]);
  });
});

// ── Area 2: the agent workspace settings file ──
//
// The built-in writer this area used to pin was removed in #521: core writes no
// agent-specific settings file on a launch at all. The whole area now lives in
// CC-PERM-08 below, which pins the descriptor's workspace writes (the hook
// wiring, the rule arrays, the preserve-unknown-keys merge) as the one
// remaining producer of that file.

// ── Area 3: hook endpoint correlation ──

describe("hook endpoint correlation (CC-HOOK)", () => {
  it("CC-HOOK-01: the --session-id handed to the agent correlates a hook POST back to an agent-waiting record on the owning bench", async () => {
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.sessionId as string;
    // The correlation key the agent will echo back is exactly the spawn argv id.
    expect(sessionIdArg(lastSpawn())).toBe(sessionId);

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId, notification_type: "permission_prompt" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    const waiting = notificationsOfType(bench, "agent-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].sourceSessionId).toBe(sessionId);
  });

  it("CC-HOOK-02: a missing or non-string session_id returns 400", async () => {
    const missing = await request(app).post("/api/hooks/claude-notification").send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBeDefined();

    const nonString = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: 12345 });
    expect(nonString.status).toBe(400);
  });

  it("CC-HOOK-03: an unknown session id returns 404", async () => {
    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("CC-HOOK-04: a session with no hook wiring returns 400 and records nothing", async () => {
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, {});
    expect(created.status).toBe(201);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: created.body.sessionId });

    // The gate is the session's declared wiring, not its command name, so the
    // reason is agent-generic (AP-FR-013).
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hook-wired/);
    expect(res.body.error).not.toMatch(/claude/i);
    expect(bench.notifications).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("CC-HOOK-07: a hook POST quoting an already-exited session is rejected and records nothing", async () => {
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    expect(created.status).toBe(201);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    lastSpawn().pty.emitExit(0);
    // Exit records agent-exited; the point of this row is that no *waiting*
    // record follows the stale token.
    bench.notifications.length = 0;

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: created.body.sessionId });

    expect(res.status).toBe(400);
    expect(bench.notifications).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("CC-HOOK-05: a session whose bench no longer exists returns 404", async () => {
    const { benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    expect(created.status).toBe(201);
    benchFixtures.benches.delete(`${PROJECT_ID}:${benchId}`);

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: created.body.sessionId });

    expect(res.status).toBe(404);
  });

  it("CC-HOOK-06: repeated hook POSTs for one session dedupe to a single agent-waiting record", async () => {
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    const sessionId = created.body.sessionId as string;

    const first = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId });
    const second = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(1);
  });
});

// ── Area 4: quiescence debounce and waiting/exited notifications ──

describe("quiescence and lifecycle notifications (CC-QUI)", () => {
  it("CC-QUI-01: a hook-wired agent session notifies agent-waiting after exactly 8000ms of PTY silence, with the session label as metadata", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    const sessionId = created.body.sessionId as string;
    const spawn = lastSpawn();

    spawn.pty.emitData("thinking...");
    vi.advanceTimersByTime(7999);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const waiting = notificationsOfType(bench, "agent-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].sourceSessionId).toBe(sessionId);
    expect(waiting[0].metadata).toEqual({ label: created.body.label });
  });

  it("CC-QUI-02: a plain shell session notifies terminal-waiting after 2000ms of PTY silence", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, {});
    const spawn = lastSpawn();

    spawn.pty.emitData("$ ");
    vi.advanceTimersByTime(1999);
    expect(notificationsOfType(bench, "terminal-waiting")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const waiting = notificationsOfType(bench, "terminal-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].sourceSessionId).toBe(created.body.sessionId);
  });

  it("CC-QUI-03: fresh PTY output within the window resets the debounce timer", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    const spawn = lastSpawn();

    spawn.pty.emitData("chunk 1");
    vi.advanceTimersByTime(5000);
    spawn.pty.emitData("chunk 2");
    vi.advanceTimersByTime(5000);
    // 10s since the first chunk, but only 5s since the last: no notification.
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(0);

    vi.advanceTimersByTime(3000);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(1);
  });

  it("CC-QUI-04: fresh PTY output dismisses a pending agent-waiting record", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    const spawn = lastSpawn();

    spawn.pty.emitData("idle now");
    vi.advanceTimersByTime(8000);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(1);

    spawn.pty.emitData("working again");
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(0);
  });

  // Since #521 there is one exited notification and it is product-neutral:
  // `agent-exited`, raised by the plugin launch path (#646). This row pins that
  // a hook-wired agent session raises it at all, which it did not before
  // AP-FR-013 wired `onAgentExit`.
  it("CC-QUI-05: an agent session's exit records agent-exited", async () => {
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    const spawn = lastSpawn();

    spawn.pty.emitExit(0);

    const exited = notificationsOfType(bench, "agent-exited");
    expect(exited).toHaveLength(1);
    expect(exited[0].sourceSessionId).toBe(created.body.sessionId);
  });

  it("CC-QUI-06: continued silence after an agent-waiting fires does not create duplicates", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    await createAgentTerminal(benchId, {
      notification: HTTP_HOOK_WIRING,
      waitingDetection: { kind: "hook-driven" },
    });
    const spawn = lastSpawn();

    spawn.pty.emitData("idle");
    vi.advanceTimersByTime(8000);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(1);

    vi.advanceTimersByTime(16_000);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(1);
  });
});

// ── Area 4b: notification parity for a descriptor-driven session (AP-TC-099) ──
//
// The parity claim the built-in rows above pin, restated for a session launched
// from a plugin descriptor: the same hook endpoint, the same notification
// records, the same dismissal. What changes is only where eligibility and the
// debounce come from (the descriptor, not the command name).

describe("descriptor-driven notification parity (CC-NOTIFY-PARITY)", () => {
  it("CC-NOTIFY-PARITY-01: a descriptor-declared http-hook correlates a POST to an agent-waiting record", async () => {
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, { notification: HTTP_HOOK_WIRING });
    expect(created.status).toBe(201);
    const sessionId = created.body.sessionId as string;
    expect(sessionIdArg(lastSpawn())).toBe(sessionId);

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId, notification_type: "permission_prompt" });

    expect(res.status).toBe(200);
    const waiting = notificationsOfType(bench, "agent-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].sourceSessionId).toBe(sessionId);
  });

  it("CC-NOTIFY-PARITY-02: an agent declaring no notification wiring is rejected by the hook endpoint", async () => {
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: created.body.sessionId });

    expect(res.status).toBe(400);
    expect(bench.notifications).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("CC-NOTIFY-PARITY-03: the declared quiescence debounce replaces the default windows", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    const created = await createAgentTerminal(benchId, {
      waitingDetection: { kind: "quiescence-only", debounceMs: 4000 },
    });
    const spawn = lastSpawn();

    spawn.pty.emitData("working");
    // Neither the 2000ms terminal window nor the 8000ms hook fallback applies.
    vi.advanceTimersByTime(3999);
    expect(bench.notifications).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const waiting = notificationsOfType(bench, "agent-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].sourceSessionId).toBe(created.body.sessionId);
    expect(waiting[0].metadata).toEqual({ label: created.body.label });
  });

  it("CC-NOTIFY-PARITY-04: fresh output dismisses a descriptor-driven waiting record", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    await createAgentTerminal(benchId, {
      waitingDetection: { kind: "quiescence-only", debounceMs: 1000 },
    });
    const spawn = lastSpawn();

    spawn.pty.emitData("idle now");
    vi.advanceTimersByTime(1000);
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(1);

    spawn.pty.emitData("working again");
    expect(notificationsOfType(bench, "agent-waiting")).toHaveLength(0);
  });
});

// ── Area 5: version gate ──
//
// The built-in `claude --version` probe and its POST /api/settings/claude-code/
// recheck route went with the rest of the built-in path in #521. The version
// gate is now the descriptor's own declared probe, resolved by
// agent-version-probe.ts and pinned in agent-version-probe.test.ts and the
// AP-FR-014 rows of terminal-agent-session.test.ts. There is nothing
// agent-specific left in core to pin here.

// ── Area 6: permissions CRUD and resync ──

describe("permissions CRUD and resync (CC-PERM)", () => {
  it("CC-PERM-01: a project with no saved permissions reads as empty allow/deny/ask arrays", async () => {
    seedProject("cc-parity-fresh");

    const res = await request(app).get("/api/projects/cc-parity-fresh/permissions");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("CC-PERM-02: an unregistered project returns 404 on GET, PUT, and resync", async () => {
    const get = await request(app).get("/api/projects/no-such/permissions");
    const put = await request(app).put("/api/projects/no-such/permissions").send({ allow: [] });
    const resync = await request(app).post("/api/projects/no-such/permissions/resync");

    expect(get.status).toBe(404);
    expect(put.status).toBe(404);
    expect(resync.status).toBe(404);
  });

  it("CC-PERM-03: PUT replaces the stored set wholesale and GET reads it back", async () => {
    const first = await request(app)
      .put(`/api/projects/${PROJECT_ID}/permissions`)
      .send({ allow: ["Bash(npm test:*)"], deny: ["Bash(rm:*)"], ask: ["Edit(.env*)"] });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      allow: ["Bash(npm test:*)"],
      deny: ["Bash(rm:*)"],
      ask: ["Edit(.env*)"],
    });

    const replaced = await request(app)
      .put(`/api/projects/${PROJECT_ID}/permissions`)
      .send({ allow: ["Read(*)"] });
    expect(replaced.status).toBe(200);

    const read = await request(app).get(`/api/projects/${PROJECT_ID}/permissions`);
    // Replacement, not merge: the first PUT's rules are gone.
    expect(read.body).toEqual({ allow: ["Read(*)"], deny: [], ask: [] });
  });

  it("CC-PERM-04: PUT validates arrays: non-arrays, >100 entries, and >512-char entries are rejected with 400", async () => {
    const nonArray = await request(app)
      .put(`/api/projects/${PROJECT_ID}/permissions`)
      .send({ allow: "Bash(*)" });
    expect(nonArray.status).toBe(400);

    const nonString = await request(app)
      .put(`/api/projects/${PROJECT_ID}/permissions`)
      .send({ deny: [42] });
    expect(nonString.status).toBe(400);

    const tooMany = await request(app)
      .put(`/api/projects/${PROJECT_ID}/permissions`)
      .send({ allow: Array.from({ length: 101 }, (_, i) => `Rule(${i})`) });
    expect(tooMany.status).toBe(400);

    const tooLong = await request(app)
      .put(`/api/projects/${PROJECT_ID}/permissions`)
      .send({ ask: ["x".repeat(513)] });
    expect(tooLong.status).toBe(400);
  });

  it("CC-PERM-05: omitted fields default to empty arrays", async () => {
    const res = await request(app).put(`/api/projects/${PROJECT_ID}/permissions`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("CC-PERM-06: resync additively unions the project rules into every operable bench workspace and reports resynced/skipped/errors", async () => {
    // Since #521 the agent plugin is the ONLY carrier, so resync needs one
    // installed to have anywhere to write (AP-TC-101).
    agentFixture.installed = true;
    agentFixture.descriptor = claudeCodePluginDescriptor({
      allow: ["Bash(npm test:*)"],
      ask: [],
      deny: [],
    });
    const projectId = "cc-parity-resync";
    seedProject(projectId);
    const a = seedBench(projectId);
    const b = seedBench(projectId);
    // Bench B already has a workspace-local rule that must survive the resync.
    mkdirSync(join(b.workspacePath, ".claude"), { recursive: true });
    writeFileSync(
      workspaceSettingsPath(b.workspacePath),
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
    );
    const clearing = seedBench(projectId, { status: "clearing" });
    seedBench(projectId, { workspacePath: "" }); // skipped: blank workspace path
    // A workspace whose parent is a regular file makes mkdir fail for real.
    const errWs = join(realOs.tmpdir(), `cc-conformance-file-${Date.now()}`);
    writeFileSync(errWs, "not a directory");
    tmpWorkspaces.push(errWs);
    const broken = seedBench(projectId, { workspacePath: join(errWs, "ws") });

    await setProjectRules({ allow: ["Bash(npm test:*)"], deny: [], ask: [] }, projectId);
    const res = await request(app).post(`/api/projects/${projectId}/permissions/resync`);

    expect(res.status).toBe(200);
    expect(res.body.resynced).toBe(2);
    expect(res.body.skipped).toBe(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].benchId).toBe(broken.benchId);
    expect(typeof res.body.errors[0].message).toBe("string");

    const permsA = readWorkspaceSettings(a.workspacePath).permissions as Record<string, unknown>;
    expect(permsA.allow).toEqual(["Bash(npm test:*)"]);
    const permsB = readWorkspaceSettings(b.workspacePath).permissions as Record<string, unknown>;
    // Additive: the pre-existing workspace rule is never removed.
    expect(permsB.allow).toEqual(["Bash(ls:*)", "Bash(npm test:*)"]);
    expect(existsSync(workspaceSettingsPath(clearing.workspacePath))).toBe(false);

    await setProjectRules({ allow: [], deny: [], ask: [] }, projectId);
  });

  it("CC-PERM-07: resync with no agent plugin installed writes nothing at all (AP-TC-103)", async () => {
    const projectId = "cc-parity-noop";
    seedProject(projectId);
    const { workspacePath } = seedBench(projectId);
    await setProjectRules({ allow: ["Bash(npm test:*)"], deny: [], ask: [] }, projectId);

    const res = await request(app).post(`/api/projects/${projectId}/permissions/resync`);

    expect(res.status).toBe(200);
    // The retired built-in carrier wrote an agent-specific settings file here.
    // With no plugin there is no carrier, so the bench is reported as skipped
    // and core writes nothing of its own.
    expect(res.body).toEqual({ resynced: 0, skipped: 1, errors: [] });
    expect(existsSync(workspaceSettingsPath(workspacePath))).toBe(false);

    await setProjectRules({ allow: [], deny: [], ask: [] }, projectId);
  });
});

// ── Binary discovery (#645) ──
//
// Not a parity-matrix row: this pins the one parity gap the matrix left open,
// namely that the matrix's argv and correlation rows say nothing about how the
// CLI itself is found. A plugin's launch descriptor names a bare command, and it
// must land on the same binary the retired built-in path used to find, or a
// plugin-launched session fails to spawn on installs that used to work. The real
// env module is used here (the fixture mock at the top of this file is what
// every other row wants) so this is pinned against the shipping resolver, not a
// stub.

describe("agent CLI discovery (#645)", () => {
  it("a descriptor command resolves through the shared well-known install list", async () => {
    const env = await vi.importActual<typeof import("./services/env.js")>("./services/env.js");
    const candidates = env.wellKnownPathsFor("claude");
    // Guard: the homedir-rooted candidates must sit inside the isolated home, or
    // this test would probe (and could match) the developer's real install.
    const shim = join(isolation.tmpHome, ".claude", "local", "claude");
    expect(candidates).toContain(shim);

    mkdirSync(join(isolation.tmpHome, ".claude", "local"), { recursive: true });
    // 0o755 is load-bearing: resolution gates on an executable regular file
    // (#651), so a default-0644 shim would be skipped like a broken install.
    writeFileSync(shim, "#!/bin/sh\nexec true\n", { mode: 0o755 });

    const original = { PATH: process.env.PATH, SHELL: process.env.SHELL };
    // An empty PATH plus a fish login shell (whose PATH the server never
    // resolves) is the install shape from the issue: the command cannot be
    // found by searching, so the well-known list is the only thing left.
    process.env.PATH = "";
    process.env.SHELL = "/usr/local/bin/fish";
    try {
      expect(env.resolveAgentCommand("claude")).toBe(shim);

      // An explicit path in a descriptor is spawned exactly as given.
      expect(env.resolveAgentCommand("/opt/acme/bin/acme")).toBe("/opt/acme/bin/acme");
      // An unresolvable command names what it tried rather than surfacing ENOENT.
      expect(() => env.resolveAgentCommand("acme")).toThrow(/was not found/);
    } finally {
      process.env.PATH = original.PATH;
      process.env.SHELL = original.SHELL;
      rmSync(shim, { force: true });
    }
  });

  // The same install shape, for a CLI the host's own table has never heard of
  // (#712). This is what the manifest field buys: a base name other than
  // `claude` resolving on an install whose PATH the server never inherits,
  // against the shipping resolver and real files on disk.
  it("a non-claude CLI resolves from its plugin manifest's declared locations", async () => {
    const env = await vi.importActual<typeof import("./services/env.js")>("./services/env.js");
    // Nothing host-side knows this base name, so PATH is all it would have had.
    expect(env.wellKnownPathsFor("acme")).toEqual([]);

    const installDir = join(isolation.tmpHome, ".acme", "bin");
    const installed = join(installDir, "acme");
    mkdirSync(installDir, { recursive: true });
    // 0o644 on the first candidate, 0o755 on the second: the executability gate
    // still applies to a declared location, so the broken one must not shadow
    // the working one (#651).
    const broken = join(isolation.tmpHome, "acme-broken");
    writeFileSync(broken, "#!/bin/sh\nexec true\n", { mode: 0o644 });
    writeFileSync(installed, "#!/bin/sh\nexec true\n", { mode: 0o755 });
    const declared = ["~/acme-broken", "~/.acme/bin/acme"];

    const original = { PATH: process.env.PATH, SHELL: process.env.SHELL };
    process.env.PATH = "";
    process.env.SHELL = "/usr/local/bin/fish";
    try {
      expect(env.resolveAgentCommand("acme", process.env.PATH, declared)).toBe(installed);

      // And a total miss still names every location tried, declared ones
      // included, rather than leaving an opaque ENOENT to the PTY.
      rmSync(installed, { force: true });
      expect(() => env.resolveAgentCommand("acme", process.env.PATH, declared)).toThrow(installed);
    } finally {
      process.env.PATH = original.PATH;
      process.env.SHELL = original.SHELL;
      rmSync(broken, { force: true });
      rmSync(installed, { force: true });
    }
  });
});

// ── Plugin-descriptor parity (CC-PERM-08, AP-TC-097, AP-TC-098, AP-TC-101) ──
//
// The rows above pin the BUILT-IN writer. This block pins the other half of the
// swap: that the descriptor the claude-code agent plugin emits, executed through
// the core AgentLaunchExecutor, produces the same settings file for the same
// inputs. The fixture below is a verbatim copy of what
// roubo-plugins/plugins/claude-code/src/translate-launch.ts returns; it is
// duplicated here on purpose, because the whole point of a parity suite is that
// core can prove the equivalence without depending on the plugin's build.

function claudeCodePluginDescriptor(rules: {
  allow: string[];
  ask: string[];
  deny: string[];
}): unknown {
  const ops: unknown[] = [];
  if (rules.allow.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.allow", values: rules.allow });
  }
  if (rules.deny.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.deny", values: rules.deny });
  }
  if (rules.ask.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.ask", values: rules.ask });
  }
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: "claude",
    args: ["--session-id", "{{sessionId}}"],
    initialPrompt: { mode: "argv-positional", maxLength: 100_000 },
    capabilities: {
      ...(ops.length > 0 && {
        workspaceWrites: [{ relPath: ".claude/settings.local.json", format: "json", ops }],
      }),
      notification: {
        kind: "http-hook",
        event: "waiting",
        carrier: {
          workspaceWrite: {
            relPath: ".claude/settings.local.json",
            format: "json",
            ops: [
              {
                op: "set",
                path: "hooks.Notification",
                value: [
                  {
                    hooks: [
                      {
                        type: "http",
                        url: "http://localhost:{{port}}/api/hooks/claude-notification",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        correlation: { field: "session_id", source: "agent-native" },
      },
      permissions: {
        postures: {
          "read-only": { args: ["--permission-mode", "plan"] },
          guarded: { args: ["--permission-mode", "manual"] },
          "auto-edit": { args: ["--permission-mode", "acceptEdits"] },
          "full-auto": { args: ["--permission-mode", "auto"] },
        },
        rules: { carrier: "workspace-write", resync: true },
      },
    },
  };
}

function runPluginWrites(
  workspacePath: string,
  rules: { allow: string[]; ask: string[]; deny: string[] },
): void {
  const descriptor = validateDescriptor(claudeCodePluginDescriptor(rules));
  executeWorkspaceWrites(
    workspacePath,
    resolveWriteTemplates(collectWorkspaceWrites(descriptor), {
      ports: {},
      portHttps: {},
      workspace: workspacePath,
      components: {},
      sessionId: "00000000-0000-4000-8000-000000000000",
      port: process.env.ROUBO_PORT || "3335",
    }),
  );
}

describe("plugin-descriptor parity for the settings write (CC-PERM-08)", () => {
  const rules = {
    allow: ["Bash(npm run *)", "Read(**)"],
    ask: ["WebFetch"],
    deny: ["Bash(rm -rf *)"],
  };

  it("CC-PERM-08: the plugin descriptor's writes reproduce the retired built-in writer's bytes (AP-TC-097)", () => {
    const plugin = mkdtempSync(join(realOs.tmpdir(), "cc-parity-plugin-"));
    tmpWorkspaces.push(plugin);

    runPluginWrites(plugin, rules);

    // The exact bytes the removed built-in writer produced for these inputs,
    // frozen here as literal expected output. #521 deleted that writer, so the
    // parity claim can no longer be proved by running both; it is proved by
    // pinning the target instead, which is what a parity baseline is for.
    const expected = JSON.stringify(
      {
        permissions: {
          allow: rules.allow,
          deny: rules.deny,
          ask: rules.ask,
        },
        hooks: { Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT) },
      },
      null,
      2,
    );

    expect(readFileSync(workspaceSettingsPath(plugin), "utf-8")).toBe(expected);
  });

  it("CC-PERM-08: allow, ask, and deny land in their own arrays with the hook wired (AP-TC-078)", () => {
    const ws = mkdtempSync(join(realOs.tmpdir(), "cc-parity-plugin-"));
    tmpWorkspaces.push(ws);

    runPluginWrites(ws, rules);

    const settings = readWorkspaceSettings(ws);
    expect(settings.permissions).toEqual({
      allow: rules.allow,
      deny: rules.deny,
      ask: rules.ask,
    });
    expect(settings.hooks).toEqual({ Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT) });
  });

  it("CC-PERM-08: user-authored keys survive the merge untouched (AP-TC-098)", () => {
    const ws = mkdtempSync(join(realOs.tmpdir(), "cc-parity-plugin-"));
    tmpWorkspaces.push(ws);
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(
      workspaceSettingsPath(ws),
      JSON.stringify({
        env: { MY_VAR: "1" },
        editorSettings: { theme: "solarized" },
        permissions: { allow: ["Read(mine/**)"], defaultMode: "auto" },
      }),
    );

    runPluginWrites(ws, rules);

    const settings = readWorkspaceSettings(ws);
    expect(settings.env).toEqual({ MY_VAR: "1" });
    expect(settings.editorSettings).toEqual({ theme: "solarized" });
    const perms = settings.permissions as Record<string, unknown>;
    expect(perms.defaultMode).toBe("auto");
    // Union, existing first: the user's own rule is never dropped or reordered.
    expect(perms.allow).toEqual(["Read(mine/**)", ...rules.allow]);
  });

  it("CC-PERM-08: an empty rule set writes only the hook wiring, never an empty permissions key", () => {
    const ws = mkdtempSync(join(realOs.tmpdir(), "cc-parity-plugin-"));
    tmpWorkspaces.push(ws);

    runPluginWrites(ws, { allow: [], ask: [], deny: [] });

    const settings = readWorkspaceSettings(ws);
    expect(settings.permissions).toBeUndefined();
    expect(settings.hooks).toEqual({ Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT) });
  });

  // CC-SET-02's successor. The retired built-in writer replaced the whole
  // `hooks` key; the descriptor sets `hooks.Notification` specifically, so the
  // guarantee is narrower and worth pinning exactly: our Notification wiring
  // always wins, and a user's unrelated hook events survive.
  it("CC-PERM-08: a user-authored Notification hook is overwritten, sibling events survive (CC-SET-02)", () => {
    const ws = mkdtempSync(join(realOs.tmpdir(), "cc-parity-plugin-"));
    tmpWorkspaces.push(ws);
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(
      workspaceSettingsPath(ws),
      JSON.stringify({
        hooks: {
          Notification: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo stopping" }] }],
        },
      }),
    );

    runPluginWrites(ws, rules);

    const hooks = readWorkspaceSettings(ws).hooks as Record<string, unknown>;
    // Never merged with the user's: correlation depends on ours being the one
    // that fires, so it is replaced outright.
    expect(hooks.Notification).toEqual(FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT));
    expect(JSON.stringify(hooks.Notification)).not.toContain("user-hook");
    // A different event is none of our business and is left alone.
    expect(hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo stopping" }] }]);
  });

  // CC-SET-06's successor: the descriptor write path is now the sole producer
  // of the hook wiring, so its corrupt-file handling has to be pinned here.
  it("CC-PERM-08: a corrupt existing settings file is treated as empty and rewritten as valid JSON (CC-SET-06)", () => {
    const ws = mkdtempSync(join(realOs.tmpdir(), "cc-parity-plugin-"));
    tmpWorkspaces.push(ws);
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(workspaceSettingsPath(ws), "{not json at all");

    runPluginWrites(ws, rules);

    const raw = readFileSync(workspaceSettingsPath(ws), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const settings = readWorkspaceSettings(ws);
    expect(settings.hooks).toEqual({ Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT) });
    expect(settings.permissions).toEqual({
      allow: rules.allow,
      deny: rules.deny,
      ask: rules.ask,
    });
  });
});
