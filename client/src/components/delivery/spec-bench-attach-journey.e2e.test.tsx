// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator attaches a Spec Bench to
// a delivery started elsewhere" (SB-TC-007, SB-FR-003, SB-FR-022, SB-US-002).
// It asserts the authoritative e2e_flow case SB-TC-007 step for step, so a
// divergence is integration drift and not a re-specification.
//
// What runs for real: the Benches page (BenchDashboard and BenchesTab with the
// real BenchCard and the real Set up Spec Bench dialog), the bench page
// (BenchDetail with the real Delivery tab, its health rail, map and lifecycle
// controls), the real React Query hooks, the real `lib/api` request layer and
// the real notification stream hook. `fetch` and `EventSource` reach an
// in-process Roubo server stand-in below.
//
// The resume of step 4 runs the real route: POST /delivery/resume goes through
// server/routes/delivery.ts, mounted in-process on an express app as
// server/index.ts mounts it and reached through supertest, as the route suites
// do. Behind it run the real record loader, over the committed record that the
// bench's workspace (a temporary folder) holds, the real event log and the real
// lifecycle check. The bench manager is a stand-in that hands the route the
// stand-in's benches, and the session launcher is a stand-in that keeps the
// options the route passes it and hands the fake tooling a launch descriptor
// built from them, so the resume argument the tooling holds is the one the real
// route built.
//
// The other routes the journey calls (server/routes/benches.ts, the reads of
// server/routes/delivery.ts, server/routes/delivery-hooks.ts,
// server/routes/specbench-specs.ts) are answered by the stand-in in the shape
// of their bodies and statuses: it folds the record and the accepted events
// through the shared delivery reducer as GET /delivery does, summarizes a
// record with the shared summary helper as the summary route does, and checks
// the delivery token on the event endpoint. It models the checkout's git state
// in two slots, the working tree and the commit a new bench's worktree starts
// from: the summary reads only the committed record, and a created bench's
// workspace holds only what its worktree checks out from that commit, never a
// working-tree copy. It does not run git, resolve the project's worktree source
// settings or provision a worktree; the route's own suite covers those. A
// request to any other route answers 404 and is listed in the failure output.
// The hooks and components that the journey does not cross (projects,
// integration, settings, plugins, terminals, logs, issue controls) are stubbed
// as in the page suites.
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, RegisteredProject } from "@roubo/shared";
import { SPEC_BENCH_BIND_MODES } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryEvent,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_FILE,
  summarizeSpecDelivery,
  type DeliveryEventsResponse,
  type DeliveryLaunchDescriptor,
  type DeliveryReadError,
  type DeliveryStreamFrame,
  type SpecBenchSpecSummary,
} from "@roubo/shared/delivery-bench";
import { fourUnitRecord } from "../../test/delivery-fixtures";

// ── Server services behind the real resume route ──
//
// The bench manager hands the route the stand-in's benches, and the session
// launcher hands the launch to the stand-in, with the options the route passed.
// The terminal service and persisted state stay out of this file, as in the
// route suites.

interface LaunchOptions {
  resume?: string;
}

const routeServices = vi.hoisted(() => ({
  benches: [] as Bench[],
  workspaceRoot: "",
  launch: undefined as
    ((bench: Bench, options?: LaunchOptions) => { sessionId?: string }) | undefined,
}));

vi.mock("../../../../server/services/bench-manager.js", () => ({
  getBench: vi.fn((projectId: string, benchId: number) =>
    routeServices.benches.find((bench) => bench.projectId === projectId && bench.id === benchId),
  ),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));
vi.mock("../../../../server/services/delivery-session-launcher.js", () => ({
  DeliveryLaunchBlockedError: class extends Error {},
  deliveryLaunchBlock: vi.fn(() => undefined),
  handOutDeliveryToken: vi.fn(),
  launchDeliverySession: vi.fn(async (bench: Bench, options?: LaunchOptions) => {
    if (routeServices.launch === undefined) throw new Error("no launcher stand-in is set");
    return routeServices.launch(bench, options);
  }),
  whenDeliveryBound: vi.fn(async () => undefined),
}));
vi.mock("../../../../server/services/terminal.js", () => ({
  getSession: vi.fn(),
  getSessionScrollback: vi.fn(),
}));
vi.mock("../../../../server/services/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, updateBench: vi.fn(), loadSettings: vi.fn(() => ({})) };
});

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
const REPO_PATH = "/repos/demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

