// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Tooling author opens a Spec Bench
// from the published contract alone" (SB-TC-018, SB-FR-005, SB-FR-006,
// SB-FR-007, SB-NFR-007, SB-US-011). It asserts the authoritative e2e_flow case
// SB-TC-018 step for step, so a divergence is integration drift and not a
// re-specification.
//
// The tooling author's side knows nothing of Roubo's code. A generic script
// below reads the two published JSON schemas under `schema/` with node:fs and
// writes the delivery record and the event batch from them alone: it fills
// every field a schema requires, keeps what the author wrote, and checks the
// result against the schema's own keywords. It imports no Roubo type and no
// Roubo validator, so a record that Roubo then reads proves the published
// contract is enough. (The client tsconfig pins `types: ["vite/client"]`, so
// the file references the node types explicitly.)
//
// What runs for real on the Roubo side: the Benches page (BenchDashboard and
// BenchesTab with the real BenchCard), the bench page (BenchDetail with the
// real Delivery tab, its health rail, progress, map and its view of cost,
// health and controls), the real React Query hooks, the real `lib/api` request
// layer and the real notification stream hook. The one stand-in is the
// network: `fetch` and `EventSource` reach an in-process Roubo server stand-in
// below, which answers each route the journey calls with the body and the
// status the real route answers (server/routes/benches.ts,
// server/routes/delivery.ts, server/routes/delivery-hooks.ts), reads the record
// with the shared record check the record loader runs, and folds the record and
// the accepted events through the shared delivery reducer as GET /delivery
// does. A request to any other route answers 404 and is listed in the failure
// output. The hooks and components that the journey does not cross (projects,
// integration, settings, plugins, terminals, logs, issue controls) are stubbed
// as in the page suites.
//
// Attach mode launches nothing: the author's tooling already runs. It writes
// its record into the spec folder of the bench workspace, and takes its token
// from the attach handout (POST <delivery>/attach) before it posts the batch.
//
// Failure-output contract: each SB-TC-018 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, RegisteredProject } from "@roubo/shared";
import {
  validateDeliveryEvent,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_SECTIONS,
  checkDeliveryRecord,
  type DeliveryEventsResponse,
  type DeliveryLaunchDescriptor,
  type DeliveryReadError,
  type DeliveryRecordSection,
  type DeliveryStreamFrame,
} from "@roubo/shared/delivery-bench";

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
  contract:
    "delivery observation contract: the published record and event schemas (SB-FR-005, SB-FR-006, SB-NFR-007)",
  attach:
    "launch, attach and resume a Spec Bench's delivery session, with the attach token handout (SB-FR-002, SB-FR-003)",
  ingest: "token-gated event ingest with sequence checks and a stream frame (SB-FR-007)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  setup: "Spec Bench variant and its set up from a spec folder (SB-FR-001)",
  deliveryTab: "Delivery tab with its map and health rail (SB-FR-009)",
  map: "delivery map graph and list views (SB-FR-010)",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type OutsideSlice = keyof typeof OUTSIDE_BLOCKED_BY;

function owners(blockedBy: BlockedBySlice[], outside: OutsideSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (outside.length === 0) return named;
  const also = outside.map((key) => OUTSIDE_BLOCKED_BY[key]).join("; ");
  return `${named}\n  also crossed, outside the blocked-by set: ${also}`;
}

// ── Fixture project and spec (SB-TC-018 preconditions) ──

const PROJECT_ID = "demo";
const REPO_PATH = "/repos/demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;
const UNIT_ID = "A";
const MAP_UPDATE_BUDGET_MS = 2000;

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

// ── The tooling author's generic script ──
//
// Everything in this section works from a JSON schema document and plain JSON
// values only. It is what a tooling author with no Roubo code writes.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface JsonSchema {
  type?: string;
  const?: Json;
  enum?: Json[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  propertyNames?: JsonSchema;
  anyOf?: JsonSchema[];
}

