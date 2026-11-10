// @vitest-environment jsdom
//
// The mode switch of the delivery's controls, through the real control, ingest
// and stream path (SB-TC-084; SB-FR-032, SB-US-013).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// routes (routes/delivery.ts: the snapshot read and the mode route), the
// delivery event and control routes (routes/delivery-hooks.ts) and their body
// parser, the notification stream (routes/notifications.ts and
// services/sse.ts), the delivery token check, the bench's event log, the
// control outbox and its read-back rule, and the record loader over a record in
// a bench workspace on disk. On the client side, the real `lib/api` request
// layer, the real React Query hooks, the real notification stream hook, the
// real Delivery tab with its Mode switch and shell header, and the real variant
// badge of the bench card, fed from the bench list the stream patches. The
// client reaches the server over HTTP, and `EventSource` (which jsdom lacks) is
// a small text/event-stream reader over a streamed fetch. The fake tooling
// posts events with the token and reads the outbox from the controls endpoint.
//
// The bench manager is a stand-in that knows the one Spec Bench, the state
// file write is a stand-in, and the operator's git identity is fixed.
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
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
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
}));
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import * as stateService from "../services/state.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import { forgetDeliveryControlMemory } from "../services/delivery-control-outbox.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { _resetClientsForTest } from "../services/sse.js";
import { makeBench } from "../test/fixtures.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import deliveryRouter from "./delivery.js";
import notificationsRouter from "./notifications.js";
import { useNotificationStream } from "../../client/src/hooks/useNotificationStream";
import DeliveryTabPanel from "../../client/src/components/delivery/DeliveryTabPanel";
import { openCostView } from "../../client/src/test/delivery-views";
import VariantBadge from "../../client/src/components/VariantBadge";

// The jsdom URL global is not the one fileURLToPath takes, so the path is
// joined from this file's own path.
const FIXTURE_RECORD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/__fixtures__/delivery-record.json",
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-mode-switch";

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
// C, running in attended mode with nothing pending and no review waiting.
function modeRecord(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  return {
    ...record,
    mode: { value: "attended", pending: null },
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
    ...overrides,
  };
}

