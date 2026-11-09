// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator reviews the agent's
// decisions from the bench and approves the delivery" (SB-TC-105, SB-FR-034,
// SB-FR-035, SB-FR-036, SB-FR-038, SB-US-014). It asserts the authoritative
// e2e_flow case SB-TC-105 step for step, so a divergence is integration drift
// and not a re-specification.
//
// What runs for real on the client: the bench page (BenchDetail with the real
// Delivery tab, its review pile with the agent decision cards, their Accept,
// Overturn and Discuss actions and the thread, the provisional gate's card and
// its Open sitting, the lifecycle controls with Approve, and the real Test
// bench tab of the Spec Bench with the sitting's provisional mark and its
// Confirm), the real React Query hooks, the real `lib/api` request layer and
// the real notification stream hook, which reads the snapshot again on each
// delivery frame and shows each action-needed notification through the
// desktop bridge.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode in auto mode
//     and hands it to the real session launcher
//     (server/services/delivery-session-launcher.ts), which mints the token in
//     the real registry and builds the launch descriptor;
//   - server/routes/delivery.ts answers the snapshot through the real record
//     loader over the bench's workspace and the real event log, takes the
//     accept, the thread message, the overturn and the approval into the real
//     control outbox, opens the gate's sitting through the real gate pin
//     service, and reads the cross-check through the real loader
//     (server/services/delivery-cross-check-loader.ts) over real git;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log, raises the review call's
//     notification through the real notification service, reads each control
//     back, and broadcasts each change through the real server/services/sse.ts;
//     it also serves the tooling's controls read;
//   - server/routes/testbench.ts serves the sitting's plan and takes the
//     operator's mark through the real Spec Bench provider
//     (server/lib/specbench-testbench-adapter.ts) and the real results writer,
//     which stamps the operator's git identity as the author in the
//     workspace's test-results.json;
//   - server/services/terminal.ts holds the delivery session as a terminal
//     session of the bench: the bench's terminal list, the live-session check
//     the thread route makes, and the session's input count, which step 6
//     reads.
//
// Git is real: the project checkout is a git repository with one branch per
// unit at the head the record names, and the bench workspace is a worktree of
// it, so the cross-check finds nothing. The operator's git identity is the
// checkout's own user.name and user.email. The project has no github.com
// `origin`, so the cross-check consults no GitHub.
//
// The stand-ins sit below those routes: the bench manager claims the bench and
// provisions its workspace as a git worktree of the checkout; the launch
// executor (the port the launcher hands the descriptor to) records each
// launch, opens the session as a terminal session of the real terminal service
// and hands the descriptor to the fake delivery tooling; node-pty spawns a fake
// PTY, which is the fake tooling's process; the notification stream's response
// is a fake that hands each frame to the client's fake EventSource; the desktop
// bridge records each notification it is asked to show; and the state file
// writes are stubbed, with the terminal sessions persisted in a scratch folder.
// Two reads that no step asserts, the spec list and the list of every
// project's benches, are answered by the stand-in in the shape of their bodies,
// and the bench's terminal list is answered from the real terminal service. A
// request to any other route answers 404 and is listed in the failure output.
// The hooks and components that the journey does not cross (projects,
// integration, settings, plugins, the terminal view, logs, issue controls) are
// stubbed as in the page suites.
//
// The precondition "the build is live and smoke-checked" is the bench's
// prepared sitting of the gate after B in state `ready`, with a passed smoke
// check, as the gate pin service records it once a gate.reached's preparation
// passes; the preparation itself is SB-TC-058's journey, not this one.
//
// Started, the fake delivery tooling writes the record into the bench
// workspace in auto mode, with A, B and D done and C running, each unit on its
// branch at its head, the plan and the results in which the gate after C's
// case passes. It then posts the two decisions it made on its own and the
// provisional mark of the gate after B. In the journey it opens the review,
// reads the operator's controls from the controls endpoint and posts the
// events that apply them, each with the token.
//
// Failure-output contract: each SB-TC-105 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
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
    fs.mkdtempSync(path.join(os.tmpdir(), "spec-bench-review-journey-roubo-")),
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
import { openCostView, openDecisionsView, returnToMap } from "../../test/delivery-views";

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// OWNERS is exactly this journey's blocked-by set, eight slices, each named by
// the exact title of its issue, and every step names at least one of them. A
// slice that a step also crosses but that sits outside the blocked-by set is
// labelled apart.
const OWNERS = {
  reviewCards: "'Agent decision cards on the pile and the review call notification'",
  reviewControls:
    "'Accept and overturn as review controls, early during a run and at an open review'",
  waitingRead: "'Waiting control read for the tooling'",
  thread: "'Discussion thread on the review card'",
  controlQueue: "'Durable control queue on the bench record with ordered replay at resume'",
  provisionalRules: "'Provisional gate rules in the cross-check and the approval refusals'",
  provisional:
    "'Provisional gate on the map, the gate card that opens a sitting, and the provisional mark with confirm'",
  surfaces:
    "'Keyboard and screen-reader paths for the mode switch, the review card, the thread and the provisional mark'",
} as const;

