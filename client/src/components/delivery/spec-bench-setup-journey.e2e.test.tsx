// @vitest-environment jsdom
//
// Integration-level E2E test for the journey "Operator sets up a Spec Bench from
// a specification and sees the delivery appear" (SB-TC-006, SB-FR-001,
// SB-FR-002, SB-FR-009, SB-US-001). It asserts the authoritative e2e_flow case
// SB-TC-006 step for step, so a divergence is integration drift and not a
// re-specification.
//
// What runs for real: the Benches page (BenchDashboard and BenchesTab with the
// real BenchCard and EmptyBenchCard), the bench page (BenchDetail with the real
// Delivery tab, map and health rail), the real React Query hooks, the real
// `lib/api` request layer and the real notification stream hook. The one stand-in
// is the network: `fetch` and `EventSource` reach an in-process Roubo server
// stand-in below, which answers each route the journey calls with the body and
// the status the real route answers (server/routes/benches.ts,
// server/routes/delivery.ts, server/routes/delivery-hooks.ts,
// server/routes/specbench-specs.ts), folds the record
// and the accepted events through the shared delivery reducer as GET /delivery
// does, and checks the delivery token on the event endpoint. A request to any
// other route answers 404 and is listed in the failure output, so a step that
// needs a route the stand-in does not serve says so. The hooks and components
// that the journey does not cross (projects, integration, settings, plugins,
// terminals, logs, issue controls) are stubbed as in the page suites.
//
// The fake delivery tooling is the launch executor's other side: when the
// stand-in launches the delivery session of a launch-mode bench, it hands the
// tooling the launch descriptor (event URL, controls URL, token). Started, the
// tooling writes the initial record into the bench workspace's spec folder, as
// the delivery session does, and posts its first event to the event URL with
// the token.
//
// Failure-output contract: each SB-TC-006 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  type DeliveryEventsResponse,
  type DeliveryReadError,
  type DeliveryStreamFrame,
  type SpecBenchSpecSummary,
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
  setup: "Spec Bench variant and its set up from a spec folder (SB-FR-001)",
  launch: "delivery session launch, delivery token and event ingest (SB-FR-002)",
  deliveryTab: "Delivery tab with its map and health rail (SB-FR-009)",
} as const;

// ── Fixture project (SB-TC-006 preconditions) ──

const PROJECT_ID = "demo";
const REPO_PATH = "/repos/demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;
const UNIT_IDS = ["A", "B", "C", "D"];

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
// C, and gates after B and after C. The session writes it before any unit
// starts, so every unit of the stack is still pending, and it is fresh.
function initialRecord(): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  return {
    ...record,
    units: record.units.map((unit) => (unit.id === "D" ? unit : { ...unit, status: "pending" })),
    health: { status: "ok", checked_at: now },
    updated_at: now,
  };
}

