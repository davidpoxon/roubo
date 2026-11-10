// A raised decision raises the bench's delivery-decision notification, through
// the real ingest path (SB-TC-036, SB-FR-014, SB-US-005).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// event route (routes/delivery-hooks.ts) and its body parser, the notification
// stream (routes/notifications.ts and services/sse.ts), the delivery token
// check, the bench's event log, the record loader over a record in a bench
// workspace on disk, the decision rule (services/delivery-decision.ts) and the
// notification store (services/notification.ts). The tooling posts
// `decision.raised` events, and the test reads the bench's notifications and
// the frames that the stream sends the client.
//
// The bench manager is a stand-in that knows the one Spec Bench, the state
// file write is a stand-in, and the session launcher and terminals stay out.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench, BenchNotification } from "@roubo/shared";
import { DELIVERY_EVENT_HOOK_PATH } from "@roubo/shared/delivery-bench";
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

import * as benchManager from "../services/bench-manager.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { getNotifications } from "../services/notification.js";
import { _resetClientsForTest, getClientCount } from "../services/sse.js";
import { makeBench } from "../test/fixtures.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import notificationsRouter from "./notifications.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-decision-notification";

let tmp: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let stream: AbortController | undefined;

function fixtureRecord(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function decisionEvent(seq: number, type: string, payload: Record<string, unknown>): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: fixtureRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
    unit_id: "B",
    payload,
  };
}

function raised(seq: number, decisionId: string): DeliveryEvent {
  return decisionEvent(seq, "decision.raised", {
    decision_id: decisionId,
    question: `Which layout for ${decisionId}?`,
    options: ["one file per unit", "one file per stack"],
    default: "one file per unit",
  });
}

async function post(events: DeliveryEvent[]): Promise<Response> {
  return fetch(`${origin}${DELIVERY_EVENT_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ events }),
  });
}

interface NotificationsFrame {
  type: string;
  projectId: string;
  benchId: number;
  notifications: BenchNotification[];
}

// Opens the notification stream the client reads, and collects each
// `notifications` frame it sends.
async function openStream(): Promise<NotificationsFrame[]> {
  const frames: NotificationsFrame[] = [];
  stream = new AbortController();
  const res = await fetch(`${origin}/api/notifications/stream`, {
    headers: { Accept: "text/event-stream" },
    signal: stream.signal,
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
  await vi.waitFor(() => expect(getClientCount()).toBe(1), { timeout: 3000 });
  return frames;
}

function decisionsOf(notifications: readonly BenchNotification[]): BenchNotification[] {
  return notifications.filter((n) => n.type === "delivery-decision");
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-decision-live-"));
  const workspace = path.join(tmp, "workspace");
  const specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(fixtureRecord(), null, 2)}\n`,
  );
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
  forgetDeliveryEventLog();
  _resetClientsForTest();

  const app = express();
  app.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
  app.use(express.json({ limit: "210kb" }));
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/notifications", notificationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  stream?.abort();
  stream = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetClientsForTest();
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Decision notification over the live event path", () => {
  it("SB-TC-036 a posted decision.raised raises one delivery-decision notification per decision, deduplicated by the decision id", async () => {
    const frames = await openStream();
    expect(decisionsOf(getNotifications(bench))).toEqual([]);

    // Step 1: the tooling raises a decision with the token.
    const first = fixtureRecord().last_event_seq + 1;
    const posted = await post([raised(first, "decision-3")]);
    expect(posted.status).toBe(202);
    expect(await posted.json()).toEqual({ acceptedSeq: first });

    const decisions = decisionsOf(getNotifications(bench));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      type: "delivery-decision",
      priority: "action-needed",
      dedupeKey: "decision-3",
      metadata: {
        decisionId: "decision-3",
        question: "Which layout for decision-3?",
        unitId: "B",
      },
    });
    await vi.waitFor(
      () => {
        const last = frames.at(-1);
        expect(last).toMatchObject({ projectId: PROJECT_ID, benchId: BENCH_ID });
        expect(decisionsOf(last?.notifications ?? []).map((n) => n.dedupeKey)).toEqual([
          "decision-3",
        ]);
      },
      { timeout: 2000 },
    );

    // Step 2: a repeated event for the same decision adds no notification.
    const repeated = await post([raised(first + 1, "decision-3")]);
    expect(repeated.status).toBe(202);
    expect(decisionsOf(getNotifications(bench))).toHaveLength(1);

    // Step 3: a second decision adds its own.
    const second = await post([raised(first + 2, "decision-4")]);
    expect(second.status).toBe(202);
    expect(decisionsOf(getNotifications(bench)).map((n) => n.dedupeKey)).toEqual([
      "decision-3",
      "decision-4",
    ]);
    await vi.waitFor(
      () => {
        expect(decisionsOf(frames.at(-1)?.notifications ?? []).map((n) => n.dedupeKey)).toEqual([
          "decision-3",
          "decision-4",
        ]);
      },
      { timeout: 2000 },
    );

    // An answer settles the decision and dismisses its notification.
    const answered = await post([
      decisionEvent(first + 3, "decision.answered", {
        decision_id: "decision-3",
        answer: "one file per unit",
      }),
    ]);
    expect(answered.status).toBe(202);
    expect(decisionsOf(getNotifications(bench)).map((n) => n.dedupeKey)).toEqual(["decision-4"]);
  });
});
