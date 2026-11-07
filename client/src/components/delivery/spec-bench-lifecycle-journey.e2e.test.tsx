// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator controls models and
// lifecycle without the terminal" (SB-TC-057, SB-FR-021, SB-FR-022, SB-US-008).
// It asserts the authoritative e2e_flow case SB-TC-057 step for step, so a
// divergence is integration drift and not a re-specification.
//
// What runs for real on the client: the bench page (BenchDetail with the real
// Delivery tab, its health rail, its role matrix and its lifecycle controls
// with the wind-down dialog), the real React Query hooks, the real `lib/api`
// request layer and the real notification stream hook, which reads the
// snapshot again on each delivery frame.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode and hands it to
//     the real session launcher (server/services/delivery-session-launcher.ts),
//     which mints the token in the real registry and builds the launch
//     descriptor;
//   - server/routes/delivery.ts answers the snapshot through the real record
//     loader over the bench's workspace and the real event log, takes the role
//     change and the wind-down into the real control outbox, and resumes the
//     delivery through the real launcher, whose lifecycle and live-session
//     checks decide whether it may;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log, reads each control back into
//     the outbox, and broadcasts each change through the real
//     server/services/sse.ts; it also serves the tooling's controls read;
//   - server/services/terminal.ts holds each delivery session as a terminal
//     session of the bench: the bench's terminal list, the live-session check
//     the resume route makes, and the session's input count, which step 5 reads.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as an empty folder; the launch executor (the port
// the launcher hands the descriptor to) records each launch, opens the session
// as a terminal session of the real terminal service and hands the descriptor
// to the fake delivery tooling; node-pty spawns a fake PTY, which is the fake
// tooling's process; the notification stream's response is a fake that hands
// each frame to the client's fake EventSource; and the state file writes are
// stubbed, with the terminal sessions persisted in a scratch folder. Two reads
// that no step asserts, the spec list and the list of every project's benches,
// are answered by the stand-in in the shape of their bodies, and the bench's
// terminal list is answered from the real terminal service. A request to any
// other route answers 404 and is listed in the failure output. The hooks and
// components that the journey does not cross (projects, integration, settings,
// plugins, the terminal view, logs, issue controls) are stubbed as in the page
// suites.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts. Started, the fake delivery tooling writes the record into the
// bench workspace with A and D done, B running and C waiting on B, and the
// unit-coder role on the fast tier. In the journey it reads the operator's
// controls from the controls endpoint and posts the events that apply them,
// each with the token; wound down, its process ends, and resumed, it posts
// with the new token the relaunch handed it.
//
// Failure-output contract: each SB-TC-057 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, RegisteredProject, TerminalSession } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_FILE,
  type DeliveryLaunchDescriptor,
} from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord } from "../../test/delivery-fixtures";

// ── Stand-ins below the real routes ──
//
// The bench manager keeps the stand-in's benches and delegates the create and
// the workspace provisioning to it. The project registry names the fixture
// project. node-pty spawns the fake PTY the stand-in hands out, and the state
// file writes are stubbed, with the Roubo folder, where the terminal service
// persists its sessions, in a scratch folder.

interface CreateBenchOptions {
  variant?: string;
  focusedSpecPath?: string;
  delivery?: { mode: string; decisionMode?: string };
}

// The part of a node-pty process that the terminal service uses.
interface FakePtyProcess {
  pid: number;
  written: string[];
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose: () => void };
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): {
    dispose: () => void;
  };
  exit(exitCode: number): void;
}

const routeServices = vi.hoisted(() => {
  class BenchError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
      this.name = "BenchError";
    }
  }
  return {
    BenchError,
    benches: [] as Bench[],
    project: undefined as unknown,
    createBench: undefined as
      ((projectId: string, branch?: string, options?: CreateBenchOptions) => Bench) | undefined,
    provisioned: new Map<number, Promise<void>>(),
    rouboDir: "",
    spawnPty: undefined as (() => FakePtyProcess) | undefined,
  };
});