const OUTSIDE_BLOCKED_BY = {
  reducer: "'Delivery reducer and selectors shared by server and client'",
  controls: "'Control service, outbox and the token-gated controls endpoint'",
  ingest: "'Token-gated event ingest, sequence checks and the delivery stream frame'",
  launcher: "'Record loader, token registry and session launcher for launch and attach'",
  lifecycle: "'Role matrix and lifecycle controls: pause, wind-down, resume and approve'",
  sittingMarks: "marking a gate sitting's cases on the TestBench surfaces (SB-FR-026, SB-US-009)",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => OUTSIDE_BLOCKED_BY[key]).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project, repository, record and decisions (SB-TC-105 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The operator, as the checkout's git identity names them.
const OPERATOR = { name: "Ada Operator", email: "ada@example.test" };

// Each unit's branch in the project checkout.
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
type UnitId = keyof typeof BRANCH;
const UNITS: UnitId[] = ["A", "B", "C", "D"];

// Every commit is dated before the record's updated_at, so no branch head is
// newer than the record.
const COMMIT_DATE = "2026-01-05T09:00:00Z";

// The provisional gate after B, its one case, and the gate after C's case.
const GATE = "gate-after-b";
const GATE_CASE = "FX-TC-001";
const OTHER_GATE_CASE = "FX-TC-002";
const CASES = [GATE_CASE, OTHER_GATE_CASE];
const GATE_EVIDENCE = `The drive of ${GATE_CASE} showed the expected banner.`;

// The two decisions the session made on its own in auto mode, D-1 and D-2,
// oldest first: each is an agent card on the pile.
const D1 = {
  id: "decision-1",
  question: "Does the cache keep one file per unit or one per stack?",
  options: ["one file per unit", "one file per stack"],
  chosen: "one file per stack",
  decidedAt: "2026-01-06T10:00:00.000Z",
};
const D2 = {
  id: "decision-2",
  question: "Does the log rotate per unit or per stack?",
  options: ["rotate per unit", "rotate per stack"],
  chosen: "rotate per unit",
  decidedAt: "2026-01-06T10:05:00.000Z",
};
const DECIDING_UNIT = "B";
const QUESTION = "Why per unit, when the stack shares one log?";
const REPLY = "Per unit keeps each unit's log small enough to read in its drill-in.";
const SUMMARY = "Overturned to rotate per stack: the stack shares one log, so one file reads best.";

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
// stacked in that order and D on main, whose own git identity is the
// operator's.
function initCheckout(): Record<UnitId, string> {
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "config", "user.name", OPERATOR.name);
  git(checkout, "config", "user.email", OPERATOR.email);
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

// The conformant record fixture of four units A, B, C and D, a stack of A, B
// and C, and gates after B and after C, as the session writes it in auto mode:
// A, B and D are done, C runs, each unit is on its branch at its head, the
// gate after B waits on its case and the gate after C passed.
function initialRecord(planHash: string): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  const status: Record<string, string> = { A: "done", B: "done", C: "running", D: "done" };
  const gateCases: Record<string, string[]> = {
    [GATE]: [GATE_CASE],
    "gate-after-c": [OTHER_GATE_CASE],
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
        status: gate.id === GATE ? "pending" : "passed",
        cases: gateCases[gate.id] ?? gate.cases,
      })),
    },
    mode: { value: "auto", pending: null },
    health: { status: "ok", checked_at: now },
    updated_at: now,
  };
}

