// @vitest-environment jsdom
//
// The burn meter moves with a posted cost row, through the real ingest and
// stream path (SB-TC-046, SB-FR-018, SB-US-007).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// event route (routes/delivery-hooks.ts) and its body parser, the delivery read
// route (routes/delivery.ts), the notification stream (routes/notifications.ts
// and services/sse.ts), the delivery token check, the bench's event log and the
// record loader over a record in a bench workspace on disk. On the client side,
// the real `lib/api` request layer, the real React Query delivery hook, the real
// notification stream hook and the real burn meter. The client reaches the
// server over HTTP: `fetch` resolves the client's relative paths against the
// server, and `EventSource` (which jsdom lacks) is a small text/event-stream
// reader over a streamed fetch of GET /api/notifications/stream.
//
// The bench manager is a stand-in that knows the one Spec Bench, and the
// session launcher, the terminals and the notification store stay out.
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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import { DELIVERY_EVENT_HOOK_PATH } from "@roubo/shared/delivery-bench";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
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
vi.mock("../services/notification.js", () => ({
  createNotification: vi.fn(),
  dismissByKey: vi.fn(() => false),
  getNotifications: vi.fn(() => []),
}));

import * as benchManager from "../services/bench-manager.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { _resetClientsForTest, getClientCount } from "../services/sse.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import deliveryRouter from "./delivery.js";
import notificationsRouter from "./notifications.js";
import { useDelivery } from "../../client/src/hooks/useDelivery";
import { useNotificationStream } from "../../client/src/hooks/useNotificationStream";
import DeliveryBurn from "../../client/src/components/delivery/DeliveryBurn";

// The jsdom URL global is not the one fileURLToPath takes, so the path is
// joined from this file's own path.
const FIXTURE_RECORD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/__fixtures__/delivery-record.json",
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-burn-meter";
// The case allows 2 seconds from the post to the meter and both breakdowns.
const UPDATE_WITHIN_MS = 2_000;

// What the posted cost row brings the burn to: B's run cost, and the coder's
// spend, which takes the delivery from 0.42 to 1.22 of a 5.00 budget.
const B_COST_USD = 0.8;
const CODER_SPEND_USD = 0.92;
const SPENT_USD = 1.22;

const nodeFetch = globalThis.fetch;

let tmp: string;
let server: http.Server;
let origin: string;
let streams: StreamEventSource[];

function fixtureRecord(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
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
function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), origin).toString();
  const rest: RequestInit = { ...init };
  delete rest.signal;
  return nodeFetch(url, rest);
}

function LiveBurn() {
  const delivery = useDelivery(PROJECT_ID, BENCH_ID);
  return delivery.isSuccess ? createElement(DeliveryBurn, { snapshot: delivery.data }) : null;
}

function Harness() {
  useNotificationStream();
  return createElement(LiveBurn);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-burn-live-"));
  const workspace = path.join(tmp, "workspace");
  const specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  const record = fixtureRecord();
  record.budget = { ...record.budget, by_role: { main: 0.3, "unit-coder": 0.12 } };
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const bench = {
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
  } as Bench;
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  forgetDeliveryEventLog();
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
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetClientsForTest();
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Burn meter over the live event path", () => {
  it("SB-TC-046 updates the burn meter and both breakdowns within 2 seconds of a posted budget.changed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));

    // Step 1: the view shows the spend and the soft budget from the record,
    // the cost per unit and the cost per role.
    const spent = () => screen.getByTestId("delivery-stat-spent");
    await waitFor(() => expect(spent()).toHaveTextContent("0.42"), { timeout: 3000 });
    expect(spent()).toHaveTextContent("of 5.00 soft budget");
    expect(screen.getByTestId("delivery-burn-unit-A")).toHaveTextContent("0.42");
    expect(screen.queryByTestId("delivery-burn-unit-B")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-burn-role-main")).toHaveTextContent("0.30");
    expect(screen.getByTestId("delivery-burn-role-unit-coder")).toHaveTextContent("0.12");
    // The client's stream is connected before the tooling posts.
    await waitFor(() => expect(getClientCount()).toBe(1), { timeout: 3000 });

    // Step 2: the tooling posts a cost row with the token: B's cost on its
    // unit, and the budget.changed that carries the new spend and the coder's.
    const first = fixtureRecord().last_event_seq + 1;
    const events = [
      event(first, "unit.changed", { cost_usd: B_COST_USD }, "B"),
      event(first + 1, "budget.changed", {
        spent_usd: SPENT_USD,
        by_role: { "unit-coder": CODER_SPEND_USD },
      }),
    ];
    const postedAt = performance.now();
    const res = await nodeFetch(
      `${origin}${DELIVERY_EVENT_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ events }),
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ acceptedSeq: first + 1 });

    await waitFor(
      () => {
        expect(spent()).toHaveTextContent(SPENT_USD.toFixed(2));
        expect(screen.getByTestId("delivery-burn-unit-B")).toHaveTextContent(B_COST_USD.toFixed(2));
        expect(screen.getByTestId("delivery-burn-role-unit-coder")).toHaveTextContent(
          CODER_SPEND_USD.toFixed(2),
        );
      },
      { timeout: UPDATE_WITHIN_MS, interval: 10 },
    );
    const elapsed = performance.now() - postedAt;
    expect(elapsed).toBeLessThan(UPDATE_WITHIN_MS);

    expect(spent()).toHaveTextContent("of 5.00 soft budget");
    expect(screen.getByTestId("delivery-burn-unit-A")).toHaveTextContent("0.42");
    expect(screen.getByTestId("delivery-burn-role-main")).toHaveTextContent("0.30");
  });
});
