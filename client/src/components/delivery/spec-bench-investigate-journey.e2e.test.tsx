// @vitest-environment jsdom
//
// Integration-level E2E test for the journey "Operator investigates a failed
// unit from timeline to diff" (SB-TC-034, SB-FR-013, SB-US-004). It asserts the
// authoritative e2e_flow case SB-TC-034 step for step, so a divergence is
// integration drift and not a re-specification.
//
// What runs for real: the Benches page (BenchDashboard and BenchesTab with the
// real BenchCard), the bench page (BenchDetail with the real Delivery tab, its
// map and the unit drill-in with its timeline, recorded terminal, Diff and
// Verify panels), the real React Query hooks, the real `lib/api` request layer
// and the real notification stream hook. The one stand-in is the network:
// `fetch` and `EventSource` reach an in-process Roubo server stand-in below,
// which answers each route the journey calls with the body and the status the
// real route answers (server/routes/benches.ts, server/routes/delivery.ts,
// server/routes/delivery-hooks.ts), and folds the record, the accepted events
// and the spec's plan and results in the bench workspace through the shared
// delivery reducer as GET /delivery does. A request to any other route answers
// 404 and is listed in the failure output. The hooks and components that the
// journey does not cross (projects, integration, settings, plugins, terminals,
// logs, issue controls) are stubbed as in the page suites.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts, through the same create route the setup journey crosses, and
// the fake delivery tooling holds the launch descriptor it was handed. Started,
// it writes the record into the bench workspace, writes its output to the
// delivery session terminal, and posts the events that take A to done, commit
// B's layer, fail the gate after B and end B in a failed review, with the
// token.
//
// Failure-output contract: each SB-TC-034 step runs inside step(), which on a
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
import { foldDelivery, ownValue, type DeliveryResults } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  type DeliveryEventsResponse,
  type DeliveryReadError,
  type DeliveryStreamFrame,
  type DeliveryUnitDiffResponse,
  type DeliveryUnitTranscriptResponse,
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
// The blocked-by slices come first, by title and FR id. A slice that a step
// also crosses but that sits outside the blocked-by set is labelled apart.
const OWNERS = {
  drillIn:
    "Unit drill-in with timeline, terminal beside it, and diff and verify beneath (SB-FR-013)",
  routes: "Delivery snapshot and events routes (SB-FR-008, SB-FR-013)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  launch: "delivery session launch, delivery token and event ingest (SB-FR-002)",
  deliveryTab: "Delivery tab with its map and health rail (SB-FR-009)",
  map: "delivery map graph and list views (SB-FR-010)",
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

// ── Fixture project and spec (SB-TC-034 preconditions) ──

const PROJECT_ID = "demo";
const REPO_PATH = "/repos/demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;
const GATE_AFTER_B = "gate-after-b";
const GATE_AFTER_C = "gate-after-c";
const CASES_AFTER_B = ["FX-TC-001", "FX-TC-002"];
const CASES_AFTER_C = ["FX-TC-003"];
const FAILED_CASE = "FX-TC-001";
const PASSED_CASE = "FX-TC-002";

// The commits the session made: A's layer, B's layer on top of it, and the
// base of the stack below A.
const STACK_BASE = "0000aaaa1111bbbb2222cccc3333dddd4444eeee";
const A_HEAD = "a1a1a1a1b2b2b2b2c3c3c3c3d4d4d4d4e5e5e5e5";
const B_HEAD = "b7b7b7b7c8c8c8c8d9d9d9d9e0e0e0e0f1f1f1f1";
const B_LAYER_DIFF =
  "diff --git a/src/second.ts b/src/second.ts\n" +
  "--- a/src/second.ts\n" +
  "+++ b/src/second.ts\n" +
  "@@ -1 +1 @@\n" +
  "-export const second = 2;\n" +
  "+export const second = 3;\n";

// What B's failed review reports, as its event and its terminal both say it.
const FAILURE_SUMMARY = "Review failed: FX-TC-001 expected 2, got 3";
const FAILED_EVIDENCE = "vitest report: FX-TC-001 expected 2, got 3 (src/second.test.ts:12)";
const FAILED_NOTE = "The second layer changes the value the case reads.";

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

// The results the verifier recorded when the gate after B failed: one of its
// cases failed, with the suite evidence and a note, and the other passed.
function gateAfterBResults(): DeliveryResults {
  const author = { name: "verifier", email: "verifier@example.test" };
  const timestamp = new Date().toISOString();
  const failed: CaseResult = {
    observationMarks: {},
    derivedStatus: "failed",
    verification: {
      tier: "b",
      confidence: "high",
      evidence: [FAILED_EVIDENCE],
      author,
      timestamp,
    },
    notes: [{ id: "note-1", text: FAILED_NOTE, author, timestamp, statusAtWrite: "failed" }],
  };
  const passed: CaseResult = { observationMarks: {}, derivedStatus: "passed", notes: [] };
  return {
    planHash: initialRecord().plan_hash,
    updatedAt: timestamp,
    caseResults: { [FAILED_CASE]: failed, [PASSED_CASE]: passed },
  };
}

const START = Date.parse("2026-10-16T09:40:00Z");

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
    ts: new Date(START + seq * 1_000).toISOString(),
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

// Step 1: the events the tooling posts for B. A finishes its layer, B commits
// its layer, the gate after B fails, and B's review fails on it.
function deliveryEvents(): DeliveryEvent[] {
  const first = initialRecord().last_event_seq + 1;
  return [
    event(first, "unit.changed", { status: "running" }, "A"),
    event(first + 1, "unit.changed", { status: "done", head: A_HEAD }, "A"),
    event(first + 2, "unit.changed", { status: "running" }, "B"),
    event(first + 3, "unit.changed", { head: B_HEAD, summary: "Committed the second layer" }, "B"),
    event(first + 4, "gate.changed", { gate_id: GATE_AFTER_B, status: "failed" }),
    event(first + 5, "unit.changed", { status: "failed", summary: FAILURE_SUMMARY }, "B"),
  ];
}

function failureEvent(): DeliveryEvent {
  const last = deliveryEvents().at(-1);
  if (last === undefined) throw new Error("the fixture posts no event");
  return last;
}

// What the delivery session terminal wrote while it worked on B, colour
// escapes included, with the failure among other output.
const B_TERMINAL_OUTPUT = [
  "$ git commit -m 'second layer'\r\n",
  "[b-layer b7b7b7b7] second layer\r\n",
  "$ npm test\r\n",
  "\x1b[32m PASS \x1b[0m FX-TC-002\r\n",
  "\x1b[31m FAIL \x1b[0m FX-TC-001 expected 2, got 3\r\n",
  `${FAILURE_SUMMARY}\r\n`,
  "Waiting for the operator.\r\n",
];

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
  diffs: Array<{ unit: string; base: string | null; head: string | null }> = [];
  private records = new Map<number, DeliveryRecord>();
  private verifyInputs = new Map<number, { plan: TestCasesPlan; results: DeliveryResults }>();
  private events = new Map<number, DeliveryEvent[]>();
  private scrollback = new Map<number, string[]>();
  private layerDiffs = new Map<string, string>();
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

  // What the delivery session writes to its terminal: the scrollback the
  // transcript route cuts by the unit's span.
  writeSessionOutput(benchId: number, lines: string[]): void {
    this.scrollback.set(benchId, [...(this.scrollback.get(benchId) ?? []), ...lines]);
  }

  // A commit range in the bench workspace, as `git diff <base> <head>` prints it.
  commitLayer(base: string, head: string, diff: string): void {
    this.layerDiffs.set(`${base}..${head}`, diff);
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
    if (
      (match = new RegExp(`^${base}/benches/(\\d+)/delivery/units/([^/]+)/transcript$`).exec(
        path,
      )) &&
      method === "GET"
    ) {
      return this.readTranscript(Number(match[1]), decodeURIComponent(match[2]));
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

  // GET /delivery/units/:unitId/diff: `git diff <base> <head>` from the head of
  // the unit below in its stack (or the stack base) to the unit's head, both as
  // the fold of the record and the accepted events reads them.
  private readDiff(benchId: number, unitId: string): StandInResponse {
    const loaded = this.loadRecord(benchId);
    if (!loaded.ok) return respond(409, loaded.error);
    const snapshot = foldDelivery({
      record: loaded.record,
      events: this.events.get(benchId) ?? [],
      now: Date.now(),
    });
    const unit = ownValue(snapshot.unitsById, unitId);
    if (unit === undefined) {
      return respond(404, { error: `No unit ${unitId}`, code: "UNIT_NOT_FOUND" });
    }
    let body: DeliveryUnitDiffResponse = {
      unit: unitId,
      base: null,
      head: null,
      diff: "",
      truncated: false,
    };
    if (unit.head !== undefined) {
      const order = ownValue(loaded.record.stack.stacks, unit.stack) ?? [];
      const below = order[order.indexOf(unitId) - 1];
      const belowHead = below === undefined ? undefined : ownValue(snapshot.unitsById, below)?.head;
      const base = belowHead ?? STACK_BASE;
      body = {
        unit: unitId,
        base,
        head: unit.head,
        diff: this.layerDiffs.get(`${base}..${unit.head}`) ?? "",
        truncated: false,
      };
    }
    this.diffs.push({ unit: unitId, base: body.base, head: body.head });
    return respond(200, body);
  }

  // GET /delivery/units/:unitId/transcript: the session terminal's scrollback
  // over the unit's span. The stand-in's session wrote B's output only.
  private readTranscript(benchId: number, unitId: string): StandInResponse {
    const loaded = this.loadRecord(benchId);
    if (!loaded.ok) return respond(409, loaded.error);
    if (!loaded.record.units.some((unit) => unit.id === unitId)) {
      return respond(404, { error: `No unit ${unitId}`, code: "UNIT_NOT_FOUND" });
    }
    const own = (this.events.get(benchId) ?? []).filter((item) => item.unit_id === unitId);
    const bench = this.benches.find((b) => b.id === benchId);
    const body: DeliveryUnitTranscriptResponse = {
      unit: unitId,
      sessionId: bench?.deliverySessionId ?? null,
      from: own[0]?.ts ?? null,
      to: own.at(-1)?.ts ?? null,
      lines: unitId === "B" ? (this.scrollback.get(benchId) ?? []) : [],
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
// the record into the bench workspace, commits the layers, writes its output to
// its terminal and posts its events to the event URL with the token. The
// verify seam of the gate after B wrote the plan and the results beside the
// record.
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
    output: string[],
    events: DeliveryEvent[],
  ): Promise<number> {
    const { descriptor, benchId } = this;
    if (descriptor === undefined || benchId === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
    this.server.workspaceReady(benchId);
    this.server.writeWorkspaceRecord(benchId, record);
    this.server.writeWorkspaceVerify(benchId, verify.plan, verify.results);
    this.server.commitLayer(STACK_BASE, A_HEAD, "diff --git a/src/base.ts b/src/base.ts\n");
    this.server.commitLayer(A_HEAD, B_HEAD, B_LAYER_DIFF);
    this.server.writeSessionOutput(benchId, output);
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
      `SB-TC-034 step diverged: "${label}"\n` +
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

// jsdom has no layout, so it ships no scrollIntoView: the spy records which
// element the terminal scrolled to.
const scrolledTo = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();

beforeEach(() => {
  localStorage.clear();
  scrolledTo.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrolledTo,
  });
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
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
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

// Step 1: the tooling posts B's events, the last of which is its failed
// review, and the operator opens the bench from its card on the map.
async function postFailedReviewForB(
  user: ReturnType<typeof userEvent.setup>,
  tooling: FakeDeliveryTooling,
  benchId: number,
): Promise<void> {
  expect(server.launches).toHaveLength(1);
  const status = await tooling.start(
    initialRecord(),
    { plan: fixturePlan(), results: gateAfterBResults() },
    B_TERMINAL_OUTPUT,
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
      expect(screen.getByTestId("unit-node-B")).toHaveAttribute("data-status", "failed");
    },
    { timeout: 3000 },
  );
}

function drillInOfB(): HTMLElement {
  return within(screen.getByRole("region", { name: "Unit B" })).getByTestId("unit-drill-in");
}

describe("Spec Bench investigate journey", () => {
  it("SB-TC-034: Operator investigates a failed unit from timeline to diff", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling(server);
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const benchId = await setUpLaunchModeSpecBench();
    renderRoubo();
    const failure = failureEvent();

    // Step 1 is a setup step: B's events, ending in a failed review.
    await step(
      "1. Post events for B that end in a failed review",
      "the event endpoint accepts the tooling's events, and the bench opens on its Delivery tab with B failed on the map",
      owners(["routes"], ["launch", "deliveryTab", "map", "reducer"]),
      () => postFailedReviewForB(user, tooling, benchId),
    );

    await step(
      "2. Click B on the map",
      `B's drill-in opens on its timeline, which holds B's events and ends with the failure event (seq ${failure.seq}, "${FAILURE_SUMMARY}")`,
      owners(["drillIn", "routes"], ["map"]),
      async () => {
        await user.click(screen.getByTestId("unit-node-B"));
        const panels = drillInOfB();
        const timeline = within(panels).getByRole("region", { name: "Timeline of unit B" });
        expect(within(panels).getAllByRole("region")[0]).toBe(timeline);
        const newestId = `timeline-event-${failure.seq}`;
        await waitFor(() => expect(within(timeline).getByTestId(newestId)).toBeInTheDocument());
        const ofB = deliveryEvents()
          .filter((item) => item.unit_id === "B")
          .map((item) => item.seq);
        const rows = within(timeline).getAllByTestId(/^timeline-event-/);
        const seqs = rows.map((row) => Number(row.dataset.seq));
        expect([...seqs].sort((a, b) => a - b)).toEqual(ofB);
        // Newest first: the row at the top is the last event of B's timeline.
        expect(rows[0]).toHaveAttribute("data-seq", String(failure.seq));
        expect(Math.max(...seqs)).toBe(failure.seq);
        expect(rows[0]).toHaveTextContent(FAILURE_SUMMARY);
      },
    );

    await step(
      "3. Click the failure event",
      `the terminal replays B's recorded output and scrolls to the line the failure event matches ("${FAILURE_SUMMARY}")`,
      owners(["drillIn", "routes"]),
      async () => {
        const panels = drillInOfB();
        const timeline = within(panels).getByRole("region", { name: "Timeline of unit B" });
        const row = within(timeline).getByTestId(`timeline-event-${failure.seq}`);
        await user.click(within(row).getByRole("button"));
        expect(within(row).getByRole("button")).toHaveAttribute("aria-pressed", "true");
        const terminal = within(panels).getByRole("region", { name: "Terminal of unit B" });
        const transcript = await within(terminal).findByRole("region", {
          name: "Recorded transcript of unit B, read-only",
        });
        expect(transcript).toHaveTextContent("FAIL FX-TC-001 expected 2, got 3");
        const match = await within(transcript).findByTestId("unit-transcript-match");
        expect(match).toHaveTextContent(FAILURE_SUMMARY);
        expect(match).toHaveAttribute("data-seq", String(failure.seq));
        await waitFor(() => expect(scrolledTo.mock.contexts).toContain(match));
        expect(within(terminal).getByTestId("unit-transcript-chosen")).toHaveTextContent(
          `Showing the output of event ${failure.seq}.`,
        );
      },
    );

    await step(
      "4. Open the Diff panel",
      `the Diff panel shows the diff of B's layer, from A's head ${A_HEAD.slice(0, 8)} to B's head ${B_HEAD.slice(0, 8)}`,
      owners(["drillIn", "routes"], ["reducer"]),
      async () => {
        const panels = drillInOfB();
        const diff = within(panels).getByRole("region", { name: "Diff of unit B" });
        await user.click(diff);
        expect(diff).toHaveFocus();
        const text = await within(diff).findByTestId("unit-diff-text");
        expect(text.textContent).toBe(B_LAYER_DIFF);
        expect(diff).toHaveTextContent(`${A_HEAD.slice(0, 8)}..${B_HEAD.slice(0, 8)}`);
        expect(server.diffs).toContainEqual({ unit: "B", base: A_HEAD, head: B_HEAD });
      },
    );

    await step(
      "5. Open the Verify panel",
      `the Verify panel lists ${FAILED_CASE} as failed with its evidence ("${FAILED_EVIDENCE}", "${FAILED_NOTE}")`,
      owners(["drillIn"], ["reducer"]),
      async () => {
        const panels = drillInOfB();
        const verify = within(panels).getByRole("region", { name: "Verify results of unit B" });
        await user.click(verify);
        expect(verify).toHaveFocus();
        const results = gateAfterBResults().caseResults;
        const failedCases = CASES_AFTER_B.filter(
          (id) => ownValue(results, id)?.derivedStatus === "failed",
        );
        expect(failedCases).toEqual([FAILED_CASE]);
        for (const id of failedCases) {
          const row = within(verify).getByTestId(`unit-verify-${id}`);
          expect(row).toHaveTextContent(`${id}${GATE_AFTER_B}failed`);
          const evidence = within(row).getByRole("list", { name: `Evidence of ${id}` });
          const lines = within(evidence)
            .getAllByRole("listitem")
            .map((item) => item.textContent);
          expect(lines).toEqual(["tier b · high confidence", FAILED_EVIDENCE, FAILED_NOTE]);
        }
        expect(within(verify).getByTestId(`unit-verify-${PASSED_CASE}`)).toHaveTextContent(
          `${PASSED_CASE}${GATE_AFTER_B}passed`,
        );
      },
    );
  });
});
