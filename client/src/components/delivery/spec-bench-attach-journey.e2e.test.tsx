// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator attaches a Spec Bench to
// a delivery started elsewhere" (SB-TC-007, SB-FR-003, SB-FR-022, SB-US-002).
// It asserts the authoritative e2e_flow case SB-TC-007 step for step, so a
// divergence is integration drift and not a re-specification.
//
// What runs for real on the client: the Benches page (BenchDashboard and
// BenchesTab with the real BenchCard and the real Set up Spec Bench dialog),
// the bench page (BenchDetail with the real Delivery tab, its health rail, map
// and lifecycle controls), the real React Query hooks, the real `lib/api`
// request layer and the real notification stream hook.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/specbench-specs.ts answers the dialog's summary, from the
//     record committed in a real git checkout at the commit that the real
//     resolveWorktreeStartCommit names for the project's worktree source
//     settings;
//   - server/routes/benches.ts creates the bench and hands it to the real
//     session launcher (server/services/delivery-session-launcher.ts), whose
//     create-time binding decides whether the bench launches anything;
//   - server/routes/delivery.ts answers the snapshot, the event reads and the
//     resume, through the real record loader over the bench's workspace, the
//     real event log and the real lifecycle check, and the resume launches
//     through the real launcher, which mints the token in the real registry and
//     builds the launch descriptor;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log, and broadcasts a delivery frame
//     through the real server/services/sse.ts.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as a real git worktree of the checkout at the start
// commit (so the workspace holds what git checks out, never a working-tree
// copy), the launch executor (the port the launcher hands the descriptor to)
// records each launch and hands the descriptor to the fake delivery tooling,
// the notification stream's response is a fake that hands each frame to the
// client's fake EventSource, and the state file writes are stubbed. Three
// reads that no step asserts, the spec list, the bench's terminals and the
// list of every project's benches, are answered by the stand-in in the shape
// of their bodies. A request to any other route
// answers 404 and is listed in the failure output. The hooks and components
// that the journey does not cross (projects, integration, settings, plugins,
// terminals, logs, issue controls) are stubbed as in the page suites.
//
// The delivery was started elsewhere: its record is copied into the spec folder
// of the project checkout and committed there, two units in, and no session
// runs it. An attached bench launches nothing; its worktree checks the
// committed record out, so the bench reads it from its workspace. Resume
// launches the session with the record's resume argument, and the fake delivery
// tooling, handed that launch descriptor, posts its first event with the token.
//
// Failure-output contract: each SB-TC-007 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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
// OWNERS is exactly this journey's blocked-by set, named by slice title, and
// every step names at least one of them. A slice that a step also crosses but
// that sits outside the blocked-by set is labelled apart.
const OWNERS = {
  launcher: "record loader, token registry and session launcher for launch and attach (SB-FR-003)",
  controls: "control service, outbox and token-gated controls endpoint",
  lifecycle: "role matrix and lifecycle controls (SB-FR-022)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  setup: "Spec Bench variant and its set up from a spec folder (SB-FR-001)",
  health: "delivery health chip and staleness (SB-FR-019)",
  map: "delivery map graph and list views (SB-FR-010)",
  ingest: "delivery token and event ingest (SB-FR-007)",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => OUTSIDE_BLOCKED_BY[key]).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project and record (SB-TC-007 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The scratch folder of a test, the project checkout (a git repository) in it,
// and the folder the benches' workspaces go in.
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
// C, and gates after B and after C, as a delivery started elsewhere leaves it
// two units in: A and B done, C and D pending, the lifecycle still running (the
// session ended without a pause), and the record last written an hour ago.
function twoUnitsInRecord(): DeliveryRecord {
  const record = fourUnitRecord();
  const written = new Date(Date.now() - 60 * 60_000).toISOString();
  return {
    ...record,
    units: record.units.map((unit) => ({
      ...unit,
      status: unit.id === "A" || unit.id === "B" ? "done" : "pending",
    })),
    health: { status: "ok", checked_at: written },
    lifecycle: { ...record.lifecycle, state: "running" },
    updated_at: written,
  };
}

function event(seq: number, type: string, payload: Record<string, unknown>, unitId?: string) {
  const envelope: DeliveryEvent = {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: twoUnitsInRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
  return envelope;
}

// ── The project checkout ──

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

const gitAsync = promisify(execFile);

// A checkout on `main` whose spec folder is committed, with `main` as origin's
// default branch as last fetched. Nothing is fetched or pushed: the record a
// test commits is a local commit that origin does not have yet.
function createCheckout(): void {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-attach-journey-")));
  checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, SPEC_FOLDER), { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, SPEC_FOLDER, "prd.md"), `# ${SPEC_SLUG}\n`);
  git(checkout, "add", "--", SPEC_FOLDER);
  git(checkout, "commit", "-q", "-m", "spec");
  git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(checkout, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  mkdirSync(join(scratch, "workspaces"));
}

const CHECKOUT_RECORD = join(SPEC_FOLDER, DELIVERY_RECORD_FILE);

// A copy of the record into the spec folder of the checkout's working tree.
function copyIntoCheckout(record: DeliveryRecord): void {
  writeFileSync(join(checkout, CHECKOUT_RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

// A commit of the working tree's record on the checked-out branch.
function commitCheckoutRecord(): void {
  git(checkout, "add", "--", CHECKOUT_RECORD);
  git(checkout, "commit", "-q", "-m", "delivery record");
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
  specbenchSpecs: { default: express.Router };
  eventLog: { forgetDeliveryEventLog: () => void };
  controlOutbox: { forgetDeliveryControlMemory: () => void };
  launcher: {
    setDeliveryLaunchExecutor: (executor: LaunchExecutor) => void;
    resetDeliveryLaunchExecutor: () => void;
    whenDeliveryBound: (projectId: string, benchId: number) => Promise<void>;
  };
  gitHelpers: {
    resolveWorktreeStartCommit: (
      repoPath: string,
      source: { branchFromDefault: boolean; pullLatest: boolean },
    ) => Promise<string | null>;
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
    specbenchSpecs: await loadServerModule<ServerModules["specbenchSpecs"]>(
      "routes/specbench-specs.js",
    ),
    eventLog: await loadServerModule<ServerModules["eventLog"]>("services/delivery-event-log.js"),
    controlOutbox: await loadServerModule<ServerModules["controlOutbox"]>(
      "services/delivery-control-outbox.js",
    ),
    launcher: await loadServerModule<ServerModules["launcher"]>(
      "services/delivery-session-launcher.js",
    ),
    gitHelpers: await loadServerModule<ServerModules["gitHelpers"]>("services/git-helpers.js"),
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
  { methods: ["GET"], path: new RegExp(`^${BASE}/specbench/specs/[^/]+/summary$`) },
  { methods: ["POST"], path: new RegExp(`^${DELIVERY_EVENT_HOOK_PATH}$`) },
  { methods: ["GET"], path: new RegExp(`^${DELIVERY_CONTROLS_HOOK_PATH}$`) },
];

class RouboServerStandIn {
  createRequests: unknown[] = [];
  unrouted: string[] = [];
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
    this.app.use("/api/projects", modules.specbenchSpecs.default);
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

    if (method === "POST" && path === `${BASE}/benches` && typeof init?.body === "string") {
      this.createRequests.push(JSON.parse(init.body) as unknown);
    }
    if (REAL_ROUTES.some((route) => route.methods.includes(method) && route.path.test(path))) {
      return this.routed(method, `${path}${url.search}`, init);
    }
    if (method === "GET" && path === "/api/benches") {
      return respond(200, copy(routeServices.benches));
    }
    if (method === "GET" && path === `${BASE}/testbench/specs`) {
      return respond(200, { specs: [discoveredFixtureSpec()], invalid: [] });
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
  // bench and provisions its workspace as a git worktree of the checkout at the
  // commit that the real resolveWorktreeStartCommit names, so the workspace
  // holds what that commit holds and nothing of the checkout's working tree.
  private createBench(projectId: string, options: CreateBenchOptions): Bench {
    const folder = resolve(checkout, options.focusedSpecPath ?? "");
    if (folder !== join(checkout, SPEC_FOLDER) || !existsSync(folder)) {
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

  private async provision(bench: Bench): Promise<void> {
    const project = fixtureProject();
    const start = await this.modules.gitHelpers.resolveWorktreeStartCommit(
      project.repoPath,
      project.settings.worktreeSource,
    );
    if (start === null) {
      bench.status = "error";
    } else {
      await gitAsync(
        "git",
        ["worktree", "add", "-q", "-b", bench.branch, bench.workspacePath, start],
        { cwd: checkout },
      );
      bench.status = "active";
    }
    this.modules.sse.broadcastBenchStatus(bench);
  }
}

function discoveredFixtureSpec() {
  return {
    slug: SPEC_SLUG,
    path: `${checkout}/${SPEC_FOLDER}/test-cases.json`,
    caseCount: 2,
    verification: {
      classification: "needs-attention",
      statusCounts: { not_started: 2, in_progress: 0, passed: 0, failed: 0, blocked: 0 },
      resultsPresent: false,
      resultsValid: true,
      planHashMatch: true,
      recoveryReason: null,
      aggregationError: false,
    },
    lifecycle: { archived: false, reason: null, supersededBy: null, recordError: null },
  };
}

// ── The fake delivery tooling ──
//
// It holds the launch descriptor the launch executor hands it, and posts its
// events to the event URL with the token.
class FakeDeliveryTooling {
  descriptor: DeliveryLaunchDescriptor | undefined;

  launched(descriptor: DeliveryLaunchDescriptor): void {
    this.descriptor = descriptor;
  }

  async post(events: DeliveryEvent[]): Promise<number> {
    const { descriptor } = this;
    if (descriptor === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
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
      `SB-TC-007 step diverged: "${label}"\n` +
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

// Picks a spec in the setup dialog's Specification menu (#1625): opens the
// menu, then chooses the spec's option, which the menu's popover holds.
async function pickSpec(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  slug: string,
): Promise<void> {
  await user.click(await within(dialog).findByRole("button", { name: /specification/i }));
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${slug} `) }));
}

// A choice in the setup dialog, whichever control offers it.
function choice(dialog: HTMLElement, name: RegExp): HTMLElement {
  const scope = within(dialog);
  const found =
    scope.queryByRole("tab", { name }) ??
    scope.queryByRole("radio", { name }) ??
    scope.queryByRole("option", { name }) ??
    scope.queryByRole("button", { name }) ??
    scope.queryByRole("menuitemradio", { name });
  if (found) return found;
  throw new Error(`the setup dialog offers no control named ${String(name)}`);
}

function setupDialog(): HTMLElement {
  const dialog = screen.queryByRole("dialog", { name: /spec bench/i });
  if (!dialog) throw new Error("no dialog named Spec Bench is open");
  return dialog;
}

function healthChip(): HTMLElement {
  const rail = screen.getByRole("group", { name: "Delivery health" });
  return within(rail).getByTestId("delivery-health-chip");
}

// The created bench, once the real create-time binding has run: its workspace
// is provisioned and the launcher has decided whether to launch.
async function boundBench(): Promise<Bench> {
  await waitFor(() => expect(server.benches).toHaveLength(1), { timeout: 3000 });
  const bench = server.benches[0];
  await serverModules.launcher.whenDeliveryBound(PROJECT_ID, bench.id);
  return bench;
}

let serverModules: ServerModules;

beforeAll(async () => {
  serverModules = await loadServerModules();
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  createCheckout();
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

describe("Spec Bench attach journey", { timeout: JOURNEY_TIMEOUT_MS }, () => {
  it("SB-TC-007: Operator attaches a Spec Bench to a delivery started elsewhere", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const record = twoUnitsInRecord();

    // Step 1 is a setup step: the delivery started elsewhere is copied into
    // the spec folder of the checkout, two units in, and committed, as a
    // delivery run elsewhere leaves it for a bench's worktree to check out.
    await step(
      "1. Copy the record fixture into fixture-spec as a delivery already two units in",
      "a conformant record at the contract version, with A and B done",
      owners(["launcher"]),
      () => {
        expect(validateDeliveryRecord(record).ok).toBe(true);
        copyIntoCheckout(record);
        commitCheckoutRecord();
        renderRoubo();
      },
    );

    await step(
      "2. Open Set up Spec Bench, choose Attach and pick fixture-spec",
      "the dialog shows the record's progress (2 of 4 units done) and lifecycle state (running), and says no session will be launched",
      owners(["launcher"], ["setup"]),
      async () => {
        await user.click(await findSetUpSpecBench(user));
        await waitFor(() => setupDialog());
        await user.click(choice(setupDialog(), /^attach/i));
        await pickSpec(user, setupDialog(), SPEC_SLUG);
        await waitFor(() => {
          const dialog = setupDialog();
          // The Attach tab is selected, and its Found line reads what the
          // summary found in the committed record.
          const shown = `the dialog reads "${dialog.textContent ?? ""}"`;
          expect(choice(dialog, /^attach/i), shown).toHaveAttribute("aria-selected", "true");
          const found = within(within(dialog).getByTestId("specbench-setup-summary-delivery"));
          expect(found.getByTestId("specbench-setup-summary-progress"), shown).toHaveTextContent(
            /^2 of 4 units done$/,
          );
          expect(found.getByTestId("specbench-setup-summary-lifecycle"), shown).toHaveTextContent(
            /^running$/,
          );
        });
        const note = within(setupDialog()).getByTestId("specbench-setup-attach-note");
        expect(note).toHaveTextContent(/no session will be launched/i);
      },
    );

    const benchId = await step(
      "3. Confirm and open the bench",
      "no session launches, the map shows A and B done and C pending, and the health chip reads attached",
      owners(["launcher"], ["setup", "health", "map"]),
      async () => {
        await user.click(choice(setupDialog(), /confirm|set up/i));
        const bench = await boundBench();
        expect(server.createRequests.at(-1)).toMatchObject({
          variant: "specbench",
          focusedSpecPath: expect.stringContaining(SPEC_FOLDER),
          delivery: { mode: "attach" },
        });
        expect(bench.status, "the bench workspace was not provisioned").toBe("active");
        expect(server.launches, "an attach launched a session").toHaveLength(0);
        expect(bench.deliveryTokenHash, "an attach minted a delivery token").toBeUndefined();
        await user.click(
          await screen.findByRole(
            "link",
            { name: new RegExp(`Bench ${bench.id}`) },
            { timeout: 3000 },
          ),
        );
        const deliveryTab = await screen.findByRole("tab", { name: /delivery/i });
        expect(deliveryTab).toHaveAttribute("aria-selected", "true");
        await waitFor(
          () => {
            expect(screen.getByTestId("unit-node-A")).toHaveAttribute("data-status", "done");
            expect(screen.getByTestId("unit-node-B")).toHaveAttribute("data-status", "done");
            expect(screen.getByTestId("unit-node-C")).toHaveAttribute("data-status", "pending");
          },
          { timeout: 3000 },
        );
        const chip = healthChip();
        expect(chip).toHaveAttribute("data-health", "attached");
        expect(chip).toHaveTextContent(/^attached$/);
        expect(chip).not.toHaveAttribute("data-tone", "active");
        return bench.id;
      },
    );

    await step(
      "4. Click Resume in the controls view",
      "the real resume route launches the session with the record's resume argument, and the health chip turns active once the first event arrives",
      owners(["lifecycle", "controls", "launcher"], ["health", "ingest"]),
      async () => {
        await user.click(screen.getByRole("button", { name: "Cost, health and controls" }));
        const controls = screen.getByRole("region", { name: "Cost, health and controls" });
        const lifecycle = within(controls).getByRole("region", { name: "Lifecycle" });
        const resume = within(lifecycle).getByRole("button", { name: "Resume" });
        await waitFor(() => expect(resume).toBeEnabled());
        await user.click(resume);
        await waitFor(() => expect(server.launches).toHaveLength(1), { timeout: 3000 });
        const [launch] = server.launches;
        const bench = server.benches.find((b) => b.id === benchId);
        // The descriptor is the one the real launcher built for the resume.
        expect(launch.benchId).toBe(benchId);
        expect(launch.specSlug).toBe(SPEC_SLUG);
        expect(launch.workspacePath).toBe(bench?.workspacePath);
        expect(launch.descriptor.resume, "the resume argument the session launched with").toBe(
          record.delivery_id,
        );
        expect(bench?.deliverySessionId).toBe(`delivery-session-${benchId}-1`);
        // Back on the map, through the view's breadcrumb (#1620). No event has
        // arrived yet, so the chip is not active.
        await returnToMap(user);
        expect(healthChip()).not.toHaveAttribute("data-tone", "active");

        const status = await tooling.post([
          event(record.last_event_seq + 1, "unit.changed", { status: "running" }, "C"),
        ]);
        expect(status).toBe(202);
        await waitFor(
          () => {
            const chip = healthChip();
            expect(chip).toHaveAttribute("data-tone", "active");
            expect(chip).toHaveAttribute("data-health", "fresh");
            expect(screen.getByTestId("unit-node-C")).toHaveAttribute("data-status", "running");
          },
          { timeout: 3000 },
        );
      },
    );
  });

  it("SB-TC-007: a record copied into fixture-spec but not committed is neither shown nor joined", async () => {
    const user = userEvent.setup();
    copyIntoCheckout(twoUnitsInRecord());
    renderRoubo();

    await user.click(await findSetUpSpecBench(user));
    await waitFor(() => setupDialog());
    await user.click(choice(setupDialog(), /^attach/i));
    await pickSpec(user, setupDialog(), SPEC_SLUG);
    await waitFor(() =>
      expect(
        within(setupDialog()).getByTestId("specbench-setup-summary-delivery"),
      ).toHaveTextContent(/no committed delivery record/i),
    );
    expect(within(setupDialog()).queryByTestId("specbench-setup-summary-progress")).toBeNull();

    await user.click(choice(setupDialog(), /confirm|set up/i));
    const bench = await boundBench();
    expect(bench.status, "the bench workspace was not provisioned").toBe("active");
    // The checkout's working tree holds the record, and the bench's worktree,
    // checked out from the commit, holds the spec folder without it.
    expect(existsSync(join(checkout, CHECKOUT_RECORD))).toBe(true);
    expect(existsSync(join(bench.workspacePath, SPEC_FOLDER))).toBe(true);
    const read = await server.fetch(`${BASE}/benches/${bench.id}/delivery`);
    expect(read.status).toBe(409);
    expect(await read.json()).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });
  });
});
