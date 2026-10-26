// @vitest-environment jsdom
//
// Integration-level E2E test for the journey "Operator reads where the delivery
// stands from the map and progress" (SB-TC-026, SB-FR-010, SB-FR-011,
// SB-US-003). It asserts the authoritative e2e_flow case SB-TC-026 step for
// step, so a divergence is integration drift and not a re-specification.
//
// What runs for real: the Benches page (BenchDashboard and BenchesTab with the
// real BenchCard), the bench page (BenchDetail with the real Delivery tab, its
// health rail, progress stats, map, list and unit drill-in), the real React
// Query hooks, the real `lib/api` request layer and the real notification
// stream hook. The one stand-in is the network: `fetch` and `EventSource` reach
// an in-process Roubo server stand-in below, which answers each route the
// journey calls with the body and the status the real route answers
// (server/routes/benches.ts, server/routes/delivery.ts,
// server/routes/delivery-hooks.ts), and folds the record, the accepted events
// and the spec's plan and results in the bench workspace through the shared
// delivery reducer as GET /delivery does. A request to any other route answers
// 404 and is listed in the failure output. The hooks and components that the
// journey does not cross (projects, integration, settings, plugins, terminals,
// logs, issue controls) are stubbed as in the page suites, and so is the live
// terminal that a running unit's drill-in embeds.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts, through the same create route the setup journey crosses, and
// the fake delivery tooling holds the launch descriptor it was handed. Started,
// it writes the record into the bench workspace and posts the events that take
// units A and B to done and pass the gate after B, with the token.
//
// Failure-output contract: each SB-TC-026 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, RegisteredProject } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryEvent,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, type DeliveryResults } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  type DeliveryEventsResponse,
  type DeliveryReadError,
  type DeliveryStreamFrame,
  type DeliveryUnitDiffResponse,
} from "@roubo/shared/delivery-bench";
import type { CaseResult, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import { fourUnitRecord } from "../../test/delivery-fixtures";

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
const OWNERS = {
  launch: "delivery session launch, delivery token and event ingest (SB-FR-002)",
  deliveryTab: "Delivery tab with its map and health rail (SB-FR-009)",
  map: "delivery map with its graph and list views and gate markers (SB-FR-010)",
  progress: "progress in cases met and requirements covered (SB-FR-011)",
  drillIn: "unit drill-in with its timeline, terminal, diff and verify (SB-FR-013)",
  health: "delivery health chip and staleness (SB-FR-019)",
} as const;

// ── Fixture project and spec (SB-TC-026 preconditions) ──

const PROJECT_ID = "demo";
const REPO_PATH = "/repos/demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;
const UNIT_IDS = ["A", "B", "C", "D"];
const GATE_AFTER_B = "gate-after-b";
const GATE_AFTER_C = "gate-after-c";
const CASES_AFTER_B = ["FX-TC-001", "FX-TC-002"];
const CASES_AFTER_C = ["FX-TC-003"];

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
// C, and gates after B and after C, as the session writes it before any unit of
// the stack starts. The gate after B gates two cases, the gate after C one.
function initialRecord(): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  return {
    ...record,
    units: record.units.map((unit) => (unit.id === "D" ? unit : { ...unit, status: "pending" })),
    stack: {
      ...record.stack,
      gates: [
        { id: GATE_AFTER_B, after: ["B"], status: "pending", cases: CASES_AFTER_B },
        { id: GATE_AFTER_C, after: ["C"], status: "pending", cases: CASES_AFTER_C },
      ],
    },
    health: { status: "ok", checked_at: now },
    updated_at: now,
  };
}

// The spec's test plan: the two cases of the gate after B cover FX-FR-001, and
// the case of the gate after C covers FX-FR-002.
function fixturePlan(): TestCasesPlan {
  const linked: Record<string, string> = {
    "FX-TC-001": "FX-FR-001",
    "FX-TC-002": "FX-FR-001",
    "FX-TC-003": "FX-FR-002",
  };
  return {
    $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
    schemaVersion: "1.2.0",
    specSlug: SPEC_SLUG,
    cases: Object.entries(linked).map(([id, requirement]) => ({
      id,
      title: id,
      area: "fixture",
      level: 1,
      type: "functional",
      steps: [],
      tags: [],
      linked_requirement_ids: [requirement],
      linked_user_story_ids: [],
    })),
  };
}

