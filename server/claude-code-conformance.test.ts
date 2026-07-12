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
  getClaudeBinary: () => "claude",
  getLoginShell: () => "/bin/zsh",
  cleanEnv: () => ({}),
  getEnvFileKeys: () => [],
  getContextWindow: () => 200_000,
  loadEnvFile: () => {},
  resolveShellPath: () => {},
  resolveClaudeBinary: () => {},
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

vi.mock("./services/config-parser.js", () => ({
  buildTemplateContext: () => ({ ports: {}, portHttps: {}, workspace: "/ws", components: {} }),
  applyContainerOverrides: () => {},
}));

vi.mock("./services/issue-formatting.js", () => ({
  fetchIssueContext: () => Promise.resolve({}),
  buildPluginIssueContext: () => ({}),
}));

import terminalRouter from "./routes/terminal.js";
import hooksRouter from "./routes/hooks.js";
import permissionsRouter from "./routes/permissions.js";
import settingsRouter from "./routes/settings.js";

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

describe("jig injection (CC-JIG)", () => {
  it("CC-JIG-01: autoExecute on passes the resolved jig as the final positional argument and reports jigInjected", async () => {
    const { benchId, workspacePath } = seedBench();
    seedJig("push", "Push my branch to GitHub");
    writeUserSettings({ jigs: { autoInject: true, autoExecute: true } });

    const res = await createTerminal(benchId, { command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(res.body.jigScheduled).toBeUndefined();
    const spawn = lastSpawn();
    expect(spawn.file).toBe("claude");
    expect(spawn.cwd).toBe(workspacePath);
    expect(spawn.args[spawn.args.length - 1]).toBe("Push my branch to GitHub");
    expect(sessionIdArg(spawn)).toBe(res.body.sessionId);
  });

  it("CC-JIG-02: autoExecute off omits the positional argument and writes the jig to the PTY 1500ms after creation", async () => {
    vi.useFakeTimers();
    const { benchId } = seedBench();
    seedJig("push", "Push my branch to GitHub");
    writeUserSettings({ jigs: { autoInject: true, autoExecute: false } });

    const res = await createTerminal(benchId, { command: "claude", jigId: "push" });

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

  it("CC-JIG-03: the positional prompt argument is truncated to 100,000 characters", async () => {
    const { benchId } = seedBench();
    seedJig("huge", "x".repeat(150_000));

    const res = await createTerminal(benchId, { command: "claude", jigId: "huge" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    const spawn = lastSpawn();
    expect(spawn.args[spawn.args.length - 1]).toHaveLength(100_000);
  });

  it("CC-JIG-03: the scheduled PTY write path delivers the full content untruncated", async () => {
    vi.useFakeTimers();
    const { benchId } = seedBench();
    seedJig("huge", "x".repeat(150_000));
    writeUserSettings({ jigs: { autoInject: true, autoExecute: false } });

    const res = await createTerminal(benchId, { command: "claude", jigId: "huge" });

    expect(res.status).toBe(201);
    const spawn = lastSpawn();
    vi.advanceTimersByTime(1500);
    expect(spawn.pty.writes[0]).toHaveLength(150_000);
  });

  it("CC-JIG-04: agent argv order is --enable-auto-mode, --permission-mode plan, --session-id <uuid>, prompt", async () => {
    const { benchId } = seedBench();
    seedJig("push", "Do the thing");
    writeUserSettings({
      jigs: { autoInject: true, autoExecute: true },
      claudeCode: { enableAutoMode: true, startInPlanMode: true },
    });

    const res = await createTerminal(benchId, { command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(lastSpawn().args).toEqual([
      "--enable-auto-mode",
      "--permission-mode",
      "plan",
      "--session-id",
      res.body.sessionId,
      "Do the thing",
    ]);
  });

  it("CC-JIG-05: a jigId on a non-claude command is ignored: plain shell, no argv, no settings write", async () => {
    const { benchId, workspacePath } = seedBench();
    seedJig("push", "Do the thing");

    const res = await createTerminal(benchId, { jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBeUndefined();
    expect(res.body.jigScheduled).toBeUndefined();
    const spawn = lastSpawn();
    expect(spawn.file).toBe("/bin/zsh");
    expect(spawn.args).toEqual([]);
    expect(existsSync(workspaceSettingsPath(workspacePath))).toBe(false);
  });

  it("CC-JIG-06: unknown jigId returns 404 and spawns nothing; malformed jigId returns 400", async () => {
    const { benchId } = seedBench();

    const missing = await createTerminal(benchId, { command: "claude", jigId: "no-such-jig" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/jig not found/i);

    const malformed = await createTerminal(benchId, { command: "claude", jigId: "../evil" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/invalid jig id/i);

    expect(spawnRecords).toHaveLength(0);
  });

  it("CC-JIG-07: a jig flagged sizeWarning propagates sizeWarning: true in the response", async () => {
    const { benchId } = seedBench();
    seedJig("big", "large content", true);

    const res = await createTerminal(benchId, { command: "claude", jigId: "big" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(res.body.sizeWarning).toBe(true);
  });

  it("CC-JIG-08: .claude/settings.local.json exists before the agent process is spawned", async () => {
    const { benchId } = seedBench();

    const res = await createTerminal(benchId, { command: "claude" });

    expect(res.status).toBe(201);
    expect(lastSpawn().settingsFileExistedAtSpawn).toBe(true);
  });
});

// ── Area 2: .claude/settings.local.json writer ──

describe("settings.local.json writer (CC-SET)", () => {
  it("CC-SET-01: a fresh workspace gets a valid settings file whose Notification hook is the catch-all Roubo HTTP hook (default port 3335)", async () => {
    const { benchId, workspacePath } = seedBench();

    const res = await createTerminal(benchId, { command: "claude" });

    expect(res.status).toBe(201);
    const settings = readWorkspaceSettings(workspacePath);
    expect(settings.hooks).toEqual({
      Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT),
    });
    // No matcher key: the hook is a catch-all over every Notification event.
    const entry = (settings.hooks as { Notification: Array<Record<string, unknown>> })
      .Notification[0];
    expect(entry).not.toHaveProperty("matcher");
  });

  it("CC-SET-01: the forced hook URL honors ROUBO_PORT", async () => {
    const { benchId, workspacePath } = seedBench();
    process.env.ROUBO_PORT = "4444";
    try {
      const res = await createTerminal(benchId, { command: "claude" });
      expect(res.status).toBe(201);
      const settings = readWorkspaceSettings(workspacePath);
      expect(settings.hooks).toEqual({
        Notification: FORCED_NOTIFICATION_HOOK(
          "http://localhost:4444/api/hooks/claude-notification",
        ),
      });
    } finally {
      delete process.env.ROUBO_PORT;
    }
  });

  it("CC-SET-02: user-defined hooks are overwritten (Notification is never merged) while unrelated top-level keys survive", async () => {
    const { benchId, workspacePath } = seedBench();
    mkdirSync(join(workspacePath, ".claude"), { recursive: true });
    writeFileSync(
      workspaceSettingsPath(workspacePath),
      JSON.stringify({
        hooks: {
          Notification: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
        model: "opus",
      }),
    );

    const res = await createTerminal(benchId, { command: "claude" });

    expect(res.status).toBe(201);
    const settings = readWorkspaceSettings(workspacePath);
    expect(settings.hooks).toEqual({
      Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT),
    });
    expect(settings.model).toBe("opus");
  });

  it("CC-SET-03: enableAutoMode drives permissions.defaultMode: set to auto when on, removed when off", async () => {
    const { benchId, workspacePath } = seedBench();
    writeUserSettings({ claudeCode: { enableAutoMode: true, startInPlanMode: false } });

    let res = await createTerminal(benchId, { command: "claude" });
    expect(res.status).toBe(201);
    const perms = readWorkspaceSettings(workspacePath).permissions as Record<string, unknown>;
    expect(perms.defaultMode).toBe("auto");

    writeUserSettings({ claudeCode: { enableAutoMode: false, startInPlanMode: false } });
    res = await createTerminal(benchId, { command: "claude" });
    expect(res.status).toBe(201);
    expect(readWorkspaceSettings(workspacePath).permissions).toBeUndefined();
  });

  it("CC-SET-04: allow/deny/ask are deduplicating unions of the existing workspace arrays and the project rules, existing entries first", async () => {
    const { benchId, workspacePath } = seedBench();
    mkdirSync(join(workspacePath, ".claude"), { recursive: true });
    writeFileSync(
      workspaceSettingsPath(workspacePath),
      JSON.stringify({
        permissions: {
          allow: ["Bash(ls:*)"],
          deny: ["Bash(rm:*)"],
          ask: ["Edit(.env)"],
          additionalDirectories: ["/extra"],
        },
      }),
    );
    await setProjectRules({
      allow: ["Bash(ls:*)", "Bash(npm test:*)"],
      deny: ["Read(secrets/*)"],
      ask: ["Edit(.env)"],
    });

    const res = await createTerminal(benchId, { command: "claude" });

    expect(res.status).toBe(201);
    const perms = readWorkspaceSettings(workspacePath).permissions as Record<string, unknown>;
    expect(perms.allow).toEqual(["Bash(ls:*)", "Bash(npm test:*)"]);
    expect(perms.deny).toEqual(["Bash(rm:*)", "Read(secrets/*)"]);
    expect(perms.ask).toEqual(["Edit(.env)"]);
    // Unknown permissions sub-keys are preserved untouched.
    expect(perms.additionalDirectories).toEqual(["/extra"]);
  });

  it("CC-SET-05: with no rules and auto mode off, the permissions key is absent entirely", async () => {
    const { benchId, workspacePath } = seedBench();

    const res = await createTerminal(benchId, { command: "claude" });

    expect(res.status).toBe(201);
    const settings = readWorkspaceSettings(workspacePath);
    expect(settings.permissions).toBeUndefined();
    expect(settings.hooks).toBeDefined();
  });

  it("CC-SET-06: a corrupt existing settings file is treated as empty and rewritten as valid JSON", async () => {
    const { benchId, workspacePath } = seedBench();
    mkdirSync(join(workspacePath, ".claude"), { recursive: true });
    writeFileSync(workspaceSettingsPath(workspacePath), "{not json at all");

    const res = await createTerminal(benchId, { command: "claude" });

    expect(res.status).toBe(201);
    const settings = readWorkspaceSettings(workspacePath);
    expect(settings.hooks).toEqual({
      Notification: FORCED_NOTIFICATION_HOOK(HOOK_URL_DEFAULT),
    });
  });
});

// ── Area 3: hook endpoint correlation ──

describe("hook endpoint correlation (CC-HOOK)", () => {
  it("CC-HOOK-01: the --session-id handed to the agent correlates a hook POST back to a claude-waiting record on the owning bench", async () => {
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, { command: "claude" });
    expect(created.status).toBe(201);
    const sessionId = created.body.sessionId as string;
    // The correlation key the agent will echo back is exactly the spawn argv id.
    expect(sessionIdArg(lastSpawn())).toBe(sessionId);

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId, notification_type: "permission_prompt" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    const waiting = notificationsOfType(bench, "claude-waiting");
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

  it("CC-HOOK-04: a non-claude session returns 400 and records nothing", async () => {
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, {});
    expect(created.status).toBe(201);

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: created.body.sessionId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/claude/i);
    expect(bench.notifications).toHaveLength(0);
  });

  it("CC-HOOK-05: a session whose bench no longer exists returns 404", async () => {
    const { benchId } = seedBench();
    const created = await createTerminal(benchId, { command: "claude" });
    expect(created.status).toBe(201);
    benchFixtures.benches.delete(`${PROJECT_ID}:${benchId}`);

    const res = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: created.body.sessionId });

    expect(res.status).toBe(404);
  });

  it("CC-HOOK-06: repeated hook POSTs for one session dedupe to a single claude-waiting record", async () => {
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, { command: "claude" });
    const sessionId = created.body.sessionId as string;

    const first = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId });
    const second = await request(app)
      .post("/api/hooks/claude-notification")
      .send({ session_id: sessionId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(1);
  });
});

// ── Area 4: quiescence debounce and waiting/exited notifications ──

describe("quiescence and lifecycle notifications (CC-QUI)", () => {
  it("CC-QUI-01: a claude session notifies claude-waiting after exactly 8000ms of PTY silence, with the session label as metadata", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, { command: "claude" });
    const sessionId = created.body.sessionId as string;
    const spawn = lastSpawn();

    spawn.pty.emitData("thinking...");
    vi.advanceTimersByTime(7999);
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const waiting = notificationsOfType(bench, "claude-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].sourceSessionId).toBe(sessionId);
    expect(waiting[0].metadata).toEqual({ label: created.body.label });
  });

  it("CC-QUI-02: a non-claude session notifies terminal-waiting after 2000ms of PTY silence", async () => {
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
    await createTerminal(benchId, { command: "claude" });
    const spawn = lastSpawn();

    spawn.pty.emitData("chunk 1");
    vi.advanceTimersByTime(5000);
    spawn.pty.emitData("chunk 2");
    vi.advanceTimersByTime(5000);
    // 10s since the first chunk, but only 5s since the last: no notification.
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(0);

    vi.advanceTimersByTime(3000);
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(1);
  });

  it("CC-QUI-04: fresh PTY output dismisses a pending claude-waiting record", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    await createTerminal(benchId, { command: "claude" });
    const spawn = lastSpawn();

    spawn.pty.emitData("idle now");
    vi.advanceTimersByTime(8000);
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(1);

    spawn.pty.emitData("working again");
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(0);
  });

  it("CC-QUI-05: agent process exit records a claude-exited notification for the session", async () => {
    const { bench, benchId } = seedBench();
    const created = await createTerminal(benchId, { command: "claude" });
    const spawn = lastSpawn();

    spawn.pty.emitExit(0);

    const exited = notificationsOfType(bench, "claude-exited");
    expect(exited).toHaveLength(1);
    expect(exited[0].sourceSessionId).toBe(created.body.sessionId);
  });

  it("CC-QUI-05: a non-claude session exit records no claude-exited notification", async () => {
    const { bench, benchId } = seedBench();
    await createTerminal(benchId, {});
    const spawn = lastSpawn();

    spawn.pty.emitExit(0);

    expect(notificationsOfType(bench, "claude-exited")).toHaveLength(0);
  });

  it("CC-QUI-06: continued silence after a claude-waiting fires does not create duplicates", async () => {
    vi.useFakeTimers();
    const { bench, benchId } = seedBench();
    await createTerminal(benchId, { command: "claude" });
    const spawn = lastSpawn();

    spawn.pty.emitData("idle");
    vi.advanceTimersByTime(8000);
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(1);

    vi.advanceTimersByTime(16_000);
    expect(notificationsOfType(bench, "claude-waiting")).toHaveLength(1);
  });
});

// ── Area 5: version gate ──

describe("version gate (CC-VER)", () => {
  async function recheck(): Promise<request.Response> {
    return request(app).post("/api/settings/claude-code/recheck").send({});
  }

  it("CC-VER-01: version 2.1.83 (the exact minimum) reports auto mode available with no reason", async () => {
    execState.script.push({ code: 0, stdout: "2.1.83 (Claude Code)", stderr: "" });

    const res = await recheck();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claudeCodeAutoModeAvailable: true });
    expect(execState.calls[0]).toEqual({ cmd: "claude", args: ["--version"] });
  });

  it("CC-VER-02: a version below 2.1.83 reports unavailable, naming both versions", async () => {
    execState.script.push({ code: 0, stdout: "2.1.82 (Claude Code)", stderr: "" });

    const res = await recheck();

    expect(res.status).toBe(200);
    expect(res.body.claudeCodeAutoModeAvailable).toBe(false);
    expect(res.body.claudeCodeAutoModeReason).toContain("2.1.82");
    expect(res.body.claudeCodeAutoModeReason).toContain("2.1.83");
  });

  it("CC-VER-03: a failed direct probe retries through a login shell before succeeding", async () => {
    execState.script.push({ code: 127, stdout: "", stderr: "not found" });
    execState.script.push({ code: 0, stdout: "3.0.0 (Claude Code)", stderr: "" });

    const res = await recheck();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claudeCodeAutoModeAvailable: true });
    expect(execState.calls).toEqual([
      { cmd: "claude", args: ["--version"] },
      { cmd: "sh", args: ["-lc", "claude --version"] },
    ]);
  });

  it("CC-VER-04: when both probes fail, auto mode is unavailable with a not-installed reason", async () => {
    execState.script.push({ code: 127, stdout: "", stderr: "" });
    execState.script.push({ code: 127, stdout: "", stderr: "" });

    const res = await recheck();

    expect(res.status).toBe(200);
    expect(res.body.claudeCodeAutoModeAvailable).toBe(false);
    expect(res.body.claudeCodeAutoModeReason).toMatch(/not installed|could not be run/i);
  });

  it("CC-VER-05: unparseable version output reports unavailable with a could-not-determine reason", async () => {
    execState.script.push({ code: 0, stdout: "no semver here", stderr: "" });

    const res = await recheck();

    expect(res.status).toBe(200);
    expect(res.body.claudeCodeAutoModeAvailable).toBe(false);
    expect(res.body.claudeCodeAutoModeReason).toMatch(/could not be determined/i);
  });

  it("CC-VER-06: the detection result is cached until an explicit recheck resets it", async () => {
    execState.script.push({ code: 0, stdout: "2.5.0 (Claude Code)", stderr: "" });
    await recheck();
    const callsAfterDetect = execState.calls.length;

    // A settings read reuses the cache: the binary is not probed again.
    const settingsRes = await request(app).get("/api/settings");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.claudeCodeAutoModeAvailable).toBe(true);
    expect(execState.calls.length).toBe(callsAfterDetect);

    // An explicit recheck re-probes and can flip the result.
    execState.script.push({ code: 127, stdout: "", stderr: "" });
    execState.script.push({ code: 127, stdout: "", stderr: "" });
    const flipped = await recheck();
    expect(flipped.body.claudeCodeAutoModeAvailable).toBe(false);
    expect(execState.calls.length).toBeGreaterThan(callsAfterDetect);
  });
});

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

  it("CC-PERM-07: resync with an empty project rule set writes nothing (rule removal never propagates)", async () => {
    const projectId = "cc-parity-noop";
    seedProject(projectId);
    const { workspacePath } = seedBench(projectId);

    const res = await request(app).post(`/api/projects/${projectId}/permissions/resync`);

    expect(res.status).toBe(200);
    // The bench still counts as resynced, but no file is created.
    expect(res.body).toEqual({ resynced: 1, skipped: 0, errors: [] });
    expect(existsSync(workspaceSettingsPath(workspacePath))).toBe(false);
  });
});
