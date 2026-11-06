// @vitest-environment jsdom
//
// The discussion thread on a review card, through the real ingest, control and
// stream path (SB-TC-088, SB-TC-089, SB-TC-092; SB-FR-036, SB-US-014).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// event and control routes (routes/delivery-hooks.ts) and their body parser,
// the delivery routes (routes/delivery.ts: the snapshot read, accept and the
// thread), the notification stream (routes/notifications.ts and
// services/sse.ts), the delivery token check, the bench's event log, the
// control outbox and the record loader over a record in a bench workspace on
// disk. On the client side, the real `lib/api` request layer, the real React
// Query hooks, the real notification stream hook and the real Delivery tab
// with its review pile. The fake tooling posts events with the token and reads
// the outbox from the controls endpoint.
//
// The bench manager is a stand-in that knows the one Spec Bench, the state
// file write is a stand-in that records what would be saved, the operator's
// git identity is fixed, the session launcher stays out, and the terminal
// service is a stand-in whose one session is the bench's main session, live or
// stopped as a test sets it; the client reads the same session from a small
// terminals route. A server restart drops what the server keeps in memory: the
// event log above the record and the in-memory part of the outbox.
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
import type { Bench, DeliveryOutboxControl } from "@roubo/shared";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
} from "@roubo/shared/delivery-bench";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryDecision,
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
import * as stateService from "../services/state.js";
import { getSession } from "../services/terminal.js";
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
import {
  REVIEW_THREAD_NO_SESSION,
  REVIEW_THREAD_UNAVAILABLE,
  REVIEW_THREAD_WAITING,
} from "../../client/src/components/delivery/ReviewPile";

const FIXTURE_RECORD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/__fixtures__/delivery-record.json",
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-thread";
const SESSION_ID = "main-session-1";
const OPTIONS = ["one file per unit", "one file per stack"];

const nodeFetch = globalThis.fetch;

let tmp: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let streams: StreamEventSource[];
let nextSeq: number;
let sessionLive: boolean;
let threadReplies: Array<{ status: number; body: Record<string, unknown> }>;

const decidedAt = (index: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString();

function agentDecision(id: string, index: number): DeliveryDecision {
  return {
    id,
    question: `Which layout for ${id}?`,
    options: OPTIONS,
    default: OPTIONS[0],
    status: "decided",
    unit_id: "B",
    raised_at: decidedAt(index),
    author: "agent",
    chosen: OPTIONS[1],
    rationale: `Rationale of ${id}.`,
    affected_units: ["B", "C"],
    review: { status: "unreviewed" },
    decided_at: decidedAt(index),
  };
}

// The record of four units A, B, C and D, a stack of A, B and C, and gates
// after B and after C, in auto mode, with the agent decisions D-1 (the older)
// and D-2, and the review as given.
function autoRecord(review: DeliveryRecord["review"]): DeliveryRecord {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  return {
    ...record,
    mode: { value: "auto", pending: null },
    review,
    decisions: [agentDecision("D-1", 1), agentDecision("D-2", 2)],
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({
        id: gate.id,
        after: gate.after,
        status: "passed",
        cases: gate.cases,
      })),
    },
  };
}

const OPEN_REVIEW: DeliveryRecord["review"] = {
  status: "open",
  trigger: "boundary",
  unreviewed: ["D-1", "D-2"],
};
const NO_REVIEW: DeliveryRecord["review"] = { status: "none", unreviewed: [] };

function event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
  const seq = nextSeq;
  nextSeq += 1;
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
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

