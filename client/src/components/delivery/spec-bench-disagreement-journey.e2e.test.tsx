// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator sees a disagreement and
// is blocked from the risky action only" (SB-TC-077, SB-FR-028, SB-FR-029,
// SB-FR-030, SB-US-010). It asserts the authoritative e2e_flow case SB-TC-077
// step for step, so a divergence is integration drift and not a
// re-specification.
//
// What runs for real on the client: the bench page (BenchDetail with the real
// Delivery tab, its health rail with the cross-check, its boundary panel with
// the steering composer, and its lifecycle controls with Approve), the real
// React Query hooks, which read the cross-check on its 5-second interval, the
// real `lib/api` request layer, and the real notification stream hook, which
// shows each action-needed notification through the desktop bridge.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode and hands it to
//     the real session launcher (server/services/delivery-session-launcher.ts),
//     which mints the token in the real registry and builds the launch
//     descriptor;
//   - server/routes/delivery.ts answers the snapshot and the cross-check, the
//     latter through the real loader (server/services/delivery-cross-check-
//     loader.ts), which reads the branches with `git for-each-ref` in the bench
//     workspace, runs the real cross-check, and raises and dismisses the
//     bench's delivery-crosscheck notification through the real notification
//     service; it refuses the approval while a blocking class is present, and
//     takes the operator's steering note into the real control outbox;
//   - server/routes/delivery-hooks.ts serves the fake tooling's controls read.
//
// Git is real: the project checkout is a git repository with one branch per
// unit, the bench workspace is a worktree of it, so a branch moved by hand in
// the checkout is what `git for-each-ref` reads in the workspace. The project
// has no github.com `origin`, so the cross-check consults no GitHub.
//
// "Wait for the next refresh": a branch moved by hand changes no file the
// loader watches and posts no event, so the refresh that sees it is the 60-second
// backstop. The test runs on fake timers that advance with real time, and moves
// the clock past the backstop (and past the 30-second window a backstop refresh
// can be deferred to) until the loader has run one more refresh; then past the
// view's 5-second cross-check read.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as a git worktree of the checkout, the launch
// executor records each launch and hands the descriptor to the fake delivery
// tooling, the notification stream's response is a fake that hands each frame
// to the client's fake EventSource, the desktop bridge records each
// notification it is asked to show, and the state file writes are stubbed.
// Three reads that no step asserts, the spec list, the bench's terminals and
// the list of every project's benches, are answered by the stand-in in the
// shape of their bodies. A request to any other route answers 404 and is listed
// in the failure output. The hooks and components that the journey does not
// cross are stubbed as in the page suites.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts. Started, the fake delivery tooling writes the record into the
// bench workspace with A, B and D done and C running, each unit on its branch
// at the head the record names, gate after B passed and gate after C
// verifying, with the plan and the results that pass both gates: so nothing
// disagrees and Approve is enabled.
//
// Failure-output contract: each SB-TC-077 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { execFileSync } from "node:child_process";
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
  validateDeliveryRecord,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_FILE,
  type DeliveryCrossCheckResponse,
  type DeliveryLaunchDescriptor,
} from "@roubo/shared/delivery-bench";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { DELIVERY_CROSS_CHECK_REFETCH_MS } from "../../hooks/useDeliveryCrossCheck";

// ── Stand-ins below the real routes ──

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
// Each slice of the blocked-by set is named by what it delivers and its FR ids.
// A slice that a step also crosses is labelled apart.
const OWNERS = {
  crossCheck: "pure delivery cross-check over the nine disagreement classes (SB-FR-028)",
  loader:
    "delivery cross-check loader, its refresh triggers, the rail and the blocking-class notification (SB-FR-030)",
  blocking:
    "blocking cross-check classes refuse gate sittings and the approval, and nothing else (SB-FR-029)",
  provisional: "provisional gate rules in the cross-check and the approval (SB-FR-039)",
} as const;

