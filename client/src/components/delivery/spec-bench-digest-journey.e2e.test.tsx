// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator catches up after time
// away with the digest" (SB-TC-027, SB-FR-012, SB-US-012). It asserts the
// authoritative e2e_flow case SB-TC-027 step for step, so a divergence is
// integration drift and not a re-specification.
//
// What runs for real on the client: the Benches page (BenchDashboard and
// BenchesTab), the bench page (BenchDetail with the real Delivery tab, its
// since-you-left digest, its map and its decision pile), the real React Query
// hooks, among them the digest hook that marks the delivery seen, the real
// `lib/api` request layer, and the real notification stream hook.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode and hands it to
//     the real session launcher (server/services/delivery-session-launcher.ts),
//     which mints the token in the real registry and builds the launch
//     descriptor;
//   - server/routes/delivery.ts answers the snapshot through the real record
//     loader over the bench's workspace and the real event log, derives the
//     digest through the real shared derivation (shared/delivery-digest.ts)
//     above the bench's last viewed seq, and stores the last view the digest's
//     seen mark posts;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log and broadcasts each change
//     through the real server/services/sse.ts.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as an empty folder, the launch executor records each
// launch and hands the descriptor to the fake delivery tooling, the
// notification stream's response is a fake that hands each frame to the
// client's fake EventSource, the desktop bridge records each notification it
// is asked to show, and the state file writes are stubbed. Three reads that no
// step asserts, the spec list, the bench's terminals and the list of every
// project's benches, are answered by the stand-in in the shape of their bodies.
// A request to any other route answers 404 and is listed in the failure output.
// The hooks and components that the journey does not cross are stubbed as in
// the page suites.
//
// A reload is a new mount of the app with a new query cache: nothing the client
// held survives it, and only what the server stored can keep the digest away.
//
// Failure-output contract: each SB-TC-027 step runs inside step(), which on a
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
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_FILE,
  type DeliveryLaunchDescriptor,
} from "@roubo/shared/delivery-bench";
import type { DeliveryDigest } from "@roubo/shared/delivery-digest";
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
import { JOURNEY_TIMEOUT_MS } from "../../test/journey-timeout";
import { returnToMap } from "../../test/delivery-views";

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// This journey's blocked-by set is one slice, and OWNERS names it, so every
// step names that slice. A slice that a step also crosses but that sits outside
// the blocked-by set is labelled apart.
const OWNERS = {
  digest: "'Since-you-left digest' (SB-FR-012, SB-US-012)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  reducer: "'Delivery reducer and selectors shared by server and client'",
  launcher: "'Record loader, token registry and session launcher for launch and attach'",
  ingest: "'Token-gated event ingest, sequence checks and the delivery stream frame'",
  inbox: "'Decision inbox: notifications, answer in place and overturn a default'",
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

// ── Fixture project, record and events (SB-TC-027 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The decision already on the pile when the operator leaves: open, and raised
// after the one the delivery proceeds on by default, so it sits on top until a
// digest link raises the other.
const OPEN_DECISION_ID = "decision-1";
const OPEN_QUESTION = "Which port does the preview server take?";
// The decision the session raises while the operator is away and goes on with
// its default.
const DEFAULTED_DECISION_ID = "decision-2";
const DEFAULTED_QUESTION = "Does the cache keep one file per unit or one per stack?";
const DEFAULT_OPTION = "one file per unit";
const OTHER_OPTION = "one file per stack";
// The unit that finishes while the operator is away.
const DONE_UNIT = "D";
const DONE_UNIT_TITLE = "Own";
// The drift entry the session records while the operator is away.
const DRIFT_SUMMARY = "A requirement was reworded";

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
// C, and gates after B and after C, as the session writes it while B and D run:
// A is done, C waits on B, and one decision is open.
function initialRecord(): DeliveryRecord {
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
    decisions: [
      {
        id: OPEN_DECISION_ID,
        question: OPEN_QUESTION,
        options: ["3000", "4000"],
        default: "3000",
        status: "open",
        unit_id: "C",
        raised_at: "2026-10-16T09:40:00Z",
      },
    ],
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

const RECORD_SEQ = initialRecord().last_event_seq;
const FIRST_SEQ = RECORD_SEQ + 1;

// The events of the time away: a unit done, a decision raised and proceeded on
// its default, and a drift entry.
function timeAwayEvents(): DeliveryEvent[] {
  return [
    event(FIRST_SEQ, "unit.changed", { status: "done" }, DONE_UNIT),
    event(
      FIRST_SEQ + 1,
      "decision.raised",
      {
        decision_id: DEFAULTED_DECISION_ID,
        question: DEFAULTED_QUESTION,
        options: [DEFAULT_OPTION, OTHER_OPTION],
        default: DEFAULT_OPTION,
        unit_id: "B",
        raised_at: "2026-10-16T09:20:00Z",
      },
      "B",
    ),
    event(FIRST_SEQ + 2, "decision.defaulted", { decision_id: DEFAULTED_DECISION_ID }),
    event(FIRST_SEQ + 3, "drift.detected", {
      kind: "spec",
      file: "prd.md",
      detail: "prd.md changed",
      summary: DRIFT_SUMMARY,
    }),
  ];
}

const LAST_SEQ = FIRST_SEQ + 3;

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
];

class RouboServerStandIn {
  unrouted: string[] = [];
  // Each request the client made, as `<METHOD> <path>`.
  requests: string[] = [];
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

  // The number of requests the client made as `<METHOD> <path>`.
  count(method: string, path: string): number {
    return this.requests.filter((made) => made === `${method} ${path}`).length;
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
    this.requests.push(`${method} ${path}`);

    if (REAL_ROUTES.some((route) => route.methods.includes(method) && route.path.test(path))) {
      return this.routed(method, `${path}${url.search}`, init);
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
// writes the record into the spec folder of the bench workspace; then it posts
// its events to the event URL with the token.
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
}

// ── The desktop bridge ──
//
// What the Electron preload hands the client: it records each notification it
// was asked to show.
class DesktopBridge {
  shown: { title: string; body: string; routeTo?: string }[] = [];

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
        showNotification: (req: { title: string; body: string; routeTo?: string }) => {
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
      `SB-TC-027 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${owningSlices}${unrouted}`,
      { cause },
    );
  }
}

function AppHarness() {
  useNotificationStream();
  return null;
}

// One mount of the app: a launch, a reopen or a reload, each with its own query
// cache, so nothing the client held before survives it.
function renderRoubo() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
        <AppHarness />
        <Routes>
          <Route path="/projects/:projectId" element={<BenchDashboard />}>
            <Route index element={<BenchesTab />} />
          </Route>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
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
  const read = await server.fetch(`${BASE}/benches/${id}/delivery`);
  if (read.status !== 200) {
    throw new Error(
      `the snapshot read answered ${read.status}: ${JSON.stringify(await read.json())}`,
    );
  }
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

async function readDigest(benchId: number): Promise<DeliveryDigest> {
  const res = await server.fetch(`${BASE}/benches/${benchId}/delivery/digest`);
  if (res.status !== 200) {
    throw new Error(`the digest read answered ${res.status}: ${JSON.stringify(await res.json())}`);
  }
  return (await res.json()) as DeliveryDigest;
}

function lastViewedSeq(benchId: number): number | undefined {
  return server.benches.find((bench) => bench.id === benchId)?.deliveryLastViewedSeq;
}

// Open the bench from the Benches page, as the operator does: a Spec Bench
// opens on its Delivery tab.
async function openBench(benchId: number, user: ReturnType<typeof userEvent.setup>) {
  const link = await screen.findByRole(
    "link",
    { name: new RegExp(`Bench ${benchId}`) },
    { timeout: 3000 },
  );
  await user.click(link);
  await waitFor(
    () =>
      expect(
        screen.getByRole("tab", { name: /delivery/i }),
        "the bench did not open on its Delivery tab",
      ).toHaveAttribute("aria-selected", "true"),
    { timeout: 3000 },
  );
  await screen.findByTestId("delivery-snapshot", {}, { timeout: 3000 });
}

// Whether `first` comes before `second` in the document.
function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

let serverModules: ServerModules;

beforeAll(async () => {
  serverModules = await loadServerModules();
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-digest-journey-")));
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

describe("Spec Bench digest journey", { timeout: JOURNEY_TIMEOUT_MS }, () => {
  it("SB-TC-027: Operator catches up after time away with the digest", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const bench = await setUpLaunchModeSpecBench(tooling);
    const digestPath = `${BASE}/benches/${bench.id}/delivery/digest`;

    // Step 1 is a setup step: the operator views the bench and leaves it. The
    // view is what the next digest starts from.
    await step(
      "1. View the bench and leave it",
      `the bench opens on its Delivery tab with no digest, its view is stored as the last view at seq ${RECORD_SEQ}, and the operator leaves`,
      owners(["digest"], ["launcher"]),
      async () => {
        const view = renderRoubo();
        await openBench(bench.id, user);
        await waitFor(() => expect(server.count("GET", digestPath)).toBeGreaterThan(0), {
          timeout: 3000,
        });
        await waitFor(
          () =>
            expect(lastViewedSeq(bench.id), "the view was not stored as the last view").toBe(
              RECORD_SEQ,
            ),
          { timeout: 3000 },
        );
        expect(screen.queryByTestId("delivery-digest")).toBeNull();
        view.unmount();
      },
    );

    // Step 2 is a setup step: while the operator is away, the tooling posts a
    // unit done, a decision proceeded on its default and a drift entry.
    await step(
      "2. Post events covering a unit done, a decision proceeded on default and a drift entry",
      `the event endpoint accepts the four events of the time away with the token, up to seq ${LAST_SEQ}`,
      owners(["digest"], ["ingest", "reducer"]),
      async () => {
        const status = await tooling.post(timeAwayEvents());
        expect(status).toBe(202);
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.seq).toBe(LAST_SEQ);
        expect(snapshot.unitsById[DONE_UNIT]?.status).toBe("done");
        expect(snapshot.decisionsById[DEFAULTED_DECISION_ID]?.status).toBe("defaulted");
        expect(snapshot.drift.map((entry) => entry.summary)).toEqual([DRIFT_SUMMARY]);
        // The operator is still away: the last view has not moved.
        expect(lastViewedSeq(bench.id)).toBe(RECORD_SEQ);
      },
    );

    await step(
      "3. Reopen the bench",
      `the digest opens first, above the rest of the delivery, and lists the three changes: unit ${DONE_UNIT} running to done, ${DEFAULTED_DECISION_ID} defaulted, and the drift entry "${DRIFT_SUMMARY}"`,
      owners(["digest"], ["reducer"]),
      async () => {
        renderRoubo();
        await openBench(bench.id, user);
        const digest = await screen.findByTestId("delivery-digest", {}, { timeout: 3000 });
        expect(digest).toHaveAccessibleName("Since you left");

        // First: above the progress, the map and the cost, health and
        // controls view, which holds the decision pile and the drift ledger.
        for (const testId of [
          "delivery-progress",
          "delivery-map",
          "delivery-cost-health-controls",
        ]) {
          expect(
            precedes(digest, screen.getByTestId(testId)),
            `the digest does not come before ${testId}`,
          ).toBe(true);
        }

        // The three changes, one entry each, grouped by kind.
        const entries = within(digest).getAllByRole("listitem");
        expect(entries.map((entry) => entry.textContent)).toEqual([
          `${DONE_UNIT}${DONE_UNIT_TITLE}running to done`,
          `${DEFAULTED_DECISION_ID}${DEFAULTED_QUESTION}defaulted`,
          `spec${DRIFT_SUMMARY}new spec drift`,
        ]);
        expect(
          within(within(digest).getByTestId("delivery-digest-unit")).getByRole("button", {
            name: `Open unit ${DONE_UNIT}`,
          }),
        ).toBeInTheDocument();
        expect(
          within(within(digest).getByTestId("delivery-digest-decision")).getByRole("button", {
            name: `Show decision ${DEFAULTED_DECISION_ID}`,
          }),
        ).toBeInTheDocument();
        expect(
          within(within(digest).getByTestId("delivery-digest-drift")).getByRole("button", {
            name: `Show drift entry ${DRIFT_SUMMARY}`,
          }),
        ).toBeInTheDocument();
        expect(within(digest).queryByTestId("delivery-digest-gate")).toBeNull();
        expect(digest).toHaveAttribute("data-source", "events");
        // A digest on screen holds the last view back until it is marked seen.
        expect(lastViewedSeq(bench.id)).toBe(RECORD_SEQ);
      },
    );

    await step(
      `4. Click the decision entry ${DEFAULTED_DECISION_ID}`,
      `the decision pile opens, in view and focused, with ${DEFAULTED_DECISION_ID} on top, its default "${DEFAULT_OPTION}" applied, and ${OPEN_DECISION_ID} under it`,
      owners(["digest"], ["inbox", "reducer"]),
      async () => {
        const pile = () =>
          within(screen.getByRole("region", { name: "Decisions" })).getByRole("list", {
            name: "Decision pile",
          });
        // Before the click, the newer open decision is on top.
        expect(screen.getByTestId(`decision-card-${OPEN_DECISION_ID}`)).toHaveAttribute(
          "data-position",
          "top",
        );
        expect(screen.getByTestId(`decision-card-${DEFAULTED_DECISION_ID}`)).toHaveAttribute(
          "data-position",
          "lower",
        );

        const digest = screen.getByTestId("delivery-digest");
        await user.click(
          within(digest).getByRole("button", { name: `Show decision ${DEFAULTED_DECISION_ID}` }),
        );
        await waitFor(
          () => {
            const card = within(pile()).getByRole("article", {
              name: `Decision ${DEFAULTED_DECISION_ID}`,
            });
            expect(card).toHaveAttribute("data-position", "top");
            expect(within(pile()).getAllByRole("listitem")[0]).toContainElement(card);
          },
          { timeout: 3000 },
        );
        expect(
          screen.getByTestId("delivery-decision-pile-target"),
          "the decision pile was not brought into focus",
        ).toHaveFocus();
        const card = within(pile()).getByRole("article", {
          name: `Decision ${DEFAULTED_DECISION_ID}`,
        });
        expect(within(card).getByTestId("decision-badge")).toHaveTextContent(/^Default applied$/);
        expect(card).toHaveTextContent(DEFAULTED_QUESTION);
        expect(within(card).getByTestId("decision-applied")).toHaveTextContent(
          `Applied: ${DEFAULT_OPTION} (the default)`,
        );
        expect(screen.getByTestId(`decision-card-${OPEN_DECISION_ID}`)).toHaveAttribute(
          "data-position",
          "lower",
        );
        // Following a link is not marking the digest seen: it stays.
        expect(screen.getByTestId("delivery-digest")).toBeInTheDocument();
      },
    );

    await step(
      "5. Mark the digest seen",
      `the digest closes, the last view is stored at seq ${LAST_SEQ}, and after a reload the bench opens with no digest`,
      owners(["digest"]),
      async () => {
        // The digest is on the map, which the decisions view's breadcrumb
        // returns to (#1620).
        await returnToMap(user);
        const digest = screen.getByTestId("delivery-digest");
        await user.click(within(digest).getByRole("button", { name: "Dismiss" }));
        await waitFor(() => expect(screen.queryByTestId("delivery-digest")).toBeNull(), {
          timeout: 3000,
        });
        expect(lastViewedSeq(bench.id), "the seen mark was not stored").toBe(LAST_SEQ);

        // Reload: a new mount of the app, with nothing the client held.
        cleanup();
        const before = server.count("GET", digestPath);
        const { queryClient } = renderRoubo();
        await openBench(bench.id, user);
        await waitFor(
          () => {
            expect(server.count("GET", digestPath), "the reload read no digest").toBeGreaterThan(
              before,
            );
            const read = queryClient.getQueryState(["delivery-digest", PROJECT_ID, bench.id]);
            expect(read?.status, "the reload's digest read did not settle").toBe("success");
            expect(read?.fetchStatus).toBe("idle");
          },
          { timeout: 3000 },
        );
        expect(
          screen.queryByTestId("delivery-digest"),
          "the digest came back on reload",
        ).toBeNull();
        const served = await readDigest(bench.id);
        expect(served.entries).toEqual([]);
        expect(served.lastViewedSeq).toBe(LAST_SEQ);
      },
    );
  });
});