vi.mock("../../../../server/services/bench-manager.js", () => ({
  BenchError: routeServices.BenchError,
  getBench: vi.fn((projectId: string, benchId: number) =>
    routeServices.benches.find((bench) => bench.projectId === projectId && bench.id === benchId),
  ),
  getBenches: vi.fn((projectId: string) =>
    routeServices.benches.filter((bench) => bench.projectId === projectId),
  ),
  createBench: vi.fn((projectId: string, branch?: string, options?: CreateBenchOptions) => {
    if (routeServices.createBench === undefined) throw new Error("no bench manager stand-in");
    return routeServices.createBench(projectId, branch, options);
  }),
  whenWorkspaceProvisioned: vi.fn(
    (_projectId: string, benchId: number) =>
      routeServices.provisioned.get(benchId) ?? Promise.resolve(),
  ),
  isBenchLive: vi.fn(() => true),
}));
vi.mock("../../../../server/services/project-registry.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getProject: vi.fn(() => routeServices.project),
    resolveEnforceIssueDependencies: vi.fn(() => false),
  };
});
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    if (routeServices.spawnPty === undefined) throw new Error("no PTY stand-in");
    return routeServices.spawnPty();
  }),
}));
vi.mock("../../../../server/services/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  routeServices.rouboDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "spec-bench-lifecycle-journey-roubo-")),
  );
  return {
    ...actual,
    updateBench: vi.fn(),
    loadSettings: vi.fn(() => ({})),
    getRouboDir: vi.fn(() => routeServices.rouboDir),
  };
});
// The services of the benches routes that the journey does not cross.
vi.mock("../../../../server/services/tool-launcher.js", () => ({
  getResolvedTools: vi.fn(),
  executeTool: vi.fn(),
}));
vi.mock("../../../../server/services/issue-assignment.js", () => ({
  createBenchAndAssignFromIssue: vi.fn(),
}));
vi.mock("../../../../server/routes/plugin-route-helpers.js", () => ({
  getActivePluginOrRespond: vi.fn(),
  fetchPluginComments: vi.fn(),
  resolveActivePluginQuiet: vi.fn(),
}));
vi.mock("../../../../server/services/plugin-manager.js", () => ({
  invoke: vi.fn(),
  getAgentManifests: vi.fn(() => []),
  getRecord: vi.fn(),
  getConnection: vi.fn(),
  HOST_API_VERSION: "1.4.0",
}));
vi.mock("../../../../server/services/start-gate.js", () => ({
  assertGateOpen: vi.fn(),
  fetchIssueForStart: vi.fn(),
}));
vi.mock("../../../../server/services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(),
}));
vi.mock("../../../../server/services/git-state.js", () => ({
  getDirtyState: vi.fn(),
}));

// ── Stubs for what the journey does not cross ──

vi.mock("../../hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useProjects")>();
  return { ...actual, useProjects: vi.fn() };
});
vi.mock("../../hooks/useProjectIntegration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useProjectIntegration")>();
  return {
    ...actual,
    useProjectIntegration: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  };
});
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  return {
    ...actual,
    useSettings: vi.fn(() => ({ settings: undefined, isLoading: false, updateSettings: vi.fn() })),
  };
});
vi.mock("../../hooks/useGlobalCap", () => ({
  useGlobalCap: vi.fn(() => ({
    current: 0,
    max: null,
    isCapped: false,
    isAtCap: false,
    isOverCap: false,
  })),
}));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn() }),
}));
vi.mock("../../hooks/useClearingTracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useClearingTracker")>();
  return {
    ...actual,
    useTeardownTracker: () => ({ register: vi.fn(), teardowns: new Map() }),
  };
});
vi.mock("../../hooks/useContainers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useContainers")>();
  return { ...actual, useUnassignContainer: () => ({ mutate: vi.fn(), isPending: false }) };
});
vi.mock("../../hooks/usePlugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/usePlugins")>();
  return {
    ...actual,
    usePlugins: () => ({ data: { hostApiVersion: "1.0.0", plugins: [] } }),
  };
});
vi.mock("../../hooks/useBenchIssue", () => ({
  useBenchIssue: vi.fn(() => ({ data: undefined })),
}));
vi.mock("../../hooks/useElapsed", () => ({ useElapsed: () => null }));
vi.mock("../MissingPluginDialog", () => ({ default: () => null }));
vi.mock("../EnablePluginPromptModal", () => ({ default: () => null }));
vi.mock("../settings/plugins/ConsentReviewDialog", () => ({ default: () => null }));
vi.mock("../ComponentStatusDot", () => ({ default: () => <span data-testid="status-dot" /> }));
vi.mock("../ToolButtons", () => ({ default: () => <span data-testid="tool-buttons" /> }));
vi.mock("../LogStream", () => ({ default: () => <div data-testid="log-stream" /> }));
vi.mock("../TerminalTabs", () => ({ default: () => <div data-testid="terminal-tabs" /> }));
vi.mock("../Terminal", () => ({ default: () => <div data-testid="live-terminal" /> }));
vi.mock("../AssignContainerModal", () => ({ default: () => null }));
vi.mock("../IssueTransitionDropdown", () => ({ default: () => null }));
vi.mock("../IssueAssignControl", () => ({ default: () => null }));
vi.mock("../testbench/TestBenchPanel", () => ({ default: () => null }));