// The results the verifier recorded when the gate after B passed: both of its
// cases passed, and the case of the gate after C has no result yet.
function gateAfterBResults(): DeliveryResults {
  const passed: CaseResult = {
    observationMarks: {},
    derivedStatus: "passed",
    notes: [],
  };
  return {
    planHash: initialRecord().plan_hash,
    updatedAt: new Date().toISOString(),
    caseResults: Object.fromEntries(CASES_AFTER_B.map((id) => [id, passed])),
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

// What the tooling posts by the time the operator opens the bench: A and B run
// and finish, the gate after B passes, and C starts.
function deliveryEvents(): DeliveryEvent[] {
  const first = initialRecord().last_event_seq + 1;
  return [
    event(first, "unit.changed", { status: "running" }, "A"),
    event(first + 1, "unit.changed", { status: "done" }, "A"),
    event(first + 2, "unit.changed", { status: "running" }, "B"),
    event(first + 3, "unit.changed", { status: "done" }, "B"),
    event(first + 4, "gate.changed", { gate_id: GATE_AFTER_B, status: "passed" }),
    event(first + 5, "unit.changed", { status: "running" }, "C"),
  ];
}

// ── The network stand-in ──

interface LaunchDescriptor {
  eventUrl: string;
  controlsUrl: string;
  token: string;
}

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

class RouboServerStandIn {
  benches: Bench[] = [];
  unrouted: string[] = [];
  launches: LaunchDescriptor[] = [];
  private records = new Map<number, DeliveryRecord>();
  private verifyInputs = new Map<number, { plan: TestCasesPlan; results: DeliveryResults }>();
  private events = new Map<number, DeliveryEvent[]>();
  private tokens = new Map<number, string>();
  private streams: FakeEventSource[] = [];
  private onLaunch: ((descriptor: LaunchDescriptor) => void) | undefined;

  setLaunchExecutor(onLaunch: (descriptor: LaunchDescriptor) => void): void {
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

  // What the delivery session does when it starts: it writes the record into
  // the spec folder of the bench workspace.
  writeWorkspaceRecord(benchId: number, record: DeliveryRecord): void {
    this.records.set(benchId, record);
  }

  // The spec's test-cases.json and test-results.json in the bench workspace.
  writeWorkspaceVerify(benchId: number, plan: TestCasesPlan, results: DeliveryResults): void {
    this.verifyInputs.set(benchId, { plan, results });
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
      return respond(200, { specs: [], invalid: [] });
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
    if (
      (match = new RegExp(`^${base}/benches/(\\d+)/delivery/units/([^/]+)/diff$`).exec(path)) &&
      method === "GET"
    ) {
      return this.readDiff(Number(match[1]), decodeURIComponent(match[2]));
    }
    if (method === "POST" && path === DELIVERY_EVENT_HOOK_PATH) {
      return this.ingest(url.searchParams, headers.Authorization, body);
    }
    this.unrouted.push(`${method} ${path}${url.search}`);
    return respond(404, { error: `The stand-in serves no ${method} ${path}`, code: "NOT_FOUND" });
  }

  // POST /api/projects/:projectId/benches with variant specbench in launch
  // mode, then the launch of the bench's delivery session.
  private createBench(body: unknown): StandInResponse {
    const request = (body ?? {}) as {
      variant?: unknown;
      focusedSpecPath?: unknown;
      delivery?: { mode?: unknown } | null;
    };
    if (
      request.variant !== "specbench" ||
      request.focusedSpecPath !== SPEC_FOLDER ||
      request.delivery?.mode !== "launch"
    ) {
      return respond(400, {
        error: "The journey sets up a launch-mode specbench from fixture-spec",
        code: "INVALID",
      });
    }
    const id = this.benches.length + 1;
    const token = `token-${id}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(id, token);
    const bench: Bench = {
      id,
      projectId: PROJECT_ID,
      branch: `bench-${id}`,
      workspacePath: `/workspaces/${PROJECT_ID}/bench-${id}`,
      status: "preparing",
      ports: {},
      components: {},
      createdAt: new Date().toISOString(),
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
      variant: "specbench",
      focusedSpecPath: `${REPO_PATH}/${SPEC_FOLDER}`,
      deliveryBindMode: "launch",
      deliverySessionId: `delivery-session-${id}`,
    };
    this.benches.push(bench);
    const query = new URLSearchParams({ projectId: PROJECT_ID, benchId: String(id) });
    const descriptor: LaunchDescriptor = {
      eventUrl: `http://localhost:4000${DELIVERY_EVENT_HOOK_PATH}?${query.toString()}`,
      controlsUrl: `http://localhost:4000${DELIVERY_CONTROLS_HOOK_PATH}?${query.toString()}`,
      token,
    };
    this.launches.push(descriptor);
    this.onLaunch?.(descriptor);
    return respond(201, copy(bench));
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
          error: "The delivery session has not written the delivery record yet",
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

  // GET /delivery folds the record, the accepted events and the spec's plan and
  // results in the workspace, as the real route does.
  private readDelivery(benchId: number): StandInResponse {
    const loaded = this.loadRecord(benchId);
    if (!loaded.ok) return respond(409, loaded.error);
    const events = this.events.get(benchId) ?? [];
    const verify = this.verifyInputs.get(benchId);
    return respond(
      200,
      foldDelivery({ record: loaded.record, events, ...verify, now: Date.now() }),
    );
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

  // GET /delivery/units/:unitId/diff: no unit of the fixture has a head yet.
  private readDiff(benchId: number, unitId: string): StandInResponse {
    const loaded = this.loadRecord(benchId);
    if (!loaded.ok) return respond(409, loaded.error);
    if (!loaded.record.units.some((unit) => unit.id === unitId)) {
      return respond(404, { error: `No unit ${unitId}`, code: "UNIT_NOT_FOUND" });
    }
    const body: DeliveryUnitDiffResponse = {
      unit: unitId,
      base: null,
      head: null,
      diff: "",
      truncated: false,
    };
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
          code: "EVENT_SEQ_GAP",
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

// ── The fake delivery tooling ──
//
// It holds the launch descriptor the stand-in hands it, and, started, writes
// the record into the bench workspace and posts its events to the event URL
// with the token. The verify seam of the gate after B wrote the plan and the
// results beside the record.
class FakeDeliveryTooling {
  descriptor: LaunchDescriptor | undefined;
  private benchId: number | undefined;

  constructor(private readonly server: RouboServerStandIn) {}

  launched(descriptor: LaunchDescriptor): void {
    this.descriptor = descriptor;
    this.benchId = Number(new URL(descriptor.eventUrl).searchParams.get("benchId"));
  }

  async start(
    record: DeliveryRecord,
    verify: { plan: TestCasesPlan; results: DeliveryResults },
    events: DeliveryEvent[],
  ): Promise<number> {
    const { descriptor, benchId } = this;
    if (descriptor === undefined || benchId === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
    this.server.workspaceReady(benchId);
    this.server.writeWorkspaceRecord(benchId, record);
    this.server.writeWorkspaceVerify(benchId, verify.plan, verify.results);
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
  owners: string,
  body: () => T | Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    const unrouted =
      server.unrouted.length > 0 ? `\n  unserved requests: ${server.unrouted.join(", ")}` : "";
    throw new Error(
      `SB-TC-026 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${owners}${unrouted}`,
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

beforeEach(() => {
  localStorage.clear();
  server = new RouboServerStandIn();
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
});

// The precondition: a Spec Bench set up from fixture-spec in launch mode.
async function setUpLaunchModeSpecBench(): Promise<number> {
  const res = await fetch(`/api/projects/${PROJECT_ID}/benches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: "specbench",
      focusedSpecPath: SPEC_FOLDER,
      delivery: { mode: "launch" },
    }),
  });
  if (res.status !== 201) {
    throw new Error(
      `the create route answered ${res.status}: ${JSON.stringify(await res.json())}`,
    );
  }
  return ((await res.json()) as Bench).id;
}

// What a unit node of the graph reads, to compare with its list row.
interface UnitReading {
  name: string;
  status: string;
}

function graphReadings(): Map<string, UnitReading> {
  const readings = new Map<string, UnitReading>();
  for (const id of UNIT_IDS) {
    const node = screen.getByTestId(`unit-node-${id}`);
    readings.set(id, {
      name: node.getAttribute("aria-label") ?? "",
      status: node.dataset.status ?? "",
    });
  }
  return readings;
}

// Step 1: the tooling has taken A and B to done and passed the gate after B,
// and the operator opens the bench from its card.
async function openBenchAfterGateAfterB(
  user: ReturnType<typeof userEvent.setup>,
  tooling: FakeDeliveryTooling,
  benchId: number,
): Promise<void> {
  expect(server.launches).toHaveLength(1);
  const status = await tooling.start(
    initialRecord(),
    { plan: fixturePlan(), results: gateAfterBResults() },
    deliveryEvents(),
  );
  expect(status).toBe(202);
  await user.click(
    await screen.findByRole("link", { name: new RegExp(`Bench ${benchId}`) }, { timeout: 3000 }),
  );
  const deliveryTab = await screen.findByRole("tab", { name: /delivery/i });
  expect(deliveryTab).toHaveAttribute("aria-selected", "true");
  await waitFor(
    () => {
      expect(screen.getByTestId("unit-node-A")).toHaveAttribute("data-status", "done");
      expect(screen.getByTestId("unit-node-B")).toHaveAttribute("data-status", "done");
      expect(screen.getByTestId(`gate-marker-${GATE_AFTER_B}`)).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
}

describe("Spec Bench progress journey", () => {
  it("SB-TC-026: Operator reads where the delivery stands from the map and progress", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling(server);
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const benchId = await setUpLaunchModeSpecBench();
    renderRoubo();

    // Step 1 is a setup step: the delivery has moved on before the bench opens.
    await step(
      "1. Open the bench after two units are done and one gate has passed",
      "the event endpoint accepts the tooling's events, and the bench opens on its Delivery tab with A and B done",
      `${OWNERS.launch}, ${OWNERS.deliveryTab}`,
      () => openBenchAfterGateAfterB(user, tooling, benchId),
    );

    await step(
      "2. Read the header",
      "the health chip shows the delivery state, and the progress stat shows cases met and requirements covered",
      `${OWNERS.health}, ${OWNERS.progress}`,
      () => {
        const rail = screen.getByRole("group", { name: "Delivery health" });
        const chip = within(rail).getByTestId("delivery-health-chip");
        expect(chip).toHaveAttribute("data-health", "fresh");
        expect(chip).toHaveTextContent("fresh");
        // Two of the three gating cases are met; FX-FR-001 is covered by both
        // cases of the gate after B, and FX-FR-002 waits on the gate after C.
        expect(screen.getByTestId("delivery-stat-cases")).toHaveTextContent("2 of 3 cases met");
        expect(screen.getByTestId("delivery-stat-requirements")).toHaveTextContent(
          "1 of 2 requirements covered",
        );
      },
    );

    await step(
      "3. Hover the gate after B",
      `the gate after B shows passed and the count of cases it gated (${CASES_AFTER_B.length})`,
      OWNERS.map,
      async () => {
        const marker = screen.getByTestId(`gate-marker-${GATE_AFTER_B}`);
        await user.hover(marker);
        const shown = within(screen.getByTestId("delivery-graph")).queryByRole("tooltip");
        if (!shown) {
          throw new Error(
            `hovering the gate after B shows nothing more; the marker reads "${marker.textContent ?? ""}"`,
          );
        }
        expect(shown).toHaveTextContent(/\bpassed\b/);
        expect(shown).toHaveTextContent(new RegExp(`\\b${CASES_AFTER_B.length} cases\\b`));
        expect(marker).toHaveTextContent("passed");
        await user.unhover(marker);
      },
    );

    const graph = await step(
      "4. Click unit C",
      "the drill-in of unit C opens on C's timeline, which holds C's events",
      `${OWNERS.drillIn}, ${OWNERS.map}`,
      async () => {
        const readings = graphReadings();
        await user.click(screen.getByTestId("unit-node-C"));
        const drillIn = await screen.findByRole("region", { name: "Unit C" });
        const panels = within(drillIn).getByTestId("unit-drill-in");
        const timeline = within(panels).getByRole("region", { name: "Timeline of unit C" });
        expect(within(panels).getAllByRole("region")[0]).toBe(timeline);
        const ofC = deliveryEvents()
          .filter((item) => item.unit_id === "C")
          .map((item) => item.seq);
        const newest = `timeline-event-${ofC.at(-1) ?? -1}`;
        await waitFor(() => expect(within(timeline).getByTestId(newest)).toBeInTheDocument());
        const rows = within(timeline).getAllByTestId(/^timeline-event-/);
        const seqs = rows.map((row) => Number(row.dataset.seq));
        expect(seqs.sort((a, b) => a - b)).toEqual(ofC);
        return readings;
      },
    );

    await step(
      "5. Return to the map and switch to list view",
      "the list shows one row per unit with the same status, stack and layer as the graph, and B's row names the gate after B as passed",
      OWNERS.map,
      async () => {
        const drillIn = screen.getByRole("region", { name: "Unit C" });
        await user.click(within(drillIn).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("region", { name: "Unit C" })).not.toBeInTheDocument();
        const views = screen.getByRole("group", { name: "Map view" });
        await user.click(within(views).getByRole("button", { name: "List" }));
        const list = await screen.findByTestId("delivery-list");
        expect(screen.queryByTestId("delivery-graph")).not.toBeInTheDocument();
        const row = (id: string) => within(list).getByTestId(`unit-row-${id}`);
        const rows = within(list).getAllByTestId(/^unit-row-/);
        const rowIds = rows.map((item) => item.dataset.testid?.slice("unit-row-".length));
        expect(rowIds.sort()).toEqual(UNIT_IDS);
        for (const id of UNIT_IDS) {
          const reading = graph.get(id);
          expect(row(id)).toHaveAttribute("data-status", reading?.status);
          expect(row(id).getAttribute("aria-label") ?? "").toContain(reading?.name ?? "");
        }
        expect(row("A")).toHaveAttribute("data-status", "done");
        expect(row("B")).toHaveAttribute("data-status", "done");
        expect(row("B")).toHaveTextContent(`${GATE_AFTER_B} · passed`);
        expect(row("C")).toHaveTextContent(`${GATE_AFTER_C} · pending`);
      },
    );
  });
});