function fixtureProject(): RegisteredProject {
  return {
    id: PROJECT_ID,
    repoPath: REPO_PATH,
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

// The real delivery router and event log, loaded once the mocks above are in
// place. The specifier is built at run time so that the client's type check,
// whose root is client/src, does not take in the server's sources; the shape
// the journey uses of each module is declared here.
const SERVER_ROOT = "../../../../server";

interface ServerModules {
  delivery: { default: express.Router };
  eventLog: { forgetDeliveryEventLog: () => void };
}

async function loadServerModule<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ `${SERVER_ROOT}/${file}`)) as T;
}

async function loadServerModules(): Promise<ServerModules> {
  return {
    delivery: await loadServerModule<ServerModules["delivery"]>("routes/delivery.js"),
    eventLog: await loadServerModule<ServerModules["eventLog"]>("services/delivery-event-log.js"),
  };
}

type SupertestMethod = (url: string) => request.Test;

class RouboServerStandIn {
  benches: Bench[] = [];
  createRequests: unknown[] = [];
  unrouted: string[] = [];
  launches: DeliveryLaunchDescriptor[] = [];
  // The options the real resume route passed to the session launcher.
  launcherOptions: (LaunchOptions | undefined)[] = [];
  private readonly app = express();
  private readonly workspaces: string;
  // The record in the spec folder of the checkout's working tree, and the
  // record committed at the commit a new bench's worktree starts from.
  private workingTreeRecord: DeliveryRecord | undefined;
  private committedRecord: DeliveryRecord | undefined;
  private records = new Map<number, DeliveryRecord>();
  private events = new Map<number, DeliveryEvent[]>();
  private tokens = new Map<number, string>();
  private streams: FakeEventSource[] = [];
  private onLaunch: ((descriptor: DeliveryLaunchDescriptor) => void) | undefined;

  // The delivery router mounted as server/index.ts mounts it, behind the
  // global JSON parser, with the stand-in's benches and launcher behind it.
  constructor(modules: ServerModules) {
    this.workspaces = mkdtempSync(join(routeServices.workspaceRoot, "server-"));
    this.app.use(express.json({ limit: "210kb" }));
    this.app.use("/api/projects", modules.delivery.default);
    routeServices.benches = this.benches;
    routeServices.launch = (bench, options) => {
      this.launcherOptions.push(options);
      this.launch(bench, options ?? {});
      return { sessionId: bench.deliverySessionId };
    };
  }

  setLaunchExecutor(onLaunch: (descriptor: DeliveryLaunchDescriptor) => void): void {
    this.onLaunch = onLaunch;
  }

  openStream(): FakeEventSource {
    const source: FakeEventSource = {
      onmessage: null,
      onerror: null,
      onopen: null,
      readyState: 1,
      close: () => {
        source.readyState = 2;
      },
    };
    this.streams.push(source);
    return source;
  }

  // A copy of the record into the spec folder of the checkout: the working
  // tree only.
  copyIntoCheckout(record: DeliveryRecord): void {
    this.workingTreeRecord = copy(record);
  }

  // A commit of the working tree's record on the branch a new bench's worktree
  // starts from.
  commitCheckoutRecord(): void {
    this.committedRecord = this.workingTreeRecord && copy(this.workingTreeRecord);
  }