import { useProjects } from "../../hooks/useProjects";
import { useNotificationStream } from "../../hooks/useNotificationStream";
import BenchDetail from "../BenchDetail";

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// OWNERS holds exactly the two slices of this journey's blocked-by set, each by
// its exact title, and every step names both as its owners. A slice that a
// step also crosses but that sits outside the blocked-by set is listed apart
// in OUTSIDE_BLOCKED_BY, by its exact title, and is never named as an owner.
const OWNERS = {
  controls: "Control service, outbox and the token-gated controls endpoint",
  lifecycle: "Role matrix and lifecycle controls: pause, wind-down, resume and approve",
} as const;

const OUTSIDE_BLOCKED_BY = {
  reducer: "Delivery reducer and selectors shared by server and client",
  ingest: "Token-gated event ingest, sequence checks and the delivery stream frame",
  launcher: "Record loader, token registry and session launcher for launch and attach",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => `'${OWNERS[key]}'`).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => `'${OUTSIDE_BLOCKED_BY[key]}'`).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project and record (SB-TC-057 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The role whose model the operator changes, from the tier it runs on to the
// one the operator picks, and the boundary at which the session applies it.
const ROLE = "unit-coder";
const CURRENT_TIER = "fast";
const NEW_TIER = "large";
const BOUNDARY_UNIT = "B";
const NEXT_UNIT = "C";

// The scratch folder of a test, the project checkout in it, and the folder the
// benches' workspaces go in.
let scratch: string;
let checkout: string;

function fixtureProject(): RegisteredProject {
  return {
    id: PROJECT_ID,
    repoPath: checkout,
    configValid: true,
    config: {
      project: { displayName: "Demo", name: "demo", repo: "" },
      layout: { type: "single-repo" },
      components: {},
      ports: {},
      benches: { max: 3 },
    } as unknown as RegisteredProject["config"],
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  } as RegisteredProject;
}

// The conformant record fixture of four units A, B, C and D, a stack of A, B and
// C, and gates after B and after C, as the session writes it while B runs: A
// and D are done, C waits on B, the delivery is running, and the unit-coder
// role runs on the fast tier.
function initialRecord(): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  const status: Record<string, string> = { A: "done", B: "running", C: "pending", D: "done" };
  return {
    ...record,
    units: record.units.map((unit) => ({ ...unit, status: status[unit.id] ?? unit.status })),
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({ ...gate, status: "pending" })),
    },
    roles: { main: { tier: "balanced" }, [ROLE]: { tier: CURRENT_TIER } },
    health: { status: "ok", checked_at: now },
    lifecycle: { ...record.lifecycle, state: "running" },
    updated_at: now,
  };
}

// ── The network stand-in ──

interface StandInResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function respond(status: number, body: unknown): StandInResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  };
}

interface FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  readyState: number;
  close: () => void;
}

// What the launcher hands its executor, as the journey reads it.
interface LaunchRequest {
  projectId: string;
  benchId: number;
  workspacePath: string;
  specSlug: string;
  descriptor: DeliveryLaunchDescriptor;
}

interface LaunchExecutor {
  launch(request: LaunchRequest): Promise<{ sessionId?: string }>;
}

// The fake response the notification stream writes to: the part of an
// express Response that server/services/sse.ts uses.
interface StreamResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  on(event: string, listener: () => void): void;
}

// The real routers and services, loaded once the mocks above are in place. The
// specifier is built at run time so that the client's type check, whose root is
// client/src, does not take in the server's sources; the shape the journey
// uses of each module is declared here.
const SERVER_ROOT = "../../../../server";

interface ServerModules {
  benches: { default: express.Router };
  delivery: { default: express.Router };
  deliveryHooks: { default: express.Router; deliveryEventBodyParser: express.RequestHandler };
  eventLog: { forgetDeliveryEventLog: () => void };
  controlOutbox: { forgetDeliveryControlMemory: () => void };
  launcher: {
    setDeliveryLaunchExecutor: (executor: LaunchExecutor) => void;
    resetDeliveryLaunchExecutor: () => void;
    whenDeliveryBound: (projectId: string, benchId: number) => Promise<void>;
  };
  terminal: {
    createSession: (
      projectId: string,
      benchId: number,
      workspacePath: string,
      projectName: string,
    ) => TerminalSession;
    getSession: (sessionId: string) => TerminalSession | undefined;
    getSessions: (projectId: string, benchId: number) => TerminalSession[];
    getSessionInputCount: (sessionId: string) => number | undefined;
    destroyAllSessions: () => void;
  };
  sse: {
    addClient: (res: StreamResponse) => void;
    broadcastBenchStatus: (bench: Bench) => void;
    _resetClientsForTest: () => void;
  };
}

