// @vitest-environment jsdom
//
// The role matrix and the lifecycle controls, through the real control, ingest
// and stream path (SB-TC-049, SB-TC-050, SB-TC-051; SB-FR-021, SB-FR-022,
// SB-US-008).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// routes (routes/delivery.ts: the snapshot read, the roles, pause, wind-down,
// resume and approve routes), the delivery event and control routes
// (routes/delivery-hooks.ts) and their body parser, the notification stream
// (routes/notifications.ts and services/sse.ts), the delivery token check, the
// bench's event log, the control outbox and its read-back rule, and the record
// loader over a record, a plan and its results in a bench workspace on disk. On
// the client side, the real `lib/api` request layer, the real React Query
// hooks, the real notification stream hook and the real Delivery tab with its
// role matrix, lifecycle controls and health chip. The client reaches the
// server over HTTP, and `EventSource` (which jsdom lacks) is a small
// text/event-stream reader over a streamed fetch. The fake tooling posts
// events with the token and reads the outbox from the controls endpoint.
//
// The bench manager is a stand-in that knows the one Spec Bench, the state
// file write is a stand-in, the operator's git identity is fixed, and the
// session launcher is a stand-in that records each launch request, as the
// executor would receive it.
//
// This file renders client components, so it calls createElement: the server
// suite takes `.ts` test files only.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
} from "@roubo/shared/delivery-bench";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  isBenchLive: vi.fn(() => true),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));
vi.mock("../services/state.js", async (importOriginal) => ({
  updateBench: vi.fn(),
  toPersistedBench: (await importOriginal<typeof import("../services/state.js")>())
    .toPersistedBench,
}));
vi.mock("../services/delivery-session-launcher.js", () => ({
  DeliveryLaunchBlockedError: class extends Error {},
  deliveryLaunchBlock: vi.fn(),
  handOutDeliveryToken: vi.fn(),
  launchDeliverySession: vi.fn(),
  whenDeliveryBound: vi.fn(async () => undefined),
}));
vi.mock("../services/terminal.js", () => ({
  getSession: vi.fn(),
  getSessionScrollback: vi.fn(),
}));
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import { forgetDeliveryControlMemory } from "../services/delivery-control-outbox.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import {
  deliveryLaunchBlock,
  launchDeliverySession,
} from "../services/delivery-session-launcher.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { _resetClientsForTest } from "../services/sse.js";
import { computePlanHash } from "../lib/testbench-store.js";
import { makeBench } from "../test/fixtures.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import deliveryRouter from "./delivery.js";
import notificationsRouter from "./notifications.js";
import { useNotificationStream } from "../../client/src/hooks/useNotificationStream";
import DeliveryTabPanel from "../../client/src/components/delivery/DeliveryTabPanel";

// The jsdom URL global is not the one fileURLToPath takes, so the path is
// joined from this file's own path.
const FIXTURE_RECORD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/__fixtures__/delivery-record.json",
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-lifecycle-controls";
const CASES = ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"];

const PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: "1.2.0",
  specSlug: "fixture-spec",
  cases: CASES.map((id) => ({
    id,
    title: id,
    area: "demo",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["DEMO-FR-001"],
    linked_user_story_ids: [],
  })),
};
const PLAN_HASH = computePlanHash(PLAN);

const nodeFetch = globalThis.fetch;

let tmp: string;
let specFolder: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let streams: StreamEventSource[];
let nextSeq: number;
// Each request the client sent: its method, path and answer status.
let clientRequests: Array<{ method: string; path: string; status: number }>;

// Four units A, B, C and D, a stack of A, B and C, and gates after B and after
// C, running, with no review waiting and the plan's hash.
function lifecycleRecord(): DeliveryRecord {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  return {
    ...record,
    plan_hash: PLAN_HASH,
    review: { status: "none", unreviewed: [] },
    decisions: [],
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({
        id: gate.id,
        after: gate.after,
        status: "pending",
        cases: gate.cases,
      })),
    },
  };
}

// The spec's results in the workspace: `met` passed, every other case without
// a result.
function writeResults(met: readonly string[]): void {
  const passed = { observationMarks: {}, derivedStatus: "passed", notes: [] };
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: PLAN_HASH,
      caseResults: Object.fromEntries(met.map((id) => [id, passed])),
      updatedAt: "2026-10-16T09:30:00Z",
    }),
  );
}