// The results as the delivery left them: the gate after C's case passed, and
// the gate after B's case not yet marked.
function initialResults(planHash: string): unknown {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash,
    caseResults: {
      [OTHER_GATE_CASE]: { observationMarks: {}, derivedStatus: "passed", notes: [] },
    },
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
  testbench: { default: express.Router };
  specbenchTestbench: { registerSpecbenchTestbenchAdapter: () => void };
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
    getSessions: (projectId: string, benchId: number) => TerminalSession[];
    getSessionInputCount: (sessionId: string) => number | undefined;
    destroyAllSessions: () => void;
  };
  sse: {
    addClient: (res: StreamResponse) => void;
    broadcastBenchStatus: (bench: Bench) => void;
    _resetClientsForTest: () => void;
  };
  crossCheck: {
    forgetDeliveryCrossCheck: (projectId?: string, benchId?: number) => void;
  };
  gatePin: { forgetGateSittingWatches: () => void };
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
    testbench: await loadServerModule<ServerModules["testbench"]>("routes/testbench.js"),
    specbenchTestbench: await loadServerModule<ServerModules["specbenchTestbench"]>(
      "lib/specbench-testbench-adapter.js",
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
    crossCheck: await loadServerModule<ServerModules["crossCheck"]>(
      "services/delivery-cross-check-loader.js",
    ),
    gatePin: await loadServerModule<ServerModules["gatePin"]>("services/gate-pin.js"),
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
  { methods: ["GET", "PUT", "POST"], path: new RegExp(`^${BASE}/benches/\\d+/testbench(/.*)?$`) },
  { methods: ["POST"], path: new RegExp(`^${DELIVERY_EVENT_HOOK_PATH}$`) },
  { methods: ["GET"], path: new RegExp(`^${DELIVERY_CONTROLS_HOOK_PATH}$`) },
];

// A node-pty process that runs nothing: it keeps what is written into it.
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
  private onLaunch: ((descriptor: DeliveryLaunchDescriptor) => void) | undefined;

  // The routers mounted as server/index.ts mounts them, behind the delivery
  // event parser and the global JSON parser.
  constructor(modules: ServerModules) {
    this.modules = modules;
    this.app.use(DELIVERY_EVENT_HOOK_PATH, modules.deliveryHooks.deliveryEventBodyParser);
    this.app.use(express.json({ limit: "210kb" }));
    this.app.use("/api/projects", modules.benches.default);
    this.app.use("/api/projects", modules.delivery.default);
    this.app.use("/api/projects", modules.testbench.default);
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
        this.onLaunch?.(launch.descriptor);
        return { sessionId: session.id };
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
  // bench with the bind mode and the decision mode the route hands it, and
  // provisions its workspace as a git worktree of the checkout.
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
    git(checkout, "worktree", "add", "--quiet", "-b", bench.branch, bench.workspacePath, "main");
    bench.status = "active";
    this.modules.sse.broadcastBenchStatus(bench);
    return Promise.resolve();
  }
}

// ── The fake delivery tooling ──
//
// It holds the launch descriptor the launch executor hands it. Started, it
// writes the record, the plan and the results into the spec folder of the
// bench workspace; then it posts its events to the event URL and reads the
// controls from the controls URL, each with the token.
interface ControlRead {
  control_seq: number;
  kind: string;
  target_id?: string;
  body: Record<string, unknown>;
  status: string;
}

