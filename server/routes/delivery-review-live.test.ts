// @vitest-environment jsdom
//
// Agent decisions on the decision pile and the review call, through the real
// ingest, control and stream path (SB-TC-080, SB-TC-081, SB-TC-083, SB-TC-097,
// SB-TC-103; SB-FR-033, SB-FR-034, SB-NFR-009, SB-US-014).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// event and control routes (routes/delivery-hooks.ts) and their body parser,
// the delivery routes (routes/delivery.ts: the snapshot read and approve), the notification stream (routes/notifications.ts and
// services/sse.ts), the delivery token check, the bench's event log, the
// control outbox, the record loader over a record in a bench workspace on
// disk, the decision notification rule (services/delivery-decision.ts) and the
// notification store (services/notification.ts). On the client side, the real
// `lib/api` request layer, the real React Query hooks, the real notification
// stream hook and the real Delivery tab with its decision pile. The client
// reaches the server over HTTP: `fetch` resolves the client's relative paths
// against the server, and `EventSource` (which jsdom lacks) is a small
// text/event-stream reader over a streamed fetch of GET
// /api/notifications/stream. The fake tooling posts events with the token and
// reads the outbox from the controls endpoint.
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
import type { Bench, BenchNotification } from "@roubo/shared";
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
  getSessionScrollback: vi.fn(),
}));
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import { forgetDeliveryControlMemory } from "../services/delivery-control-outbox.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { getNotifications } from "../services/notification.js";
import { _resetClientsForTest, getClientCount } from "../services/sse.js";
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
const TOKEN = "delivery-token-for-the-review-pile";
const OPTIONS = ["one file per unit", "one file per stack"];

const nodeFetch = globalThis.fetch;

let tmp: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let streams: StreamEventSource[];
let rawStream: AbortController | undefined;
let nextSeq: number;

// The record of four units A, B, C and D, a stack of A, B and C, and gates
// after B and after C, in auto mode, with no decision and nothing to review.
function autoRecord(): DeliveryRecord {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  return {
    ...record,
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    decisions: [],
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

function event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
  const seq = nextSeq;
  nextSeq += 1;
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: autoRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

// The session decides a decision on its own, `index` seconds after 10:00.
function decided(id: string, index: number, rationale = `Rationale of ${id}.`): DeliveryEvent {
  return event(
    "decision.decided",
    {
      decision_id: id,
      question: `Which layout for ${id}?`,
      options: OPTIONS,
      default: OPTIONS[0],
      chosen: OPTIONS[1],
      rationale,
      affected_units: ["B", "C"],
      decided_at: new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString(),
    },
    "B",
  );
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

function decisionNotifications(): BenchNotification[] {
  return getNotifications(bench).filter((n) => n.type === "delivery-decision");
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

interface NotificationsFrame {
  type: string;
  notifications: BenchNotification[];
}

// The notification stream as any client reads it: each `notifications` frame.
async function openNotificationFrames(): Promise<NotificationsFrame[]> {
  const frames: NotificationsFrame[] = [];
  const before = getClientCount();
  rawStream = new AbortController();
  const res = await nodeFetch(`${origin}/api/notifications/stream`, {
    headers: { Accept: "text/event-stream" },
    signal: rawStream.signal,
  });
  if (res.body === null) throw new Error("the stream answered no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const frame = JSON.parse(line.slice(5).trimStart()) as NotificationsFrame;
            if (frame.type === "notifications") frames.push(frame);
          }
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The stream is aborted when the test ends.
    }
  })();
  await vi.waitFor(() => expect(getClientCount()).toBe(before + 1), { timeout: 3000 });
  return frames;
}

// The client's requests carry relative paths; they reach the server here. The
// jsdom AbortSignal is not the one Node's fetch takes, so a signal is dropped.
function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), origin).toString();
  const rest: RequestInit = { ...init };
  delete rest.signal;
  return nodeFetch(url, rest);
}

function Harness() {
  useNotificationStream();
  return createElement(DeliveryTabPanel, { bench });
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
}

async function snapshotShown(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("delivery-snapshot")).toBeInTheDocument(), {
    timeout: 3000,
  });
}

const reviewCard = (id: string) => screen.queryByTestId(`review-card-${id}`);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-review-live-"));
  const workspace = path.join(tmp, "workspace");
  const specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  const record = autoRecord();
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
  vi.stubGlobal("fetch", vi.fn(clientFetch));
  vi.stubGlobal("EventSource", StreamEventSource);
});