async function loadServerModule<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ `${SERVER_ROOT}/${file}`)) as T;
}

async function loadServerModules(): Promise<ServerModules> {
  return {
    benches: await loadServerModule<ServerModules["benches"]>("routes/benches.js"),
    delivery: await loadServerModule<ServerModules["delivery"]>("routes/delivery.js"),
    deliveryHooks: await loadServerModule<ServerModules["deliveryHooks"]>(
      "routes/delivery-hooks.js",
    ),
    eventLog: await loadServerModule<ServerModules["eventLog"]>("services/delivery-event-log.js"),
    controlOutbox: await loadServerModule<ServerModules["controlOutbox"]>(
      "services/delivery-control-outbox.js",
    ),
    launcher: await loadServerModule<ServerModules["launcher"]>(
      "services/delivery-session-launcher.js",
    ),
    terminal: await loadServerModule<ServerModules["terminal"]>("services/terminal.js"),
    sse: await loadServerModule<ServerModules["sse"]>("services/sse.js"),
  };
}

type SupertestMethod = (url: string) => request.Test;

const BASE = `/api/projects/${PROJECT_ID}`;

// The requests that the real routers answer.
const REAL_ROUTES: { methods: string[]; path: RegExp }[] = [
  { methods: ["GET", "POST"], path: new RegExp(`^${BASE}/benches$`) },
  { methods: ["GET"], path: new RegExp(`^${BASE}/benches/\\d+$`) },
  { methods: ["DELETE"], path: new RegExp(`^${BASE}/benches/\\d+/notifications$`) },
  { methods: ["GET", "POST", "PUT"], path: new RegExp(`^${BASE}/benches/\\d+/delivery(/.*)?$`) },
  { methods: ["POST"], path: new RegExp(`^${DELIVERY_EVENT_HOOK_PATH}$`) },
  { methods: ["GET"], path: new RegExp(`^${DELIVERY_CONTROLS_HOOK_PATH}$`) },
];

// A node-pty process that runs nothing: it keeps what is written into it, and
// ends when the fake tooling ends it.
function fakePty(): FakePtyProcess {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: { exitCode: number; signal?: number }) => void>();
  const written: string[] = [];
  let ended = false;
  const pty: FakePtyProcess = {
    pid: 4242,
    written,
    write: (data) => {
      written.push(data);
    },
    resize: () => undefined,
    kill: () => pty.exit(0),
    onData: (listener) => {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    exit: (exitCode) => {
      if (ended) return;
      ended = true;
      for (const listener of [...exitListeners]) listener({ exitCode });
    },
  };
  return pty;
}

class RouboServerStandIn {
  unrouted: string[] = [];
  // Each request the real routers answered: its method, path and status.
  answered: { method: string; path: string; status: number }[] = [];
  // Each launch the real launcher handed its executor, the terminal session the
  // executor opened for it, and that session's process.
  launches: LaunchRequest[] = [];
  sessions: TerminalSession[] = [];
  processes: FakePtyProcess[] = [];
  private readonly app = express();
  private readonly modules: ServerModules;
  private streams: FakeEventSource[] = [];
  private onLaunch:
    ((descriptor: DeliveryLaunchDescriptor, pty: FakePtyProcess) => void) | undefined;

  // The routers mounted as server/index.ts mounts them, behind the delivery
  // event parser and the global JSON parser.
  constructor(modules: ServerModules) {
    this.modules = modules;
    this.app.use(DELIVERY_EVENT_HOOK_PATH, modules.deliveryHooks.deliveryEventBodyParser);
    this.app.use(express.json({ limit: "210kb" }));
    this.app.use("/api/projects", modules.benches.default);
    this.app.use("/api/projects", modules.delivery.default);
    this.app.use("/api/hooks", modules.deliveryHooks.default);
    routeServices.benches = [];
    routeServices.provisioned = new Map();
    routeServices.project = fixtureProject();
    routeServices.createBench = (projectId, _branch, options) =>
      this.createBench(projectId, options ?? {});
    routeServices.spawnPty = () => {
      const pty = fakePty();
      this.processes.push(pty);
      return pty;
    };
    // The executor opens the session as a terminal session of the bench in the
    // real terminal service; its process is the fake tooling.
    modules.launcher.setDeliveryLaunchExecutor({
      launch: async (launch) => {
        this.launches.push(launch);
        const session = modules.terminal.createSession(
          launch.projectId,
          launch.benchId,
          launch.workspacePath,
          "Demo",
        );
        this.sessions.push(session);
        const pty = this.processes.at(-1);
        if (pty === undefined) throw new Error("the session spawned no process");
        this.onLaunch?.(launch.descriptor, pty);
        return { sessionId: session.id };
      },
    });
  }

