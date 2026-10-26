// @vitest-environment jsdom
//
// Integration-level E2E test for the journey "Operator checks health and cost
// and reads the drift ledger" (SB-TC-056, SB-FR-018, SB-FR-019, SB-FR-020,
// SB-US-007). It asserts the authoritative e2e_flow case SB-TC-056 step for
// step, so a divergence is integration drift and not a re-specification.
//
// What runs for real: the Benches page (BenchDashboard and BenchesTab with the
// real BenchCard), the bench page (BenchDetail with the real Delivery tab, its
// health rail, map, and its view of cost, health and controls with the burn
// meter, the jam list, the drift ledger and the controls), the real React
// Query hooks, the real `lib/api` request layer and the real notification
// stream hook. The one stand-in is the network: `fetch` and `EventSource` reach
// an in-process Roubo server stand-in below, which answers each route the
// journey calls with the body and the status the real route answers
// (server/routes/benches.ts, server/routes/delivery.ts,
// server/routes/delivery-hooks.ts), and folds the record and the accepted
// events in the bench workspace through the shared delivery reducer as GET
// /delivery does. A request to any other route answers 404 and is listed in the
// failure output. The hooks and components that the journey does not cross
// (projects, integration, settings, plugins, terminals, logs, issue controls)
// are stubbed as in the page suites.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts, through the same create route the setup journey crosses, and
// the fake delivery tooling holds the launch descriptor it was handed. Started,
// it writes the record into the bench workspace, and the operator opens the
// bench on it. In the journey, the tooling posts cost rows, a jam event and a
// drift event with the token while the bench is open, and the delivery frame
// on the notification stream moves the Delivery tab.
//
// Failure-output contract: each SB-TC-056 step runs inside step(), which on a
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
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  type DeliveryEventsResponse,
  type DeliveryReadError,
  type DeliveryStreamFrame,
} from "@roubo/shared/delivery-bench";
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
// The blocked-by slices come first, by title and FR id. A slice that a step
// also crosses but that sits outside the blocked-by set is labelled apart.
const OWNERS = {
  costHealth:
    "Burn meter, jam flags, drift ledger and the stale indicator (SB-FR-018, SB-FR-019, SB-FR-020)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  ingest: "Delivery session launch, delivery token and event ingest (SB-FR-002)",
  deliveryTab: "Delivery tab with its map and health rail (SB-FR-009)",
  reducer: "reducer and selectors (SB-FR-008, SB-FR-010, SB-FR-011)",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => OUTSIDE_BLOCKED_BY[key]).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project and spec (SB-TC-056 preconditions) ──

const PROJECT_ID = "demo";
const REPO_PATH = "/repos/demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;
const JAMMED_UNIT = "B";
const SPEC_LAYER_PR = "https://github.com/demo/demo/pull/42";
const OLDER_PR = "https://github.com/demo/demo/pull/7";

// What the cost rows of the journey bring the burn to: B's run cost, and the
// coder's spend, which takes the delivery from 0.42 to 1.22 of a 5.00 budget.
const B_COST_USD = 0.8;
const CODER_SPEND_USD = 0.92;
const MAIN_SPEND_USD = 0.3;
const SPENT_USD = 1.22;

