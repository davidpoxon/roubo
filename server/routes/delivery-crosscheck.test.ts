// GET /delivery/crosscheck of a Spec Bench over a fixture workspace
// (SB-FR-030, SB-NFR-005): after a restart the first read lists every
// disagreement within 5 seconds and the snapshot's seq is the record's, and a
// GitHub failure answers the last list with a source error naming GitHub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
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
vi.mock("../services/sse.js", () => ({
  broadcast: vi.fn(),
  broadcastBenchDecisionMode: vi.fn(),
  broadcastDeliveryFrame: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import {
  DELIVERY_CROSS_CHECK_CLASSES,
  type DeliveryGitObservation,
} from "../lib/delivery-cross-check.js";
import {
  forgetDeliveryCrossCheck,
  refreshDeliveryCrossCheckOnEvents,
  setDeliveryCrossCheckDeps,
} from "../services/delivery-cross-check-loader.js";
import { computePlanHash } from "../lib/testbench-store.js";
import router from "./delivery.js";

const UPDATED_AT = "2026-10-16T09:30:00Z";
const BEFORE_UPDATE = "2026-10-16T09:00:00Z";
const AFTER_UPDATE = "2026-10-16T10:00:00Z";
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
const HEAD = { A: "a".repeat(40), B: "b".repeat(40), C: "c".repeat(40), D: "d".repeat(40) };
type UnitId = keyof typeof BRANCH;
const UNITS: UnitId[] = ["A", "B", "C", "D"];
const CASES = ["FX-TC-001", "FX-TC-002", "FX-TC-003"];

const plan: TestCasesPlan = {
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

// The record of four units A, B and C on one stack and D on its own, with
// gates after B and after C. With `inject`, its plan hash is not the results'
// own (plan-hash-mismatch), the gate after B claims `passed` (it reads stale,
// gate-state-differs) and the gate after C marks a failed case met
// (case-status-differs).
function record(planHash: string): unknown {
  const stackOf: Record<UnitId, string> = { A: "A", B: "A", C: "A", D: "D" };
  const layerOf: Record<UnitId, number> = { A: 0, B: 1, C: 2, D: 0 };
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: planHash,
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      gates: [
        { id: "gate-after-b", after: ["B"], status: "passed", cases: ["FX-TC-001", "FX-TC-002"] },
        {
          id: "gate-after-c",
          after: ["C"],
          status: "provisional",
          cases: ["FX-TC-003"],
          provisionalCases: [
            { case: "FX-TC-003", mark: "met", evidence: "The suite row passed.", confirmed: false },
          ],
        },
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

function writeSpec(recordPlanHash: string, failed: string[]): void {
  const hash = computePlanHash(plan);
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(plan));
  const caseResults = Object.fromEntries(
    CASES.map((id) => [
      id,
      {
        observationMarks: {},
        derivedStatus: failed.includes(id) ? "failed" : "passed",
        notes: [],
      },
    ]),
  );
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: hash,
      caseResults,
      updatedAt: UPDATED_AT,
    }),
  );
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record(recordPlanHash), null, 2)}\n`,
  );
}

// The sources. `nine` sets each to give one disagreement of its classes:
// D's branch is missing, A's head moved, B's head was committed after the
// record, stack A lists C before B, B's pull request closed unmerged, and C's
// pull request targets main.
let nine: boolean;
let githubDown: boolean;

function git(): DeliveryGitObservation {
  const observation: Record<string, DeliveryGitObservation[string]> = {};
  for (const id of UNITS) {
    if (nine && id === "D") continue;
    observation[BRANCH[id]] = {
      localHead: nine && id === "A" ? "e".repeat(40) : HEAD[id],
      remoteHead: null,
      committedAt: nine && id === "B" ? AFTER_UPDATE : BEFORE_UPDATE,
    };
  }
  return observation;
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  if (githubDown) throw new TypeError("fetch failed");
  const url = new URL(String(input));
  if (url.pathname.endsWith("/stacks")) {
    const order = nine ? [BRANCH.A, BRANCH.C, BRANCH.B] : [BRANCH.A, BRANCH.B, BRANCH.C];
    return Response.json([
      { name: "A", branches: order },
      { name: "D", branches: [BRANCH.D] },
    ]);
  }
  const base: Record<UnitId, string> = {
    A: "main",
    B: BRANCH.A,
    C: nine ? "main" : BRANCH.B,
    D: "main",
  };
  return Response.json(
    UNITS.map((id) => ({
      state: nine && id === "B" ? "closed" : "open",
      merged_at: null,
      head: { ref: BRANCH[id] },
      base: { ref: base[id] },
      html_url: `https://github.com/example/fixture/pull/${id}`,
    })),
  );
}