  get benches(): Bench[] {
    return routeServices.benches;
  }

  setLaunchExecutor(
    onLaunch: (descriptor: DeliveryLaunchDescriptor, pty: FakePtyProcess) => void,
  ): void {
    this.onLaunch = onLaunch;
  }

  // A client EventSource: the real notification stream service holds a fake
  // response for it, which hands each `data:` frame to the source.
  openStream(): FakeEventSource {
    const closed: (() => void)[] = [];
    const source: FakeEventSource = {
      onmessage: null,
      onerror: null,
      onopen: null,
      readyState: 1,
      close: () => {
        source.readyState = 2;
        for (const listener of closed) listener();
      },
    };
    const response: StreamResponse = {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk) => {
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ") && source.readyState === 1) {
            source.onmessage?.({ data: line.slice("data: ".length) } as MessageEvent);
          }
        }
        return true;
      },
      on: (name, listener) => {
        if (name === "close") closed.push(listener);
      },
    };
    this.modules.sse.addClient(response);
    this.streams.push(source);
    return source;
  }

  close(): void {
    for (const stream of this.streams) stream.close();
    this.modules.launcher.resetDeliveryLaunchExecutor();
    this.modules.terminal.destroyAllSessions();
    routeServices.spawnPty = undefined;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<StandInResponse> {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (REAL_ROUTES.some((route) => route.methods.includes(method) && route.path.test(path))) {
      const res = await this.routed(method, `${path}${url.search}`, init);
      this.answered.push({ method, path, status: res.status });
      return res;
    }
    if (method === "GET" && path === "/api/benches") {
      return respond(200, copy(routeServices.benches));
    }
    if (method === "GET" && path === `${BASE}/testbench/specs`) {
      return respond(200, { specs: [], invalid: [] });
    }
    // The bench's terminal list, as server/routes/terminal.ts answers it: from
    // the real terminal service.
    const terminals = new RegExp(`^${BASE}/benches/(\\d+)/terminals$`).exec(path);
    if (method === "GET" && terminals !== null) {
      return respond(
        200,
        copy(this.modules.terminal.getSessions(PROJECT_ID, Number(terminals[1]))),
      );
    }
    this.unrouted.push(`${method} ${path}${url.search}`);
    return respond(404, { error: `The stand-in serves no ${method} ${path}`, code: "NOT_FOUND" });
  }

  // A request that the real routers answer, in-process, through supertest.
  private async routed(
    method: string,
    target: string,
    init: RequestInit | undefined,
  ): Promise<StandInResponse> {
    const agent = request(this.app) as unknown as Record<string, SupertestMethod>;
    let pending = agent[method.toLowerCase()](target);
    new Headers(init?.headers).forEach((value, name) => {
      pending = pending.set(name, value);
    });
    const res = typeof init?.body === "string" ? await pending.send(init.body) : await pending;
    return respond(res.status, res.body as unknown);
  }

  // The bench manager's create, below the real benches route: it claims the
  // bench and provisions its workspace as an empty folder.
  private createBench(projectId: string, options: CreateBenchOptions): Bench {
    const folder = resolve(checkout, options.focusedSpecPath ?? "");
    if (folder !== join(checkout, SPEC_FOLDER)) {
      throw new routeServices.BenchError(
        `Invalid focusedSpecPath: no spec folder ${String(options.focusedSpecPath)}`,
        "INVALID_FOCUS",
      );
    }
    const id = routeServices.benches.length + 1;
    const bench: Bench = {
      id,
      projectId,
      branch: `bench-${id}`,
      workspacePath: join(scratch, "workspaces", `bench-${id}`),
      status: "preparing",
      ports: {},
      components: {},
      createdAt: new Date().toISOString(),
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
      variant: "specbench",
      focusedSpecPath: folder,
      ...(options.delivery && {
        deliveryBindMode: options.delivery.mode as Bench["deliveryBindMode"],
      }),
    };
    routeServices.benches.push(bench);
    routeServices.provisioned.set(id, this.provision(bench));
    return bench;
  }

  private provision(bench: Bench): Promise<void> {
    mkdirSync(bench.workspacePath, { recursive: true });
    bench.status = "active";
    this.modules.sse.broadcastBenchStatus(bench);
    return Promise.resolve();
  }
}

// ── The fake delivery tooling ──
//
// It holds the launch descriptor and the process of the session it runs as.
// Started, it writes the record into the spec folder of the bench workspace;
// then it reads the controls from the controls URL and posts its events to the
// event URL, each with the token of its latest launch. Its process ends when
// it winds down.
interface ControlRead {
  control_seq: number;
  kind: string;
  target_id?: string;
  body: Record<string, unknown>;
  status: string;
}