  workspaceReady(benchId: number): void {
    const bench = this.benches.find((b) => b.id === benchId);
    if (bench) bench.status = "active";
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<StandInResponse> {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const base = `/api/projects/${PROJECT_ID}`;
    const path = url.pathname;
    let match: RegExpExecArray | null;

    if (method === "GET" && (path === `${base}/benches` || path === "/api/benches")) {
      return respond(200, copy(this.benches));
    }
    if (method === "POST" && path === `${base}/benches`) return this.createBench(body);
    if (method === "GET" && path === `${base}/testbench/specs`) {
      return respond(200, { specs: [discoveredFixtureSpec()], invalid: [] });
    }
    if (method === "GET" && path === `${base}/specbench/specs/${SPEC_SLUG}/summary`) {
      return respond(200, this.specSummary());
    }
    if ((match = new RegExp(`^${base}/benches/(\\d+)$`).exec(path)) && method === "GET") {
      const bench = this.benches.find((b) => b.id === Number(match?.[1]));
      return bench
        ? respond(200, copy(bench))
        : respond(404, { error: "Bench not found", code: "NOT_FOUND" });
    }
    if ((match = new RegExp(`^${base}/benches/(\\d+)/terminals$`).exec(path))) {
      return respond(200, []);
    }
    // Opening a bench clears its notifications; the fixture bench has none.
    if (
      (match = new RegExp(`^${base}/benches/(\\d+)/notifications$`).exec(path)) &&
      method === "DELETE"
    ) {
      return respond(200, []);
    }
    if ((match = new RegExp(`^${base}/benches/(\\d+)/delivery$`).exec(path)) && method === "GET") {
      return this.readDelivery(Number(match[1]));
    }
    if (
      (match = new RegExp(`^${base}/benches/(\\d+)/delivery/events$`).exec(path)) &&
      method === "GET"
    ) {
      return this.readEvents(Number(match[1]), url.searchParams);
    }
    if (new RegExp(`^${base}/benches/\\d+/delivery/resume$`).test(path) && method === "POST") {
      return this.routed(method, `${path}${url.search}`, init);
    }
    if (method === "POST" && path === DELIVERY_EVENT_HOOK_PATH) {
      return this.ingest(url.searchParams, headers.Authorization, body);
    }
    this.unrouted.push(`${method} ${path}${url.search}`);
    return respond(404, { error: `The stand-in serves no ${method} ${path}`, code: "NOT_FOUND" });
  }

  // A request that the real router answers, in-process, through supertest.
  private async routed(
    method: string,
    target: string,
    init: RequestInit | undefined,
  ): Promise<StandInResponse> {
    const agent = request(this.app) as unknown as Record<string, SupertestMethod>;
    let pending = agent[method.toLowerCase()](target);
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      pending = pending.set(name, value);
    }
    const res = typeof init?.body === "string" ? await pending.send(init.body) : await pending;
    return respond(res.status, res.body as unknown);
  }

  // GET /specbench/specs/fixture-spec/summary: the spec's unit and gate
  // counts, and the committed record only, never the working tree's.
  private specSummary(): SpecBenchSpecSummary {
    const plan = twoUnitsInRecord();
    const summary: SpecBenchSpecSummary = {
      slug: SPEC_SLUG,
      units: plan.units.length,
      gates: plan.stack.gates.length,
    };
    const validated =
      this.committedRecord === undefined ? undefined : validateDeliveryRecord(this.committedRecord);
    if (validated?.ok === true) summary.delivery = summarizeSpecDelivery(validated.data);
    return summary;
  }

  // POST /api/projects/:projectId/benches with variant specbench, as the real
  // route validates it. An attached bench launches nothing and mints nothing.
  // Its workspace, a temporary folder, holds what its worktree checks out: the
  // committed record, when there is one, and never the working tree's copy.
  private createBench(body: unknown): StandInResponse {
    this.createRequests.push(body);
    const request = (body ?? {}) as {
      variant?: unknown;
      focusedSpecPath?: unknown;
      delivery?: { mode?: unknown } | null;
    };
    if (request.variant !== "specbench") {
      return respond(400, { error: "The journey sets up a specbench variant", code: "INVALID" });
    }
    const mode = request.delivery?.mode;
    if (typeof mode !== "string" || !(SPEC_BENCH_BIND_MODES as readonly string[]).includes(mode)) {
      return respond(400, {
        error: `delivery.mode must be one of ${SPEC_BENCH_BIND_MODES.join(", ")} for a specbench variant`,
        code: "INVALID_DELIVERY",
      });
    }
    const folder = String(request.focusedSpecPath ?? "").replace(/\/+$/, "");
    if (folder !== SPEC_FOLDER && folder !== `${REPO_PATH}/${SPEC_FOLDER}`) {
      return respond(400, {
        error: `Invalid focusedSpecPath: no spec folder ${String(request.focusedSpecPath)}`,
        code: "INVALID_FOCUS",
      });
    }
    const id = this.benches.length + 1;
    const workspacePath = join(this.workspaces, `bench-${id}`);
    mkdirSync(join(workspacePath, SPEC_FOLDER), { recursive: true });
    const bench: Bench = {
      id,
      projectId: PROJECT_ID,
      branch: `bench-${id}`,
      workspacePath,
      status: "preparing",
      ports: {},
      components: {},
      createdAt: new Date().toISOString(),
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
      variant: "specbench",
      focusedSpecPath: `${REPO_PATH}/${SPEC_FOLDER}`,
      deliveryBindMode: mode as Bench["deliveryBindMode"],
    };
    this.benches.push(bench);
    if (this.committedRecord !== undefined) {
      this.records.set(id, copy(this.committedRecord));
      writeFileSync(
        join(workspacePath, SPEC_FOLDER, DELIVERY_RECORD_FILE),
        `${JSON.stringify(this.committedRecord, null, 2)}\n`,
      );
    }
    if (mode === "launch") this.launch(bench, {});
    return respond(201, copy(bench));
  }

