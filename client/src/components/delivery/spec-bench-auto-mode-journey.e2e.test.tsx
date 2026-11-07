// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator sets up an auto delivery
// and switches the mode from the bench" (SB-TC-104, SB-FR-031, SB-FR-032,
// SB-FR-033, SB-US-013). It asserts the authoritative e2e_flow case SB-TC-104
// step for step, so a divergence is integration drift and not a
// re-specification.
//
// What runs for real on the client: the Benches page (BenchDashboard and
// BenchesTab with the real Set up Spec Bench dialog and its mode switch), the
// bench page (BenchDetail with the real Delivery tab, its mode label, its
// decision pile with the agent decisions to review, and the mode switch of its
// controls), the real React Query hooks, the real `lib/api` request layer and
// the real notification stream hook, which reads the snapshot again on each
// delivery frame and shows each action-needed notification through the desktop
// bridge.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode with the
//     decision mode the dialog chose and hands it to the real session launcher
//     (server/services/delivery-session-launcher.ts), which mints the token in
//     the real registry and builds the launch descriptor with that mode;
//   - server/routes/delivery.ts answers the snapshot through the real record
//     loader over the bench's workspace and the real event log, and takes the
//     operator's mode switch into the real control outbox;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log, raises the notifications that
//     an event calls for through the real notification service, reads the mode
//     switch back into the outbox, and broadcasts each change through the real
//     server/services/sse.ts; it also serves the tooling's controls read.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as an empty folder, the launch executor (the port
// the launcher hands the descriptor to) records each launch and hands the
// descriptor to the fake delivery tooling, the notification stream's response
// is a fake that hands each frame to the client's fake EventSource, the desktop
// bridge records each notification it is asked to show, and the state file
// writes are stubbed. Four reads that no step asserts, the spec list, the
// spec's summary, the bench's terminals and the list of every project's
// benches, are answered by the stand-in in the shape of their bodies. A request
// to any other route answers 404 and is listed in the failure output. The
// hooks and components that the journey does not cross (projects, integration,
// settings, plugins, terminals, logs, issue controls) are stubbed as in the
// page suites.
//
// Started, the fake delivery tooling writes the record into the bench
// workspace in the decision mode its launch descriptor names, with A done, B and
// D running and C waiting on B. In the journey it posts two decisions it made on
// its own, then reads the operator's mode switch from the controls endpoint and
// posts the events that finish B and apply the switch, each with the token.
//
// Failure-output contract: each SB-TC-104 step runs inside step(), which on a
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
import type { Bench, RegisteredProject, SpecBenchDecisionMode } from "@roubo/shared";
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
  type SpecBenchSpecSummary,
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
vi.mock("../../hooks/useRegisterProjectModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useRegisterProjectModal")>();
  return { ...actual, useRegisterProjectModal: () => ({ open: vi.fn() }) };
});
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
vi.mock("../IssueQueuePanel", () => ({ default: () => <div data-testid="issue-queue-panel" /> }));
vi.mock("../CreateBenchModal", () => ({ default: () => null }));
vi.mock("../IssuePickerModal", () => ({ default: () => null }));
vi.mock("../BranchConflictDialog", () => ({ default: () => null }));
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
import BenchDashboard from "../BenchDashboard";
import BenchesTab from "../BenchesTab";
import BenchDetail from "../BenchDetail";

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// OWNERS is exactly this journey's blocked-by set, named by what each slice
// delivers and the spec ids it implements, and every step names at least one
// of them. A slice that a step also crosses but that sits outside the
// blocked-by set is labelled apart.
const OWNERS = {
  setUpMode: "'Choose attended or auto decision mode at set-up' (SB-FR-031)",
  modeSwitch: "'Mode switch control with a pending badge' (SB-FR-032, SB-US-013)",
  reviewCards: "'Agent decisions as review cards on the decision pile' (SB-FR-033)",
  surfaces:
    "'Keyboard and screen-reader paths for the Spec Bench surfaces' (SB-NFR-004, SB-US-013)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  observationContract:
    "'Delivery observation contract in shared with generated schema and drift coverage'",
  reducer: "'Delivery reducer and selectors shared by server and client'",
  controls: "'Control service, outbox and the token-gated controls endpoint'",
  launch: "delivery session launch, delivery token and event ingest (SB-FR-002, SB-FR-007)",
  inbox: "'Decision inbox: notifications, answer in place and overturn a default'",
  deliveryTab: "Delivery tab with its map and health rail (SB-FR-009)",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => OUTSIDE_BLOCKED_BY[key]).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project, record and decisions (SB-TC-104 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The two decisions the session makes on its own in auto mode, in the order it
// makes them: each joins the pile as an agent card to review.
const OPTIONS = ["one file per unit", "one file per stack", "one file per repo"];
const DECIDED = [
  {
    id: "decision-1",
    question: "Does the cache keep one file per unit or one per stack?",
    chosen: OPTIONS[1],
    decidedAt: "2026-01-01T10:00:00.000Z",
  },
  {
    id: "decision-2",
    question: "Does the log rotate per unit or per stack?",
    chosen: OPTIONS[0],
    decidedAt: "2026-01-01T10:05:00.000Z",
  },
] as const;
const DECIDING_UNIT = "B";

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
// C, and gates after B and after C, as the session writes it while B and D run
// in the decision mode it was launched in: A is done and C waits on B.
function initialRecord(mode: SpecBenchDecisionMode = "attended"): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  const status: Record<string, string> = { A: "done", B: "running", C: "pending", D: "running" };
  return {
    ...record,
    units: record.units.map((unit) => ({ ...unit, status: status[unit.id] ?? unit.status })),
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({ ...gate, status: "pending" })),
    },
    mode: { value: mode, pending: null },
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