class FakeDeliveryTooling {
  descriptor: DeliveryLaunchDescriptor | undefined;
  process: FakePtyProcess | undefined;
  private nextSeq = initialRecord().last_event_seq + 1;

  launched(descriptor: DeliveryLaunchDescriptor, pty: FakePtyProcess): void {
    this.descriptor = descriptor;
    this.process = pty;
  }

  private held(): DeliveryLaunchDescriptor {
    const { descriptor } = this;
    if (descriptor === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
    return descriptor;
  }

  start(bench: Bench, record: DeliveryRecord): void {
    this.held();
    const folder = join(bench.workspacePath, SPEC_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return {
      $schema: DELIVERY_EVENT_SCHEMA_ID,
      schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
      delivery_id: initialRecord().delivery_id,
      type,
      seq,
      ts: new Date().toISOString(),
      ...(unitId !== undefined && { unit_id: unitId }),
      payload,
    };
  }

  async post(events: DeliveryEvent[]): Promise<number> {
    const descriptor = this.held();
    const res = await fetch(descriptor.eventUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({ events }),
    });
    if (res.status !== 202) {
      throw new Error(
        `the event endpoint answered ${res.status}: ${JSON.stringify(await res.json())}`,
      );
    }
    return res.status;
  }

  async readControls(): Promise<ControlRead[]> {
    const descriptor = this.held();
    const res = await fetch(descriptor.controlsUrl, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
    });
    const body = (await res.json()) as { controls?: ControlRead[] };
    if (res.status !== 200 || !Array.isArray(body.controls)) {
      throw new Error(`the controls endpoint answered ${res.status}: ${JSON.stringify(body)}`);
    }
    return body.controls;
  }

  // The session finishes the unit it is on, starts no other, and its process
  // ends.
  exit(): void {
    if (this.process === undefined) throw new Error("the tooling runs as no process");
    this.process.exit(0);
  }
}

// ── Failure-output wrapper ──

let server: RouboServerStandIn;

async function step<T>(
  label: string,
  expectation: string,
  owningSlices: string,
  body: () => T | Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    const unrouted =
      server.unrouted.length > 0 ? `\n  unserved requests: ${server.unrouted.join(", ")}` : "";
    throw new Error(
      `SB-TC-057 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${owningSlices}${unrouted}`,
      { cause },
    );
  }
}

function StreamHarness() {
  useNotificationStream();
  return null;
}

// The bench page of the Spec Bench, which opens on its Delivery tab.
function renderBenchPage(benchId: number) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/benches/${benchId}`]}>
        <StreamHarness />
        <Routes>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The precondition: a Spec Bench set up from fixture-spec in launch mode, its
// session launched with the token, and its record written and conformant.
async function setUpLaunchModeSpecBench(tooling: FakeDeliveryTooling): Promise<Bench> {
  const res = await server.fetch(`${BASE}/benches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: "specbench",
      focusedSpecPath: SPEC_FOLDER,
      delivery: { mode: "launch" },
    }),
  });
  if (res.status !== 201) {
    throw new Error(`the create route answered ${res.status}: ${JSON.stringify(await res.json())}`);
  }
  const { id } = (await res.json()) as Bench;
  await serverModules.launcher.whenDeliveryBound(PROJECT_ID, id);
  const bench = server.benches.find((b) => b.id === id);
  if (bench === undefined) throw new Error(`the bench manager holds no bench ${id}`);
  expect(server.launches, "the launch-mode bench launched no session").toHaveLength(1);
  expect(bench.deliverySessionId).toBe(server.sessions[0]?.id);
  const record = initialRecord();
  expect(validateDeliveryRecord(record).ok).toBe(true);
  tooling.start(bench, record);
  await readSnapshot(id);
  return bench;
}

async function readSnapshot(benchId: number): Promise<DeliverySnapshot> {
  const res = await server.fetch(`${BASE}/benches/${benchId}/delivery`);
  if (res.status !== 200) {
    throw new Error(
      `the snapshot read answered ${res.status}: ${JSON.stringify(await res.json())}`,
    );
  }
  return (await res.json()) as DeliverySnapshot;
}

async function requestAnswered(
  benchId: number,
  method: string,
  route: string,
  status: number,
): Promise<void> {
  await waitFor(
    () =>
      expect(server.answered).toContainEqual({
        method,
        path: `${BASE}/benches/${benchId}/delivery/${route}`,
        status,
      }),
    { timeout: 3000 },
  );
}

function controlsView(): HTMLElement {
  return screen.getByRole("region", { name: "Cost, health and controls" });
}