// The drift edit the tooling detects during the journey.
const DRIFT_FILE = "test-cases.json";
const DRIFT_SUMMARY = "Added a case for the retry path";
const DRIFT_IDS = ["FX-TC-004"];

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
// C, and gates after B and after C, as the session writes it while B runs: A is
// done at its cost, the delivery has spent 0.42 by role, and the drift ledger
// holds one earlier spec edit.
function initialRecord(): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  return {
    ...record,
    units: record.units.map((unit) => {
      if (unit.id === "A") return { ...unit, status: "done" };
      if (unit.id === JAMMED_UNIT) return { ...unit, status: "running" };
      return unit;
    }),
    budget: {
      ...record.budget,
      spent_usd: 0.42,
      by_role: { main: MAIN_SPEND_USD, "unit-coder": 0.12 },
    },
    drift: [
      {
        kind: "spec",
        detail: "Clarified a requirement",
        detected_at: now,
        file: "prd.md",
        summary: "Clarified a requirement",
        ids: [],
        pr_url: OLDER_PR,
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

// Step 1 of the case: cost rows (B's cost and the coder's spend), a jam event
// for B and a drift event with its spec-layer pull request.
function journeyEvents(): DeliveryEvent[] {
  const first = initialRecord().last_event_seq + 1;
  return [
    event(first, "unit.changed", { cost_usd: B_COST_USD }, JAMMED_UNIT),
    event(first + 1, "budget.changed", {
      spent_usd: SPENT_USD,
      by_role: { "unit-coder": CODER_SPEND_USD },
    }),
    event(first + 2, "unit.changed", { status: "jammed" }, JAMMED_UNIT),
    event(first + 3, "drift.detected", {
      kind: "spec",
      file: DRIFT_FILE,
      summary: DRIFT_SUMMARY,
      ids: DRIFT_IDS,
      pr_url: SPEC_LAYER_PR,
    }),
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

  // GET /delivery folds the record and the accepted events, as the real route
  // does.
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
// It holds the launch descriptor the stand-in hands it. Started, it writes the
// record into the bench workspace; then it posts its events to the event URL
// with the token.
class FakeDeliveryTooling {
  descriptor: LaunchDescriptor | undefined;
  private benchId: number | undefined;

  constructor(private readonly server: RouboServerStandIn) {}

  launched(descriptor: LaunchDescriptor): void {
    this.descriptor = descriptor;
    this.benchId = Number(new URL(descriptor.eventUrl).searchParams.get("benchId"));
  }

  private launch(): { descriptor: LaunchDescriptor; benchId: number } {
    const { descriptor, benchId } = this;
    if (descriptor === undefined || benchId === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
    return { descriptor, benchId };
  }

  start(record: DeliveryRecord): void {
    const { benchId } = this.launch();
    this.server.workspaceReady(benchId);
    this.server.writeWorkspaceRecord(benchId, record);
  }

  async post(events: DeliveryEvent[]): Promise<number> {
    const { descriptor } = this.launch();
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
      `SB-TC-056 step diverged: "${label}"\n` +
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
    throw new Error(`the create route answered ${res.status}: ${JSON.stringify(await res.json())}`);
  }
  return ((await res.json()) as Bench).id;
}

// The precondition: the bench's record is loaded and conformant, and the
// operator has the bench open on its Delivery tab.
async function openBenchOnLoadedRecord(
  user: ReturnType<typeof userEvent.setup>,
  tooling: FakeDeliveryTooling,
  benchId: number,
): Promise<void> {
  expect(server.launches).toHaveLength(1);
  tooling.start(initialRecord());
  await user.click(
    await screen.findByRole("link", { name: new RegExp(`Bench ${benchId}`) }, { timeout: 3000 }),
  );
  const deliveryTab = await screen.findByRole("tab", { name: /delivery/i });
  expect(deliveryTab).toHaveAttribute("aria-selected", "true");
  await waitFor(
    () => {
      expect(screen.getByTestId("delivery-health-chip")).toHaveAttribute("data-health", "fresh");
      expect(screen.getByTestId("delivery-stat-spent")).toHaveTextContent("0.42");
      expect(screen.getAllByTestId(/^delivery-drift-row-/)).toHaveLength(1);
    },
    { timeout: 3000 },
  );
}

function costHealthControlsView(): HTMLElement {
  return screen.getByRole("region", { name: "Cost, health and controls" });
}

function newDriftRow(): HTMLElement {
  return within(costHealthControlsView()).getByTestId("delivery-drift-row-1");
}

function col(row: HTMLElement, name: string): string {
  return row.querySelector(`[data-col="${name}"]`)?.textContent ?? "";
}

describe("Spec Bench health and cost journey", () => {
  it("SB-TC-056: Operator checks health and cost and reads the drift ledger", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling(server);
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const benchId = await setUpLaunchModeSpecBench();
    renderRoubo();
    await openBenchOnLoadedRecord(user, tooling, benchId);

    // Step 1 is a setup step: the tooling posts while the bench is open.
    await step(
      "1. Post cost rows, a jam event and a drift event",
      "the event endpoint accepts the tooling's cost rows, jam event and drift event with the token",
      owners(["costHealth"], ["ingest"]),
      async () => {
        expect(await tooling.post(journeyEvents())).toBe(202);
      },
    );

    await step(
      "2. Read the header",
      `the health chip shows the jam: blocked, with ${JAMMED_UNIT} jammed`,
      owners(["costHealth"], ["deliveryTab", "reducer"]),
      async () => {
        const rail = screen.getByRole("group", { name: "Delivery health" });
        await waitFor(
          () =>
            expect(within(rail).getByTestId("delivery-health-chip")).toHaveAttribute(
              "data-health",
              "blocked",
            ),
          { timeout: 3000 },
        );
        const chip = within(rail).getByTestId("delivery-health-chip");
        expect(chip).toHaveTextContent(`blocked · ${JAMMED_UNIT} jammed`);
      },
    );

    await step(
      "3. Open the cost, health and controls view",
      `the burn meter shows ${SPENT_USD.toFixed(2)} spent with B's ${B_COST_USD.toFixed(2)} and the coder's ${CODER_SPEND_USD.toFixed(2)}, the jam is listed with unit ${JAMMED_UNIT}, and the drift ledger shows the new ${DRIFT_FILE} row with its pull request`,
      owners(["costHealth"], ["deliveryTab", "reducer"]),
      async () => {
        await user.click(screen.getByRole("button", { name: "Cost, health and controls" }));
        const view = costHealthControlsView();
        expect(view).toHaveFocus();

        // The burn meter shows the new spend.
        const burn = within(view).getByTestId("delivery-burn");
        expect(within(burn).getByTestId("delivery-stat-spent")).toHaveTextContent(
          SPENT_USD.toFixed(2),
        );
        expect(within(burn).getByTestId("delivery-stat-spent")).toHaveTextContent(
          "of 5.00 soft budget",
        );
        expect(within(burn).getByTestId(`delivery-burn-unit-${JAMMED_UNIT}`)).toHaveTextContent(
          B_COST_USD.toFixed(2),
        );
        expect(within(burn).getByTestId("delivery-burn-role-unit-coder")).toHaveTextContent(
          CODER_SPEND_USD.toFixed(2),
        );
        expect(within(burn).getByTestId("delivery-burn-role-main")).toHaveTextContent(
          MAIN_SPEND_USD.toFixed(2),
        );

        // The jam is listed with its unit.
        const jams = within(view).getByRole("region", { name: "Jams" });
        const rows = within(jams).getAllByTestId(/^delivery-jam-row-/);
        expect(rows.map((row) => row.dataset.unit)).toEqual([JAMMED_UNIT]);
        expect(col(rows[0], "unit")).toBe(JAMMED_UNIT);
        expect(col(rows[0], "title")).toBe("Second");
        expect(col(rows[0], "status")).toBe("jammed");

        // The drift ledger shows the new row with its pull request.
        const ledger = within(view).getByRole("region", { name: "Drift ledger" });
        expect(within(ledger).getAllByTestId(/^delivery-drift-row-/)).toHaveLength(2);
        const row = newDriftRow();
        expect([col(row, "file"), col(row, "summary"), col(row, "ids")]).toEqual([
          DRIFT_FILE,
          DRIFT_SUMMARY,
          DRIFT_IDS.join(""),
        ]);
        expect(within(row).getByRole("link", { name: "Spec-layer pull request" })).toHaveAttribute(
          "href",
          SPEC_LAYER_PR,
        );
      },
    );

    await step(
      "4. Click the drift row's pull request",
      `it opens the spec-layer pull request ${SPEC_LAYER_PR} in a new window`,
      owners(["costHealth"]),
      async () => {
        const link = within(newDriftRow()).getByRole("link", { name: "Spec-layer pull request" });
        const opened: string[] = [];
        // The click's default action is the navigation; jsdom implements
        // none, so the listener records where the click goes and stops it.
        const onClick = (clicked: MouseEvent) => {
          const anchor = (clicked.target as Element | null)?.closest("a");
          if (anchor !== null && anchor !== undefined && !clicked.defaultPrevented) {
            opened.push(anchor.href);
            clicked.preventDefault();
          }
        };
        document.addEventListener("click", onClick);
        try {
          await user.click(link);
        } finally {
          document.removeEventListener("click", onClick);
        }
        expect(opened).toEqual([SPEC_LAYER_PR]);
        expect(link).toHaveAttribute("target", "_blank");
        expect(link.getAttribute("rel") ?? "").toContain("noopener");
      },
    );
  });
});