// The unit-started event. The observation contract names no `unit.started`
// type: a unit starts with the `unit.changed` event that sets it running.
function unitStarted(seq: number, unitId: string): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: initialRecord().delivery_id,
    type: "unit.changed",
    seq,
    ts: new Date().toISOString(),
    unit_id: unitId,
    payload: { status: "running" },
  };
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
  createRequests: unknown[] = [];
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
      return respond(200, { specs: [discoveredFixtureSpec()], invalid: [] });
    }
    if (method === "GET" && path === `${base}/specbench/specs/${SPEC_SLUG}/summary`) {
      return respond(200, fixtureSpecSummary());
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

  // POST /api/projects/:projectId/benches with variant specbench, as the real
  // route validates it, then the launch of a launch-mode bench's session.
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
    if (typeof request.focusedSpecPath !== "string" || request.focusedSpecPath.length === 0) {
      return respond(400, {
        error: "focusedSpecPath must be a non-empty string for a specbench variant",
        code: "INVALID_FOCUS",
      });
    }
    const mode = request.delivery?.mode;
    if (typeof mode !== "string" || !(SPEC_BENCH_BIND_MODES as readonly string[]).includes(mode)) {
      return respond(400, {
        error: `delivery.mode must be one of ${SPEC_BENCH_BIND_MODES.join(", ")} for a specbench variant`,
        code: "INVALID_DELIVERY",
      });
    }
    const folder = request.focusedSpecPath.replace(/\/+$/, "");
    if (folder !== SPEC_FOLDER && folder !== `${REPO_PATH}/${SPEC_FOLDER}`) {
      return respond(400, {
        error: `Invalid focusedSpecPath: no spec folder ${request.focusedSpecPath}`,
        code: "INVALID_FOCUS",
      });
    }
    const id = this.benches.length + 1;
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
      deliveryBindMode: mode as Bench["deliveryBindMode"],
    };
    this.benches.push(bench);
    if (mode === "launch") {
      const token = `token-${id}-${Math.random().toString(36).slice(2)}`;
      this.tokens.set(id, token);
      bench.deliverySessionId = `delivery-session-${id}`;
      const query = new URLSearchParams({ projectId: PROJECT_ID, benchId: String(id) });
      const descriptor: LaunchDescriptor = {
        eventUrl: `http://localhost:4000${DELIVERY_EVENT_HOOK_PATH}?${query.toString()}`,
        controlsUrl: `http://localhost:4000${DELIVERY_CONTROLS_HOOK_PATH}?${query.toString()}`,
        token,
      };
      this.launches.push(descriptor);
      this.onLaunch?.(descriptor);
    }
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
        (event) =>
          (after === null || event.seq > Number(after)) &&
          (unit === null || event.unit_id === unit),
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
      const event = validateDeliveryEvent(item);
      if (!event.ok) {
        return respond(400, {
          error: `Invalid delivery event at index ${index}: ${event.errors.join("; ")}`,
          code: "INVALID_EVENT",
        });
      }
      if (event.data.seq !== seq + 1) {
        return respond(409, {
          error: `Expected seq ${seq + 1}, got ${event.data.seq}`,
          code: "EVENT_SEQ_GAP",
        });
      }
      seq = event.data.seq;
      accepted.push(event.data);
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

// GET /specbench/specs/fixture-spec/summary, as the real route counts the
// spec's work-units.json: the fixture spec plans the record fixture's units
// and gates, so its delivery units and its verify gates are those of the record.
function fixtureSpecSummary(): SpecBenchSpecSummary {
  const record = initialRecord();
  return { slug: SPEC_SLUG, units: record.units.length, gates: record.stack.gates.length };
}

// ── The fake delivery tooling ──
//
// It holds the launch descriptor the stand-in hands it, and, started, writes
// the initial record and posts its events to the event URL with the token.
class FakeDeliveryTooling {
  descriptor: LaunchDescriptor | undefined;
  private benchId: number | undefined;

  constructor(private readonly server: RouboServerStandIn) {}

  launched(descriptor: LaunchDescriptor): void {
    this.descriptor = descriptor;
    this.benchId = Number(new URL(descriptor.eventUrl).searchParams.get("benchId"));
  }

