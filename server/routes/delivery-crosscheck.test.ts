// GET /delivery/crosscheck of a Spec Bench over a fixture workspace
// (SB-FR-030, SB-NFR-005): after a restart the first read lists every
// disagreement within 5 seconds and the snapshot's seq is the record's, and a
// GitHub failure answers the last list with a source error naming GitHub. An
// event that the tooling posts to the event route runs one refresh per
// refreshing type.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import { DELIVERY_EVENT_HOOK_PATH, DELIVERY_EVENT_SPILL_FILE } from "@roubo/shared/delivery-bench";
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
  deliveryCrossCheckRunCount,
  forgetDeliveryCrossCheck,
  refreshDeliveryCrossCheckOnEvents,
  setDeliveryCrossCheckDeps,
  whenDeliveryCrossCheckIdle,
} from "../services/delivery-cross-check-loader.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { computePlanHash } from "../lib/testbench-store.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import router from "./delivery.js";

const TOKEN = "delivery-token-for-the-cross-check";

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
// A delay of every GitHub answer, on the test's timers.
let githubDelayMs: number;

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

// Posts `count` events of a type the fold does not know (it skips them and
// still accepts their seq), from `firstSeq` on, in one batch.
async function postEvents(firstSeq: number, count: number): Promise<void> {
  const events = Array.from({ length: count }, (_, index) => ({
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    type: "fixture.noted",
    seq: firstSeq + index,
    ts: "2026-10-16T09:40:00Z",
    payload: {},
  }));
  const res = await request(app)
    .post(`${DELIVERY_EVENT_HOOK_PATH}?projectId=${bench.projectId}&benchId=${bench.id}`)
    .set("Authorization", `Bearer ${TOKEN}`)
    .send({ events });
  expect(res.status).toBe(202);
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  if (githubDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, githubDelayMs));
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
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
    components: {},
    notifications: [],
  } as unknown as Bench;
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  nine = false;
  githubDown = false;
  githubDelayMs = 0;
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
  app.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
  app.use(express.json());
  app.use("/api/hooks", deliveryHooksRouter);
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

  it("SB-TC-074 lists all nine disagreements on the first read after a restart, with the snapshot seq at the seq folded from what the restart kept", async () => {
    // Step 1: one disagreement of each class. Events posted before the
    // restart: a full in-memory log spills its oldest 500 to the spill file in
    // the workspace, which the restart keeps.
    nine = true;
    writeSpec("plan-hash-of-another-plan", ["FX-TC-003"]);
    await postEvents(8, 1_000);
    await postEvents(1_008, 3);
    const before = await request(app).get(base);
    expect(before.body.seq).toBe(1_010);
    const spill = path.join(specFolder, DELIVERY_EVENT_SPILL_FILE);
    const spilledSeqs = fs
      .readFileSync(spill, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(spilledSeqs).toHaveLength(500);

    // The restart: the loader and the event log forget the bench.
    forgetDeliveryCrossCheck();
    forgetDeliveryEventLog();

    // Step 2: the first reads after the restart.
    const [crossCheck, snapshot] = await Promise.all([
      request(app).get(`${base}/crosscheck`),
      request(app).get(base),
    ]);

    expect(crossCheck.status).toBe(200);
    const classes = (crossCheck.body.disagreements as { class: string }[]).map((d) => d.class);
    expect(classes).toEqual([...DELIVERY_CROSS_CHECK_CLASSES]);
    expect(crossCheck.body.sourceError).toBeNull();

    // The fold of the record (last_event_seq 7) and the spilled events.
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.seq).toBe(Math.max(...spilledSeqs));
    expect(snapshot.body.seq).toBe(507);
  });

  it("SB-TC-074 answers the first read after a restart within 5 seconds with the git and results classes while GitHub takes longer", async () => {
    nine = true;
    writeSpec("plan-hash-of-another-plan", ["FX-TC-003"]);
    forgetDeliveryCrossCheck();
    forgetDeliveryEventLog();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // Each GitHub answer takes 6 seconds of the test's clock.
      githubDelayMs = 6_000;
      const started = Date.now();
      let answeredAt: number | undefined;
      const pending = request(app)
        .get(`${base}/crosscheck`)
        .then((res) => {
          answeredAt = Date.now();
          return res;
        });
      // Let the request reach the route and the load refresh start.
      while (deliveryCrossCheckRunCount(bench.projectId, bench.id) === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(0);
      }
      for (let step = 0; step < 100 && answeredAt === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise((resolve) => setImmediate(resolve));
      }
      const crossCheck = await pending;

      expect(crossCheck.status).toBe(200);
      expect(answeredAt).toBeDefined();
      expect((answeredAt ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(5_000);
      const classes = (crossCheck.body.disagreements as { class: string }[]).map((d) => d.class);
      expect(classes).toEqual([
        "branch-missing",
        "head-commit-differs",
        "gate-state-differs",
        "case-status-differs",
        "plan-hash-mismatch",
        "record-stale",
      ]);
      expect(crossCheck.body.sourceError).toBeNull();

      // GitHub answers later.
      await vi.advanceTimersByTimeAsync(12_000);
      await whenDeliveryCrossCheckIdle(bench.projectId, bench.id);
    } finally {
      vi.useRealTimers();
    }
    // Once GitHub answered, the next read lists all nine.
    const later = await request(app).get(`${base}/crosscheck`);
    const all = (later.body.disagreements as { class: string }[]).map((d) => d.class);
    expect(all).toEqual([...DELIVERY_CROSS_CHECK_CLASSES]);
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

describe("POST /api/hooks/delivery-event and the cross-check", () => {
  function posted(seq: number, type: string): Record<string, unknown> {
    return {
      $schema: DELIVERY_EVENT_SCHEMA_ID,
      schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
      delivery_id: "fixture-delivery",
      type,
      seq,
      ts: "2026-10-16T09:40:00Z",
      ...(type === "unit.changed" && { unit_id: "A" }),
      payload:
        type === "unit.changed"
          ? { status: "running" }
          : type === "gate.changed"
            ? { gate_id: "gate-after-b", status: "passed" }
            : {},
    };
  }

  async function post(seq: number, type: string): Promise<void> {
    const res = await request(app)
      .post(`${DELIVERY_EVENT_HOOK_PATH}?projectId=${bench.projectId}&benchId=${bench.id}`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ events: [posted(seq, type)] });
    expect(res.status, type).toBe(202);
    await whenDeliveryCrossCheckIdle(bench.projectId, bench.id);
  }

  function runs(): number {
    return deliveryCrossCheckRunCount(bench.projectId, bench.id);
  }

  it("SB-TC-071 runs one refresh per posted unit.boundary, pr.submitted, gate.reached, unit.changed and gate.changed, and none for another type", async () => {
    writeSpec(computePlanHash(plan), []);

    // Before a read arms the bench, a posted event runs none.
    await post(8, "unit.boundary");
    expect(runs()).toBe(0);

    // Step 1: the load.
    const loaded = await request(app).get(`${base}/crosscheck`);
    expect(loaded.status).toBe(200);
    expect(runs()).toBe(1);

    // Step 2: one run per posted event of a refreshing type.
    let seq = 9;
    for (const type of [
      "unit.boundary",
      "pr.submitted",
      "gate.reached",
      "unit.changed",
      "gate.changed",
    ]) {
      const before = runs();
      await post(seq++, type);
      expect(runs(), type).toBe(before + 1);
    }

    // Another type runs none.
    const before = runs();
    await post(seq, "decision.raised");
    expect(runs()).toBe(before);
  });
});