function roleRow(): HTMLElement {
  return within(controlsView()).getByTestId(`role-row-${ROLE}`);
}

function lifecycleButton(name: string): HTMLElement {
  const lifecycle = within(controlsView()).getByRole("region", { name: "Lifecycle" });
  return within(lifecycle).getByRole("button", { name });
}

function healthChip(): HTMLElement {
  const rail = screen.getByRole("group", { name: "Delivery health" });
  return within(rail).getByTestId("delivery-health-chip");
}

let serverModules: ServerModules;

beforeAll(async () => {
  serverModules = await loadServerModules();
});

afterAll(() => {
  if (routeServices.rouboDir !== "") {
    rmSync(routeServices.rouboDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-lifecycle-journey-")));
  checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, SPEC_FOLDER), { recursive: true });
  mkdirSync(join(scratch, "workspaces"));
  server = new RouboServerStandIn(serverModules);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(function FakeEventSourceCtor() {
      return server.openStream();
    }),
  );
  vi.mocked(useProjects).mockReturnValue({
    data: [fixtureProject()],
    isLoading: false,
  } as unknown as ReturnType<typeof useProjects>);
});

afterEach(() => {
  cleanup();
  server.close();
  serverModules.sse._resetClientsForTest();
  vi.unstubAllGlobals();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  rmSync(scratch, { recursive: true, force: true });
});