  async start(record: DeliveryRecord, events: DeliveryEvent[]): Promise<number> {
    const { descriptor, benchId } = this;
    if (descriptor === undefined || benchId === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
    this.server.workspaceReady(benchId);
    this.server.writeWorkspaceRecord(benchId, record);
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
      `SB-TC-006 step diverged: "${label}"\n` +
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

// Step 3's expectation: the card of the new bench, with its badge and status.
async function expectPreparingSpecBenchCard(benchId: number): Promise<void> {
  const status = await screen.findByTestId("bench-card-status", {}, { timeout: 3000 });
  expect(status).toHaveTextContent("preparing");
  const card = status.closest<HTMLElement>("[data-testid='bench-card-frame']");
  if (!card) throw new Error("the bench status sits in no bench card");
  expect(within(card).getByText(`Bench ${benchId}`)).toBeInTheDocument();
  expect(within(card).getByTestId("bench-variant-badge")).toHaveTextContent("Spec Bench");
}

// Step 4: the tooling starts with the token that the launch handed it.
async function startTooling(tooling: FakeDeliveryTooling): Promise<void> {
  expect(server.launches).toHaveLength(1);
  const record = initialRecord();
  const status = await tooling.start(record, [unitStarted(record.last_event_seq + 1, "A")]);
  expect(status).toBe(202);
}

// Step 5: open the bench from its card and read the Delivery tab.
async function openBenchAndExpectDelivery(
  user: ReturnType<typeof userEvent.setup>,
  benchId: number,
): Promise<void> {
  await user.click(screen.getByRole("link", { name: new RegExp(`Bench ${benchId}`) }));
  const deliveryTab = await screen.findByRole("tab", { name: /delivery/i });
  expect(deliveryTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByRole("tab")[0]).toBe(deliveryTab);

  await waitFor(
    () => {
      const ids = screen
        .getAllByTestId(/^unit-node-/)
        .map((node) => node.dataset.testid?.slice("unit-node-".length));
      expect(ids.sort()).toEqual(UNIT_IDS);
      expect(screen.getByTestId("unit-node-A")).toHaveAttribute("data-status", "running");
    },
    { timeout: 3000 },
  );
  for (const id of UNIT_IDS.filter((unitId) => unitId !== "A")) {
    expect(screen.getByTestId(`unit-node-${id}`)).not.toHaveAttribute("data-status", "running");
  }

  const chip = screen.getByTestId("delivery-health-chip");
  expect(chip).toHaveAttribute("data-health", "fresh");
  expect(chip).toHaveTextContent("fresh");
}

describe("Spec Bench setup journey", () => {
  it("SB-TC-006: Operator sets up a Spec Bench from a specification and sees the delivery appear", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling(server);
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    renderRoubo();

    // Step 1 is a setup step: the Benches page opens the setup dialog.
    await step(
      "1. Open the Benches page and click Set up Spec Bench",
      "a Set up Spec Bench control on the Benches page that opens the setup dialog",
      OWNERS.setup,
      async () => {
        await user.click(await findSetUpSpecBench(user));
        await waitFor(() => setupDialog());
      },
    );

    await step(
      "2. Pick fixture-spec in the dialog and choose Launch",
      "the dialog shows the spec fixture-spec, the mode Launch and a summary of 4 units and 2 gates",
      OWNERS.setup,
      async () => {
        await user.click(await within(setupDialog()).findByText(SPEC_SLUG));
        await user.click(choice(setupDialog(), /^launch/i));
        await waitFor(() => {
          const dialog = setupDialog();
          const text = dialog.textContent ?? "";
          const shown = `the dialog reads "${text}"`;
          // textContent runs the text of neighbouring elements together, so the
          // counts are matched element by element, as the operator reads them.
          const reads = (pattern: RegExp) => within(dialog).queryAllByText(pattern).length > 0;
          expect(text, shown).toContain(SPEC_SLUG);
          expect(text, shown).toMatch(/launch/i);
          expect(reads(/\b4 units\b/i), shown).toBe(true);
          expect(reads(/\b2 gates\b/i), shown).toBe(true);
        });
      },
    );

    const benchId = await step(
      "3. Confirm",
      "a new bench card appears with the Spec Bench variant badge and a preparing status",
      OWNERS.setup,
      async () => {
        await user.click(choice(setupDialog(), /confirm|set up/i));
        await waitFor(() => expect(server.benches).toHaveLength(1), { timeout: 3000 });
        expect(server.createRequests.at(-1)).toMatchObject({
          variant: "specbench",
          focusedSpecPath: expect.stringContaining(SPEC_FOLDER),
          delivery: { mode: "launch" },
        });
        const created = server.benches[0].id;
        await expectPreparingSpecBenchCard(created);
        return created;
      },
    );

    // Step 4 is a setup step: the tooling starts with the token it was handed.
    await step(
      "4. Start the fake tooling with the token and post the initial record and a unit.started event",
      "the launch handed the tooling a token, and the event endpoint accepted its event with it",
      OWNERS.launch,
      () => startTooling(tooling),
    );

    await step(
      "5. Open the bench",
      "the Delivery tab is the default tab, the map shows four units with A active, and the health chip shows the delivery state",
      `${OWNERS.deliveryTab}, ${OWNERS.launch}`,
      () => openBenchAndExpectDelivery(user, benchId),
    );
  });
});