function event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
  const seq = nextSeq;
  nextSeq += 1;
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: lifecycleRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

async function post(events: DeliveryEvent[]): Promise<void> {
  const res = await nodeFetch(
    `${origin}${DELIVERY_EVENT_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ events }),
    },
  );
  expect(res.status).toBe(202);
}

async function operator(method: string, route: string, body: unknown = {}): Promise<Response> {
  return nodeFetch(`${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readControls(): Promise<{ controls: Array<Record<string, unknown>> }> {
  const res = await nodeFetch(
    `${origin}${DELIVERY_CONTROLS_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { controls: Array<Record<string, unknown>> };
}

// An EventSource over a streamed fetch: it reads the text/event-stream body and
// hands each `data:` block to onmessage, as a browser's EventSource does.
class StreamEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(url: string) {
    streams.push(this);
    void this.run(new URL(url, origin).toString());
  }

  private async run(url: string): Promise<void> {
    try {
      const res = await nodeFetch(url, { headers: { Accept: "text/event-stream" } });
      if (res.body === null) throw new Error("the stream answered no body");
      this.reader = res.body.getReader();
      if (this.readyState === 2) {
        await this.reader.cancel();
        return;
      }
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data.length > 0) this.onmessage?.(new MessageEvent("message", { data }));
          end = buffer.indexOf("\n\n");
        }
      }
    } catch (cause) {
      if (this.readyState !== 2) {
        this.readyState = 2;
        this.onerror?.(new ErrorEvent("error", { error: cause }));
      }
    }
  }

  close(): void {
    this.readyState = 2;
    void this.reader?.cancel().catch(() => undefined);
  }
}

// The client's requests carry relative paths; they reach the server here. The
// jsdom AbortSignal is not the one Node's fetch takes, so a signal is dropped.
async function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), origin);
  const rest: RequestInit = { ...init };
  delete rest.signal;
  const res = await nodeFetch(url.toString(), rest);
  clientRequests.push({ method: rest.method ?? "GET", path: url.pathname, status: res.status });
  return res;
}

function Harness() {
  useNotificationStream();
  return createElement(DeliveryTabPanel, { bench });
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
}

async function snapshotShown(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("delivery-snapshot")).toBeInTheDocument(), {
    timeout: 3000,
  });
}

async function requestAnswered(method: string, route: string, status: number): Promise<void> {
  await waitFor(
    () =>
      expect(clientRequests).toContainEqual({
        method,
        path: `/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/${route}`,
        status,
      }),
    { timeout: 3000 },
  );
}

async function chipReads(word: string): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId("delivery-health-chip")).toHaveAttribute("data-health", word),
    { timeout: 3000 },
  );
}

const lifecycleButton = (name: string) =>
  within(screen.getByTestId("delivery-lifecycle-controls")).getByRole("button", { name });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-lifecycle-live-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  const record = lifecycleRecord();
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(PLAN));
  writeResults(["DEMO-TC-001", "DEMO-TC-002"]);
  nextSeq = record.last_event_seq + 1;
  bench = makeBench({
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
  });
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(resolveGitIdentity).mockResolvedValue({
    name: "Ada Operator",
    email: "ada@example.test",
  });
  vi.mocked(deliveryLaunchBlock).mockReset();
  vi.mocked(deliveryLaunchBlock).mockReturnValue(undefined);
  vi.mocked(launchDeliverySession).mockReset();
  vi.mocked(launchDeliverySession).mockResolvedValue({ sessionId: "session-2" });
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  _resetClientsForTest();

  const app = express();
  app.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
  app.use(express.json({ limit: "210kb" }));
  app.use("/api/projects", deliveryRouter);
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/notifications", notificationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  streams = [];
  clientRequests = [];
  vi.stubGlobal("fetch", vi.fn(clientFetch));
  vi.stubGlobal("EventSource", StreamEventSource);
});

afterEach(async () => {
  cleanup();
  for (const stream of streams) stream.close();
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetClientsForTest();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Role matrix over the live path", () => {
  it("SB-TC-049 a model change PUTs the role, shows pending, is listed on the controls endpoint, and shows current after roles.applied", async () => {
    renderTab();
    await snapshotShown();
    const row = () => screen.getByTestId("role-row-unit-coder");
    expect(row()).toHaveAttribute("data-state", "current");

    // Step 1: change the coder's model and save.
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model of unit-coder" }),
      "large",
    );
    await user.click(screen.getByRole("button", { name: "Save the model of unit-coder" }));
    await requestAnswered("PUT", "roles", 202);
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "pending"), { timeout: 3000 });
    expect(screen.getByTestId("role-pending-unit-coder")).toHaveTextContent("pending · large");
    expect(screen.getByRole("combobox", { name: "Model of unit-coder" })).toHaveValue("fast");

    // Step 2: the tooling reads the role control from the controls endpoint.
    const read = await readControls();
    expect(read.controls).toHaveLength(1);
    expect(read.controls[0]).toMatchObject({
      control_seq: 1,
      kind: "role-change",
      target_id: "unit-coder",
      body: { tier: "large" },
    });

    // Step 3: the session applies it, and the row shows the new model as current.
    await post([event("roles.applied", { role: "unit-coder", tier: "large", control_seq: 1 })]);
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "current"), { timeout: 3000 });
    expect(screen.getByRole("combobox", { name: "Model of unit-coder" })).toHaveValue("large");
    expect(screen.queryByTestId("role-pending-unit-coder")).not.toBeInTheDocument();
    expect(bench.deliveryControlQueue?.[0]?.status).toBe("applied");
  });
});

describe("PUT /delivery/roles", () => {
  it("SB-TC-049 answers 202 with a role-change control that passes the control contract", async () => {
    const res = await operator("PUT", "roles", { role: "unit-coder", tier: "large" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      kind: "role-change",
      control_seq: 1,
      target_id: "unit-coder",
      body: { tier: "large" },
      durability: "durable",
      status: "pending",
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
  });

  it.each([
    ["no role", { tier: "large" }, "role"],
    ["a role the delivery does not have", { role: "reviewer", tier: "large" }, "role"],
    ["a role named toString", { role: "toString", tier: "large" }, "role"],
    ["no tier", { role: "unit-coder" }, "tier"],
    ["a blank tier", { role: "unit-coder", tier: "  " }, "tier"],
    ["a tier that is not a string", { role: "unit-coder", tier: 3 }, "tier"],
  ])("SB-TC-049 refuses a change with %s and issues nothing", async (_label, body, field) => {
    const res = await operator("PUT", "roles", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BODY", field });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);
  });
});

describe("Lifecycle controls over the live path", () => {
  it("SB-TC-050 pause, wind-down with its dialog, resume and approve post their endpoints, and the chip follows each lifecycle event", async () => {
    renderTab();
    await snapshotShown();
    const user = userEvent.setup();

    // Step 1: Pause.
    await user.click(lifecycleButton("Pause"));
    await requestAnswered("POST", "pause", 202);
    expect((await readControls()).controls).toMatchObject([{ kind: "pause", control_seq: 1 }]);
    await post([event("lifecycle.changed", { state: "paused", control_seq: 1 })]);
    await chipReads("paused");
    expect(lifecycleButton("Pause")).toBeDisabled();

    // Step 2: Wind down, confirmed in its dialog.
    await user.click(lifecycleButton("Wind down"));
    const dialog = await screen.findByRole("alertdialog", { name: "Wind down the delivery?" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm wind down" }));
    await requestAnswered("POST", "wind-down", 202);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await post([event("lifecycle.changed", { state: "wound_down", control_seq: 2 })]);
    await chipReads("wound down");
    expect(screen.getByTestId("delivery-health-chip")).toHaveTextContent("wound down");
    expect(lifecycleButton("Wind down")).toBeDisabled();

    // Step 3: Resume relaunches the session with the record's resume argument.
    await user.click(lifecycleButton("Resume"));
    await requestAnswered("POST", "resume", 202);
    expect(launchDeliverySession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(launchDeliverySession).mock.calls[0]?.[1]).toEqual({
      resume: "demo-delivery-1",
    });
    await post([event("lifecycle.changed", { state: "running" })]);
    await chipReads("fresh");

    // Step 4: Approve, once every gating case is met.
    expect(lifecycleButton("Approve")).toBeDisabled();
    expect(screen.getByTestId("delivery-approve-reason")).toHaveTextContent("gate-after-c");
    writeResults(CASES);
    // The results are read with the snapshot; an event makes the client read it.
    await post([event("unit.changed", { status: "done" }, "B")]);
    await waitFor(() => expect(lifecycleButton("Approve")).toBeEnabled(), { timeout: 3000 });
    await user.click(lifecycleButton("Approve"));
    await requestAnswered("POST", "approve", 202);
    const approval = (await readControls()).controls.find((c) => c.kind === "approval");
    expect(approval).toMatchObject({ kind: "approval", status: "delivered" });
    await post([
      event("lifecycle.changed", { state: "complete", control_seq: approval?.control_seq }),
    ]);
    await chipReads("complete");
    for (const name of ["Pause", "Wind down", "Resume", "Approve"]) {
      expect(lifecycleButton(name)).toBeDisabled();
    }
  });

  it("SB-TC-050 Cancel closes the wind-down dialog and posts nothing", async () => {
    renderTab();
    await snapshotShown();
    const user = userEvent.setup();
    await user.click(lifecycleButton("Wind down"));
    const dialog = await screen.findByRole("alertdialog", { name: "Wind down the delivery?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(clientRequests.some((r) => r.path.endsWith("/wind-down"))).toBe(false);
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);
  });
});

describe("POST /delivery/pause, /wind-down, /resume and /approve", () => {
  it("SB-TC-050 pause and wind-down answer 202 with their controls", async () => {
    const paused = await operator("POST", "pause", { reason: "lunch" });
    expect(paused.status).toBe(202);
    expect(await paused.json()).toMatchObject({
      kind: "pause",
      body: { reason: "lunch" },
      status: "pending",
    });
    const wound = await operator("POST", "wind-down");
    expect(wound.status).toBe(202);
    expect(await wound.json()).toMatchObject({ kind: "wind-down", body: {}, control_seq: 2 });
  });

  it("SB-TC-050 refuses a pause with a reason that is not a string", async () => {
    const res = await operator("POST", "pause", { reason: 3 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BODY", field: "reason" });
  });

  it("SB-TC-051 resume while the delivery is active is 409 naming the lifecycle state", async () => {
    vi.mocked(deliveryLaunchBlock).mockReturnValue("session_live");
    const res = await operator("POST", "resume");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; state: string };
    expect(body).toMatchObject({ code: "DELIVERY_SESSION_LIVE", state: "running" });
    expect(body.error).toContain("running");
    expect(launchDeliverySession).not.toHaveBeenCalled();
  });

  it("SB-TC-051 resume of a complete delivery is 409 WRONG_LIFECYCLE_STATE", async () => {
    await post([event("lifecycle.changed", { state: "complete" })]);
    const res = await operator("POST", "resume");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "WRONG_LIFECYCLE_STATE",
      state: "complete",
      error: "The delivery is complete, so it cannot be resumed",
    });
    expect(launchDeliverySession).not.toHaveBeenCalled();
  });

  it("SB-TC-051 pause while wound down is 409 naming the state, and issues nothing", async () => {
    await post([event("lifecycle.changed", { state: "wound_down" })]);
    const res = await operator("POST", "pause");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "WRONG_LIFECYCLE_STATE",
      state: "wound_down",
      error: "The delivery is wound_down, so it cannot be paused",
    });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);
  });

  it("SB-TC-051 wind-down of a complete delivery is 409", async () => {
    await post([event("lifecycle.changed", { state: "Complete" })]);
    const res = await operator("POST", "wind-down");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "WRONG_LIFECYCLE_STATE", state: "Complete" });
  });

  it("SB-TC-051 approve while a gating case is unmet is 409 GATING_UNMET naming the gate", async () => {
    const res = await operator("POST", "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "GATING_UNMET", gates: ["gate-after-c"] });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);

    writeResults(CASES);
    const approved = await operator("POST", "approve");
    expect(approved.status).toBe(202);
    expect(await approved.json()).toMatchObject({ kind: "approval" });
  });

  it("SB-TC-051 approve of a complete delivery is 409 WRONG_LIFECYCLE_STATE before any other check", async () => {
    writeResults(CASES);
    await post([event("lifecycle.changed", { state: "complete" })]);
    const res = await operator("POST", "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "WRONG_LIFECYCLE_STATE", state: "complete" });
  });
});
