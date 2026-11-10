// The cross-check's blocking policy at control time (SB-FR-029, SB-US-010):
// with a disagreement of a blocking class present in the bench's last
// cross-check, POST /delivery/sittings and POST /delivery/approve answer 409
// CROSSCHECK_BLOCKED naming the class; a display-only class blocks neither;
// and pause, wind-down, resume, a steering note and a decision answer are
// never refused for the cross-check. Each class is injected alone through the
// cross-check's own sources (git, the stacks resource, the pull request query
// and the results file), so the routes read the list the real loader built.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import {
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
  isBenchLive: vi.fn(() => true),
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
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));
// The workspace here is no git checkout: the gate pin service records the
// sitting alone, as it does once the pin is in place. Its git sequence runs
// against a real repository in delivery-gate-pin.test.ts.
vi.mock("../services/gate-pin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/gate-pin.js")>()),
  openGatePin: vi.fn(async (target: Bench, input: { gateId: string }) => {
    const sitting = { gateId: input.gateId, openedAt: new Date().toISOString() };
    target.deliverySitting = sitting;
    return sitting;
  }),
}));

import * as benchManager from "../services/bench-manager.js";
import * as stateService from "../services/state.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import { openGatePin } from "../services/gate-pin.js";
import {
  deliveryLaunchBlock,
  launchDeliverySession,
} from "../services/delivery-session-launcher.js";
import { forgetDeliveryControlMemory } from "../services/delivery-control-outbox.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import {
  DELIVERY_CROSS_CHECK_BLOCKING,
  DELIVERY_CROSS_CHECK_CLASSES,
  type DeliveryCrossCheckClass,
  type DeliveryGitObservation,
} from "../lib/delivery-cross-check.js";
import {
  forgetDeliveryCrossCheck,
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
const DECISION = "D-1";

const BLOCKING = DELIVERY_CROSS_CHECK_CLASSES.filter((cls) => DELIVERY_CROSS_CHECK_BLOCKING[cls]);
const DISPLAY_ONLY = DELIVERY_CROSS_CHECK_CLASSES.filter(
  (cls) => !DELIVERY_CROSS_CHECK_BLOCKING[cls],
);

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
const PLAN_HASH = computePlanHash(plan);

// The class injected alone, or null when every source agrees.
let injected: DeliveryCrossCheckClass | null;
let lifecycleState: string;

// How the record states the gate after B for the provisional cases, or null for
// the class fixture above: `provisional` with FX-TC-001 unconfirmed and no
// result for it; `provisional-stale`, provisional under results of another
// plan; `over-claimed`, passed while FX-TC-001 is unconfirmed. Under each, the
// gate after C claims a word the evaluator never answers, so it adds nothing.
type GateAfterB = "provisional" | "provisional-stale" | "over-claimed";
let gateAfterB: GateAfterB | null;

const UNCONFIRMED_MARK = {
  case: "FX-TC-001",
  mark: "met",
  evidence: "The suite row passed.",
  confirmed: false,
} as const;

function gates(): unknown[] {
  if (gateAfterB !== null) {
    return [
      {
        id: "gate-after-b",
        after: ["B"],
        status: gateAfterB === "over-claimed" ? "passed" : "provisional",
        cases: ["FX-TC-001", "FX-TC-002"],
        provisionalCases: [UNCONFIRMED_MARK],
      },
      { id: "gate-after-c", after: ["C"], status: "verifying", cases: ["FX-TC-003"] },
    ];
  }
  return [
    {
      id: "gate-after-b",
      after: ["B"],
      status: is("plan-hash-mismatch") ? "verifying" : "passed",
      cases: ["FX-TC-001", "FX-TC-002"],
    },
    {
      id: "gate-after-c",
      after: ["C"],
      status: "provisional",
      cases: ["FX-TC-003"],
      provisionalCases: [
        { case: "FX-TC-003", mark: "met", evidence: "The suite row passed.", confirmed: false },
      ],
    },
  ];
}

function is(cls: DeliveryCrossCheckClass): boolean {
  return injected === cls;
}

// Four units A, B and C on one stack and D on its own, with gates after B and
// after C, running, with one open decision and no review. The gate after B
// claims `passed`; under plan-hash-mismatch it claims a word the evaluator
// never answers, so the stale gate it reads adds no gate-state-differs.
function record(): unknown {
  const stackOf: Record<UnitId, string> = { A: "A", B: "A", C: "A", D: "D" };
  const layerOf: Record<UnitId, number> = { A: 0, B: 1, C: 2, D: 0 };
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: is("plan-hash-mismatch") ? "plan-hash-of-another-plan" : PLAN_HASH,
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      gates: gates(),
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
    decisions: [
      {
        id: DECISION,
        question: "Does the cache keep one file per unit or one per stack?",
        options: ["one file per unit", "one file per stack"],
        default: "one file per unit",
        status: "open",
        unit_id: "A",
        raised_at: BEFORE_UPDATE,
      },
    ],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: {},
    health: { status: "ok", checked_at: UPDATED_AT },
    drift: [],
    seams: {},
    lifecycle: {
      state: lifecycleState,
      armed: true,
      started_at: BEFORE_UPDATE,
      ended_at: null,
    },
    last_event_seq: 7,
    updated_at: UPDATED_AT,
  };
}

