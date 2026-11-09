// @vitest-environment jsdom
//
// A GitHub failure in the cross-check, from the route to the rail (SB-TC-075;
// SB-FR-028, SB-FR-030, SB-US-010).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// routes (routes/delivery.ts, the snapshot and the cross-check reads), the
// cross-check loader and the pure cross-check over a record, a plan and its
// results in a bench workspace on disk. On the client side, the real `lib/api`
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
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";

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
  getSessionScrollback: vi.fn(),
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
  refreshDeliveryCrossCheckOnEvents,
  setDeliveryCrossCheckDeps,
} from "../services/delivery-cross-check-loader.js";
import { computePlanHash } from "../lib/testbench-store.js";
import { makeBench } from "../test/fixtures.js";
import deliveryRouter from "./delivery.js";
import { deliveryCrossCheckQueryKey } from "../../client/src/hooks/useDeliveryCrossCheck";
import DeliveryTabPanel from "../../client/src/components/delivery/DeliveryTabPanel";

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const UPDATED_AT = "2026-10-16T09:30:00Z";
const BEFORE_UPDATE = "2026-10-16T09:00:00Z";
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
const HEAD = { A: "a".repeat(40), B: "b".repeat(40), C: "c".repeat(40), D: "d".repeat(40) };
type UnitId = keyof typeof BRANCH;
const UNITS: UnitId[] = ["A", "B", "C", "D"];
const CASES = ["FX-TC-001", "FX-TC-002", "FX-TC-003"];

const PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: "1.2.0",
  specSlug: "fixture-spec",
  cases: CASES.map((id) => ({
    id,
    title: id,
    area: "fixture",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["FX-FR-001"],
    linked_user_story_ids: [],
  })),
};

// Four units A, B and C on one stack and D on its own, with gates after B and C.
function record(): unknown {
  const stackOf: Record<UnitId, string> = { A: "A", B: "A", C: "A", D: "D" };
  const layerOf: Record<UnitId, number> = { A: 0, B: 1, C: 2, D: 0 };
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: computePlanHash(PLAN),
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      gates: [
        { id: "gate-after-b", after: ["B"], status: "pending", cases: ["FX-TC-001", "FX-TC-002"] },
        { id: "gate-after-c", after: ["C"], status: "pending", cases: ["FX-TC-003"] },
      ],
    },
    units: UNITS.map((id) => ({
      id,
      title: `Unit ${id}`,
      status: "running",
      stack: stackOf[id],
      layer: layerOf[id],
      depends_on: [],
      branch: BRANCH[id],
      head: HEAD[id],
      pr_url: `https://github.com/example/fixture/pull/${id}`,
    })),
    decisions: [],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: {},
    health: { status: "ok", checked_at: UPDATED_AT },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: BEFORE_UPDATE, ended_at: null },
    last_event_seq: 7,
    updated_at: UPDATED_AT,
  };
}

function writeSpec(): void {
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(PLAN));
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: computePlanHash(PLAN),
      caseResults: {},
      updatedAt: UPDATED_AT,
    }),
  );
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record(), null, 2)}\n`,
  );
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

// A unit-boundary event, which runs one refresh of the cross-check.
async function refresh(): Promise<void> {
  const event: DeliveryEvent = {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    type: "gate.reached",
    seq: nextSeq,
    ts: "2026-10-16T09:40:00Z",
    payload: {},
  } as DeliveryEvent;
  nextSeq += 1;
  await refreshDeliveryCrossCheckOnEvents(bench, [event]);
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
  writeSpec();
  nextSeq = 8;
  bench = makeBench({
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    deliveryBindMode: "launch",
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
  app.use(express.json());
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
