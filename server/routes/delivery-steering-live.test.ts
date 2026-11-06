// @vitest-environment jsdom
//
// The steering composer and the boundary panel, through the real control,
// ingest and stream path (SB-TC-039, SB-TC-040; SB-FR-016, SB-FR-017,
// SB-US-006).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// routes (routes/delivery.ts: the snapshot read and the steering route), the
// delivery event and control routes (routes/delivery-hooks.ts) and their body
// parser, the notification stream (routes/notifications.ts and
// services/sse.ts), the delivery token check, the bench's event log, the
// control outbox and its read-back rule, and the record loader over a record in
// a bench workspace on disk. On the client side, the real `lib/api` request
// layer, the real React Query hooks, the real notification stream hook and the
// real Delivery tab with its boundary panel. The client reaches the server over
// HTTP, and `EventSource` (which jsdom lacks) is a small text/event-stream
// reader over a streamed fetch. The fake tooling posts events with the token
// and reads the outbox from the controls endpoint.
//
// The bench manager is a stand-in that knows the one Spec Bench, the state
// file write is a stand-in, the operator's git identity is fixed, and the
// session launcher and terminals stay out.
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
import {
  forgetDeliveryControlMemory,
  issueDeliveryControl,
} from "../services/delivery-control-outbox.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { _resetClientsForTest, broadcastDeliveryFrame } from "../services/sse.js";
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
const TOKEN = "delivery-token-for-the-steering-composer";
const NOTE = "Prefer React Aria Dialog over a custom modal.";
const READ_BACK = "Will use Dialog from React Aria for every new modal from C on.";

const nodeFetch = globalThis.fetch;

let tmp: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let streams: StreamEventSource[];
let nextSeq: number;
// Each request the client sent: its method, path and answer status.
let clientRequests: Array<{ method: string; path: string; status: number }>;