  // The launch executor's side: a fresh token, the descriptor built from the
  // options the launch was given, and the session recorded on the bench.
  private launch(bench: Bench, options: { resume?: string }): DeliveryLaunchDescriptor {
    const token = `token-${bench.id}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(bench.id, token);
    bench.deliverySessionId = `delivery-session-${bench.id}-${this.launches.length + 1}`;
    const query = new URLSearchParams({ projectId: PROJECT_ID, benchId: String(bench.id) });
    const descriptor: DeliveryLaunchDescriptor = {
      eventUrl: `http://localhost:4000${DELIVERY_EVENT_HOOK_PATH}?${query.toString()}`,
      controlsUrl: `http://localhost:4000${DELIVERY_CONTROLS_HOOK_PATH}?${query.toString()}`,
      token,
      ...(options.resume !== undefined && { resume: options.resume }),
    };
    this.launches.push(descriptor);
    this.onLaunch?.(descriptor);
    return descriptor;
  }

  private loadRecord(
    benchId: number,
  ): { ok: true; record: DeliveryRecord } | { ok: false; error: DeliveryReadError } {
    const raw = this.records.get(benchId);
    if (raw === undefined) {
      return {
        ok: false,
        error: {
          code: "DELIVERY_RECORD_MISSING",
          error: "No delivery record yet in the spec folder of the bench workspace",
        },
      };
    }
    const validated = validateDeliveryRecord(raw);
    if (!validated.ok) {
      return {
        ok: false,
        error: { code: "DELIVERY_INVALID", error: validated.errors.join("; ") },
      };
    }
    return { ok: true, record: validated.data };
  }

  private readDelivery(benchId: number): StandInResponse {
    const loaded = this.loadRecord(benchId);
    if (!loaded.ok) return respond(409, loaded.error);
    const events = this.events.get(benchId) ?? [];
    return respond(200, foldDelivery({ record: loaded.record, events, now: Date.now() }));
  }

  private readEvents(benchId: number, query: URLSearchParams): StandInResponse {
    const loaded = this.loadRecord(benchId);
    if (!loaded.ok) return respond(409, loaded.error);
    const after = query.get("after");
    const unit = query.get("unit");
    const accepted = this.events.get(benchId) ?? [];
    const body: DeliveryEventsResponse = {
      events: accepted.filter(
        (item) =>
          (after === null || item.seq > Number(after)) && (unit === null || item.unit_id === unit),
      ),
      acceptedSeq: accepted.at(-1)?.seq ?? loaded.record.last_event_seq,
    };
    if (unit !== null) body.folded = 0;
    return respond(200, body);
  }

  // POST /api/hooks/delivery-event: the token first, then the envelopes, then
  // the sequence, then a delivery frame on the notification stream.
  private ingest(
    query: URLSearchParams,
    authorization: string | null,
    body: unknown,
  ): StandInResponse {
    const benchId = Number(query.get("benchId"));
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (
      query.get("projectId") !== PROJECT_ID ||
      token === undefined ||
      this.tokens.get(benchId) !== token
    ) {
      return respond(401, { error: "A valid delivery token is required", code: "UNAUTHORIZED" });
    }
    const raw =
      typeof body === "object" && body !== null && "events" in body
        ? (body as { events: unknown[] }).events
        : [body];
    const loaded = this.loadRecord(benchId);
    const accepted = this.events.get(benchId) ?? [];
    let seq = accepted.at(-1)?.seq ?? (loaded.ok ? loaded.record.last_event_seq : 0);
    for (const [index, item] of raw.entries()) {
      const validated = validateDeliveryEvent(item);
      if (!validated.ok) {
        return respond(400, {
          error: `Invalid delivery event at index ${index}: ${validated.errors.join("; ")}`,
          code: "INVALID_EVENT",
        });
      }
      if (validated.data.seq !== seq + 1) {
        return respond(409, {
          error: `Expected seq ${seq + 1}, got ${validated.data.seq}`,
          code: "SEQ_GAP",
        });
      }
      seq = validated.data.seq;
      accepted.push(validated.data);
    }
    this.events.set(benchId, accepted);
    const frame: DeliveryStreamFrame = {
      type: "delivery",
      projectId: PROJECT_ID,
      benchId,
      change: "snapshot",
      seq,
    };
    for (const stream of this.streams) {
      if (stream.readyState === 1) {
        stream.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
    }
    return respond(202, { acceptedSeq: seq });
  }
}