function readPublishedSchema(file: string): JsonSchema {
  return JSON.parse(readFileSync(resolve(process.cwd(), "schema", file), "utf8")) as JsonSchema;
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueSchema(schema: JsonSchema, key: string): JsonSchema {
  const declared = schema.properties?.[key];
  if (declared) return declared;
  return typeof schema.additionalProperties === "object" ? schema.additionalProperties : {};
}

// The smallest value a schema accepts, or the author's value with every
// required field the author left out filled in.
function fromSchema(schema: JsonSchema, authored?: Json): Json {
  if (authored !== undefined) {
    if (isObject(authored) && (schema.type === "object" || schema.properties)) {
      const filled: { [key: string]: Json } = {};
      for (const key of schema.required ?? []) {
        if (!(key in authored)) filled[key] = fromSchema(valueSchema(schema, key));
      }
      for (const [key, value] of Object.entries(authored)) {
        filled[key] = fromSchema(valueSchema(schema, key), value);
      }
      return filled;
    }
    if (Array.isArray(authored) && schema.items) {
      const items = schema.items;
      return authored.map((item) => fromSchema(items, item));
    }
    return authored;
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum !== undefined) return schema.enum[0];
  if (schema.anyOf !== undefined) return fromSchema(schema.anyOf[0]);
  switch (schema.type) {
    case "string":
      if (schema.format === "date-time") return new Date().toISOString();
      return "x".repeat(schema.minLength ?? 0);
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "array": {
      const items = schema.items ?? {};
      return Array.from({ length: schema.minItems ?? 0 }, () => fromSchema(items));
    }
    case "object": {
      const built: { [key: string]: Json } = {};
      for (const key of schema.required ?? []) built[key] = fromSchema(valueSchema(schema, key));
      return built;
    }
    default:
      return null;
  }
}

function typeOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

// Every place a value breaks its schema, by the schema's own keywords.
function violations(schema: JsonSchema, value: Json, at = "$"): string[] {
  if (schema.anyOf !== undefined) {
    const fits = schema.anyOf.some((branch) => violations(branch, value, at).length === 0);
    return fits ? [] : [`${at}: matches no anyOf branch`];
  }
  const found: string[] = [];
  const actual = typeOf(value);
  if (
    schema.type !== undefined &&
    schema.type !== actual &&
    !(schema.type === "number" && actual === "integer")
  ) {
    return [`${at}: is ${actual}, the schema wants ${schema.type}`];
  }
  if (schema.const !== undefined && value !== schema.const) found.push(`${at}: is not the const`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    found.push(`${at}: is not one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0)) found.push(`${at}: is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      found.push(`${at}: is too long`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      found.push(`${at}: does not match the pattern`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) found.push(`${at}: is too small`);
    if (schema.maximum !== undefined && value > schema.maximum) found.push(`${at}: is too large`);
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) found.push(`${at}: has too few items`);
    const items = schema.items;
    if (items) value.forEach((item, i) => found.push(...violations(items, item, `${at}[${i}]`)));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) found.push(`${at}.${key}: is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      found.push(...violations(valueSchema(schema, key), item, `${at}.${key}`));
    }
  }
  return found;
}

function writeFromSchema(schema: JsonSchema, authored: Json): Json {
  const written = fromSchema(schema, authored);
  const broken = violations(schema, written);
  if (broken.length > 0) {
    throw new Error(`the written document breaks its schema: ${broken.join("; ")}`);
  }
  return written;
}

// Every field name that some object of a schema requires, with its path.
function requiredFields(schema: JsonSchema, at = "$"): string[] {
  const found = (schema.required ?? []).map((key) => `${at}.${key}`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    found.push(...requiredFields(child, `${at}.${key}`));
  }
  if (schema.items) found.push(...requiredFields(schema.items, `${at}[]`));
  if (typeof schema.additionalProperties === "object") {
    found.push(...requiredFields(schema.additionalProperties, `${at}.*`));
  }
  for (const branch of schema.anyOf ?? []) found.push(...requiredFields(branch, at));
  return found;
}

// A field name that ties a record to one agent, one vendor or one way of
// running it.
const AGENT_SPECIFIC = new Set([
  "agent",
  "agents",
  "claude",
  "anthropic",
  "codex",
  "openai",
  "gpt",
  "gemini",
  "cursor",
  "copilot",
  "llm",
  "model",
  "prompt",
  "session",
  "terminal",
  "transcript",
  "cli",
  "command",
  "argv",
  "pid",
]);

function agentSpecific(path: string): boolean {
  const name = path.split(/[.[\]*]+/).pop() ?? "";
  return name
    .split(/[_\-$]+|(?=[A-Z])/)
    .some((word) => AGENT_SPECIFIC.has(word.toLowerCase()));
}

// What the author writes by hand: one delivery of one unit, in the field names
// the record schema publishes. The script fills in the rest.
function authoredRecord(): Json {
  return {
    delivery_id: "author-delivery-1",
    spec_slug: SPEC_SLUG,
    plan_hash: "author-plan-1",
    stack: { stacks: { [UNIT_ID]: [UNIT_ID] }, gates: [] },
    units: [
      {
        id: UNIT_ID,
        title: "Only unit",
        status: "pending",
        stack: UNIT_ID,
        layer: 0,
        depends_on: [],
      },
    ],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    health: { status: "ok" },
    lifecycle: { state: "running", armed: true },
  };
}

function authoredBatch(deliveryId: Json, lastSeq: Json): Json[] {
  return [
    {
      delivery_id: deliveryId,
      type: "unit.changed",
      seq: Number(lastSeq) + 1,
      unit_id: UNIT_ID,
      payload: { status: "running" },
    },
  ];
}

interface AuthorDocuments {
  record: { [key: string]: Json };
  batch: Json[];
}

function writeRecordAndBatch(): AuthorDocuments {
  const recordSchema = readPublishedSchema("delivery-record.schema.json");
  const eventSchema = readPublishedSchema("delivery-event.schema.json");
  const record = writeFromSchema(recordSchema, authoredRecord());
  if (!isObject(record)) throw new Error("the record schema does not describe an object");
  const batch = authoredBatch(record.delivery_id, record.last_event_seq).map((event) =>
    writeFromSchema(eventSchema, event),
  );
  return { record, batch };
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

class RouboServerStandIn {
  benches: Bench[] = [];
  unrouted: string[] = [];
  private records = new Map<number, unknown>();
  private events = new Map<number, DeliveryEvent[]>();
  private tokens = new Map<number, string>();
  private streams: FakeEventSource[] = [];

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

  // The tooling writes its record into the spec folder of the bench workspace.
  writeWorkspaceRecord(benchId: number, record: unknown): void {
    this.records.set(benchId, copy(record));
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
      (match = new RegExp(`^${base}/benches/(\\d+)/delivery/attach$`).exec(path)) &&
      method === "POST"
    ) {
      return this.attach(Number(match[1]));
    }
    if (method === "POST" && path === DELIVERY_EVENT_HOOK_PATH) {
      return this.ingest(url.searchParams, headers.Authorization, body);
    }
    this.unrouted.push(`${method} ${path}${url.search}`);
    return respond(404, { error: `The stand-in serves no ${method} ${path}`, code: "NOT_FOUND" });
  }

  // POST /api/projects/:projectId/benches with variant specbench in attach
  // mode: the bench binds the spec folder and launches nothing.
  private createBench(body: unknown): StandInResponse {
    const request = (body ?? {}) as {
      variant?: unknown;
      focusedSpecPath?: unknown;
      delivery?: { mode?: unknown } | null;
    };
    if (
      request.variant !== "specbench" ||
      request.focusedSpecPath !== SPEC_FOLDER ||
      request.delivery?.mode !== "attach"
    ) {
      return respond(400, {
        error: "The journey sets up an attach-mode specbench from fixture-spec",
        code: "INVALID",
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
      deliveryBindMode: "attach",
    };
    this.benches.push(bench);
    return respond(201, copy(bench));
  }

  // POST <delivery>/attach: a fresh token in the launch descriptor, for the
  // session that already runs the delivery. It launches nothing.
  private attach(benchId: number): StandInResponse {
    const bench = this.benches.find((b) => b.id === benchId);
    if (!bench) return respond(404, { error: "Bench not found", code: "NOT_FOUND" });
    const token = `token-${benchId}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(benchId, token);
    const query = new URLSearchParams({ projectId: PROJECT_ID, benchId: String(benchId) });
    const descriptor: DeliveryLaunchDescriptor = {
      eventUrl: `http://localhost:4000${DELIVERY_EVENT_HOOK_PATH}?${query.toString()}`,
      controlsUrl: `http://localhost:4000${DELIVERY_CONTROLS_HOOK_PATH}?${query.toString()}`,
      token,
    };
    return respond(201, descriptor);
  }

  // The record loader's read: the contract major, then the required sections,
  // then the full schema.
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
    const checked = checkDeliveryRecord(raw);
    return checked.ok ? { ok: true, record: checked.record } : checked;
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

  // POST /api/hooks/delivery-event: the token first, then the envelopes and
  // their delivery, then the sequence, then a delivery frame on the
  // notification stream.
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
      if (loaded.ok && validated.data.delivery_id !== loaded.record.delivery_id) {
        return respond(400, {
          error: `The event at index ${index} names another delivery`,
          code: "INVALID_EVENT",
          field: "delivery_id",
          index,
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

// ── The author's tooling ──
//
// Already running when the operator attaches. It writes its record into the
// bench workspace, takes a token from the attach handout, and posts its batch
// to the event URL with that token.
class AuthorTooling {
  constructor(
    private readonly server: RouboServerStandIn,
    private readonly documents: AuthorDocuments,
  ) {}

  writeRecord(benchId: number): void {
    this.server.workspaceReady(benchId);
    this.server.writeWorkspaceRecord(benchId, this.documents.record);
  }

  async attach(benchId: number): Promise<DeliveryLaunchDescriptor> {
    const res = await fetch(`/api/projects/${PROJECT_ID}/benches/${benchId}/delivery/attach`, {
      method: "POST",
    });
    if (res.status !== 201) {
      throw new Error(
        `the attach handout answered ${res.status}: ${JSON.stringify(await res.json())}`,
      );
    }
    return (await res.json()) as DeliveryLaunchDescriptor;
  }

  async postBatch(
    descriptor: DeliveryLaunchDescriptor,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(descriptor.eventUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({ events: this.documents.batch }),
    });
    return { status: res.status, body: await res.json() };
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
      `SB-TC-018 step diverged: "${label}"\n` +
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

// The parts of the Delivery tab that the snapshot renders: the health rail,
// the progress, the map, and the view of cost, health and controls with each
// of its parts.
const RENDERED_SECTIONS = [
  "delivery-rail",
  "delivery-progress",
  "delivery-met-cases",
  "delivery-map",
  "delivery-cost-health-controls",
  "delivery-burn",
  "delivery-jams",
  "delivery-lifecycle",
  "delivery-budget",
  "delivery-drift-ledger",
  "delivery-decision-controls",
  "delivery-steering-controls",
  "delivery-role-controls",
  "delivery-lifecycle-controls",
] as const;

// Where the folded snapshot carries each required section of the record.
const SNAPSHOT_KEYS_OF_SECTION: Record<DeliveryRecordSection, (keyof DeliverySnapshot)[]> = {
  mode: ["mode"],
  review: ["review"],
  stack: ["stacks", "gatesById"],
  units: ["unitsById"],
  decisions: ["decisionsById"],
  steering: ["steeringById"],
  budget: ["budget"],
  roles: ["roles"],
  health: ["health"],
  drift: ["drift"],
  seams: ["seams"],
  lifecycle: ["lifecycle"],
};

// Step 2: the attach-mode create, then the bench opened on the record.
async function setUpAttachedSpecBench(
  user: ReturnType<typeof userEvent.setup>,
  tooling: AuthorTooling,
): Promise<number> {
  const res = await fetch(`/api/projects/${PROJECT_ID}/benches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: "specbench",
      focusedSpecPath: SPEC_FOLDER,
      delivery: { mode: "attach" },
    }),
  });
  const created = (await res.json()) as Bench & { error?: string };
  expect(res.status, `the create route answered ${JSON.stringify(created)}`).toBe(201);
  expect(created.deliveryBindMode).toBe("attach");
  const benchId = created.id;
  tooling.writeRecord(benchId);

  const read = await fetch(`/api/projects/${PROJECT_ID}/benches/${benchId}/delivery`);
  const snapshot = (await read.json()) as unknown;
  expect(read.status, `GET /delivery answered ${JSON.stringify(snapshot)}`).toBe(200);
  const missing = DELIVERY_RECORD_SECTIONS.filter((section) =>
    SNAPSHOT_KEYS_OF_SECTION[section].some((key) => !Object.hasOwn(snapshot as object, key)),
  );
  expect(missing, `the snapshot has no ${missing.join(", ")}`).toEqual([]);

  // The operator opens Roubo on the Benches page, where the new bench is.
  renderRoubo();
  await user.click(
    await screen.findByRole("link", { name: new RegExp(`Bench ${benchId}`) }, { timeout: 3000 }),
  );
  const deliveryTab = await screen.findByRole("tab", { name: /delivery/i });
  expect(deliveryTab).toHaveAttribute("aria-selected", "true");
  await waitFor(
    () => {
      const errorShown = screen.queryByTestId("delivery-read-error");
      if (errorShown) throw new Error(`the tab shows a read error: ${errorShown.textContent}`);
      expect(screen.getByTestId("delivery-snapshot")).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  const absent = RENDERED_SECTIONS.filter((id) => screen.queryByTestId(id) === null);
  expect(absent, `the Delivery tab renders no ${absent.join(", ")}`).toEqual([]);
  expect(screen.getByTestId("delivery-tab-panel")).toHaveTextContent(
    "attached to a running delivery",
  );
  expect(screen.getByTestId(`unit-node-${UNIT_ID}`)).toHaveAttribute("data-status", "pending");
  return benchId;
}

describe("Spec Bench published contract journey", () => {
  it("SB-TC-018: Tooling author opens a Spec Bench from the published contract alone", async () => {
    const user = userEvent.setup();

    // Step 1 is a setup step: the generic script writes from the schemas alone.
    const documents = await step(
      "1. Using only the generated JSON schemas under schema/, write a record and an event batch with a generic script",
      "a record and a batch of one event that each meet their published schema",
      owners(["contract"]),
      () => writeRecordAndBatch(),
    );
    const tooling = new AuthorTooling(server, documents);

    const benchId = await step(
      "2. Set up a Spec Bench in attach mode against that record",
      "the create route answers 201, and the snapshot renders every section",
      owners(["attach", "contract"], ["setup", "deliveryTab"]),
      () => setUpAttachedSpecBench(user, tooling),
    );

    await step(
      "3. Post the batch with the bench token",
      `the event endpoint answers 202, and the map shows ${UNIT_ID} running within ${MAP_UPDATE_BUDGET_MS} ms`,
      owners(["ingest", "attach"], ["map"]),
      async () => {
        const descriptor = await tooling.attach(benchId);
        const posted = Date.now();
        const answer = await tooling.postBatch(descriptor);
        expect(answer.status, `the event endpoint answered ${JSON.stringify(answer.body)}`).toBe(
          202,
        );
        await waitFor(
          () =>
            expect(screen.getByTestId(`unit-node-${UNIT_ID}`)).toHaveAttribute(
              "data-status",
              "running",
            ),
          { timeout: MAP_UPDATE_BUDGET_MS },
        );
        expect(Date.now() - posted).toBeLessThanOrEqual(MAP_UPDATE_BUDGET_MS);
        expect(
          within(screen.getByTestId("delivery-map")).getByTestId(`unit-node-${UNIT_ID}`),
        ).toBeInTheDocument();
      },
    );

    await step(
      "4. Check the record for any agent-specific field",
      "no field the record schema requires names an agent, a vendor, a model or a way of running one",
      owners(["contract"]),
      () => {
        const recordSchema = readPublishedSchema("delivery-record.schema.json");
        const eventSchema = readPublishedSchema("delivery-event.schema.json");
        const required = [
          ...requiredFields(recordSchema, "record"),
          ...requiredFields(eventSchema, "event"),
        ];
        expect(required.length).toBeGreaterThan(0);
        expect(required.filter(agentSpecific)).toEqual([]);
        // A record of the required fields alone, with nothing an agent adds,
        // is one that Roubo reads.
        const bare = fromSchema(recordSchema);
        expect(violations(recordSchema, bare)).toEqual([]);
        const checked = checkDeliveryRecord(bare);
        expect(checked.ok, JSON.stringify(checked.ok ? null : checked.error)).toBe(true);
      },
    );
  });
});
