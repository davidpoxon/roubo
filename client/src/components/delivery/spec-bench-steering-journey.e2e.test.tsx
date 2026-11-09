// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator steers the delivery and
// sees the read-back land" (SB-TC-045, SB-FR-016, SB-FR-017, SB-US-006). It
// asserts the authoritative e2e_flow case SB-TC-045 step for step, so a
// divergence is integration drift and not a re-specification.
//
// What runs for real on the client: the bench page (BenchDetail with the real
// Delivery tab, its boundary panel and its steering composer), the real React
// Query hooks, the real `lib/api` request layer and the real notification
// stream hook, which reads the snapshot again on each delivery frame.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode and hands it to
//     the real session launcher (server/services/delivery-session-launcher.ts),
//     which mints the token in the real registry and builds the launch
//     descriptor;
//   - server/routes/delivery.ts answers the snapshot through the real record
//     loader over the bench's workspace and the real event log, and takes the
//     operator's steering note into the real control outbox;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log, reads the steering note back
//     into the outbox, and broadcasts each change through the real
//     server/services/sse.ts; it also serves the tooling's controls read.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as an empty folder, the launch executor (the port
// the launcher hands the descriptor to) records each launch and hands the
// descriptor to the fake delivery tooling, the notification stream's response
// is a fake that hands each frame to the client's fake EventSource, and the
// state file writes are stubbed. Three reads that no step asserts, the spec
// list, the bench's terminals and the list of every project's benches, are
// answered by the stand-in in the shape of their bodies. A request to any other
// route answers 404 and is listed in the failure output. The hooks and
// components that the journey does not cross (projects, integration, settings,
// plugins, terminals, logs, issue controls) are stubbed as in the page suites.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts. Started, the fake delivery tooling writes the record into the
// bench workspace with A and D done, B running and C waiting on B, so the next
// boundary is B finishing. In the journey it reads the operator's note from the
// controls endpoint, then posts the events that finish B, start C and read the
// note back, each with the token.
//
// Failure-output contract: each SB-TC-045 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, RegisteredProject } from "@roubo/shared";
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
// project. The terminal service has no live session, and the state file writes
// are stubbed, as in the route suites.

