// @vitest-environment jsdom
//
// A GitHub failure in the cross-check, from the route to the rail (SB-TC-075;
// SB-FR-028, SB-FR-030, SB-US-010).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// routes (routes/delivery.ts, the snapshot and the cross-check reads), the
// delivery event route (routes/delivery-hooks.ts) and its body parser, the
// delivery token check, the cross-check loader and the pure cross-check over a
// record, a plan and its results in a bench workspace on disk. A refresh runs
// because the test posts a unit.boundary event to the event route, as the
// delivery session does. On the client side, the real `lib/api`
// request layer, the real React Query hooks and the real Delivery tab with its
// rail. The client reaches the server over HTTP.
//
// The sources of the cross-check are stand-ins: local git is a fixed
// observation, and GitHub (the stacks resource and the pull-request query) is
// a fetch that answers or fails on the test's say. The client re-reads the
// cross-check on a 5-second interval; the test asks its query client for that
// read at once instead of waiting.
//
// This file renders client components, so it calls createElement: the server
// suite takes `.ts` test files only.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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
} from "@roubo/shared/delivery-observation-contract";

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  isBenchLive: vi.fn(() => false),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));
vi.mock("../services/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/state.js")>()),
  updateBench: vi.fn(),
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
vi.mock("../services/sse.js", () => ({
  broadcast: vi.fn(),
  broadcastBenchDecisionMode: vi.fn(),
  broadcastDeliveryFrame: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import type { DeliveryGitObservation } from "../lib/delivery-cross-check.js";
import {
  forgetDeliveryCrossCheck,
  setDeliveryCrossCheckDeps,
  whenDeliveryCrossCheckIdle,
} from "../services/delivery-cross-check-loader.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import {
  BEFORE_UPDATE,
  BRANCH,
  CROSS_CHECK_PLAN_HASH,
  HEAD,
  UNITS,
  writeCrossCheckSpec,
  type UnitId,
} from "../test/delivery-crosscheck-fixture.js";
import { makeBench } from "../test/fixtures.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import deliveryRouter from "./delivery.js";
import { deliveryCrossCheckQueryKey } from "../../client/src/hooks/useDeliveryCrossCheck";
import DeliveryTabPanel from "../../client/src/components/delivery/DeliveryTabPanel";

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-live-cross-check";

// The record has gates after B and after C, both pending, and no case has a
// result yet, so the record and the results agree.
function writeSpec(specFolder: string): void {
  writeCrossCheckSpec(specFolder, {
    recordPlanHash: CROSS_CHECK_PLAN_HASH,
    gates: [
      { id: "gate-after-b", after: ["B"], status: "pending", cases: ["FX-TC-001", "FX-TC-002"] },
      { id: "gate-after-c", after: ["C"], status: "pending", cases: ["FX-TC-003"] },
    ],
    caseResults: {},
  });
}

// Local git agrees with the record, less D's branch (branch-missing), so the
// list is not empty before GitHub fails.
function git(): DeliveryGitObservation {
  const observation: Record<string, DeliveryGitObservation[string]> = {};
  for (const id of UNITS) {
    if (id === "D") continue;
    observation[BRANCH[id]] = { localHead: HEAD[id], remoteHead: null, committedAt: BEFORE_UPDATE };
  }
  return observation;
}

// GitHub: B's pull request is closed by hand (pr-state-differs), unless it is
// down.
let githubDown: boolean;

async function fakeGitHub(input: RequestInfo | URL): Promise<Response> {
  if (githubDown) throw new TypeError("fetch failed");
  const url = new URL(String(input));
  if (url.pathname.endsWith("/stacks")) {
    return Response.json([
      { name: "A", branches: [BRANCH.A, BRANCH.B, BRANCH.C] },
      { name: "D", branches: [BRANCH.D] },
    ]);
  }
  const base: Record<UnitId, string> = { A: "main", B: BRANCH.A, C: BRANCH.B, D: "main" };
  return Response.json(
    UNITS.map((id) => ({
      state: id === "B" ? "closed" : "open",
      merged_at: null,
      head: { ref: BRANCH[id] },
      base: { ref: base[id] },
      html_url: `https://github.com/example/fixture/pull/${id}`,
    })),
  );
}

let nextSeq: number;

// Posts a unit.boundary event to the event route with the bench's token, as
// the delivery session does, and waits for the refresh it runs.
async function refresh(): Promise<void> {
  const event = {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    type: "unit.boundary",
    seq: nextSeq,
    ts: "2026-10-16T09:40:00Z",
    payload: {},
  };
  nextSeq += 1;
  const res = await nodeFetch(
    `${origin}${DELIVERY_EVENT_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [event] }),
    },
  );
  expect(res.status).toBe(202);
  await whenDeliveryCrossCheckIdle(PROJECT_ID, BENCH_ID);
}

const nodeFetch = globalThis.fetch;

let tmp: string;
let specFolder: string;
let server: http.Server;
let origin: string;
let bench: Bench;
let queryClient: QueryClient;

async function readCrossCheck(): Promise<{
  disagreements: Array<{ class: string }>;
  sourceError: { source: string; message: string } | null;
}> {
  const res = await nodeFetch(
    `${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery/crosscheck`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof readCrossCheck>>;
}

// The client's requests carry relative paths; they reach the server here. The
// jsdom AbortSignal is not the one Node's fetch takes, so a signal is dropped.
async function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), origin);
  const rest: RequestInit = { ...init };
  delete rest.signal;
  return nodeFetch(url.toString(), rest);
}

function renderTab() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(DeliveryTabPanel, { bench }),
    ),
  );
}

// The rail reads the cross-check again, as its 5-second interval would.
async function railReadsAgain(): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: deliveryCrossCheckQueryKey(PROJECT_ID, BENCH_ID),
  });
}

const railRows = () => screen.queryAllByTestId("delivery-crosscheck-row");
const railSourceError = () => screen.queryByTestId("delivery-crosscheck-source-error");

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-crosscheck-live-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  writeSpec(specFolder);
  nextSeq = 8;
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
  githubDown = false;
  setDeliveryCrossCheckDeps({
    readGit: async () => git(),
    resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
    githubToken: async () => null,
    fetch: fakeGitHub,
    watch: () => ({ close: () => undefined }),
  });
  forgetDeliveryCrossCheck();
  forgetDeliveryEventLog();

  const app = express();
  app.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
  app.use(express.json());
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/projects", deliveryRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", vi.fn(clientFetch));
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  forgetDeliveryCrossCheck();
  setDeliveryCrossCheckDeps();
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("A GitHub failure in the cross-check over the live path", () => {
  it("SB-TC-075 a GitHub failure returns the last cross-check with a source error", async () => {
    const before = await readCrossCheck();
    expect(before.sourceError).toBeNull();
    expect(before.disagreements.map((d) => d.class)).toEqual([
      "branch-missing",
      "pr-state-differs",
    ]);
    renderTab();
    await waitFor(() => expect(railRows()).toHaveLength(2), { timeout: 3000 });
    expect(railSourceError()).toBeNull();

    // Step 1: GitHub fails and a refresh runs.
    githubDown = true;
    await refresh();
    const failed = await readCrossCheck();
    expect(failed.disagreements).toEqual(before.disagreements);
    expect(failed.sourceError).toMatchObject({ source: "github" });
    expect(failed.sourceError?.message).toMatch(/GitHub/);
    await railReadsAgain();
    await waitFor(() => expect(railSourceError()).not.toBeNull(), { timeout: 3000 });
    expect(railSourceError()).toHaveTextContent("GitHub could not be read");
    expect(railRows()).toHaveLength(2);

    // Step 2: GitHub is restored and a refresh runs.
    githubDown = false;
    await refresh();
    const restored = await readCrossCheck();
    expect(restored.sourceError).toBeNull();
    expect(restored.disagreements).toEqual(before.disagreements);
    await railReadsAgain();
    await waitFor(() => expect(railSourceError()).toBeNull(), { timeout: 3000 });
    expect(railRows()).toHaveLength(2);
  });
});