let tmp: string;
let specFolder: string;
let bench: Bench;
let app: express.Express;
const base = "/api/projects/demo/benches/1/delivery";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-crosscheck-route-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    deliveryDecisionMode: "auto",
    components: {},
    notifications: [],
  } as unknown as Bench;
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  nine = false;
  githubDown = false;
  setDeliveryCrossCheckDeps({
    readGit: async () => git(),
    resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
    githubToken: async () => null,
    fetch: fakeFetch,
    watch: () => ({ close: () => undefined }),
  });
  forgetDeliveryCrossCheck();
  forgetDeliveryEventLog();
  app = express();
  app.use("/api/projects", router);
});

afterEach(() => {
  forgetDeliveryCrossCheck();
  setDeliveryCrossCheckDeps();
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GET /:projectId/benches/:id/delivery/crosscheck", () => {
  it("answers 200 with no disagreement, the refresh time and no source error when every source agrees", async () => {
    writeSpec(computePlanHash(plan), []);
    // The gate after B claims passed over passed results.
    const res = await request(app).get(`${base}/crosscheck`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      disagreements: [],
      refreshedAt: expect.any(String) as unknown as string,
      sourceError: null,
    });
  });

  it("answers 409 with the read error while the record is missing", async () => {
    const res = await request(app).get(`${base}/crosscheck`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("SB-TC-074 lists all nine disagreements within 5 seconds of a restart, with the snapshot seq at the record's last_event_seq", async () => {
    // Step 1: one disagreement of each class, then a restart: the loader and
    // the event log forget the bench.
    nine = true;
    writeSpec("plan-hash-of-another-plan", ["FX-TC-003"]);
    forgetDeliveryCrossCheck();
    forgetDeliveryEventLog();

    // Step 2: the first reads after the restart.
    const started = Date.now();
    const [crossCheck, snapshot] = await Promise.all([
      request(app).get(`${base}/crosscheck`),
      request(app).get(base),
    ]);
    const elapsed = Date.now() - started;

    expect(crossCheck.status).toBe(200);
    expect(elapsed).toBeLessThan(5_000);
    const classes = (crossCheck.body.disagreements as { class: string }[]).map((d) => d.class);
    expect(classes).toEqual([...DELIVERY_CROSS_CHECK_CLASSES]);
    expect(crossCheck.body.sourceError).toBeNull();

    expect(snapshot.status).toBe(200);
    expect(snapshot.body.seq).toBe(7);
  });

  it("SB-TC-075 answers the previous list with a source error naming GitHub, which clears on the next refresh", async () => {
    nine = true;
    writeSpec(computePlanHash(plan), []);
    const before = await request(app).get(`${base}/crosscheck`);
    expect(before.body.sourceError).toBeNull();
    const previous = before.body.disagreements as unknown[];
    expect(previous.length).toBeGreaterThan(0);

    // Step 1: GitHub fails and a refresh runs.
    githubDown = true;
    await refreshDeliveryCrossCheckOnEvents(bench, [
      {
        $schema: DELIVERY_EVENT_SCHEMA_ID,
        schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
        delivery_id: "fixture-delivery",
        type: "gate.reached",
        seq: 8,
        ts: "2026-10-16T09:40:00Z",
        payload: {},
      },
    ]);
    const failed = await request(app).get(`${base}/crosscheck`);
    expect(failed.status).toBe(200);
    expect(failed.body.disagreements).toEqual(previous);
    expect(failed.body.sourceError).toMatchObject({ source: "github" });
    expect(failed.body.sourceError.message).toMatch(/GitHub/);

    // Step 2: GitHub restored, and a refresh clears the error.
    githubDown = false;
    await refreshDeliveryCrossCheckOnEvents(bench, [
      {
        $schema: DELIVERY_EVENT_SCHEMA_ID,
        schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
        delivery_id: "fixture-delivery",
        type: "gate.reached",
        seq: 9,
        ts: "2026-10-16T09:41:00Z",
        payload: {},
      },
    ]);
    const restored = await request(app).get(`${base}/crosscheck`);
    expect(restored.body.sourceError).toBeNull();
  });
});