describe("Spec Bench lifecycle journey", () => {
  it("SB-TC-057: Operator controls models and lifecycle without the terminal", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor, pty) => tooling.launched(descriptor, pty));
    const bench = await setUpLaunchModeSpecBench(tooling);
    const record = initialRecord();
    renderBenchPage(bench.id);
    await waitFor(
      () =>
        expect(screen.getByRole("tab", { name: /delivery/i })).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      { timeout: 3000 },
    );
    await screen.findByRole("region", { name: "Cost, health and controls" }, { timeout: 3000 });

    // Precondition of step 1, not an observation of it: the record the test
    // wrote has the role on its current tier with no pending change.
    await user.click(screen.getByRole("button", { name: "Cost, health and controls" }));
    expect(roleRow(), "precondition of step 1: the role row is current").toHaveAttribute(
      "data-state",
      "current",
    );
    expect(
      within(controlsView()).getByRole("combobox", { name: `Model of ${ROLE}` }),
      "precondition of step 1: the role runs on its current tier",
    ).toHaveValue(CURRENT_TIER);

    const roleControlSeq = await step(
      "1. Change a role's model and save",
      `the ${ROLE} row shows pending with the ${NEW_TIER} model, and the outbox holds the role change`,
      owners(["lifecycle", "controls"], ["reducer"]),
      async () => {
        await user.selectOptions(
          within(controlsView()).getByRole("combobox", { name: `Model of ${ROLE}` }),
          NEW_TIER,
        );
        await user.click(
          within(controlsView()).getByRole("button", { name: `Save the model of ${ROLE}` }),
        );
        await requestAnswered(bench.id, "PUT", "roles", 202);
        await waitFor(() => expect(roleRow()).toHaveAttribute("data-state", "pending"), {
          timeout: 3000,
        });
        expect(within(roleRow()).getByTestId(`role-pending-${ROLE}`)).toHaveTextContent(
          `pending · ${NEW_TIER}`,
        );

        const snapshot = await readSnapshot(bench.id);
        const control = snapshot.controls.find(
          (c) => c.kind === "role-change" && c.target_id === ROLE,
        );
        expect(control, "the outbox holds no role-change control").toBeDefined();
        expect(control?.body).toMatchObject({ tier: NEW_TIER });
        expect(control?.status).not.toBe("applied");
        expect(snapshot.roles[ROLE]?.tier).toBe(CURRENT_TIER);
        return control?.control_seq ?? 0;
      },
    );

    // Step 2 is a setup step: the tooling reads the role change from the
    // controls endpoint, then reaches the boundary (B done, C running) and
    // applies it there.
    await step(
      "2. Post the boundary and roles.applied events",
      `the ${ROLE} row shows current with the ${NEW_TIER} model and no pending change`,
      owners(["lifecycle", "controls"], ["ingest", "reducer"]),
      async () => {
        const controls = await tooling.readControls();
        const change = controls.find(
          (control) => control.kind === "role-change" && control.control_seq === roleControlSeq,
        );
        expect(change, `no role-change control in ${JSON.stringify(controls)}`).toBeDefined();
        expect(change).toMatchObject({ target_id: ROLE, body: { tier: NEW_TIER } });

        await tooling.post([
          tooling.event("unit.changed", { status: "done" }, BOUNDARY_UNIT),
          tooling.event("unit.changed", { status: "running" }, NEXT_UNIT),
          tooling.event("roles.applied", {
            role: ROLE,
            tier: NEW_TIER,
            control_seq: roleControlSeq,
          }),
        ]);

        await waitFor(() => expect(roleRow()).toHaveAttribute("data-state", "current"), {
          timeout: 3000,
        });
        expect(
          within(controlsView()).getByRole("combobox", { name: `Model of ${ROLE}` }),
        ).toHaveValue(NEW_TIER);
        expect(within(controlsView()).queryByTestId(`role-pending-${ROLE}`)).toBeNull();

        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.roles[ROLE]?.tier).toBe(NEW_TIER);
        const control = snapshot.controls.find((c) => c.control_seq === roleControlSeq);
        expect(control?.status, "the role-change control was not marked applied").toBe("applied");
      },
    );

    await step(
      "3. Click Wind down and confirm",
      "the wind-down control reaches the outbox, the chip does not read wound down until the session's lifecycle.changed arrives, and reads wound down after it",
      owners(["lifecycle", "controls"], ["ingest"]),
      async () => {
        await user.click(lifecycleButton("Wind down"));
        const dialog = await screen.findByRole("alertdialog", { name: "Wind down the delivery?" });
        await user.click(within(dialog).getByRole("button", { name: "Confirm wind down" }));
        await requestAnswered(bench.id, "POST", "wind-down", 202);
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        expect(healthChip()).not.toHaveAttribute("data-health", "wound down");

        const controls = await tooling.readControls();
        const windDown = controls.find((control) => control.kind === "wind-down");
        expect(windDown, `no wind-down control in ${JSON.stringify(controls)}`).toBeDefined();
        await tooling.post([
          tooling.event("lifecycle.changed", {
            state: "wound_down",
            control_seq: windDown?.control_seq,
          }),
        ]);
        tooling.exit();

        await waitFor(
          () => {
            const chip = healthChip();
            expect(chip).toHaveAttribute("data-health", "wound down");
            expect(chip).toHaveTextContent(/^wound down$/);
          },
          { timeout: 3000 },
        );
        expect(lifecycleButton("Wind down")).toBeDisabled();
      },
    );

    // Precondition of step 4, not an observation of it: the tooling's process
    // ended in step 3, so the first session must read ended before Resume.
    const [first] = server.sessions;
    expect(
      serverModules.terminal.getSession(first.id)?.status,
      "precondition of step 4: the wound-down session has ended",
    ).toBe("ended");

    await step(
      "4. Click Resume",
      "the real resume route relaunches the session with the record's resume argument, and the chip returns to active once the session's lifecycle.changed arrives",
      owners(["lifecycle", "controls"], ["launcher", "ingest"]),
      async () => {
        // The bench's terminal list is read again on its interval, so Resume
        // is enabled once it shows the wound-down session ended.
        await waitFor(() => expect(lifecycleButton("Resume")).toBeEnabled(), { timeout: 8000 });
        await user.click(lifecycleButton("Resume"));
        await requestAnswered(bench.id, "POST", "resume", 202);

        expect(server.launches, "Resume did not relaunch the session").toHaveLength(2);
        const relaunch = server.launches[1];
        expect(relaunch.benchId).toBe(bench.id);
        expect(relaunch.specSlug).toBe(SPEC_SLUG);
        expect(relaunch.descriptor.resume, "the resume argument the session launched with").toBe(
          record.delivery_id,
        );
        expect(bench.deliverySessionId).toBe(server.sessions[1]?.id);
        expect(healthChip()).not.toHaveAttribute("data-tone", "active");

        await tooling.post([tooling.event("lifecycle.changed", { state: "running" })]);
        await waitFor(
          () => {
            const chip = healthChip();
            expect(chip).toHaveAttribute("data-tone", "active");
            expect(chip).toHaveAttribute("data-health", "fresh");
          },
          { timeout: 3000 },
        );
      },
    );

    await step(
      "5. Read the terminal session log",
      "each delivery session of the bench has an input count of 0: no operator input was typed into the terminal",
      owners(["controls", "lifecycle"], ["launcher"]),
      () => {
        const sessions = serverModules.terminal.getSessions(PROJECT_ID, bench.id);
        expect(sessions.map((s) => s.id).sort()).toEqual(server.sessions.map((s) => s.id).sort());
        for (const session of sessions) {
          expect(
            serverModules.terminal.getSessionInputCount(session.id),
            `the input count of session ${session.id}`,
          ).toBe(0);
        }
        // The processes behind the sessions were written nothing either.
        for (const pty of server.processes) {
          expect(pty.written).toEqual([]);
        }
      },
    );
  }, 30_000);
});