afterEach(async () => {
  cleanup();
  for (const stream of streams) stream.close();
  rawStream?.abort();
  rawStream = undefined;
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetClientsForTest();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Agent decisions and the review call over the live path", () => {
  it("SB-TC-080 a decision.decided joins the pile as a card with its choice, rationale and affected units, and raises no notification", async () => {
    renderTab();
    await snapshotShown();

    // Step 1: the session decides D-1 with a choice, a rationale and two
    // affected units.
    await post([decided("D-1", 1, "The fixture files carry none.")]);
    await waitFor(() => expect(reviewCard("D-1")).toBeInTheDocument(), { timeout: 3000 });
    const card = reviewCard("D-1") as HTMLElement;
    expect(within(card).getByTestId("review-choice")).toHaveTextContent(`chose${OPTIONS[1]}`);
    expect(within(card).getByTestId("review-rationale")).toHaveTextContent(
      "The fixture files carry none.",
    );
    expect(within(card).getByTestId("review-origin")).toHaveTextContent("affects B, C");
    expect(decisionNotifications()).toEqual([]);

    // Step 2: a raised decision still raises its notification, as before.
    await post([
      event(
        "decision.raised",
        {
          decision_id: "D-9",
          question: "Which parser?",
          options: OPTIONS,
          default: OPTIONS[0],
        },
        "B",
      ),
    ]);
    expect(decisionNotifications().map((n) => n.dedupeKey)).toEqual(["D-9"]);
  });

  it("SB-TC-081 a review call raises one notification with a count and presents the cards oldest first", async () => {
    await post([decided("D-2", 2), decided("D-1", 1), decided("D-3", 3)]);
    const frames = await openNotificationFrames();
    renderTab();
    await snapshotShown();
    await waitFor(() => expect(reviewCard("D-1")).toHaveAttribute("data-position", "top"), {
      timeout: 3000,
    });
    expect(decisionNotifications()).toEqual([]);

    // Step 1: the review call raises one notification whose text is a count.
    const opened = { trigger: "boundary", unreviewed: ["D-1", "D-2", "D-3"] };
    await post([event("review.opened", opened)]);
    const notifications = decisionNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      dedupeKey: "review:demo-delivery-1:boundary:D-1",
      metadata: { review: true, count: 3 },
    });
    expect(JSON.stringify(notifications[0].metadata)).not.toMatch(/Which layout|Rationale/);
    await vi.waitFor(
      () =>
        expect(
          frames.at(-1)?.notifications.filter((n) => n.type === "delivery-decision"),
        ).toHaveLength(1),
      { timeout: 2000 },
    );
    await waitFor(
      () =>
        expect(within(reviewCard("D-1") as HTMLElement).getByTestId("review-badge")).toHaveTextContent(
          "D-1 · to review",
        ),
      { timeout: 3000 },
    );

    // Step 2: the same review call again raises no second notification.
    const framesBefore = frames.length;
    await post([event("review.opened", opened)]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(decisionNotifications()).toHaveLength(1);
    expect(frames).toHaveLength(framesBefore);

    // Step 3: the session accepts D-1 and posts its review.outcome; D-1 leaves
    // the pile and D-2 is the top card. The card offers no Accept action in
    // this slice, and nothing lands in the outbox.
    expect(
      within(reviewCard("D-1") as HTMLElement).queryByRole("button", { name: "Accept" }),
    ).toBeNull();
    await post([event("review.outcome", { decision_id: "D-1", status: "accepted" })]);
    await waitFor(() => expect(reviewCard("D-1")).not.toBeInTheDocument(), { timeout: 3000 });
    expect(reviewCard("D-2")).toHaveAttribute("data-position", "top");
    expect((await readControls()).controls).toEqual([]);
  });

  it("SB-TC-081 a review call that lists nothing, or a decision already reviewed, notifies for the cards on the pile", async () => {
    await post([decided("D-1", 1)]);
    // An empty list while D-1 waits: the fold reviews D-1, and so does the
    // notification.
    await post([event("review.opened", { trigger: "boundary", unreviewed: [] })]);
    expect(decisionNotifications()).toEqual([
      expect.objectContaining({
        dedupeKey: "review:demo-delivery-1:boundary:D-1",
        metadata: { review: true, count: 1 },
      }),
    ]);

    // D-1 is reviewed and D-2 waits; a list that still names D-1 counts one card
    // and keys on D-2, the card on the pile.
    await post([
      event("review.outcome", { decision_id: "D-1", status: "accepted" }),
      decided("D-2", 2),
    ]);
    await post([event("review.opened", { trigger: "gate", unreviewed: ["D-1", "D-2"] })]);
    const latest = decisionNotifications().find((n) => n.dedupeKey?.includes(":gate:"));
    expect(latest).toMatchObject({
      dedupeKey: "review:demo-delivery-1:gate:D-2",
      metadata: { review: true, count: 1 },
    });
  });

  it("SB-TC-083 session text renders as literal characters and stays out of the review notification", async () => {
    const pwned = window as unknown as { __sbPwned?: number };
    delete pwned.__sbPwned;
    const rationale =
      '<script>window.__sbPwned = 1</script><img src="x" onerror="window.__sbPwned = 2">';
    await post([
      decided("D-1", 1, rationale),
      decided("D-2", 2),
      event("review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2"] }),
    ]);
    const view = renderTab();
    await snapshotShown();

    // Step 1: the rationale shows as literal characters; nothing runs.
    await waitFor(() => expect(reviewCard("D-1")).toBeInTheDocument(), { timeout: 3000 });
    const card = reviewCard("D-1") as HTMLElement;
    expect(within(card).getByTestId("review-rationale").textContent).toBe(rationale);
    expect(view.container.querySelector("script, img, iframe")).toBeNull();

    // Step 2: the thread shows a reply with a script URL and Markdown link
    // syntax as literal characters, with no link.
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Discuss" }));
    const reply =
      '<a href="javascript:window.__sbPwned = 3">open</a> [docs](javascript:window.__sbPwned=4)';
    await post([event("review.reply", { decision_id: "D-1", text: reply, in_reply_to: "1" })]);
    const thread = await screen.findByTestId("review-thread-D-1", {}, { timeout: 3000 });
    await waitFor(() => expect(thread).toHaveTextContent(reply), { timeout: 3000 });
    expect(thread.querySelector("a")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();

    // Step 3: the outcome's summary shows as literal characters.
    const summary = "<script>window.__sbPwned = 5</script>";
    await post([event("review.outcome", { decision_id: "D-1", status: "accepted", summary })]);
    const shown = await screen.findByTestId("review-summary-D-1", {}, { timeout: 3000 });
    expect(shown.textContent).toBe(summary);
    expect(view.container.querySelector("script, img, a")).toBeNull();
    expect(pwned.__sbPwned).toBeUndefined();
    // No image request reached the server or any other host.
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([input]) => /\/x$/.test(String(input))),
    ).toBe(false);

    // Step 4: the review notification carries no text from the session.
    const notifications = decisionNotifications();
    expect(notifications).toHaveLength(1);
    const carried = JSON.stringify(notifications[0].metadata);
    for (const text of ["script", "javascript", "Which layout", "Rationale", "docs"]) {
      expect(carried).not.toContain(text);
    }
  });

  it("SB-TC-097 approval is refused with REVIEW_OPEN while a review is open, and accepted once it is done", async () => {
    await post([
      decided("D-1", 1),
      decided("D-2", 2),
      event("review.opened", { trigger: "gate", unreviewed: ["D-1", "D-2"] }),
    ]);
    renderTab();
    await snapshotShown();

    // Step 1: the approval control is unavailable and names the open review.
    const approve = await screen.findByRole("button", { name: "Approve" }, { timeout: 3000 });
    await waitFor(() => expect(approve).toBeDisabled(), { timeout: 3000 });
    expect(screen.getByTestId("delivery-approve-reason")).toHaveTextContent(
      "A review is open with 2 cards to review",
    );
    expect(approve).toHaveAttribute("aria-describedby", "delivery-approve-reason");

    // Step 2: an approval request is refused.
    const refused = await operatorPost("approve", {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "REVIEW_OPEN",
      unreviewed: ["D-1", "D-2"],
    });

    // Step 3: once both outcomes land, the approval is accepted.
    await post([
      event("review.outcome", { decision_id: "D-1", status: "accepted" }),
      event("review.outcome", { decision_id: "D-2", status: "accepted" }),
    ]);
    const accepted = await operatorPost("approve", { reason: "All reviewed." });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      kind: "approval",
      body: { reason: "All reviewed." },
      status: "pending",
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(), {
      timeout: 3000,
    });
    expect(screen.queryByTestId("delivery-approve-reason")).not.toBeInTheDocument();
  });

  it("offers no accept route, and refuses an approval with a bad reason", async () => {
    await post([decided("D-1", 1)]);
    const accept = await operatorPost("decisions/D-1/accept", {});
    expect(accept.status).toBe(404);
    expect((await readControls()).controls).toEqual([]);

    const badReason = await operatorPost("approve", { reason: ["no"] });
    expect(badReason.status).toBe(400);
    expect(await badReason.json()).toMatchObject({ code: "INVALID_BODY", field: "reason" });
  });

  it("SB-TC-103 a pile of 100 agent decisions renders one body, raises a lower card on Enter and one review notification", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `D-${index + 1}`);
    // Step 1: 100 decisions, and no notification.
    await post(ids.map((id, index) => decided(id, index)));
    expect(decisionNotifications()).toEqual([]);
    renderTab();
    await snapshotShown();
    await waitFor(() => expect(reviewCard("D-1")).toHaveAttribute("data-position", "top"), {
      timeout: 3000,
    });
    const pile = screen.getByRole("list", { name: "Review pile" });
    expect(within(pile).getAllByTestId("review-rationale")).toHaveLength(1);
    expect(pile.querySelectorAll('[data-position="lower"]')).toHaveLength(99);

    // Step 2: Enter on the last card's title bar raises it with its body.
    const user = userEvent.setup();
    (reviewCard("D-100") as HTMLElement).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(reviewCard("D-100")).toHaveAttribute("data-position", "top"));
    expect(
      within(reviewCard("D-100") as HTMLElement).getByTestId("review-rationale"),
    ).toHaveTextContent("Rationale of D-100.");
    const raised = screen.getByRole("list", { name: "Review pile" });
    expect(within(raised).getAllByTestId("review-rationale")).toHaveLength(1);

    // Step 3: a review call for all 100 raises one notification with the count.
    await post([event("review.opened", { trigger: "boundary", unreviewed: ids })]);
    const notifications = decisionNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].metadata).toEqual({ review: true, count: 100 });
  });
});