function discoveredFixtureSpec() {
  return {
    slug: SPEC_SLUG,
    path: `${REPO_PATH}/${SPEC_FOLDER}/test-cases.json`,
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
// It holds the launch descriptor the stand-in hands it on a resume, and posts
// its events to the event URL with the token.
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

function setupDialog(): HTMLElement {
  const dialog = screen.queryByRole("dialog", { name: /spec bench/i });
  if (!dialog) throw new Error("no dialog named Spec Bench is open");
  return dialog;
}

function healthChip(): HTMLElement {
  const rail = screen.getByRole("group", { name: "Delivery health" });
  return within(rail).getByTestId("delivery-health-chip");
}

let serverModules: ServerModules;

beforeAll(async () => {
  routeServices.workspaceRoot = mkdtempSync(join(tmpdir(), "spec-bench-attach-journey-"));
  serverModules = await loadServerModules();
});

afterAll(() => {
  rmSync(routeServices.workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
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
  vi.unstubAllGlobals();
  serverModules.eventLog.forgetDeliveryEventLog();
});

describe("Spec Bench attach journey", () => {
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
        server.copyIntoCheckout(record);
        server.commitCheckoutRecord();
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
        await user.click(await within(setupDialog()).findByText(SPEC_SLUG));
        await waitFor(() => {
          const dialog = setupDialog();
          const summary = within(dialog).queryByRole("region", { name: "Summary" });
          if (!summary) {
            throw new Error(
              `the dialog shows no Summary section; it reads "${dialog.textContent}"`,
            );
          }
          const shown = `the Summary reads "${summary.textContent ?? ""}"`;
          const scope = within(summary);
          expect(scope.getByTestId("specbench-setup-summary-mode"), shown).toHaveTextContent(
            /^Attach$/,
          );
          expect(scope.getByTestId("specbench-setup-summary-progress"), shown).toHaveTextContent(
            /^2 of 4 units done$/,
          );
          expect(scope.getByTestId("specbench-setup-summary-lifecycle"), shown).toHaveTextContent(
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
        await waitFor(() => expect(server.benches).toHaveLength(1), { timeout: 3000 });
        expect(server.createRequests.at(-1)).toMatchObject({
          variant: "specbench",
          focusedSpecPath: expect.stringContaining(SPEC_FOLDER),
          delivery: { mode: "attach" },
        });
        expect(server.launches, "an attach launched a session").toHaveLength(0);
        const created = server.benches[0].id;
        server.workspaceReady(created);
        await user.click(
          await screen.findByRole(
            "link",
            { name: new RegExp(`Bench ${created}`) },
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
        return created;
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
        const bench = server.benches.find((b) => b.id === benchId);
        // The options are what the real resume route passed to the launcher,
        // and the tooling's descriptor is built from them.
        expect(server.launcherOptions, "the options the resume route launched with").toEqual([
          { resume: record.delivery_id },
        ]);
        expect(tooling.descriptor?.resume).toBe(record.delivery_id);
        expect(bench?.deliverySessionId).toBeDefined();
        // No event has arrived yet, so the chip is not active.
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
    server.copyIntoCheckout(twoUnitsInRecord());
    renderRoubo();

    await user.click(await findSetUpSpecBench(user));
    await waitFor(() => setupDialog());
    await user.click(choice(setupDialog(), /^attach/i));
    await user.click(await within(setupDialog()).findByText(SPEC_SLUG));
    await waitFor(() =>
      expect(
        within(setupDialog()).getByTestId("specbench-setup-summary-delivery"),
      ).toHaveTextContent(/no committed delivery record/i),
    );
    expect(within(setupDialog()).queryByTestId("specbench-setup-summary-progress")).toBeNull();

    await user.click(choice(setupDialog(), /confirm|set up/i));
    await waitFor(() => expect(server.benches).toHaveLength(1), { timeout: 3000 });
    const read = await server.fetch(
      `/api/projects/${PROJECT_ID}/benches/${server.benches[0].id}/delivery`,
    );
    expect(read.status).toBe(409);
    expect(await read.json()).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });
  });
});