const ALSO_CROSSED = {
  steering: "steering composer, boundary panel and read-back (SB-FR-016, SB-FR-017)",
  controls: "control service, outbox and the token-gated controls endpoint",
  lifecycle: "role matrix and lifecycle controls: pause, wind-down, resume and approve (SB-FR-022)",
  reducer: "delivery reducer and selectors shared by server and client",
  launcher: "record loader, token registry and session launcher for launch and attach",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type CrossedSlice = keyof typeof ALSO_CROSSED;

function owners(blockedBy: BlockedBySlice[], crossed: CrossedSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (crossed.length === 0) return named;
  const also = crossed.map((key) => ALSO_CROSSED[key]).join("; ");
  return `${named}\n  also crossed: ${also}`;
}

// ── Fixture project, repository and record (SB-TC-077 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;
const CLASS = "head-commit-differs";
const MOVED_UNIT = "A";
const NOTE = "Hold the base layer until the branch is reconciled.";
const NEXT_BOUNDARY_UNIT = "C";

// Each unit's branch in the project checkout.
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
type UnitId = keyof typeof BRANCH;
const UNITS: UnitId[] = ["A", "B", "C", "D"];

// Every commit is dated before the record's updated_at, so no branch head is
// newer than the record and no record-stale entry joins the one the journey
// makes.
const COMMIT_DATE = "2026-01-05T09:00:00Z";

const CASES = ["FX-TC-001", "FX-TC-002"];

const plan: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: "1.2.0",
  specSlug: SPEC_SLUG,
  cases: CASES.map((id) => ({
    id,
    title: id,
    area: "fixture",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["FX-FR-001"],
    linked_user_story_ids: [],
  })),
};

// The scratch folder of a test, the project checkout in it, the folder the
// benches' workspaces go in, and each unit's head in the checkout.
let scratch: string;
let checkout: string;
let heads: Record<UnitId, string>;

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

// Git with no user or system configuration, as a fixed author, dated
// COMMIT_DATE.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: COMMIT_DATE,
      GIT_COMMITTER_DATE: COMMIT_DATE,
    },
  }).trim();
}

// One commit on top of `parent`, with the parent's tree, made without a
// checkout.
function commitOn(parent: string, message: string): string {
  return git(checkout, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message);
}

// The checkout: a repository on main with a branch per unit, A, B and C
// stacked in that order and D on main.
function initCheckout(): Record<UnitId, string> {
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(checkout, "README.md"), "Fixture project\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "--quiet", "-m", "Base");
  const main = git(checkout, "rev-parse", "main");
  const a = commitOn(main, "Unit A");
  const b = commitOn(a, "Unit B");
  const c = commitOn(b, "Unit C");
  const d = commitOn(main, "Unit D");
  const made: Record<UnitId, string> = { A: a, B: b, C: c, D: d };
  for (const id of UNITS) git(checkout, "branch", BRANCH[id], made[id]);
  return made;
}

function branchHead(id: UnitId): string {
  return git(checkout, "rev-parse", `refs/heads/${BRANCH[id]}`);
}

// The record as the session writes it: A, B and D done and C running, each on
// its branch at its head; the gate after B passed and the gate after C
// verifying, both over cases the results pass.
function initialRecord(planHash: string): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  const status: Record<string, string> = { A: "done", B: "done", C: "running", D: "done" };
  const gateStatus: Record<string, string> = {
    "gate-after-b": "passed",
    "gate-after-c": "verifying",
  };
  const gateCases: Record<string, string[]> = {
    "gate-after-b": ["FX-TC-001"],
    "gate-after-c": ["FX-TC-002"],
  };
  return {
    ...record,
    plan_hash: planHash,
    units: record.units.map((unit) => ({
      ...unit,
      status: status[unit.id] ?? unit.status,
      branch: BRANCH[unit.id as UnitId],
      head: heads[unit.id as UnitId],
    })),
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({
        ...gate,
        status: gateStatus[gate.id] ?? gate.status,
        cases: gateCases[gate.id] ?? gate.cases,
      })),
    },
    health: { status: "ok", checked_at: now },
    updated_at: now,
  };
}