// The spec the dialog lists, as GET /testbench/specs discovers it in the
// checkout, and its summary, as GET /specbench/specs/:slug/summary counts the
// units and gates its work-units.json plans: those of the record fixture.
function discoveredFixtureSpec() {
  return {
    slug: SPEC_SLUG,
    path: join(checkout, SPEC_FOLDER, "test-cases.json"),
    caseCount: 1,
    verification: {
      classification: "needs-attention",
      statusCounts: { not_started: 1, in_progress: 0, passed: 0, failed: 0, blocked: 0 },
      resultsPresent: false,
      resultsValid: true,
      planHashMatch: true,
      recoveryReason: null,
      aggregationError: false,
    },
    lifecycle: { archived: false, reason: null, supersededBy: null, recordError: null },
  };
}

function fixtureSpecSummary(): SpecBenchSpecSummary {
  const record = initialRecord();
  return { slug: SPEC_SLUG, units: record.units.length, gates: record.stack.gates.length };
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
  // Each create request the benches route was sent, as the client sent it.
  createRequests: unknown[] = [];
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
      if (method === "POST" && path === `${BASE}/benches` && typeof init?.body === "string") {
        this.createRequests.push(JSON.parse(init.body) as unknown);
      }
      return this.routed(method, `${path}${url.search}`, init);
    }
    if (method === "GET" && path === "/api/benches") {
      return respond(200, copy(routeServices.benches));
    }
    if (method === "GET" && path === `${BASE}/testbench/specs`) {
      return respond(200, { specs: [discoveredFixtureSpec()], invalid: [] });
    }
    if (method === "GET" && path === `${BASE}/specbench/specs/${SPEC_SLUG}/summary`) {
      return respond(200, fixtureSpecSummary());
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
  // bench with the bind mode and the decision mode the route hands it, and
  // provisions its workspace as an empty folder.
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
      ...(options.delivery?.decisionMode !== undefined && {
        deliveryDecisionMode: options.delivery.decisionMode as Bench["deliveryDecisionMode"],
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
// writes the record into the spec folder of the bench workspace, in the
// decision mode the descriptor names; then it posts its events to the event URL
// and reads the controls from the controls URL, each with the token.
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

  start(bench: Bench): DeliveryRecord {
    const descriptor = this.held();
    const record = initialRecord(descriptor.decisionMode ?? "attended");
    const validated = validateDeliveryRecord(record);
    if (!validated.ok) {
      throw new Error(`the record fixture is not conformant: ${validated.errors.join("; ")}`);
    }
    const folder = join(bench.workspacePath, SPEC_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return record;
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

// ── The desktop bridge ──
//
// What the Electron preload hands the client: it records each notification the
// client is asked to show.
interface ShownNotification {
  title: string;
  body: string;
  routeTo?: string;
}

class DesktopBridge {
  shown: ShownNotification[] = [];

  install(): void {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        onDeepLink: () => () => undefined,
        onNavigate: () => () => undefined,
        getAppVersion: () => Promise.resolve("0.0.0"),
        platform: "darwin",
        setTitleBarOverlayTheme: () => undefined,
        setBadgeCount: () => undefined,
        writeClipboard: () => Promise.resolve(true),
        showNotification: (req: ShownNotification) => {
          this.shown.push(req);
        },
      },
    });
  }

  uninstall(): void {
    Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
  }
}

// ── Failure-output wrapper ──

let server: RouboServerStandIn;
let bridge: DesktopBridge;

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
      `SB-TC-104 step diverged: "${label}"\n` +
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

function renderRoubo() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
        <StreamHarness />
        <Routes>
          <Route path="/projects/:projectId" element={<BenchDashboard />}>
            <Route index element={<BenchesTab />} />
          </Route>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The Set up Spec Bench control: on the Benches page itself, or in the menu
// of an empty bench slot.
async function findSetUpSpecBench(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const name = /set up spec bench/i;
  const onPage = screen.queryByRole("button", { name }) ?? screen.queryByRole("menuitem", { name });
  if (onPage) return onPage;
  const slots = await screen.findAllByRole("button", { name: /available/i });
  await user.click(slots[0]);
  const inMenu = screen.queryByRole("button", { name }) ?? screen.queryByRole("menuitem", { name });
  if (inMenu) return inMenu;
  throw new Error(
    "the Benches page offers no Set up Spec Bench control, neither on the page nor in an empty slot's menu",
  );
}

function setupDialog(): HTMLElement {
  const dialog = screen.queryByRole("dialog", { name: /spec bench/i });
  if (!dialog) throw new Error("no dialog named Spec Bench is open");
  return dialog;
}

// A choice in the setup dialog, whichever control offers it.
function choice(dialog: HTMLElement, name: RegExp): HTMLElement {
  const scope = within(dialog);
  const found =
    scope.queryByRole("radio", { name }) ??
    scope.queryByRole("option", { name }) ??
    scope.queryByRole("button", { name }) ??
    scope.queryByRole("menuitemradio", { name });
  if (found) return found;
  throw new Error(`the setup dialog offers no control named ${String(name)}`);
}

// The segment of a mode switch, under its Decisions label.
function modeSegment(scope: HTMLElement, name: "Attended" | "Auto"): HTMLElement {
  const group = within(scope).getByRole("radiogroup", { name: "Decisions" });
  return within(group).getByRole("radio", { name });
}

// What the delivery shell names as the mode in effect.
function shellMode(): string {
  return screen.getByTestId("delivery-mode-label").textContent ?? "";
}

function modeControl(): HTMLElement {
  return screen.getByTestId("delivery-mode-control");
}

// The agent cards on the decision pile, oldest first, by decision id.
function agentCards(): string[] {
  const pile = screen.queryByTestId("delivery-review-pile");
  if (pile === null) return [];
  return within(pile)
    .queryAllByTestId(/^review-card-/)
    .map((card) => card.dataset.testid?.slice("review-card-".length) ?? "");
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

let serverModules: ServerModules;

beforeAll(async () => {
  serverModules = await loadServerModules();
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-auto-mode-journey-")));
  checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, SPEC_FOLDER), { recursive: true });
  mkdirSync(join(scratch, "workspaces"));
  server = new RouboServerStandIn(serverModules);
  bridge = new DesktopBridge();
  bridge.install();
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
  bridge.uninstall();
  vi.unstubAllGlobals();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  rmSync(scratch, { recursive: true, force: true });
});

describe("Spec Bench auto mode journey", () => {
  it("SB-TC-104: Operator sets up an auto delivery and switches the mode from the bench", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    renderRoubo();

    // Step 1 is a setup step: the dialog opens and Auto is selected.
    await step(
      "1. Open the Set up Spec Bench dialog and select Auto",
      "the Benches page opens the Set up Spec Bench dialog, and its Decisions switch selects Auto",
      owners(["setUpMode", "surfaces"]),
      async () => {
        await user.click(await findSetUpSpecBench(user));
        await waitFor(() => setupDialog());
        await user.click(modeSegment(setupDialog(), "Auto"));
        expect(modeSegment(setupDialog(), "Auto")).toHaveAttribute("aria-checked", "true");
      },
    );

    const bench = await step(
      "2. Set up the bench in launch mode",
      "the bench is set up in launch mode with the session launched in auto mode, and the delivery shell names auto mode",
      owners(["setUpMode"], ["launch", "deliveryTab"]),
      async () => {
        await user.click(await within(setupDialog()).findByText(SPEC_SLUG));
        await user.click(choice(setupDialog(), /^launch/i));
        await waitFor(
          () =>
            expect(within(setupDialog()).getByTestId("specbench-setup-summary")).toHaveTextContent(
              /\b4 units\b/,
            ),
          { timeout: 3000 },
        );
        await user.click(choice(setupDialog(), /confirm|set up/i));
        await waitFor(() => expect(server.benches).toHaveLength(1), { timeout: 3000 });
        expect(server.createRequests.at(-1)).toMatchObject({
          variant: "specbench",
          delivery: { mode: "launch", decisionMode: "auto" },
        });
        const created = server.benches[0];
        await serverModules.launcher.whenDeliveryBound(PROJECT_ID, created.id);
        expect(server.launches, "the launch-mode bench launched no session").toHaveLength(1);
        expect(tooling.descriptor?.decisionMode, "the session was not launched in auto").toBe(
          "auto",
        );
        tooling.start(created);

        await user.click(
          await screen.findByRole(
            "link",
            { name: new RegExp(`Bench ${created.id}`) },
            { timeout: 3000 },
          ),
        );
        await waitFor(
          () => expect(shellMode(), "the delivery shell does not name auto mode").toBe("auto mode"),
          { timeout: 3000 },
        );
        return created;
      },
    );

    await step(
      "3. Post two decision.decided events as the fake tooling",
      `two agent cards, ${DECIDED.map((d) => d.id).join(" and ")}, collect on the pile, and no notification appears`,
      owners(["reviewCards"], ["observationContract", "reducer", "launch", "inbox"]),
      async () => {
        const status = await tooling.post(
          DECIDED.map((decided, index) =>
            event(
              FIRST_SEQ + index,
              "decision.decided",
              {
                decision_id: decided.id,
                question: decided.question,
                options: OPTIONS,
                default: OPTIONS[0],
                chosen: decided.chosen,
                rationale: `The agent chose ${decided.chosen}.`,
                decided_at: decided.decidedAt,
              },
              DECIDING_UNIT,
            ),
          ),
        );
        expect(status).toBe(202);
        await waitFor(
          () =>
            expect(agentCards(), "the agent cards on the pile").toEqual(DECIDED.map((d) => d.id)),
          { timeout: 3000 },
        );
        expect(bridge.shown, "a notification was shown").toEqual([]);
        const held = server.benches.find((b) => b.id === bench.id)?.notifications ?? [];
        expect(
          held.map((n) => [n.type, n.dedupeKey]),
          "the bench holds a notification",
        ).toEqual([]);
        expect(shellMode()).toBe("auto mode");
      },
    );

    await step(
      "4. Select Attended on the mode switch in the controls",
      "the switch shows a pending badge, with Auto still the mode in effect",
      owners(["modeSwitch", "surfaces"], ["controls"]),
      async () => {
        expect(modeSegment(modeControl(), "Auto")).toHaveAttribute("aria-checked", "true");
        expect(within(modeControl()).queryByTestId("decision-mode-pending")).toBeNull();
        await user.click(modeSegment(modeControl(), "Attended"));
        await waitFor(
          () =>
            expect(
              within(modeControl()).getByTestId("decision-mode-pending"),
              "the switch shows no pending badge",
            ).toBeInTheDocument(),
          { timeout: 3000 },
        );
        expect(modeSegment(modeControl(), "Auto")).toHaveAttribute("aria-checked", "true");
        expect(shellMode()).toBe("auto mode");
      },
    );

    await step(
      "5. Post unit.done and a mode.changed event as the fake tooling",
      "the tooling reads the mode switch from the controls endpoint, and the event endpoint accepts the unit.done and the mode.changed that applies it",
      owners(["modeSwitch"], ["controls", "observationContract", "launch"]),
      async () => {
        const controls = await tooling.readControls();
        const modeSwitch = controls.find((control) => control.kind === "mode_switch");
        expect(modeSwitch, `no mode_switch control in ${JSON.stringify(controls)}`).toBeDefined();
        expect(modeSwitch?.body.mode).toBe("attended");
        const status = await tooling.post([
          event(FIRST_SEQ + DECIDED.length, "unit.changed", { status: "done" }, DECIDING_UNIT),
          event(FIRST_SEQ + DECIDED.length + 1, "mode.changed", {
            value: "attended",
            control_seq: modeSwitch?.control_seq,
          }),
        ]);
        expect(status).toBe(202);
      },
    );

    await step(
      "5. Post unit.done and a mode.changed event as the fake tooling: the shell",
      "the shell names attended mode, and the switch shows Attended with no pending badge",
      owners(["modeSwitch"], ["reducer", "deliveryTab"]),
      async () => {
        await waitFor(
          () =>
            expect(shellMode(), "the delivery shell does not name attended mode").toBe(
              "attended mode",
            ),
          { timeout: 3000 },
        );
        await waitFor(
          () => expect(within(modeControl()).queryByTestId("decision-mode-pending")).toBeNull(),
          { timeout: 3000 },
        );
        expect(modeSegment(modeControl(), "Attended")).toHaveAttribute("aria-checked", "true");
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.mode.value).toBe("attended");
        expect(snapshot.unitsById[DECIDING_UNIT]?.status).toBe("done");
      },
    );

    await step(
      "5. Post unit.done and a mode.changed event as the fake tooling: the pile",
      `the two agent cards, ${DECIDED.map((d) => d.id).join(" and ")}, are still on the pile`,
      owners(["reviewCards", "modeSwitch"], ["reducer"]),
      () => {
        expect(agentCards(), "the agent cards on the pile").toEqual(DECIDED.map((d) => d.id));
      },
    );
  });
});
