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
// layer and the real notification stream hook.
//
// On the server side the real routers answer every request the journey's
// observations rest on: server/routes/benches.ts creates the bench (the 201 of
// step 2), server/routes/delivery.ts serves the snapshot and the attach handout
// (the attach 201), and server/routes/delivery-hooks.ts takes the batch (the
// 202 of step 3). They run in-process on one express app, mounted as
// server/index.ts mounts them, and `fetch` reaches them through supertest, as
// the route suites do. Behind them run the real delivery session launcher, the
// real token registry, the real record loader over a record on disk in a
// temporary bench workspace, the real event log, the real snapshot fold and
// the real notification stream broadcast, which reaches the page's
// `EventSource`. The bench manager is a stand-in that keeps the benches in
// memory and makes each workspace a temporary folder, since provisioning a
// worktree is no part of this journey, and the services that the journey does
// not cross (plugins, tools, terminals, persisted state) are mocked as in the
// route suites. Three reads of the page that no observation rests on (the
// global bench list, the testbench spec list and the terminal list) are
// answered empty here, and a request that nothing serves answers 404 and is
// listed in the failure output. The client hooks and components that the
// journey does not cross (projects, integration, settings, plugins, terminals,
// logs, issue controls) are stubbed as in the page suites.
//
// Attach mode launches nothing: the author's tooling already runs. It writes
// its record into the spec folder of the bench workspace, and takes its token
// from the attach handout (POST <delivery>/attach) before it posts the batch.
//
// Failure-output contract: each SB-TC-018 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, RegisteredProject } from "@roubo/shared";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_FILE,
  DELIVERY_RECORD_SECTIONS,
  checkDeliveryRecord,
  type DeliveryLaunchDescriptor,
  type DeliveryRecordSection,
} from "@roubo/shared/delivery-bench";

// ── Server services the journey does not cross ──
//
// The bench manager keeps the benches in memory, and each workspace is a
// temporary folder that holds the bench's spec folder. The rest are mocked as
// in the route suites: the routers import them, and the journey calls none.

const benchStore = vi.hoisted(() => ({
  benches: [] as Bench[],
  workspaceRoot: "",
}));