function writeRecord(record: DeliveryRecord): void {
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function event(type: string, payload: Record<string, unknown>): DeliveryEvent {
  const seq = nextSeq;
  nextSeq += 1;
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: modeRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
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

async function putMode(body: unknown): Promise<Response> {
  return nodeFetch(`${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/mode`, {
    method: "PUT",
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

// The bench card's variant badge, as BenchCard renders it, over the bench list
// that the client holds: the list is seeded once and never fetched again, so
// only the stream's patch can change the mode it names.
function BenchCardBadge() {
  const benches = useQuery<Bench[]>({
    queryKey: ["benches"],
    queryFn: () => Promise.resolve([]),
    staleTime: Infinity,
  });
  const card = benches.data?.find((b) => b.projectId === PROJECT_ID && b.id === BENCH_ID);
  if (card === undefined) return null;
  return createElement(VariantBadge, {
    variant: card.variant,
    decisionMode: card.deliveryDecisionMode,
  });
}

function Harness() {
  useNotificationStream();
  return createElement(
    "div",
    null,
    createElement(BenchCardBadge),
    createElement(DeliveryTabPanel, { bench }),
  );
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<Bench[]>(["benches"], [{ ...bench }]);
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

// Waits until every stream the client opened is connected, so a broadcast
// after this reaches it.
async function streamsOpen(): Promise<void> {
  await waitFor(
    () => {
      expect(streams.length).toBeGreaterThan(0);
      expect(streams.every((stream) => stream.readyState === 1)).toBe(true);
    },
    { timeout: 3000 },
  );
}

// Opens the notification stream as a bare reader, and returns the frames it
// reads, in order, once it is connected.
async function openStream(): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = [];
  const stream = new StreamEventSource("/api/notifications/stream");
  stream.onmessage = (message) => {
    frames.push(JSON.parse(message.data) as Record<string, unknown>);
  };
  await streamsOpen();
  return frames;
}

const modeControl = () => screen.getByTestId("delivery-mode-control");
const segment = (name: "Attended" | "Auto") => within(modeControl()).getByRole("radio", { name });

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-mode-live-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  const record = modeRecord();
  writeRecord(record);
  nextSeq = record.last_event_seq + 1;
  bench = makeBench({
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    deliveryBindMode: "launch",
    deliveryDecisionMode: "attended",
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
  vi.mocked(stateService.updateBench).mockClear();
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

describe("Mode switch over the live path", () => {
  it("SB-TC-084 a switch to auto shows pending with attended selected, is read by the tooling, and applies on its mode.changed read-back", async () => {
    renderTab();
    await snapshotShown();
    // The mode control is in the cost view (#1620).
    await openCostView();
    await waitFor(() => expect(screen.getByTestId("bench-variant-badge")).toBeInTheDocument());
    expect(segment("Attended")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("decision-mode-pending")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-mode-label")).toHaveTextContent("attended mode");
    expect(screen.getByTestId("bench-variant-badge")).toHaveTextContent(/^Spec Bench$/);

    // Step 1: select Auto. The request answers 202, the badge shows, and
    // Attended stays the selected segment.
    const user = userEvent.setup();
    await user.click(segment("Auto"));
    await requestAnswered("PUT", "mode", 202);
    await waitFor(() => expect(screen.getByTestId("decision-mode-pending")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId("decision-mode-pending")).toHaveTextContent(
      "pending · next boundary",
    );
    expect(segment("Attended")).toHaveAttribute("aria-checked", "true");
    expect(segment("Auto")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("delivery-mode-label")).toHaveTextContent("attended mode");
    const [issued] = bench.deliveryControlQueue ?? [];
    expect(issued).toMatchObject({ kind: "mode_switch", body: { mode: "auto" } });

    // Step 2: the tooling reads the mode_switch control from the controls endpoint.
    const read = await readControls();
    expect(read.controls).toHaveLength(1);
    expect(read.controls[0]).toMatchObject({
      control_seq: issued?.control_seq,
      kind: "mode_switch",
      body: { mode: "auto" },
    });
    // The read alone moves nothing.
    expect(segment("Attended")).toHaveAttribute("aria-checked", "true");

    // Step 3: the session applies it. Auto is selected, the badge is gone, and
    // the shell and the bench card both name auto mode.
    await post([event("mode.changed", { value: "auto", control_seq: issued?.control_seq })]);
    await waitFor(() => expect(segment("Auto")).toHaveAttribute("aria-checked", "true"), {
      timeout: 3000,
    });
    expect(segment("Attended")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("decision-mode-pending")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-mode-label")).toHaveTextContent("auto mode");
    await waitFor(
      () =>
        expect(screen.getByTestId("bench-variant-badge")).toHaveTextContent("Spec Bench · auto"),
      { timeout: 3000 },
    );
    expect(bench.deliveryControlQueue?.[0]?.status).toBe("applied");
    expect(bench.deliveryDecisionMode).toBe("auto");
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryDecisionMode: "auto" }),
    );

    // Step 4: Auto again is 409 MODE_UNCHANGED, and issues nothing.
    const again = await putMode({ mode: "auto" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "MODE_UNCHANGED", mode: "auto" });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(1);
  });

  it("SB-TC-084 a record that already states auto, with its mode.changed at or below last_event_seq, moves the bench card and the persisted bench to auto", async () => {
    renderTab();
    await snapshotShown();
    await streamsOpen();
    expect(screen.getByTestId("bench-variant-badge")).toHaveTextContent(/^Spec Bench$/);

    // The session writes the record in auto first, with a last_event_seq that
    // covers its mode.changed, and only then posts that event with the next
    // one: the bench skips the mode.changed and accepts only the next event.
    const changed = event("mode.changed", { value: "auto" });
    writeRecord(
      modeRecord({ mode: { value: "auto", pending: null }, last_event_seq: changed.seq }),
    );
    await post([changed, event("lifecycle.changed", { state: "running" })]);

    await waitFor(
      () =>
        expect(screen.getByTestId("bench-variant-badge")).toHaveTextContent("Spec Bench · auto"),
      { timeout: 3000 },
    );
    await waitFor(
      () => expect(screen.getByTestId("delivery-mode-label")).toHaveTextContent("auto mode"),
      { timeout: 3000 },
    );
    expect(bench.deliveryDecisionMode).toBe("auto");
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryDecisionMode: "auto" }),
    );
  });

  it("SB-TC-084 a record that states auto with no event posted moves the persisted bench to auto on its next load", async () => {
    writeRecord(modeRecord({ mode: { value: "auto", pending: null } }));
    const frames = await openStream();

    const res = await nodeFetch(
      `${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery`,
    );
    expect(res.status).toBe(200);
    expect(bench.deliveryDecisionMode).toBe("auto");
    expect(stateService.updateBench).toHaveBeenCalledTimes(1);
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryDecisionMode: "auto" }),
    );
    await waitFor(
      () =>
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "bench-decision-mode",
            projectId: PROJECT_ID,
            benchId: BENCH_ID,
            decisionMode: "auto",
          }),
        ),
      { timeout: 3000 },
    );

    // A second load of the same record moves nothing.
    await nodeFetch(`${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery`);
    expect(stateService.updateBench).toHaveBeenCalledTimes(1);
  });

  it("SB-TC-084 an attached bench takes the mode of its record on the first load", async () => {
    bench = { ...bench, deliveryBindMode: "attach" };
    delete bench.deliveryDecisionMode;
    writeRecord(modeRecord({ mode: { value: "auto", pending: null } }));

    const res = await nodeFetch(
      `${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery`,
    );
    expect(res.status).toBe(200);
    expect(bench.deliveryDecisionMode).toBe("auto");
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryDecisionMode: "auto" }),
    );
  });

  it("SB-TC-084 a mode.changed to the mode already in effect saves nothing and broadcasts no bench-decision-mode", async () => {
    const frames = await openStream();

    await post([event("mode.changed", { value: "attended" })]);
    // The batch's delivery frame arrives, so a mode frame would have too.
    await waitFor(
      () => expect(frames).toContainEqual(expect.objectContaining({ type: "delivery" })),
      { timeout: 3000 },
    );
    expect(bench.deliveryDecisionMode).toBe("attended");
    expect(stateService.updateBench).not.toHaveBeenCalled();
    expect(frames).not.toContainEqual(expect.objectContaining({ type: "bench-decision-mode" }));
  });
});