async function operatorPost(route: string, body: unknown): Promise<Response> {
  return nodeFetch(`${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/${route}`, {
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

async function snapshotControls(): Promise<Array<Record<string, unknown>>> {
  const res = await nodeFetch(`${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { controls: Array<Record<string, unknown>> }).controls;
}

// What the last state.json write would hold of the bench's outbox.
function savedQueue(): DeliveryOutboxControl[] {
  const calls = vi.mocked(stateService.updateBench).mock.calls;
  const last = calls.at(-1)?.[0] as { deliveryControlQueue?: DeliveryOutboxControl[] } | undefined;
  return last?.deliveryControlQueue ?? [];
}

// A server restart: what the server holds in memory is gone, the record and
// state.json stay.
function restartServer(): void {
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
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
// Each answer to a thread message is kept, so a test reads what the card got.
async function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), origin).toString();
  const rest: RequestInit = { ...init };
  delete rest.signal;
  const res = await nodeFetch(url, rest);
  if (url.endsWith("/thread")) {
    threadReplies.push({
      status: res.status,
      body: (await res.clone().json()) as Record<string, unknown>,
    });
  }
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

async function topCard(id: string): Promise<HTMLElement> {
  await waitFor(
    () => expect(screen.getByTestId(`review-card-${id}`)).toHaveAttribute("data-position", "top"),
    { timeout: 3000 },
  );
  return screen.getByTestId(`review-card-${id}`);
}

function writeRecord(record: DeliveryRecord): void {
  const specFolder = path.join(tmp, "workspace", ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  nextSeq = record.last_event_seq + 1;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-thread-live-"));
  writeRecord(autoRecord(OPEN_REVIEW));
  bench = makeBench({
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: path.join(tmp, "workspace"),
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
    deliverySessionId: SESSION_ID,
  });
  sessionLive = true;
  threadReplies = [];
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(stateService.updateBench).mockClear();
  vi.mocked(getSession).mockImplementation((id) =>
    id === SESSION_ID
      ? ({ id, status: sessionLive ? "live" : "exited" } as ReturnType<typeof getSession>)
      : undefined,
  );
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
  app.get("/api/projects/:projectId/benches/:id/terminals", (_req, res) => {
    res.json([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        benchId: BENCH_ID,
        label: "main",
        createdAt: decidedAt(0),
        status: sessionLive ? "live" : "exited",
      },
    ]);
  });
  app.use("/api/projects", deliveryRouter);
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/notifications", notificationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  streams = [];
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

describe("The discussion thread on a review card over the live path", () => {
  it("SB-TC-088 a discussion runs on the card, and only the summary stays after the outcome", async () => {
    renderTab();
    const user = userEvent.setup();
    const card = await topCard("D-1");

    // Step 1: open the thread on D-1 and send a message.
    await user.click(within(card).getByRole("button", { name: "Discuss" }));
    const question = "Why one file per stack?";
    await user.type(within(card).getByLabelText("Ask about this decision"), question);
    await user.click(within(card).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(threadReplies).toHaveLength(1), { timeout: 3000 });
    const [sent] = threadReplies;
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({
      kind: "thread_message",
      target_id: "D-1",
      body: { text: question },
      durability: "volatile",
      status: "queued",
    });
    const controlSeq = sent.body.control_seq as number;
    const thread = await screen.findByTestId("review-thread-D-1");
    const message = await within(thread).findByTestId(
      `review-thread-control-${controlSeq}`,
      {},
      { timeout: 3000 },
    );
    expect(message).toHaveTextContent(question);
    expect(message).toHaveAttribute("data-from", "operator");
    expect(within(message).getByTestId("review-thread-author")).toHaveTextContent("you");
    const time = within(message).getByTestId("review-thread-time");
    expect(time).toHaveAttribute("datetime", sent.body.issued_at as string);
    expect(time.textContent).not.toBe("");
    expect(within(thread).getByTestId("review-thread-waiting")).toHaveTextContent(
      REVIEW_THREAD_WAITING,
    );

    // Step 2: the fake tooling reads the message with the decision id.
    const read = await readControls();
    expect(read.controls).toMatchObject([
      {
        control_seq: controlSeq,
        kind: "thread_message",
        target_id: "D-1",
        body: { text: question },
      },
    ]);
    // A second read serves it no more, and the card keeps the question.
    expect((await readControls()).controls).toEqual([]);
    expect(await snapshotControls()).toMatchObject([
      { control_seq: controlSeq, kind: "thread_message", status: "delivered" },
    ]);

    // Step 3: the session's reply names the message's sequence number and
    // shows within 2 seconds on the inset ground; the waiting line goes.
    const answer = "The cache is read once per stack, so one file per stack is fewer reads.";
    const start = Date.now();
    await post([
      event("review.reply", { decision_id: "D-1", text: answer, in_reply_to: String(controlSeq) }),
    ]);
    await waitFor(() => expect(screen.getByTestId("review-thread-D-1")).toHaveTextContent(answer), {
      timeout: 2000,
    });
    expect(Date.now() - start).toBeLessThan(2000);
    const shownThread = screen.getByTestId("review-thread-D-1");
    const reply = within(shownThread)
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("data-from") === "session");
    expect(reply).toHaveTextContent(answer);
    expect(reply).toHaveClass("bg-bg-base");
    expect(within(shownThread).queryByTestId("review-thread-waiting")).toBeNull();
    // The question stays above its answer.
    expect(
      within(shownThread)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining(question), expect.stringContaining(answer)]);

    // Step 4: accept D-1, and the session's outcome carries a summary.
    await user.click(
      within(screen.getByTestId("review-card-D-1")).getByRole("button", { name: "Accept" }),
    );
    await waitFor(
      () => expect(screen.getByTestId("review-card-D-1")).toHaveTextContent("accept queued"),
      { timeout: 3000 },
    );
    const summary = "The operator asked why one file per stack; the session kept it.";
    await post([event("review.outcome", { decision_id: "D-1", status: "accepted", summary })]);
    const shown = await screen.findByTestId("review-summary-D-1", {}, { timeout: 3000 });
    expect(shown.textContent).toBe(summary);
    await waitFor(() => expect(screen.queryByTestId("review-card-D-1")).toBeNull(), {
      timeout: 3000,
    });
    expect(screen.queryByText(question)).toBeNull();
    expect(screen.queryByText(answer)).toBeNull();
    // The server holds no message of D-1's thread any more.
    expect(
      (await snapshotControls()).filter((control) => control.kind === "thread_message"),
    ).toEqual([]);
  });

  it("SB-TC-089 the thread is unavailable outside a review and with no live session", async () => {
    writeRecord(autoRecord(NO_REVIEW));
    renderTab();
    const user = userEvent.setup();

    // Step 1: with no review open, a message is refused and the card says why.
    const noReview = await operatorPost("decisions/D-1/thread", { text: "Why?" });
    expect(noReview.status).toBe(409);
    expect(await noReview.json()).toMatchObject({
      code: "THREAD_UNAVAILABLE",
      reason: "no_review",
    });
    const card = await topCard("D-1");
    expect(within(card).getByTestId("review-thread-unavailable")).toHaveTextContent(
      REVIEW_THREAD_UNAVAILABLE,
    );
    expect(within(card).getByRole("button", { name: "Discuss" })).toBeDisabled();

    // Step 2: a review opens, the main session stops, and a message is
    // refused for no live session; the composer on the card is disabled.
    await post([event("review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2"] })]);
    sessionLive = false;
    const noSession = await operatorPost("decisions/D-1/thread", { text: "Why?" });
    expect(noSession.status).toBe(409);
    expect(await noSession.json()).toMatchObject({
      code: "THREAD_UNAVAILABLE",
      reason: "no_session",
    });
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId("review-card-D-1")).getByRole("button", { name: "Discuss" }),
        ).toBeEnabled(),
      { timeout: 3000 },
    );
    await user.click(
      within(screen.getByTestId("review-card-D-1")).getByRole("button", { name: "Discuss" }),
    );
    // The card read the session as live before it stopped: a send is refused,
    // and the card reads the session again.
    const field = within(screen.getByTestId("review-card-D-1")).getByLabelText(
      "Ask about this decision",
    );
    if (!(field as HTMLTextAreaElement).disabled) {
      await user.type(field, "Why?");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(threadReplies.at(-1)?.status).toBe(409), { timeout: 3000 });
      expect(threadReplies.at(-1)?.body).toMatchObject({ reason: "no_session" });
    }
    await waitFor(
      () =>
        expect(screen.getByTestId("review-thread-composer")).toHaveAttribute(
          "data-disabled",
          "true",
        ),
      { timeout: 3000 },
    );
    expect(
      within(screen.getByTestId("review-card-D-1")).getByLabelText("Ask about this decision"),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByTestId("review-thread-notice")).toHaveTextContent(REVIEW_THREAD_NO_SESSION);

    // Step 3: the session runs again, and an empty text is refused.
    sessionLive = true;
    for (const text of ["", "   ", undefined]) {
      const empty = await operatorPost("decisions/D-1/thread", { text });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toMatchObject({ code: "INVALID_TEXT", field: "text" });
    }
    // Nothing reached the outbox.
    expect((await readControls()).controls).toEqual([]);
  });

  it("SB-TC-092 a restart during a review keeps durable controls and drops unread thread messages", async () => {
    // Step 1: a thread message on D-1 and an accept of D-2, then a restart
    // before the tooling reads.
    const message = await operatorPost("decisions/D-1/thread", { text: "Why one per stack?" });
    expect(message.status).toBe(202);
    const accept = await operatorPost("decisions/D-2/accept", {});
    expect(accept.status).toBe(202);
    // The thread message was never written to state.json; the accept was.
    expect(savedQueue().map((control) => [control.kind, control.target_id])).toEqual([
      ["review_accept", "D-2"],
    ]);
    restartServer();

    expect(await snapshotControls()).toMatchObject([
      { kind: "review_accept", target_id: "D-2", status: "pending" },
    ]);
    renderTab();
    const user = userEvent.setup();
    const card = await topCard("D-1");
    await user.click(within(card).getByRole("button", { name: "Discuss" }));
    const thread = screen.getByTestId("review-thread-D-1");
    expect(thread).toHaveTextContent("No messages on this decision yet");
    expect(within(thread).queryByTestId("review-thread-waiting")).toBeNull();
    expect(within(thread).queryByText("Why one per stack?")).toBeNull();
    // The tooling's read after the restart serves the accept only.
    expect((await readControls()).controls).toMatchObject([
      { kind: "review_accept", target_id: "D-2" },
    ]);

    // Step 2: a reply for D-1 after the restart shows without its question.
    const answer = "One file per stack keeps the reads down.";
    await post([event("review.reply", { decision_id: "D-1", text: answer, in_reply_to: "1" })]);
    await waitFor(() => expect(screen.getByTestId("review-thread-D-1")).toHaveTextContent(answer), {
      timeout: 3000,
    });
    const items = within(screen.getByTestId("review-thread-D-1")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute("data-from", "session");
    expect(screen.queryByText("Why one per stack?")).toBeNull();
    expect(screen.queryByTestId("review-thread-waiting")).toBeNull();
  });
});