// The results: every case passed, but FX-TC-001 failed under
// gate-state-differs (the gate after B claims passed) and FX-TC-003 failed
// under case-status-differs (the gate after C marks it met).
function writeSpec(): void {
  const failed = new Set<string>();
  if (is("gate-state-differs")) failed.add("FX-TC-001");
  if (is("case-status-differs")) failed.add("FX-TC-003");
  // Under `provisional`, the results hold no result for the unconfirmed case.
  const recorded = gateAfterB === "provisional" ? CASES.filter((id) => id !== "FX-TC-001") : CASES;
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(plan));
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: gateAfterB === "provisional-stale" ? "plan-hash-of-another-plan" : PLAN_HASH,
      caseResults: Object.fromEntries(
        recorded.map((id) => [
          id,
          { observationMarks: {}, derivedStatus: failed.has(id) ? "failed" : "passed", notes: [] },
        ]),
      ),
      updatedAt: UPDATED_AT,
    }),
  );
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record(), null, 2)}\n`,
  );
}

function git(): DeliveryGitObservation {
  const observation: Record<string, DeliveryGitObservation[string]> = {};
  for (const id of UNITS) {
    if (is("branch-missing") && id === "D") continue;
    observation[BRANCH[id]] = {
      localHead: is("head-commit-differs") && id === "A" ? "e".repeat(40) : HEAD[id],
      remoteHead: null,
      committedAt: is("record-stale") && id === "B" ? AFTER_UPDATE : BEFORE_UPDATE,
    };
  }
  return observation;
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/stacks")) {
    const order = is("layer-order-differs")
      ? [BRANCH.A, BRANCH.C, BRANCH.B]
      : [BRANCH.A, BRANCH.B, BRANCH.C];
    return Response.json([
      { name: "A", branches: order },
      { name: "D", branches: [BRANCH.D] },
    ]);
  }
  const base: Record<UnitId, string> = {
    A: "main",
    B: BRANCH.A,
    C: is("base-branch-differs") ? "main" : BRANCH.B,
    D: "main",
  };
  return Response.json(
    UNITS.map((id) => ({
      state: is("pr-state-differs") && id === "B" ? "closed" : "open",
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

// Sets the injected class up on a fresh bench, and checks that the cross-check
// lists that class alone.
async function inject(cls: DeliveryCrossCheckClass | null): Promise<void> {
  injected = cls;
  writeSpec();
  const res = await request(app).get(`${base}/crosscheck`);
  expect(res.status).toBe(200);
  const classes = (res.body.disagreements as { class: string }[]).map((d) => d.class);
  expect(classes).toEqual(cls === null ? [] : [cls]);
}

// A new bench over the workspace, with no control, no sitting and no
// cross-check read yet: what one class of a case starts from.
function freshBench(): void {
  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: path.join(tmp, "workspace"),
    deliveryDecisionMode: "auto",
    deliveryBindMode: "launch",
    components: {},
    notifications: [],
  } as unknown as Bench;
  injected = null;
  gateAfterB = null;
  lifecycleState = "running";
  forgetDeliveryCrossCheck();
  forgetDeliveryControlMemory();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-crosscheck-block-"));
  specFolder = path.join(tmp, "workspace", ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  freshBench();
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(stateService.updateBench).mockClear();
  vi.mocked(resolveGitIdentity).mockResolvedValue({
    name: "Ada Operator",
    email: "ada@example.test",
  });
  vi.mocked(deliveryLaunchBlock).mockReset();
  vi.mocked(deliveryLaunchBlock).mockReturnValue(undefined);
  vi.mocked(launchDeliverySession).mockReset();
  vi.mocked(launchDeliverySession).mockResolvedValue({ sessionId: "session-2" });
  setDeliveryCrossCheckDeps({
    readGit: async () => git(),
    resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
    githubToken: async () => null,
    fetch: fakeFetch,
    watch: () => ({ close: () => undefined }),
  });
  forgetDeliveryCrossCheck();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  app = express();
  app.use(express.json());
  app.use("/api/projects", router);
});

afterEach(() => {
  forgetDeliveryCrossCheck();
  setDeliveryCrossCheckDeps();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function expectNotCrossCheckBlocked(res: request.Response, what: string): void {
  expect(res.body.code, what).not.toBe("CROSSCHECK_BLOCKED");
}

// 202, or a 409 that names the lifecycle state.
function expectAcceptedOrLifecycle(res: request.Response, what: string): void {
  expectNotCrossCheckBlocked(res, what);
  if (res.status === 202) return;
  expect(res.status, what).toBe(409);
  expect(res.body.code, what).toBe("WRONG_LIFECYCLE_STATE");
}

describe("the cross-check's blocking classes", () => {
  it("lists five blocking classes and four display-only ones", () => {
    expect(BLOCKING).toEqual([
      "branch-missing",
      "head-commit-differs",
      "pr-state-differs",
      "gate-state-differs",
      "plan-hash-mismatch",
    ]);
    expect(DISPLAY_ONLY).toEqual([
      "layer-order-differs",
      "base-branch-differs",
      "case-status-differs",
      "record-stale",
    ]);
  });

  it("SB-TC-070 five classes block a gate sitting and the approval, four display only, and pause, wind-down, resume, steering and a decision answer are never blocked", async () => {
    // Step 1: each blocking class alone refuses a sitting and the approval
    // with 409 CROSSCHECK_BLOCKED naming it.
    for (const cls of BLOCKING) {
      freshBench();
      await inject(cls);

      const sitting = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
      expect(sitting.status, cls).toBe(409);
      expect(sitting.body, cls).toMatchObject({ code: "CROSSCHECK_BLOCKED", classes: [cls] });
      expect(sitting.body.error, cls).toContain(cls);
      expect(bench.deliverySitting, cls).toBeUndefined();

      const approval = await request(app).post(`${base}/approve`).send({});
      expect(approval.status, cls).toBe(409);
      expect(approval.body, cls).toMatchObject({ code: "CROSSCHECK_BLOCKED", classes: [cls] });
      expect(approval.body.error, cls).toContain(cls);
    }

    // Step 2: each display-only class alone, listed by the cross-check (which
    // the rail shows), opens a sitting and does not block the approval.
    for (const cls of DISPLAY_ONLY) {
      freshBench();
      await inject(cls);

      const sitting = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
      expect(sitting.status, cls).toBe(201);
      expect(sitting.body, cls).toEqual({
        gateId: "gate-after-b",
        openedAt: expect.any(String) as unknown as string,
      });
      expect(bench.deliverySitting, cls).toEqual(sitting.body);

      const approval = await request(app).post(`${base}/approve`).send({});
      expectNotCrossCheckBlocked(approval, cls);
      expect([202, 409], cls).toContain(approval.status);
    }

    // Step 3: under each blocking class, the controls the cross-check never
    // blocks answer 202 or a lifecycle 409.
    for (const cls of BLOCKING) {
      freshBench();
      await inject(cls);

      const answer = await request(app)
        .post(`${base}/decisions/${DECISION}/answer`)
        .send({ option: "one file per stack" });
      expect(answer.status, `${cls} answer`).toBe(202);

      const steering = await request(app)
        .post(`${base}/steering`)
        .send({ text: "Keep the fixture ids neutral.", applies_at: "B" });
      expect(steering.status, `${cls} steering`).toBe(202);

      const pause = await request(app).post(`${base}/pause`).send({});
      expectAcceptedOrLifecycle(pause, `${cls} pause`);

      const windDown = await request(app).post(`${base}/wind-down`).send({});
      expectAcceptedOrLifecycle(windDown, `${cls} wind-down`);

      const resume = await request(app).post(`${base}/resume`).send({});
      expectAcceptedOrLifecycle(resume, `${cls} resume`);
    }
  });

  it("under each blocking class on a complete delivery, the lifecycle controls answer a lifecycle 409, never CROSSCHECK_BLOCKED", async () => {
    for (const cls of BLOCKING) {
      freshBench();
      lifecycleState = "complete";
      await inject(cls);
      for (const route of ["pause", "wind-down", "resume", "sittings", "approve"]) {
        const res = await request(app).post(`${base}/${route}`).send({ gateId: "gate-after-b" });
        expect(res.status, `${cls} ${route}`).toBe(409);
        expect(res.body.code, `${cls} ${route}`).toBe("WRONG_LIFECYCLE_STATE");
      }
    }
  });

  it("SB-TC-041 answers a decision, a steering note and a pause with 202 under head-commit-differs, and refuses the approval with CROSSCHECK_BLOCKED", async () => {
    // Step 1: a blocking class is present.
    await inject("head-commit-differs");

    // Step 2: answer the decision from the pile.
    const answer = await request(app)
      .post(`${base}/decisions/${DECISION}/answer`)
      .send({ option: "one file per stack" });
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ kind: "decision-answer", target_id: DECISION });

    // Step 3: a steering note and Pause.
    const steering = await request(app)
      .post(`${base}/steering`)
      .send({ text: "Keep the fixture ids neutral.", applies_at: "B" });
    expect(steering.status).toBe(202);
    const pause = await request(app).post(`${base}/pause`).send({});
    expect(pause.status).toBe(202);

    // Step 4: the approval.
    const approval = await request(app).post(`${base}/approve`).send({});
    expect(approval.status).toBe(409);
    expect(approval.body.code).toBe("CROSSCHECK_BLOCKED");
    expect(approval.body.classes).toEqual(["head-commit-differs"]);
  });
});

describe("POST /:projectId/benches/:id/delivery/sittings", () => {
  it("pins the gate's top unit head through the gate pin service and answers 201 with the sitting", async () => {
    await inject(null);
    const res = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-c" });
    expect(res.status).toBe(201);
    expect(res.body.gateId).toBe("gate-after-c");
    expect(Number.isNaN(Date.parse(res.body.openedAt as string))).toBe(false);
    expect(bench.deliverySitting).toEqual(res.body);
    expect(openGatePin).toHaveBeenCalledWith(bench, {
      gateId: "gate-after-c",
      commit: HEAD.C,
      resultsSpecPath: specFolder,
    });
  });

  it("answers 202 with the open sitting for the same gate, and 409 SITTING_OPEN for another", async () => {
    await inject(null);
    const first = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(first.status).toBe(201);
    const again = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    const other = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-c" });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "SITTING_OPEN", gateId: "gate-after-b" });
    expect(bench.deliverySitting).toEqual(first.body);
  });

  it("answers 400 INVALID_BODY without a gateId, and 404 GATE_NOT_FOUND for a gate the delivery lacks", async () => {
    await inject(null);
    const missing = await request(app).post(`${base}/sittings`).send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: "INVALID_BODY", field: "gateId" });
    const unknown = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-d" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("GATE_NOT_FOUND");
    expect(bench.deliverySitting).toBeUndefined();
  });

  it("answers 409 with the read error while the record is missing", async () => {
    const res = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DELIVERY_RECORD_MISSING");
  });
});

// The provisional gate rules (SB-FR-039): the cross-check reads a gate's
// provisional state from the record and never blocks the sitting that confirms
// its marks, and the approval waits for every provisional gate.
describe("a provisional gate in the cross-check, the sitting and the approval", () => {
  async function crossCheckOf(variant: GateAfterB): Promise<Record<string, unknown>[]> {
    gateAfterB = variant;
    writeSpec();
    const res = await request(app).get(`${base}/crosscheck`);
    expect(res.status).toBe(200);
    return res.body.disagreements as Record<string, unknown>[];
  }

  function gateStateEntries(list: Record<string, unknown>[]): Record<string, unknown>[] {
    return list.filter((entry) => entry.class === "gate-state-differs");
  }

  it("SB-TC-082 a provisional gate never blocks the sitting that confirms its marks, and the approval answers PROVISIONAL_UNCONFIRMED", async () => {
    // Step 1: no gate-state entry for the provisional gate.
    const list = await crossCheckOf("provisional");
    expect(gateStateEntries(list)).toEqual([]);
    expect(list).toEqual([]);

    // Step 2: the sitting opens, and its provisional case is open to a mark.
    const sitting = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(sitting.status).toBe(201);
    expect(sitting.body.gateId).toBe("gate-after-b");
    expect(bench.deliverySitting).toEqual(sitting.body);
    const snapshot = await request(app).get(base);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.gatesById["gate-after-b"].provisional).toEqual({
      cases: ["FX-TC-001"],
      unconfirmed: ["FX-TC-001"],
    });

    // Step 3: the approval waits for the provisional gate.
    const approval = await request(app).post(`${base}/approve`).send({});
    expect(approval.status).toBe(409);
    expect(approval.body).toMatchObject({
      code: "PROVISIONAL_UNCONFIRMED",
      gates: ["gate-after-b"],
    });
    expect(approval.body.error).toContain("gate-after-b");
  });

  it("SB-TC-095 a gate that claims a verdict over unconfirmed marks is a blocking entry that exempts its own sitting", async () => {
    // Step 1: one blocking gate-state entry, exempt for the gate's sitting.
    const list = await crossCheckOf("over-claimed");
    expect(gateStateEntries(list)).toEqual([
      {
        class: "gate-state-differs",
        blocking: true,
        unitId: "gate-after-b",
        sittingExempt: "gate-after-b",
        claimed: "passed",
        observed: "provisional",
        source: "test-results.json",
      },
    ]);
    expect(list).toHaveLength(1);

    // Step 3 before step 2, so no open sitting answers SITTING_OPEN: a sitting
    // of the gate after C is blocked.
    const other = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-c" });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["gate-state-differs"],
    });
    expect(bench.deliverySitting).toBeUndefined();

    // Step 2: the sitting of the gate after B opens.
    const sitting = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(sitting.status).toBe(201);
    expect(sitting.body.gateId).toBe("gate-after-b");

    // Step 4: the approval is blocked.
    const approval = await request(app).post(`${base}/approve`).send({});
    expect(approval.status).toBe(409);
    expect(approval.body).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["gate-state-differs"],
    });
  });

  it("SB-TC-096 a stale results verdict on a provisional gate stays with the plan-hash class", async () => {
    const list = await crossCheckOf("provisional-stale");
    // The loader reads the results' own hash as another plan's; the observed
    // word is the loader's reading of it, never the record's hash.
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      class: "plan-hash-mismatch",
      blocking: true,
      claimed: PLAN_HASH,
      source: "test-results.json",
    });
    expect(list[0].observed).not.toBe(PLAN_HASH);
    expect(gateStateEntries(list)).toEqual([]);

    // The plan-hash class blocks the sitting of the provisional gate too.
    const sitting = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(sitting.status).toBe(409);
    expect(sitting.body).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["plan-hash-mismatch"],
    });
  });
});