class FakeDeliveryTooling {
  descriptor: DeliveryLaunchDescriptor | undefined;
  private deliveryId = "";
  private nextSeq = 0;

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
    this.deliveryId = record.delivery_id;
    this.nextSeq = record.last_event_seq + 1;
    const folder = join(bench.workspacePath, SPEC_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "test-cases.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(
      join(folder, "test-results.json"),
      `${JSON.stringify(initialResults(planHash), null, 2)}\n`,
    );
    writeFileSync(join(folder, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return {
      $schema: DELIVERY_EVENT_SCHEMA_ID,
      schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
      delivery_id: this.deliveryId,
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
//
// Each step also notes, once it ends, whether the bench page's Terminal tab is
// selected, so step 6 can show that the terminal was opened for no step.

let server: RouboServerStandIn;
let bridge: DesktopBridge;
let terminalTabSelected: { step: string; selected: boolean }[];

function terminalTab(): HTMLElement {
  return screen.getByRole("tab", { name: /terminal/i });
}

async function step<T>(
  label: string,
  expectation: string,
  owningSlices: string,
  body: () => T | Promise<T>,
): Promise<T> {
  try {
    const result = await body();
    terminalTabSelected.push({
      step: label,
      selected: terminalTab().getAttribute("aria-selected") === "true",
    });
    return result;
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    const unrouted =
      server.unrouted.length > 0 ? `\n  unserved requests: ${server.unrouted.join(", ")}` : "";
    throw new Error(
      `SB-TC-105 step diverged: "${label}"\n` +
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

let serverModules: ServerModules;

// The precondition: a Spec Bench set up from fixture-spec in launch mode in
// auto mode, its session launched with the token and running as the bench's
// main session, its record written and conformant, the two agent decisions on
// the pile, the gate after B provisional with one case, and its build live and
// smoke-checked.
async function setUpReviewedSpecBench(tooling: FakeDeliveryTooling): Promise<Bench> {
  const res = await server.fetch(`${BASE}/benches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: "specbench",
      focusedSpecPath: SPEC_FOLDER,
      delivery: { mode: "launch", decisionMode: "auto" },
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
  expect(tooling.descriptor?.decisionMode, "the session was not launched in auto").toBe("auto");
  expect(bench.deliverySessionId).toBe(server.sessions[0]?.id);
  expect(server.sessions[0]?.status, "the bench's main session does not run").toBe("live");

  const planHash = serverModules.testbenchStore.computePlanHash(plan);
  const record = initialRecord(planHash);
  const validated = validateDeliveryRecord(record);
  expect(validated.ok, `the record fixture is not conformant: ${JSON.stringify(validated)}`).toBe(
    true,
  );
  tooling.start(bench, record, planHash);

  await tooling.post([
    ...[D1, D2].map((decision) =>
      tooling.event(
        "decision.decided",
        {
          decision_id: decision.id,
          question: decision.question,
          options: decision.options,
          default: decision.options[0],
          chosen: decision.chosen,
          rationale: `The agent chose ${decision.chosen}.`,
          decided_at: decision.decidedAt,
        },
        DECIDING_UNIT,
      ),
    ),
    tooling.event(
      "gate.provisional",
      { gate_id: GATE, cases: [{ case: GATE_CASE, mark: "met", evidence: GATE_EVIDENCE }] },
      DECIDING_UNIT,
    ),
  ]);

  // The gate's build is live and smoke-checked: its prepared sitting is ready.
  const now = new Date().toISOString();
  bench.deliverySitting = {
    gateId: GATE,
    preparedAt: now,
    commit: heads.B,
    state: "ready",
    smokeCheck: { passed: true, checkedAt: now },
    resultsSpecPath: join(bench.workspacePath, SPEC_FOLDER),
  };

  const snapshot = await readSnapshot(id);
  expect(snapshot.mode.value).toBe("auto");
  expect(snapshot.gatesById[GATE]?.gate.status).toBe("provisional");
  expect(snapshot.review.unreviewed).toEqual([D1.id, D2.id]);
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
        path: `${BASE}/benches/${benchId}/${route}`,
        status,
      }),
    { timeout: 3000 },
  );
}

// The cards on the review pile, top first, by decision or gate id.
function pileCards(): string[] {
  const pile = screen.queryByTestId("delivery-review-pile");
  if (pile === null) return [];
  const list = within(pile).queryByRole("list", { name: "Review pile" });
  if (list === null) return [];
  return within(list)
    .queryAllByTestId(/^review-card-/)
    .map((card) => card.dataset.testid?.slice("review-card-".length) ?? "");
}

function topCard(id: string): HTMLElement {
  const card = screen.getByTestId(`review-card-${id}`);
  expect(card, `${id} is not the top card`).toHaveAttribute("data-position", "top");
  return card;
}

function findControl(
  controls: ControlRead[],
  kind: string,
  targetId: string,
): ControlRead | undefined {
  return controls.find((control) => control.kind === kind && control.target_id === targetId);
}

function readResults(bench: Bench): {
  caseResults: Record<
    string,
    { statusOverride?: { status: string; author: { name: string; email: string } } }
  >;
} {
  return JSON.parse(
    readFileSync(join(bench.workspacePath, SPEC_FOLDER, "test-results.json"), "utf8"),
  ) as ReturnType<typeof readResults>;
}

function approveButton(): HTMLElement {
  return within(screen.getByTestId("delivery-lifecycle-controls")).getByRole("button", {
    name: "Approve",
  });
}

beforeAll(async () => {
  serverModules = await loadServerModules();
  serverModules.specbenchTestbench.registerSpecbenchTestbenchAdapter();
});

afterAll(() => {
  if (routeServices.rouboDir !== "") {
    rmSync(routeServices.rouboDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  localStorage.clear();
  terminalTabSelected = [];
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  serverModules.crossCheck.forgetDeliveryCrossCheck();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-review-journey-")));
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
  serverModules.gatePin.forgetGateSittingWatches();
  server.close();
  serverModules.sse._resetClientsForTest();
  bridge.uninstall();
  vi.unstubAllGlobals();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  rmSync(scratch, { recursive: true, force: true });
});

describe("Spec Bench review journey", () => {
  it("SB-TC-105: Operator reviews the agent's decisions from the bench and approves the delivery", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const bench = await setUpReviewedSpecBench(tooling);
    renderBenchPage(bench.id);
    await waitFor(
      () =>
        expect(screen.getByRole("tab", { name: /delivery/i })).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      { timeout: 3000 },
    );

    // The review pile is in the decisions and steering view (#1620).
    await openDecisionsView(user);

    // Precondition, not an observation: the pile holds the two agent cards,
    // oldest on top, and the provisional gate's card below them, and no
    // review has called the operator yet.
    await waitFor(() => expect(pileCards()).toEqual([D1.id, D2.id, GATE]), { timeout: 3000 });
    expect(bridge.shown, "precondition: a notification was shown").toEqual([]);

    await step(
      "1. Post review.opened as the fake tooling and read the notification",
      `one notification names the count of the agent decision cards: "2 agent decisions wait for your review"`,
      owners(["reviewCards"], ["ingest", "reducer"]),
      async () => {
        await tooling.post([
          tooling.event("review.opened", {
            trigger: `${GATE} reached`,
            unreviewed: [D1.id, D2.id],
          }),
        ]);
        await waitFor(
          () =>
            expect(bridge.shown).toContainEqual(
              expect.objectContaining({
                title: "Delivery review",
                body: "2 agent decisions wait for your review",
              }),
            ),
          { timeout: 3000 },
        );
        expect(
          bridge.shown.filter((shown) => shown.title === "Delivery review"),
          "the review call was shown more than once",
        ).toHaveLength(1);
        const held = (server.benches.find((b) => b.id === bench.id)?.notifications ?? []).filter(
          (n) => n.type === "delivery-decision",
        );
        expect(held, "the bench holds one review notification").toHaveLength(1);
        const decisionCards = pileCards().filter((id) => id !== GATE);
        expect(held[0]?.metadata).toMatchObject({ review: true, count: decisionCards.length });
        expect(decisionCards).toEqual([D1.id, D2.id]);
      },
    );

    await step(
      `2. Accept D-1 (${D1.id})`,
      `the fake tooling reads a review_accept control for ${D1.id}, ${D1.id} stays on the pile until its review.outcome, and leaves after it`,
      owners(
        ["reviewControls", "waitingRead", "controlQueue", "reviewCards"],
        ["controls", "reducer"],
      ),
      async () => {
        await user.click(within(topCard(D1.id)).getByRole("button", { name: "Accept" }));
        await requestAnswered(bench.id, "POST", `delivery/decisions/${D1.id}/accept`, 202);

        const controls = await tooling.readControls();
        const accept = findControl(controls, "review_accept", D1.id);
        expect(accept, `no review_accept control in ${JSON.stringify(controls)}`).toBeDefined();
        // Read by the tooling, but not applied: the card is still on the pile.
        expect(pileCards()).toContain(D1.id);

        await tooling.post([
          tooling.event(
            "review.outcome",
            { decision_id: D1.id, status: "accepted", control_seq: accept?.control_seq },
            DECIDING_UNIT,
          ),
        ]);
        await waitFor(() => expect(pileCards()).toEqual([D2.id, GATE]), { timeout: 3000 });
        expect(screen.getByTestId(`review-reviewed-${D1.id}`)).toHaveTextContent(
          `${D1.id} · accepted · chose ${D1.chosen}`,
        );
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.decisionsById[D1.id]?.review?.status).toBe("accepted");
      },
    );

    await step(
      `3. Open the thread on D-2 (${D2.id}), ask a question, and post a reply as the fake tooling`,
      `the fake tooling reads the question as a thread_message for ${D2.id}, and its reply shows on the card`,
      owners(["thread", "waitingRead", "controlQueue", "surfaces"], ["controls", "reducer"]),
      async () => {
        const card = topCard(D2.id);
        await user.click(within(card).getByRole("button", { name: "Discuss" }));
        await user.type(
          within(card).getByRole("textbox", { name: "Ask about this decision" }),
          QUESTION,
        );
        await user.click(within(card).getByRole("button", { name: "Send" }));
        await requestAnswered(bench.id, "POST", `delivery/decisions/${D2.id}/thread`, 202);

        const controls = await tooling.readControls();
        const message = findControl(controls, "thread_message", D2.id);
        expect(message, `no thread_message control in ${JSON.stringify(controls)}`).toBeDefined();
        expect(message?.body).toMatchObject({ text: QUESTION });

        await tooling.post([
          tooling.event(
            "review.reply",
            {
              decision_id: D2.id,
              text: REPLY,
              in_reply_to: String(message?.control_seq),
            },
            DECIDING_UNIT,
          ),
        ]);
        const log = await within(topCard(D2.id)).findByRole(
          "log",
          { name: `Messages on ${D2.id}` },
          { timeout: 3000 },
        );
        await waitFor(
          () => {
            const replies = within(log)
              .queryAllByRole("listitem")
              .filter((item) => item.dataset.from === "session");
            expect(replies.map((item) => item.textContent)).toEqual([
              expect.stringContaining(REPLY),
            ]);
          },
          { timeout: 3000 },
        );
        expect(within(log).getByText(QUESTION)).toBeInTheDocument();
      },
    );

    await step(
      `4. Overturn D-2 (${D2.id}) to its other option and post the outcome with a summary`,
      `${D2.id} leaves the pile, chooses "${D2.options[1]}", and its summary is recorded on the decision`,
      owners(["reviewControls", "waitingRead", "controlQueue", "thread"], ["controls", "reducer"]),
      async () => {
        const card = topCard(D2.id);
        await user.click(within(card).getByRole("button", { name: "Overturn" }));
        const other = D2.options.find((option) => option !== D2.chosen) ?? "";
        await user.click(
          within(within(card).getByRole("group", { name: `Overturn ${D2.id} with` })).getByRole(
            "button",
            { name: other },
          ),
        );
        await requestAnswered(bench.id, "POST", `delivery/decisions/${D2.id}/overturn`, 202);

        const controls = await tooling.readControls();
        const overturn = findControl(controls, "overturn", D2.id);
        expect(overturn, `no overturn control in ${JSON.stringify(controls)}`).toBeDefined();
        expect(overturn?.body).toMatchObject({ option: other });

        await tooling.post([
          tooling.event(
            "review.outcome",
            {
              decision_id: D2.id,
              status: "overturned",
              chosen: other,
              summary: SUMMARY,
              control_seq: overturn?.control_seq,
            },
            DECIDING_UNIT,
          ),
        ]);
        await waitFor(() => expect(pileCards()).toEqual([GATE]), { timeout: 3000 });
        expect(screen.getByTestId(`review-summary-${D2.id}`)).toHaveTextContent(SUMMARY);
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.decisionsById[D2.id]?.chosen).toBe(other);
        expect(snapshot.decisionsById[D2.id]?.review).toMatchObject({
          status: "overturned",
          summary: SUMMARY,
        });
      },
    );

    await step(
      "5. Open the sitting from the gate card and confirm the provisional mark",
      `the sitting of ${GATE} opens, and ${GATE_CASE}'s mark is in test-results.json as passed with the operator, ${OPERATOR.name}, as author`,
      owners(["provisional", "provisionalRules", "surfaces"], ["sittingMarks"]),
      async () => {
        const card = topCard(GATE);
        expect(within(card).getByTestId(`provisional-mark-badge-${GATE_CASE}`)).toHaveTextContent(
          "Met · provisional",
        );
        await user.click(within(card).getByRole("button", { name: "Open sitting" }));
        await requestAnswered(bench.id, "POST", "delivery/sittings", 201);
        await waitFor(
          () =>
            expect(screen.getByRole("tab", { name: /test bench/i })).toHaveAttribute(
              "aria-selected",
              "true",
            ),
          { timeout: 3000 },
        );
        const list = await screen.findByRole(
          "list",
          { name: `Escalated cases of gate ${GATE}` },
          { timeout: 3000 },
        );
        const sittingCase = within(list)
          .getAllByTestId("sitting-case")
          .find((c) => c.dataset.caseId === GATE_CASE);
        if (sittingCase === undefined) throw new Error(`the sitting lists no case ${GATE_CASE}`);
        await user.click(within(sittingCase).getByRole("button", { name: `Confirm ${GATE_CASE}` }));
        await requestAnswered(bench.id, "PUT", `testbench/cases/${GATE_CASE}/status`, 200);
        await waitFor(
          () =>
            expect(
              within(sittingCase).getByTestId(`provisional-mark-badge-${GATE_CASE}`),
            ).toHaveTextContent("Met · confirmed"),
          { timeout: 3000 },
        );

        const results = readResults(bench);
        expect(results.caseResults[GATE_CASE]?.statusOverride).toMatchObject({
          status: "passed",
          author: OPERATOR,
        });
      },
    );

    await step(
      "6. Post gate.confirmed and the closing review state, then approve the delivery",
      "the review closes with nothing waiting, and the approval request returns 202",
      owners(["provisional", "provisionalRules", "reviewCards"], ["lifecycle", "controls"]),
      async () => {
        await tooling.post([
          tooling.event(
            "gate.confirmed",
            { gate_id: GATE, cases: [GATE_CASE], status: "passed" },
            DECIDING_UNIT,
          ),
          tooling.event("review.opened", { trigger: `${GATE} confirmed`, unreviewed: [] }),
        ]);
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.review.status, "the review did not close").toBe("none");
        expect(snapshot.gatesById[GATE]?.gate.status).toBe("passed");

        await user.click(screen.getByRole("tab", { name: /delivery/i }));
        // The tab opens on the map: the pile is in the decisions view, and
        // Approve in the cost, health and controls view.
        await openDecisionsView(user);
        await waitFor(() => expect(pileCards()).toEqual([]), { timeout: 3000 });
        await returnToMap(user);
        await openCostView(user);
        await waitFor(() => expect(approveButton()).toBeEnabled(), { timeout: 8000 });
        await user.click(approveButton());
        await requestAnswered(bench.id, "POST", "delivery/approve", 202);
        const approved = await readSnapshot(bench.id);
        expect(approved.controls.filter((c) => c.kind === "approval")).toHaveLength(1);
      },
    );

    await step(
      "6. Post gate.confirmed and the closing review state, then approve the delivery: the terminal",
      "the terminal was not opened for any step: its tab was never selected, and the delivery session took no input",
      owners(["reviewControls", "thread", "provisional", "provisionalRules"], ["launcher"]),
      () => {
        expect(terminalTabSelected.filter((entry) => entry.selected)).toEqual([]);
        expect(terminalTabSelected).toHaveLength(6);
        const sessions = serverModules.terminal.getSessions(PROJECT_ID, bench.id);
        expect(sessions.map((s) => s.id)).toEqual(server.sessions.map((s) => s.id));
        for (const session of sessions) {
          expect(
            serverModules.terminal.getSessionInputCount(session.id),
            `the input count of session ${session.id}`,
          ).toBe(0);
        }
        for (const pty of server.processes) {
          expect(pty.written).toEqual([]);
        }
      },
    );
  }, 60_000);
});