function results(planHash: string): unknown {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash,
    caseResults: Object.fromEntries(
      CASES.map((id) => [id, { observationMarks: {}, derivedStatus: "passed", notes: [] }]),
    ),
    updatedAt: new Date().toISOString(),
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
  crossCheck: {
    DELIVERY_CROSS_CHECK_BACKSTOP_MS: number;
    DELIVERY_CROSS_CHECK_THROTTLE_MS: number;
    deliveryCrossCheckRunCount: (projectId: string, benchId: number) => number;
    whenDeliveryCrossCheckIdle: (projectId: string, benchId: number) => Promise<void>;
    forgetDeliveryCrossCheck: (projectId?: string, benchId?: number) => void;
  };
  testbenchStore: { computePlanHash: (plan: TestCasesPlan) => string };
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
    crossCheck: await loadServerModule<ServerModules["crossCheck"]>(
      "services/delivery-cross-check-loader.js",
    ),
    testbenchStore:
      await loadServerModule<ServerModules["testbenchStore"]>("lib/testbench-store.js"),
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
  // bench and provisions its workspace as a git worktree of the checkout.
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
    git(checkout, "worktree", "add", "--quiet", "-b", bench.branch, bench.workspacePath, "main");
    bench.status = "active";
    this.modules.sse.broadcastBenchStatus(bench);
    return Promise.resolve();
  }
}

// ── The fake delivery tooling ──
//
// It holds the launch descriptor the launch executor hands it. Started, it
// writes the record, the plan and the results into the spec folder of the bench
// workspace; it reads the controls from the controls URL with the token.
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

  start(bench: Bench, record: DeliveryRecord, planHash: string): void {
    this.held();
    const folder = join(bench.workspacePath, SPEC_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "test-cases.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(
      join(folder, "test-results.json"),
      `${JSON.stringify(results(planHash), null, 2)}\n`,
    );
    writeFileSync(join(folder, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
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
// What the Electron preload hands the client: the notifications it was asked to
// show.
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
      `SB-TC-077 step diverged: "${label}"\n` +
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
  const planHash = serverModules.testbenchStore.computePlanHash(plan);
  const record = initialRecord(planHash);
  expect(validateDeliveryRecord(record).ok).toBe(true);
  tooling.start(bench, record, planHash);
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

async function readCrossCheck(benchId: number): Promise<DeliveryCrossCheckResponse> {
  const res = await server.fetch(`${BASE}/benches/${benchId}/delivery/crosscheck`);
  if (res.status !== 200) {
    throw new Error(
      `the cross-check read answered ${res.status}: ${JSON.stringify(await res.json())}`,
    );
  }
  return (await res.json()) as DeliveryCrossCheckResponse;
}

// Waits for the next refresh of the bench's cross-check: moves the clock past
// the backstop, and past a deferred refresh's window, until the loader has run
// one refresh more than it had, and that refresh is done. Then moves the clock
// past the view's cross-check read interval, so the rail reads it.
async function waitForNextRefresh(benchId: number): Promise<void> {
  const loader = serverModules.crossCheck;
  await loader.whenDeliveryCrossCheckIdle(PROJECT_ID, benchId);
  const before = loader.deliveryCrossCheckRunCount(PROJECT_ID, benchId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await vi.advanceTimersByTimeAsync(
      attempt === 0
        ? loader.DELIVERY_CROSS_CHECK_BACKSTOP_MS
        : loader.DELIVERY_CROSS_CHECK_THROTTLE_MS,
    );
    await loader.whenDeliveryCrossCheckIdle(PROJECT_ID, benchId);
    if (loader.deliveryCrossCheckRunCount(PROJECT_ID, benchId) > before) {
      await vi.advanceTimersByTimeAsync(DELIVERY_CROSS_CHECK_REFETCH_MS);
      return;
    }
  }
  throw new Error(
    `the cross-check ran no refresh after the backstop: still ${String(before)} refreshes`,
  );
}

function approveButton(): HTMLElement {
  return within(screen.getByTestId("delivery-lifecycle-controls")).getByRole("button", {
    name: "Approve",
  });
}

function boundaryPanel(): HTMLElement {
  return screen.getByRole("region", { name: "Next boundary" });
}

function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}

let serverModules: ServerModules;

beforeAll(async () => {
  serverModules = await loadServerModules();
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  serverModules.crossCheck.forgetDeliveryCrossCheck();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-disagreement-journey-")));
  checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, SPEC_FOLDER), { recursive: true });
  mkdirSync(join(scratch, "workspaces"));
  heads = initCheckout();
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
  serverModules.crossCheck.forgetDeliveryCrossCheck();
  vi.useRealTimers();
  server.close();
  serverModules.sse._resetClientsForTest();
  bridge.uninstall();
  vi.unstubAllGlobals();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  rmSync(scratch, { recursive: true, force: true });
});