vi.mock("../../../../server/services/bench-manager.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  class BenchError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "BenchError";
      this.code = code;
    }
  }
  const createBench = vi.fn(
    (
      projectId: string,
      _branch: string | undefined,
      options?: { variant?: string; focusedSpecPath?: string; delivery?: { mode: string } },
    ): Bench => {
      if (projectId !== "demo") {
        throw new BenchError(`Project ${projectId} not found`, "PROJECT_NOT_FOUND");
      }
      if (options?.focusedSpecPath !== ".specifications/fixture-spec") {
        throw new BenchError("The fixture project has one spec, fixture-spec", "INVALID_FOCUS");
      }
      const id = benchStore.benches.length + 1;
      const workspacePath = path.join(benchStore.workspaceRoot, `bench-${id}`);
      fs.mkdirSync(path.join(workspacePath, options.focusedSpecPath), { recursive: true });
      const bench: Bench = {
        id,
        projectId,
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
        focusedSpecPath: `/repos/demo/${options.focusedSpecPath}`,
        deliveryBindMode: options.delivery?.mode === "launch" ? "launch" : "attach",
      };
      benchStore.benches.push(bench);
      return bench;
    },
  );
  return {
    BenchError,
    createBench,
    getBenches: vi.fn((projectId: string) =>
      benchStore.benches.filter((bench) => bench.projectId === projectId),
    ),
    getBench: vi.fn((projectId: string, benchId: number) =>
      benchStore.benches.find((bench) => bench.projectId === projectId && bench.id === benchId),
    ),
    isBenchLive: vi.fn((projectId: string, benchId: number) =>
      benchStore.benches.some((bench) => bench.projectId === projectId && bench.id === benchId),
    ),
    whenWorkspaceProvisioned: vi.fn(async () => undefined),
  };
});
vi.mock("../../../../server/services/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, updateBench: vi.fn(), loadSettings: vi.fn(() => ({})) };
});
vi.mock("../../../../server/services/terminal.js", () => ({
  getSession: vi.fn(),
  getSessionScrollback: vi.fn(),
}));
vi.mock("../../../../server/services/plugin-manager.js", () => ({
  invoke: vi.fn(),
  getAgentManifests: vi.fn(() => []),
  getRecord: vi.fn(),
  getConnection: vi.fn(),
  HOST_API_VERSION: "1.4.0",
}));
vi.mock("../../../../server/services/tool-launcher.js", () => ({
  getResolvedTools: vi.fn(),
  executeTool: vi.fn(),
}));
vi.mock("../../../../server/services/issue-assignment.js", () => ({
  createBenchAndAssignFromIssue: vi.fn(),
}));
vi.mock("../../../../server/services/issue-formatting.js", () => ({
  assignedIssueFetchId: vi.fn(),
}));
vi.mock("../../../../server/services/agent-presets.js", () => ({
  listAgentPresets: vi.fn(() => []),
}));
vi.mock("../../../../server/services/agent-launch-pipeline.js", () => ({
  resolveLaunchAgentId: vi.fn(),
}));
vi.mock("../../../../server/services/agent-permissions.js", () => ({
  toLaunchPermissions: vi.fn(),
}));
vi.mock("../../../../server/services/project-registry.js", () => ({
  getProject: vi.fn(),
  resolveEnforceIssueDependencies: vi.fn(() => false),
}));
vi.mock("../../../../server/services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(),
}));
vi.mock("../../../../server/services/start-gate.js", () => ({
  assertGateOpen: vi.fn(),
  fetchIssueForStart: vi.fn(),
}));
vi.mock("../../../../server/services/git-state.js", () => ({
  getDirtyState: vi.fn(),
}));
vi.mock("../../../../server/services/jig-manager.js", () => ({}));
vi.mock("../../../../server/routes/plugin-route-helpers.js", () => ({
  getActivePluginOrRespond: vi.fn(),
  fetchPluginComments: vi.fn(),
  resolveActivePluginQuiet: vi.fn(),
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

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// The blocked-by slices come first, by their exact title and FR ids. A slice
// that a step also crosses but that sits outside the blocked-by set is
// labelled apart.
const OWNERS = {
  contract:
    "'Delivery observation contract in shared with generated schema and drift coverage' (SB-FR-005, SB-FR-006, SB-NFR-007)",
  ingest: "'Token-gated event ingest, sequence checks and the delivery stream frame' (SB-FR-007)",
} as const;

const OUTSIDE_BLOCKED_BY = {
  attach:
    "launch, attach and resume a Spec Bench's delivery session, with the attach token handout (SB-FR-002, SB-FR-003)",
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
  return name.split(/[_\-$]+|(?=[A-Z])/).some((word) => AGENT_SPECIFIC.has(word.toLowerCase()));
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

// ── The Roubo server ──

interface RoutedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function respond(status: number, body: unknown): RoutedResponse {
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

// The real routers and the real notification stream broadcast, loaded once the
// mocks above are in place. Each specifier is built at run time so that the
// client's type check, whose root is client/src, does not take in the server's
// sources; the shape the journey uses of each module is declared here.
const SERVER_ROOT = "../../../../server";

interface RouterModule {
  default: express.Router;
}

interface DeliveryHooksModule extends RouterModule {
  deliveryEventBodyParser: express.RequestHandler;
}

interface SseModule {
  addClient: (res: express.Response) => void;
  _resetClientsForTest: () => void;
}

interface EventLogModule {
  forgetDeliveryEventLog: () => void;
}

interface ServerModules {
  benches: RouterModule;
  delivery: RouterModule;
  hooks: DeliveryHooksModule;
  sse: SseModule;
  eventLog: EventLogModule;
}

async function loadServerModule<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ `${SERVER_ROOT}/${file}`)) as T;
}

async function loadServerModules(): Promise<ServerModules> {
  return {
    benches: await loadServerModule<RouterModule>("routes/benches.js"),
    delivery: await loadServerModule<RouterModule>("routes/delivery.js"),
    hooks: await loadServerModule<DeliveryHooksModule>("routes/delivery-hooks.js"),
    sse: await loadServerModule<SseModule>("services/sse.js"),
    eventLog: await loadServerModule<EventLogModule>("services/delivery-event-log.js"),
  };
}

type SupertestMethod = (url: string) => request.Test;

class RouboServer {
  unrouted: string[] = [];
  private readonly app = express();
  private streams: FakeEventSource[] = [];

  // The routers mounted as server/index.ts mounts them: the event route's own
  // body parser first, then the global JSON parser, then the routers.
  constructor(modules: ServerModules) {
    this.app.use(DELIVERY_EVENT_HOOK_PATH, modules.hooks.deliveryEventBodyParser);
    this.app.use(express.json({ limit: "210kb" }));
    this.app.use("/api/projects", modules.benches.default);
    this.app.use("/api/projects", modules.delivery.default);
    this.app.use("/api/hooks", modules.hooks.default);
    this.app.use((req: express.Request, res: express.Response) => {
      this.unrouted.push(`${req.method} ${req.originalUrl}`);
      res.status(404).json({ error: `No route serves ${req.method} ${req.path}`, code: "NOT_FOUND" });
    });
    // The page's notification stream is a client of the real broadcast.
    modules.sse.addClient({
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      on: () => undefined,
      write: (chunk: string) => {
        this.toStreams(chunk);
        return true;
      },
    } as unknown as express.Response);
  }

  private toStreams(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice("data: ".length);
      for (const stream of this.streams) {
        if (stream.readyState === 1) stream.onmessage?.({ data } as MessageEvent);
      }
    }
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

  // The tooling writes its record into the spec folder of the bench workspace,
  // once the workspace is ready.
  writeWorkspaceRecord(benchId: number, record: unknown): void {
    const bench = benchStore.benches.find((b) => b.id === benchId);
    if (!bench) throw new Error(`the bench manager holds no bench ${benchId}`);
    bench.status = "active";
    const folder = join(bench.workspacePath, SPEC_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  // The three reads of the page that no observation of the journey rests on,
  // answered empty: their routers (the global bench list, testbench, terminals)
  // reach services that this journey does not cross.
  private pageOnlyRead(method: string, path: string): RoutedResponse | undefined {
    if (method !== "GET") return undefined;
    const base = `/api/projects/${PROJECT_ID}`;
    if (path === "/api/benches") return respond(200, copy(benchStore.benches));
    if (path === `${base}/testbench/specs`) return respond(200, { specs: [], invalid: [] });
    if (new RegExp(`^${base}/benches/\\d+/terminals$`).test(path)) return respond(200, []);
    return undefined;
  }

  // Every other request goes to the real routers, in-process, through
  // supertest.
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<RoutedResponse> {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const pageOnly = this.pageOnlyRead(method, url.pathname);
    if (pageOnly) return pageOnly;
    const agent = request(this.app) as unknown as Record<string, SupertestMethod>;
    let pending = agent[method.toLowerCase()](`${url.pathname}${url.search}`);
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      pending = pending.set(name, value);
    }
    const res = typeof init?.body === "string" ? await pending.send(init.body) : await pending;
    return respond(res.status, res.body as unknown);
  }
}

// ── The author's tooling ──
//
// Already running when the operator attaches. It writes its record into the
// bench workspace, takes a token from the attach handout, and posts its batch
// to the event URL with that token.
class AuthorTooling {
  constructor(
    private readonly server: RouboServer,
    private readonly documents: AuthorDocuments,
  ) {}

  writeRecord(benchId: number): void {
    this.server.writeWorkspaceRecord(benchId, this.documents.record);
  }

  async attach(benchId: number): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`/api/projects/${PROJECT_ID}/benches/${benchId}/delivery/attach`, {
      method: "POST",
    });
    return { status: res.status, body: await res.json() };
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

let serverModules: ServerModules;
let server: RouboServer;

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

beforeAll(async () => {
  benchStore.workspaceRoot = mkdtempSync(join(tmpdir(), "spec-bench-journey-"));
  serverModules = await loadServerModules();
});

afterAll(() => {
  rmSync(benchStore.workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  localStorage.clear();
  benchStore.benches.length = 0;
  serverModules.eventLog.forgetDeliveryEventLog();
  server = new RouboServer(serverModules);
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
  serverModules.sse._resetClientsForTest();
  serverModules.eventLog.forgetDeliveryEventLog();
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

interface AttachedSpecBench {
  benchId: number;
  descriptor: DeliveryLaunchDescriptor;
}

// Step 2: the attach-mode create on the real bench route, the record in the
// workspace, the attach handout on the real delivery route, then the bench
// opened on the record.
async function setUpAttachedSpecBench(
  user: ReturnType<typeof userEvent.setup>,
  tooling: AuthorTooling,
): Promise<AttachedSpecBench> {
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

  const handout = await tooling.attach(benchId);
  expect(handout.status, `the attach route answered ${JSON.stringify(handout.body)}`).toBe(201);
  const descriptor = handout.body as DeliveryLaunchDescriptor;
  expect(typeof descriptor.token, "the attach handout carries no token").toBe("string");
  expect(new URL(descriptor.eventUrl).pathname).toBe(DELIVERY_EVENT_HOOK_PATH);

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
  return { benchId, descriptor };
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

    const { descriptor } = await step(
      "2. Set up a Spec Bench in attach mode against that record",
      "the create route and the attach handout each answer 201, and the snapshot renders every section",
      owners(["contract"], ["attach", "setup", "deliveryTab"]),
      () => setUpAttachedSpecBench(user, tooling),
    );

    await step(
      "3. Post the batch with the bench token",
      `the event endpoint answers 202, and the map shows ${UNIT_ID} running within ${MAP_UPDATE_BUDGET_MS} ms`,
      owners(["ingest"], ["attach", "map"]),
      async () => {
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