describe("PUT /delivery/mode", () => {
  it("SB-TC-084 answers 202 with a mode_switch control that passes the control contract", async () => {
    const res = await putMode({ mode: "auto" });
    expect(res.status).toBe(202);
    const control = (await res.json()) as Record<string, unknown>;
    expect(control).toMatchObject({
      kind: "mode_switch",
      control_seq: 1,
      body: { mode: "auto" },
      durability: "durable",
      status: "pending",
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(control).not.toHaveProperty("target_id");
    // The switch asked for a mode; it is not in effect until the read-back.
    expect(bench.deliveryDecisionMode).toBe("attended");
  });

  it.each([
    ["no mode", {}],
    ["a mode outside the vocabulary", { mode: "manual" }],
    ["a mode that is not a string", { mode: 1 }],
    ["a mode in another case", { mode: "Auto" }],
  ])("SB-TC-084 refuses a switch with %s as 400 and issues nothing", async (_label, body) => {
    const res = await putMode(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BODY", field: "mode" });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);
  });

  it("SB-TC-084 answers 404 NOT_SPEC_BENCH for a bench that is not a Spec Bench", async () => {
    bench = { ...bench, variant: undefined };
    const res = await putMode({ mode: "auto" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_SPEC_BENCH" });
  });

  it("SB-TC-084 answers 409 MODE_UNCHANGED for the mode in effect with none pending", async () => {
    const res = await putMode({ mode: "attended" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "MODE_UNCHANGED", mode: "attended" });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(0);
  });

  it("SB-TC-084 the mode in effect with another switch pending issues a switch back", async () => {
    const toAuto = await putMode({ mode: "auto" });
    expect(toAuto.status).toBe(202);
    const back = await putMode({ mode: "attended" });
    expect(back.status).toBe(202);
    expect(await back.json()).toMatchObject({
      kind: "mode_switch",
      control_seq: 2,
      body: { mode: "attended" },
    });
  });

  it("SB-TC-084 the mode in effect with the record's own switch pending is not unchanged", async () => {
    writeRecord(modeRecord({ mode: { value: "attended", pending: "auto" } }));
    const res = await putMode({ mode: "attended" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ kind: "mode_switch", body: { mode: "attended" } });
  });

  it("SB-TC-084 the same switch again while it waits answers 202 with the waiting control", async () => {
    const first = (await (await putMode({ mode: "auto" })).json()) as { control_seq: number };
    await readControls();
    const again = await putMode({ mode: "auto" });
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({
      kind: "mode_switch",
      control_seq: first.control_seq,
      status: "delivered",
    });
    expect(bench.deliveryControlQueue ?? []).toHaveLength(1);
  });

  it("SB-TC-084 is never blocked: a paused delivery with gates claimed past their results still switches", async () => {
    // The record claims both gates passed, which no results file in the
    // workspace backs, and the delivery is paused: neither holds a switch back.
    const record = modeRecord();
    writeRecord({
      ...record,
      lifecycle: { ...record.lifecycle, state: "paused" },
      stack: {
        ...record.stack,
        gates: record.stack.gates.map((gate) => ({ ...gate, status: "passed" })),
      },
    });
    const res = await putMode({ mode: "auto" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ kind: "mode_switch", body: { mode: "auto" } });
  });
});