interface CreateBenchOptions {
  variant?: string;
  focusedSpecPath?: string;
  delivery?: { mode: string; decisionMode?: string };
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
vi.mock("../../../../server/services/terminal.js", () => ({
  getSession: vi.fn(),
  getSessionScrollback: vi.fn(),
}));
vi.mock("../../../../server/services/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, updateBench: vi.fn(), loadSettings: vi.fn(() => ({})) };
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
import { JOURNEY_TIMEOUT_MS } from "../../test/journey-timeout";

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// OWNERS is exactly this journey's blocked-by set, named by its exact slice
// title. The set holds one slice, and every step names it. A slice that a step
// also crosses but that sits outside the blocked-by set is labelled apart,
// under its exact title.
const OWNERS = {
  steering: "'Steering composer, boundary panel and read-back' (SB-FR-016, SB-FR-017, SB-US-006)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  controls: "'Control service, outbox and the token-gated controls endpoint'",
  observationContract:
    "'Delivery observation contract in shared with generated schema and drift coverage'",
  reducer: "'Delivery reducer and selectors shared by server and client'",
  launcher: "'Record loader, token registry and session launcher for launch and attach'",
  ingest: "'Token-gated event ingest, sequence checks and the delivery stream frame'",
  map: "'Delivery map with graph and list views'",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => OUTSIDE_BLOCKED_BY[key]).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project, record and note (SB-TC-045 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The note the operator sends, the boundary it lands at, and the sentence the
// session reads it back with.
const NOTE = "Prefer React Aria Dialog over a custom modal.";
const READ_BACK = "Will use Dialog from React Aria for every new modal from C on.";
const BOUNDARY_UNIT = "B";
const NEXT_BOUNDARY_UNIT = "C";

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
// and D are done and C waits on B, so the next boundary is B finishing.
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
    health: { status: "ok", checked_at: now },
    updated_at: now,
  };
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
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

const FIRST_SEQ = initialRecord().last_event_seq + 1;

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

class RouboServerStandIn {
  unrouted: string[] = [];
  // Each request the real routers answered: its method, path and status.
  answered: { method: string; path: string; status: number }[] = [];
  // Each launch the real launcher handed its executor.
  launches: LaunchRequest[] = [];
  private readonly app = express();
  private readonly modules: ServerModules;
  private streams: FakeEventSource[] = [];
  private onLaunch: ((descriptor: DeliveryLaunchDescriptor) => void) | undefined;

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
    modules.launcher.setDeliveryLaunchExecutor({
      launch: async (launch) => {
        this.launches.push(launch);
        this.onLaunch?.(launch.descriptor);
        return { sessionId: `delivery-session-${launch.benchId}-${this.launches.length}` };
      },
    });
  }

  get benches(): Bench[] {
    return routeServices.benches;
  }

  setLaunchExecutor(onLaunch: (descriptor: DeliveryLaunchDescriptor) => void): void {
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
    if (method === "GET" && new RegExp(`^${BASE}/benches/\\d+/terminals$`).test(path)) {
      return respond(200, []);
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
// It holds the launch descriptor the launch executor hands it. Started, it
// writes the record into the spec folder of the bench workspace; then it reads
// the controls from the controls URL and posts its events to the event URL,
// each with the token.
interface ControlRead {
  control_seq: number;
  kind: string;
  target_id?: string;
  body: Record<string, unknown>;
  status: string;
}

class FakeDeliveryTooling {
  descriptor: DeliveryLaunchDescriptor | undefined;

  launched(descriptor: DeliveryLaunchDescriptor): void {
    this.descriptor = descriptor;
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
      `SB-TC-045 step diverged: "${label}"\n` +
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

function boundaryPanel(): HTMLElement {
  return screen.getByRole("region", { name: "Next boundary" });
}

let serverModules: ServerModules;

beforeAll(async () => {
  serverModules = await loadServerModules();
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-steering-journey-")));
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

describe("Spec Bench steering journey", { timeout: JOURNEY_TIMEOUT_MS }, () => {
  it("SB-TC-045: Operator steers the delivery and sees the read-back land", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const bench = await setUpLaunchModeSpecBench(tooling);
    renderBenchPage(bench.id);
    await waitFor(
      () =>
        expect(screen.getByRole("tab", { name: /delivery/i })).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      { timeout: 3000 },
    );
    await screen.findByRole("region", { name: "Next boundary" }, { timeout: 3000 });

    const controlSeq = await step(
      "1. Type a steering note and send it",
      `the note "${NOTE}" shows queued under the next boundary, "${BOUNDARY_UNIT} finishes", and lands at that boundary`,
      owners(["steering"], ["controls", "reducer", "map"]),
      async () => {
        expect(within(boundaryPanel()).getByTestId("boundary-name")).toHaveTextContent(
          `${BOUNDARY_UNIT} finishes`,
        );
        expect(within(boundaryPanel()).getByTestId("boundary-queue-empty")).toBeInTheDocument();

        await user.type(screen.getByRole("textbox", { name: "Steering note" }), NOTE);
        await user.click(screen.getByRole("button", { name: "Send note" }));
        await waitFor(
          () =>
            expect(server.answered).toContainEqual({
              method: "POST",
              path: `${BASE}/benches/${bench.id}/delivery/steering`,
              status: 202,
            }),
          { timeout: 3000 },
        );

        const queue = await within(boundaryPanel()).findByRole(
          "list",
          { name: "Queued for the next boundary" },
          { timeout: 3000 },
        );
        const items = within(queue).getAllByRole("listitem");
        expect(items).toHaveLength(1);
        const [queued] = items;
        expect(queued).toHaveAttribute("data-state", "queued");
        expect(within(queued).getByTestId("steering-note-state")).toHaveTextContent(/^queued$/);
        expect(queued).toHaveTextContent(NOTE);
        expect(queued).toHaveTextContent(`applies at the next boundary · ${BOUNDARY_UNIT}`);
        expect(within(queued).queryByTestId("steering-note-read-back")).toBeNull();
        expect(within(boundaryPanel()).getByTestId("boundary-name")).toHaveTextContent(
          `${BOUNDARY_UNIT} finishes`,
        );

        // The outbox holds the note for that boundary, not yet read back.
        const snapshot = await readSnapshot(bench.id);
        const control = snapshot.controls.find((c) => c.kind === "steering-note");
        expect(control, "the outbox holds no steering-note control").toBeDefined();
        expect(control?.body).toMatchObject({ note: NOTE, applies_at: BOUNDARY_UNIT });
        expect(control?.status).not.toBe("applied");
        expect(queued).toHaveAttribute("data-testid", `steering-note-${control?.control_seq}`);
        return control?.control_seq ?? 0;
      },
    );

    // Step 2 is a setup step: the tooling reads the note from the controls
    // endpoint, then finishes B, starts C and reads the note back.
    await step(
      "2. Post events that finish the current unit and reach the boundary with the read-back",
      `the tooling reads steering-note ${controlSeq} from the controls endpoint, and the event endpoint accepts ${BOUNDARY_UNIT} done, ${NEXT_BOUNDARY_UNIT} running and the steering.added that reads it back, with the token`,
      owners(["steering"], ["controls", "observationContract", "launcher", "ingest"]),
      async () => {
        const controls = await tooling.readControls();
        const note = controls.find(
          (control) => control.kind === "steering-note" && control.control_seq === controlSeq,
        );
        expect(note, `no steering-note control in ${JSON.stringify(controls)}`).toBeDefined();
        expect(note?.body).toMatchObject({ note: NOTE, unit_ids: [], applies_at: BOUNDARY_UNIT });

        const status = await tooling.post([
          event(FIRST_SEQ, "unit.changed", { status: "done" }, BOUNDARY_UNIT),
          event(FIRST_SEQ + 1, "unit.changed", { status: "running" }, NEXT_BOUNDARY_UNIT),
          event(FIRST_SEQ + 2, "steering.added", {
            steering_id: `steering-read-back-${controlSeq}`,
            note: READ_BACK,
            unit_ids: [],
            control_seq: controlSeq,
          }),
        ]);
        expect(status).toBe(202);
      },
    );

    await step(
      "3. Read the note",
      `the note shows applied with the read-back "${READ_BACK}", and the boundary panel has moved to "${NEXT_BOUNDARY_UNIT} finishes" with nothing queued`,
      owners(["steering"], ["controls", "reducer", "ingest", "map"]),
      async () => {
        await waitFor(
          () => {
            const settled = screen.getByRole("list", { name: "Steering notes read back" });
            expect(within(settled).getByTestId(`steering-note-${controlSeq}`)).toHaveAttribute(
              "data-state",
              "applied",
            );
          },
          { timeout: 3000 },
        );
        const applied = screen.getByTestId(`steering-note-${controlSeq}`);
        expect(within(applied).getByTestId("steering-note-state")).toHaveTextContent(/^applied$/);
        expect(applied).toHaveTextContent(NOTE);
        expect(within(applied).getByTestId("steering-note-read-back")).toHaveTextContent(
          `Read-back: ${READ_BACK}`,
        );

        const panel = boundaryPanel();
        expect(within(panel).getByTestId("boundary-name")).toHaveTextContent(
          `${NEXT_BOUNDARY_UNIT} finishes`,
        );
        expect(within(panel).getByTestId("boundary-queue-empty")).toBeInTheDocument();
        expect(
          within(panel).queryByRole("list", { name: "Queued for the next boundary" }),
        ).toBeNull();
        expect(within(panel).queryByTestId(`steering-note-${controlSeq}`)).toBeNull();

        const snapshot = await readSnapshot(bench.id);
        const control = snapshot.controls.find((c) => c.control_seq === controlSeq);
        expect(control?.status, "the steering-note control was not marked applied").toBe("applied");
        expect(snapshot.unitsById[BOUNDARY_UNIT]?.status).toBe("done");
        expect(snapshot.unitsById[NEXT_BOUNDARY_UNIT]?.status).toBe("running");
      },
    );
  });
});