describe("Spec Bench disagreement journey", { timeout: JOURNEY_TIMEOUT_MS }, () => {
  it("SB-TC-077: Operator sees a disagreement and is blocked from the risky action only", async () => {
    // Fake timers that advance with real time, so the backstop refresh can be
    // reached without waiting a minute.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const bench = await setUpLaunchModeSpecBench(tooling);
    const recordedHead = heads[MOVED_UNIT];
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

    // The precondition holds: the view has read the cross-check, which finds
    // nothing, and Approve is enabled.
    await waitFor(
      () =>
        expect(server.answered).toContainEqual({
          method: "GET",
          path: `${BASE}/benches/${bench.id}/delivery/crosscheck`,
          status: 200,
        }),
      { timeout: 6000 },
    );
    await serverModules.crossCheck.whenDeliveryCrossCheckIdle(PROJECT_ID, bench.id);
    expect((await readCrossCheck(bench.id)).disagreements).toEqual([]);
    await waitFor(() => expect(approveButton()).toBeEnabled(), { timeout: 3000 });
    expect(screen.queryByTestId("delivery-crosscheck")).toBeNull();
    expect(screen.queryByTestId("delivery-approve-reason")).toBeNull();

    // Step 1 is a setup step: a commit on A's branch, made by hand in the
    // project checkout, moves its head off the one the record names.
    const movedHead = await step(
      `1. Move ${MOVED_UNIT}'s branch head by hand in the project checkout`,
      `${BRANCH[MOVED_UNIT]} moves from the recorded ${recordedHead} to a new commit`,
      owners(["crossCheck"]),
      () => {
        const moved = commitOn(recordedHead, "A hand commit on the base layer");
        git(checkout, "branch", "--force", BRANCH[MOVED_UNIT], moved);
        expect(branchHead(MOVED_UNIT)).toBe(moved);
        expect(moved).not.toBe(recordedHead);
        return moved;
      },
    );

    await step(
      "2. Wait for the next refresh",
      `a notification names ${CLASS} for ${MOVED_UNIT}, and the rail lists the ${CLASS} disagreement of ${MOVED_UNIT}, blocking, with the recorded commit ${shortCommit(recordedHead)} and the branch's commit ${shortCommit(movedHead)}`,
      owners(["loader", "crossCheck"], ["reducer"]),
      async () => {
        await waitForNextRefresh(bench.id);

        // The notification, shown through the desktop bridge.
        await waitFor(
          () =>
            expect(bridge.shown).toContainEqual({
              title: "Delivery cross-check",
              body: `The delivery record disagrees with its source: ${CLASS} for ${MOVED_UNIT}`,
              routeTo: `roubo://project/${PROJECT_ID}/bench/${bench.id}`,
            }),
          { timeout: 3000 },
        );
        // The server holds the same notification for the bench card.
        const held = (server.benches[0]?.notifications ?? []).filter(
          (n) => n.type === "delivery-crosscheck",
        );
        expect(held.map((n) => [n.dedupeKey, n.metadata])).toEqual([
          [CLASS, { class: CLASS, count: 1, unitIds: [MOVED_UNIT] }],
        ]);

        // The cross-check carries both commits.
        const crossCheck = await readCrossCheck(bench.id);
        expect(crossCheck.disagreements).toEqual([
          {
            class: CLASS,
            blocking: true,
            unitId: MOVED_UNIT,
            claimed: { local: recordedHead },
            observed: { local: movedHead },
            source: "git",
          },
        ]);

        // The rail lists it, with both commits.
        const rail = await screen.findByTestId("delivery-crosscheck", {}, { timeout: 3000 });
        const rows = within(rail).getAllByTestId("delivery-crosscheck-row");
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toHaveAttribute("data-class", CLASS);
        expect(row).toHaveAttribute("data-blocking", "true");
        expect(
          within(row).getByRole("button", { name: `${CLASS}, blocking, ${MOVED_UNIT}` }),
        ).toBeInTheDocument();
        expect(row).toHaveTextContent(`record local ${shortCommit(recordedHead)}`);
        expect(row).toHaveTextContent(`git local ${shortCommit(movedHead)}`);
      },
    );

    await step(
      "3. Click Approve",
      `the bench shows the approval blocked with ${CLASS} named, and the approve route refuses it with 409 CROSSCHECK_BLOCKED naming ${CLASS}`,
      owners(["blocking"], ["lifecycle"]),
      async () => {
        await user.click(approveButton());
        await waitFor(
          () => {
            expect(approveButton()).toBeDisabled();
            const reason = screen.getByTestId("delivery-approve-reason");
            expect(reason).toHaveAttribute("data-code", "CROSSCHECK_BLOCKED");
            expect(reason).toHaveTextContent(CLASS);
          },
          { timeout: 3000 },
        );

        // The route refuses the approval too, and no approval control is
        // queued for the session.
        const res = await server.fetch(`${BASE}/benches/${bench.id}/delivery/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { code?: string; classes?: string[]; error?: string };
        expect(body.code).toBe("CROSSCHECK_BLOCKED");
        expect(body.classes).toEqual([CLASS]);
        expect(body.error).toContain(CLASS);
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.controls.filter((c) => c.kind === "approval")).toEqual([]);
      },
    );

    await step(
      "4. Send a steering note",
      `the note "${NOTE}" is queued for the next boundary, "${NEXT_BOUNDARY_UNIT} finishes", and the session can read it from the controls endpoint`,
      owners(["blocking"], ["steering", "controls"]),
      async () => {
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
        expect(within(boundaryPanel()).getByTestId("boundary-name")).toHaveTextContent(
          `${NEXT_BOUNDARY_UNIT} finishes`,
        );

        const controls = await tooling.readControls();
        const note = controls.find((control) => control.kind === "steering-note");
        expect(note, `no steering-note control in ${JSON.stringify(controls)}`).toBeDefined();
        expect(note?.body).toMatchObject({ note: NOTE, applies_at: NEXT_BOUNDARY_UNIT });
        expect(note?.status).not.toBe("applied");
      },
    );

    await step(
      `5. Reset ${MOVED_UNIT}'s branch to the recorded commit and wait for the next refresh`,
      `the ${CLASS} disagreement clears from the rail, its notification is dismissed, and Approve is enabled again with no reason beneath it`,
      owners(["loader", "crossCheck", "blocking"], ["lifecycle"]),
      async () => {
        git(checkout, "branch", "--force", BRANCH[MOVED_UNIT], recordedHead);
        expect(branchHead(MOVED_UNIT)).toBe(recordedHead);
        await waitForNextRefresh(bench.id);

        expect((await readCrossCheck(bench.id)).disagreements).toEqual([]);
        await waitFor(() => expect(screen.queryByTestId("delivery-crosscheck")).toBeNull(), {
          timeout: 3000,
        });
        expect(
          (server.benches[0]?.notifications ?? []).filter((n) => n.type === "delivery-crosscheck"),
        ).toEqual([]);

        await waitFor(() => expect(approveButton()).toBeEnabled(), { timeout: 3000 });
        expect(screen.queryByTestId("delivery-approve-reason")).toBeNull();
      },
    );
  });
});