// Four units A, B, C and D, a stack of A, B and C, and gates after B and after
// C. B runs, so the next boundary is B finishing.
function fixtureRecord(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
  const seq = nextSeq;
  nextSeq += 1;
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: fixtureRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

// The boundary event: B finishes and C starts. It reads nothing back.
function boundaryEvents(): DeliveryEvent[] {
  return [
    event("unit.changed", { status: "done" }, "B"),
    event("unit.changed", { status: "running" }, "C"),
  ];
}

// The session's read-back of a steering note.
function steeringReadBack(controlSeq: number, note = READ_BACK): DeliveryEvent {
  return event("steering.added", {
    steering_id: `steering-read-back-${controlSeq}`,
    note,
    unit_ids: [],
    control_seq: controlSeq,
  });
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

async function operatorPost(body: unknown): Promise<Response> {
  return nodeFetch(`${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/steering`, {
    method: "POST",
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

async function sendNote(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Steering note" }), text);
  await user.click(screen.getByRole("button", { name: "Send note" }));
}

const boundaryName = () => screen.getByTestId("boundary-name");

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-steering-live-"));
  const workspace = path.join(tmp, "workspace");
  const specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  const record = fixtureRecord();
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
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

describe("Steering composer and boundary panel over the live path", () => {
  it("SB-TC-039 a steering note queues for the next boundary and is applied only after the read-back", async () => {
    renderTab();
    await snapshotShown();
    expect(boundaryName()).toHaveTextContent("B finishes");

    // Step 1: the operator types a note and sends it.
    await sendNote(NOTE);
    await waitFor(
      () =>
        expect(clientRequests).toContainEqual({
          method: "POST",
          path: `/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/steering`,
          status: 202,
        }),
      { timeout: 3000 },
    );
    const queued = await screen.findByTestId("steering-note-1", undefined, { timeout: 3000 });
    expect(within(screen.getByTestId("boundary-queue")).getByTestId("steering-note-1")).toBe(
      queued,
    );
    expect(queued).toHaveAttribute("data-state", "queued");
    expect(queued).toHaveTextContent(NOTE);
    expect(queued).toHaveTextContent("applies at the next boundary · B");
    expect(within(queued).queryByTestId("steering-note-read-back")).not.toBeInTheDocument();

    // The tooling reads the note: every unit after the boundary, with the
    // boundary kept on the body.
    const read = await readControls();
    expect(read.controls).toHaveLength(1);
    expect(read.controls[0]).toMatchObject({
      control_seq: 1,
      kind: "steering-note",
      body: { note: NOTE, unit_ids: [], applies_at: "B" },
    });

    // Step 2: the boundary passes with no read-back, and the note stays queued.
    await post(boundaryEvents());
    await waitFor(() => expect(boundaryName()).toHaveTextContent("C finishes"), {
      timeout: 3000,
    });
    const stillQueued = within(screen.getByTestId("boundary-queue")).getByTestId("steering-note-1");
    expect(stillQueued).toHaveAttribute("data-state", "queued");
    expect(screen.queryByTestId("steering-notes-settled")).not.toBeInTheDocument();

    // Step 3: the session reads the note back, and it shows applied with the
    // read-back text.
    await post([steeringReadBack(1)]);
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId("steering-notes-settled")).getByTestId("steering-note-1"),
        ).toHaveAttribute("data-state", "applied"),
      { timeout: 3000 },
    );
    const applied = screen.getByTestId("steering-note-1");
    expect(applied).toHaveTextContent(NOTE);
    expect(within(applied).getByTestId("steering-note-read-back")).toHaveTextContent(
      `Read-back: ${READ_BACK}`,
    );
    expect(screen.getByTestId("boundary-queue-empty")).toBeInTheDocument();
    expect(bench.deliveryControlQueue?.[0]?.status).toBe("applied");
  });

  it("SB-TC-040 the panel names the next boundary with every queued note and role change, then the following boundary with an empty queue", async () => {
    renderTab();
    await snapshotShown();

    // Step 1: a role change waits in the outbox, and the operator queues a note.
    const roleChange = issueDeliveryControl(bench, {
      deliveryId: fixtureRecord().delivery_id,
      kind: "role-change",
      targetId: "unit-coder",
      body: { tier: "balanced" },
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(roleChange.ok).toBe(true);
    broadcastDeliveryFrame(PROJECT_ID, BENCH_ID, fixtureRecord().last_event_seq, "controls");
    await sendNote(NOTE);

    await waitFor(
      () => {
        const queue = screen.getByTestId("boundary-queue");
        expect(within(queue).getByTestId("boundary-role-change-1")).toHaveTextContent(
          "unit-coder: balanced",
        );
        expect(within(queue).getByTestId("steering-note-2")).toHaveTextContent(NOTE);
      },
      { timeout: 3000 },
    );
    expect(boundaryName()).toHaveTextContent("B finishes");
    expect(within(screen.getByTestId("boundary-queue")).getAllByRole("listitem")).toHaveLength(2);

    // Step 2: the boundary event with the read-backs of both.
    await post([
      ...boundaryEvents(),
      steeringReadBack(2),
      event("delivery.planned", { roles: { "unit-coder": { tier: "balanced" } }, control_seq: 1 }),
    ]);
    await waitFor(
      () => {
        expect(boundaryName()).toHaveTextContent("C finishes");
        expect(screen.getByTestId("boundary-queue-empty")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByTestId("boundary-queue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("boundary-role-change-1")).not.toBeInTheDocument();
  });
});

describe("POST /delivery/steering", () => {
  it("SB-TC-039 answers 202 with a steering-note control that passes the control contract", async () => {
    const res = await operatorPost({ text: NOTE, applies_at: "B" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      kind: "steering-note",
      control_seq: 1,
      durability: "durable",
      status: "pending",
      body: { note: NOTE, unit_ids: [], applies_at: "B" },
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(bench.deliveryControlQueue).toHaveLength(1);
  });

  it.each([
    ["no text", { applies_at: "B" }, "text"],
    ["a blank text", { text: "   ", applies_at: "B" }, "text"],
    ["a text that is not a string", { text: 3, applies_at: "B" }, "text"],
    ["no boundary", { text: NOTE }, "applies_at"],
    ["an empty boundary", { text: NOTE, applies_at: "" }, "applies_at"],
  ])("SB-TC-039 refuses a note with %s and issues nothing", async (_label, body, field) => {
    const res = await operatorPost(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BODY", field });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);
  });

  it("answers 404 for a bench that is not a Spec Bench", async () => {
    bench = { ...bench, variant: undefined };
    const res = await operatorPost({ text: NOTE, applies_at: "B" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_SPEC_BENCH" });
  });
});
