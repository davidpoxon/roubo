// @vitest-environment jsdom
//
// The durable control queue on the bench record, through the real control,
// read and record-load path (SB-TC-090, SB-TC-091; SB-FR-037, SB-NFR-011,
// SB-US-014).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// event and control routes (routes/delivery-hooks.ts), the delivery routes
// (routes/delivery.ts: the snapshot read and the review actions), the
// notification stream, the delivery token check, the control outbox and the
// record loader over a record in a bench workspace on disk, which prunes the
// queue on every load. On the client side, the real `lib/api` request layer,
// the real React Query hooks and the real Delivery tab with its review pile.
// The fake tooling reads the outbox from the controls endpoint.
//
// The bench manager is a stand-in that knows the one Spec Bench, and the state
// file write is a stand-in that records what would be saved. A server restart
// drops what the server keeps in memory and builds the bench again from the
// last state.json write, as the bench manager restores it at boot.
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
import type { Bench, DeliveryOutboxControl, PersistedBench } from "@roubo/shared";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
} from "@roubo/shared/delivery-bench";
import type {
  DeliveryDecision,
  DeliveryRecord,
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

const FIXTURE_RECORD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/__fixtures__/delivery-record.json",
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-queue";
const SESSION_ID = "main-session-1";
const OPTIONS = ["one file per unit", "one file per stack"];
const DECISIONS = ["D-1", "D-2", "D-3", "D-4"];

const nodeFetch = globalThis.fetch;

let tmp: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let reviewReplies: Array<{ route: string; status: number }>;

const decidedAt = (index: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString();

function agentDecision(
  id: string,
  index: number,
  review: "unreviewed" | "accepted" | "overturned",
): DeliveryDecision {
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
    review: { status: review },
    decided_at: decidedAt(index),
  };
}

// The record of four units A, B, C and D, a stack of A, B and C, and gates
// after B and after C, in auto mode and wound down, with the agent decisions
// D-1 to D-4 pending review, but those the reviews given settle.
function windDownRecord(
  reviews: Record<string, "accepted" | "overturned"> = {},
): DeliveryRecord {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  const unreviewed = DECISIONS.filter((id) => reviews[id] === undefined);
  return {
    ...record,
    mode: { value: "auto", pending: null },
    review: { status: unreviewed.length > 0 ? "pending" : "none", unreviewed },
    decisions: DECISIONS.map((id, index) =>
      agentDecision(id, index + 1, reviews[id] ?? "unreviewed"),
    ),
    lifecycle: { ...record.lifecycle, state: "wound-down" },
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

function writeRecord(record: DeliveryRecord): void {
  const specFolder = path.join(tmp, "workspace", ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

async function readControls(after?: number): Promise<{
  controls: Array<Record<string, unknown>>;
  latestSeq: number;
}> {
  const query = after === undefined ? "" : `&after=${after}`;
  const res = await nodeFetch(
    `${origin}${DELIVERY_CONTROLS_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}${query}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { controls: Array<Record<string, unknown>>; latestSeq: number };
}

// What the last state.json write would hold of the bench.
function lastSaved(): PersistedBench | undefined {
  return vi.mocked(stateService.updateBench).mock.calls.at(-1)?.[0];
}

function savedQueue(): DeliveryOutboxControl[] {
  return lastSaved()?.deliveryControlQueue ?? [];
}

function specBench(saved?: PersistedBench): Bench {
  return makeBench({
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: path.join(tmp, "workspace"),
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
    deliverySessionId: SESSION_ID,
    ...(saved?.deliveryControlQueue !== undefined && {
      deliveryControlQueue: saved.deliveryControlQueue,
    }),
    ...(saved?.deliveryControlSeq !== undefined && {
      deliveryControlSeq: saved.deliveryControlSeq,
    }),
  });
}

// A server restart: what the server holds in memory is gone, and the bench is
// built again from what state.json holds. The record stays on disk.
function restartServer(): void {
  cleanup();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  _resetClientsForTest();
  bench = specBench(lastSaved());
}

// The client's requests carry relative paths; they reach the server here. The
// jsdom AbortSignal is not the one Node's fetch takes, so a signal is dropped.
// Each answer to a review action is kept, so a test reads what the card got.
async function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), origin).toString();
  const rest: RequestInit = { ...init };
  delete rest.signal;
  const res = await nodeFetch(url, rest);
  const action = /\/decisions\/(D-\d+\/(?:accept|overturn))$/.exec(url);
  if (action !== null) reviewReplies.push({ route: action[1], status: res.status });
  return res;
}

function Harness() {
  useNotificationStream();
  return createElement(DeliveryTabPanel, { bench });
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
}

async function card(id: string): Promise<HTMLElement> {
  return screen.findByTestId(`review-card-${id}`, {}, { timeout: 3000 });
}

// Raises a card to the top of the pile, and returns it.
async function raise(user: ReturnType<typeof userEvent.setup>, id: string): Promise<HTMLElement> {
  const found = await card(id);
  if (found.getAttribute("data-position") !== "top") await user.click(found);
  await waitFor(
    () => expect(screen.getByTestId(`review-card-${id}`)).toHaveAttribute("data-position", "top"),
    { timeout: 3000 },
  );
  return screen.getByTestId(`review-card-${id}`);
}

// Every card of the three shows its queued badge, and on top its line names
// the resume.
async function expectQueuedBadges(
  user: ReturnType<typeof userEvent.setup>,
  actions: Array<[string, string]>,
): Promise<void> {
  for (const [id, action] of actions) {
    const top = await raise(user, id);
    expect(within(top).getByTestId("review-badge")).toHaveTextContent(`${id} · queued`);
    await waitFor(() =>
      expect(within(screen.getByTestId(`review-card-${id}`)).getByTestId("review-queued"))
        .toHaveTextContent(`${action} queued · on resume`),
    );
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-control-queue-live-"));
  writeRecord(windDownRecord());
  bench = specBench();
  reviewReplies = [];
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(stateService.updateBench).mockClear();
  // The delivery is wound down: no session runs.
  vi.mocked(getSession).mockImplementation((id) =>
    id === SESSION_ID ? ({ id, status: "exited" } as ReturnType<typeof getSession>) : undefined,
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
        status: "exited",
      },
    ]);
  });
  app.use("/api/projects", deliveryRouter);
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/notifications", notificationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  vi.stubGlobal("fetch", vi.fn(clientFetch));
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage = null;
      onopen = null;
      onerror = null;
      readyState = 0;
      close(): void {
        this.readyState = 2;
      }
    },
  );
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetClientsForTest();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("The durable control queue on the bench record over the live path", () => {
  it("SB-TC-090 queued review actions survive a server restart and arrive in order at resume", async () => {
    renderTab();
    const user = userEvent.setup();

    // Step 1: accept D-1, overturn D-2 and accept D-3 from the bench.
    let top = await raise(user, "D-1");
    await user.click(within(top).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(reviewReplies).toHaveLength(1), { timeout: 3000 });
    top = await raise(user, "D-2");
    await user.click(within(top).getByRole("button", { name: "Overturn" }));
    await user.click(
      within(within(top).getByRole("group", { name: "Overturn D-2 with" })).getByRole("button", {
        name: OPTIONS[0],
      }),
    );
    await waitFor(() => expect(reviewReplies).toHaveLength(2), { timeout: 3000 });
    top = await raise(user, "D-3");
    await user.click(within(top).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(reviewReplies).toHaveLength(3), { timeout: 3000 });
    expect(reviewReplies.map((reply) => [reply.route, reply.status])).toEqual([
      ["D-1/accept", 202],
      ["D-2/overturn", 202],
      ["D-3/accept", 202],
    ]);
    // The outbox wrote each one to state.json before it answered.
    const issued = savedQueue();
    expect(issued.map((control) => [control.kind, control.target_id, control.status])).toEqual([
      ["review_accept", "D-1", "pending"],
      ["overturn", "D-2", "pending"],
      ["review_accept", "D-3", "pending"],
    ]);
    await expectQueuedBadges(user, [
      ["D-1", "accept"],
      ["D-2", "overturn"],
      ["D-3", "accept"],
    ]);
    const seqsBefore = issued.map((control) => control.control_seq);

    // Step 2: restart the server and reload the bench.
    restartServer();
    renderTab();
    await expectQueuedBadges(user, [
      ["D-1", "accept"],
      ["D-2", "overturn"],
      ["D-3", "accept"],
    ]);
    expect(bench.deliveryControlQueue?.map((c) => [c.kind, c.target_id])).toEqual([
      ["review_accept", "D-1"],
      ["overturn", "D-2"],
      ["review_accept", "D-3"],
    ]);

    // Step 3: the fake tooling reads with after=0: the three in issue order,
    // each sequence number above the one before.
    const read = await readControls(0);
    expect(read.controls.map((c) => [c.kind, c.target_id])).toEqual([
      ["review_accept", "D-1"],
      ["overturn", "D-2"],
      ["review_accept", "D-3"],
    ]);
    const seqs = read.controls.map((c) => c.control_seq as number);
    expect(seqs).toEqual(seqsBefore);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);

    // Step 4: one more control takes a seq above every one before the restart.
    const res = await nodeFetch(
      `${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/decisions/D-4/accept`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(202);
    const next = (await res.json()) as { control_seq: number };
    expect(next.control_seq).toBeGreaterThan(Math.max(...seqsBefore));
  });

  it("SB-TC-091 a queued control is cleared only when the record shows its effect", async () => {
    const accept = await nodeFetch(
      `${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/decisions/D-1/accept`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(accept.status).toBe(202);
    const seq = ((await accept.json()) as { control_seq: number }).control_seq;

    // Step 1: the tooling reads the accept, then the server restarts with no
    // outcome event: the accept is still queued.
    expect((await readControls()).controls).toMatchObject([
      { control_seq: seq, kind: "review_accept", target_id: "D-1", status: "delivered" },
    ]);
    restartServer();
    renderTab();
    await card("D-1");
    expect(bench.deliveryControlQueue).toMatchObject([
      { control_seq: seq, kind: "review_accept", target_id: "D-1", status: "delivered" },
    ]);

    // Step 2: a second read with after=0 returns the accept again.
    expect((await readControls(0)).controls).toMatchObject([
      { control_seq: seq, kind: "review_accept", target_id: "D-1" },
    ]);

    // Step 3: the tooling rewrites the record with D-1 accepted; the bench
    // reloads.
    cleanup();
    writeRecord({
      ...windDownRecord({ "D-1": "accepted" }),
      updated_at: new Date(Date.UTC(2026, 9, 16, 11)).toISOString(),
    });
    renderTab();
    await card("D-2");
    await waitFor(() => expect(screen.queryByTestId("review-card-D-1")).toBeNull(), {
      timeout: 3000,
    });
    expect(bench.deliveryControlQueue).toEqual([]);
    expect(savedQueue()).toEqual([]);
    expect((await readControls(0)).controls).toEqual([]);
  });
});
