// The Spec Bench's TestBench host (SB-FR-026, SB-FR-027, SB-US-009): during a
// gate sitting the escalated cases are marked through the existing case status
// route, which resolves the bench through the TestbenchHostResolver and writes
// the same test-results.json in the bench workspace's spec folder, with the
// operator as author. A Not met mark stores its evidence and files a fix unit
// that blocks the gate until a unit.changed event moves it to done and the case
// passes. A mark is refused with 400 outside a sitting and with 409
// CROSSCHECK_BLOCKED under a blocking class.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import { DELIVERY_EVENT_HOOK_PATH } from "@roubo/shared/delivery-bench";
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

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));
vi.mock("../services/bench-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/bench-manager.js")>();
  return {
    BenchError: actual.BenchError,
    getBench: vi.fn(),
    getBenches: vi.fn(),
    isBenchLive: vi.fn(() => true),
    whenWorkspaceProvisioned: vi.fn(async () => undefined),
    setFocusedSpecPath: vi.fn(),
  };
});
vi.mock("../services/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/state.js")>()),
  updateBench: vi.fn(),
}));
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));
vi.mock("../services/sse.js", () => ({
  broadcast: vi.fn(),
  broadcastBenchDecisionMode: vi.fn(),
  broadcastDeliveryFrame: vi.fn(),
}));
vi.mock("../services/terminal.js", () => ({
  getSession: vi.fn(),
}));
vi.mock("../services/delivery-session-launcher.js", () => ({
  DeliveryLaunchBlockedError: class extends Error {},
  deliveryLaunchBlock: vi.fn(),
  handOutDeliveryToken: vi.fn(),
  launchDeliverySession: vi.fn(),
  whenDeliveryBound: vi.fn(async () => undefined),
}));
// The cross-check is read as the sitting route reads it; each case sets the
// disagreements its last refresh found.
vi.mock("../services/delivery-cross-check-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/delivery-cross-check-loader.js")>()),
  readDeliveryCrossCheck: vi.fn(),
}));
vi.mock("../services/fix-issue-filer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/fix-issue-filer.js")>()),
  fileFixIssueAndBlock: vi.fn(),
}));
vi.mock("../services/work-unit-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/work-unit-loader.js")>();
  return {
    ...actual,
    loadVerifyUnits: vi.fn(),
    // The gates route loads the spec's gates through this; a case sets them.
    loadVerifyUnitsWithDiagnostics: vi.fn(actual.loadVerifyUnitsWithDiagnostics),
  };
});
// The gates route reads the operator's merges and splits; none are recorded.
vi.mock("../services/gate-override-store.js", async (importOriginal) => {
  const { emptyGateOverrides } = await import("@roubo/shared/gate-overrides-contract");
  return {
    ...(await importOriginal<typeof import("../services/gate-override-store.js")>()),
    loadOverrides: vi.fn(() => emptyGateOverrides()),
  };
});

import * as benchManager from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as stateService from "../services/state.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import { readDeliveryCrossCheck } from "../services/delivery-cross-check-loader.js";
import { fileFixIssueAndBlock } from "../services/fix-issue-filer.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { forgetDeliveryControlMemory } from "../services/delivery-control-outbox.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import {
  getTestbenchHostProvider,
  resolveTestbenchHost,
  unregisterTestbenchHostProvider,
} from "../services/testbench-host-resolver.js";
import {
  SPECBENCH_NO_SITTING_ERROR,
  registerSpecbenchTestbenchAdapter,
} from "../lib/specbench-testbench-adapter.js";
import { computePlanHash } from "../lib/testbench-store.js";
import testbenchRouter, {
  TESTBENCH_CASE_STATUS_PATH,
  testbenchCaseStatusBodyParser,
} from "./testbench.js";
import deliveryRouter from "./delivery.js";
import gatesRouter from "./gates.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";

const TOKEN = "delivery-token-for-the-fixture";
const UPDATED_AT = "2026-10-16T09:30:00Z";
const CASES = ["FX-TC-001", "FX-TC-002", "FX-TC-003"];
const GATE = "gate-after-b";
const FIX_REF = "example/fixture#77";
const OPERATOR = { name: "Ada Operator", email: "ada@example.test" };
// A 1x1 PNG.
const SCREENSHOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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

// Four units A, B and C on one stack and D on its own, with gates after B and
// after C, and the fix unit E that the delivery planned for the issue filed
// below the gate after B: its record entry carries the issue's bare ref.
function record(): unknown {
  const units = [
    { id: "A", stack: "A", layer: 0, status: "done" },
    { id: "B", stack: "A", layer: 1, status: "done" },
    { id: "C", stack: "A", layer: 2, status: "running" },
    { id: "D", stack: "D", layer: 0, status: "running" },
    {
      id: "E",
      stack: "E",
      layer: 0,
      status: "running",
      tracker: { system: "github", ref: "77", url: "https://github.com/example/fixture/issues/77" },
    },
  ];
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: computePlanHash(plan),
    mode: { value: "attended", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"], E: ["E"] },
      gates: [
        { id: GATE, after: ["B"], status: "verifying", cases: ["FX-TC-001", "FX-TC-002"] },
        { id: "gate-after-c", after: ["C"], status: "pending", cases: ["FX-TC-003"] },
      ],
    },
    units: units.map((unit) => ({
      title: `Unit ${unit.id}`,
      depends_on: [],
      branch: `fx/${unit.id.toLowerCase()}`,
      head: unit.id.toLowerCase().repeat(40),
      ...unit,
    })),
    decisions: [],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: {},
    health: { status: "ok", checked_at: UPDATED_AT },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: UPDATED_AT, ended_at: null },
    last_event_seq: 7,
    updated_at: UPDATED_AT,
  };
}

let tmp: string;
let repo: string;
let specFolder: string;
let bench: Bench;
let app: express.Express;
const marks = "/api/projects/demo/benches/1/testbench";

function resultsFile(): {
  caseResults: Record<
    string,
    {
      derivedStatus: string;
      statusOverride?: { status: string; author: { name: string; email: string } };
      notes: { text: string; author: { name: string } }[];
    }
  >;
} {
  return JSON.parse(fs.readFileSync(path.join(specFolder, "test-results.json"), "utf8"));
}

function openSitting(): void {
  bench.deliverySitting = {
    gateId: GATE,
    state: "open",
    openedAt: UPDATED_AT,
    commit: "b".repeat(40),
    resultsSpecPath: specFolder,
  };
}

function markCase(caseId: string, body: unknown): request.Test {
  return request(app).put(`${marks}/cases/${caseId}/status`).send(body);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "specbench-testbench-"));
  repo = path.join(tmp, "repo");
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  for (const folder of [specFolder, path.join(repo, ".specifications", "fixture-spec")]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "test-cases.json"), JSON.stringify(plan));
  }
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: computePlanHash(plan),
      caseResults: {
        "FX-TC-002": { observationMarks: {}, derivedStatus: "passed", notes: [] },
      },
      updatedAt: UPDATED_AT,
    }),
  );
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record(), null, 2)}\n`,
  );
  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: path.join(repo, ".specifications", "fixture-spec"),
    workspacePath: workspace,
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
    components: {},
    notifications: [],
  } as unknown as Bench;
  vi.mocked(projectRegistry.getProject).mockReturnValue({ repoPath: repo, config: {} } as never);
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.getBenches).mockImplementation(() => [bench]);
  vi.mocked(stateService.updateBench).mockClear();
  vi.mocked(resolveGitIdentity).mockResolvedValue(OPERATOR);
  vi.mocked(readDeliveryCrossCheck).mockResolvedValue({
    disagreements: [],
    refreshedAt: UPDATED_AT,
    sourceError: null,
  } as never);
  vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
    {
      slug: "fixture-spec",
      unit: {
        id: GATE,
        kind: "verify",
        tracker: {
          system: "github",
          ref: "12",
          url: "https://github.com/example/fixture/issues/12",
          blocked_by_refs: [],
        },
      },
    } as never,
  ]);
  vi.mocked(fileFixIssueAndBlock).mockReset();
  vi.mocked(fileFixIssueAndBlock).mockImplementation(async (_projectId, params) => ({
    fixIssueRef: FIX_REF,
    gateRef: params.gateRef,
    failedCaseId: params.failedCaseId,
    linkStatus: "complete",
    createdAt: "2026-10-16T10:00:00.000Z",
  }));
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  registerSpecbenchTestbenchAdapter();
  app = express();
  app.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
  app.use(TESTBENCH_CASE_STATUS_PATH, testbenchCaseStatusBodyParser);
  app.use(express.json());
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/projects", testbenchRouter);
  app.use("/api/projects", deliveryRouter);
  app.use("/api/projects", gatesRouter);
});

afterEach(() => {
  unregisterTestbenchHostProvider("specbench");
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the Spec Bench's TestBench host", () => {
  it("SB-TC-063 escalated cases are listed, a Met mark lands in the workspace's test-results.json with the operator as author, the gates route admits the specbench variant, and the refocus route is refused", async () => {
    openSitting();
    // Step 1: the plan read lists the cases of the spec, from the workspace.
    const planRes = await request(app).get(`${marks}/plan`);
    expect(planRes.status).toBe(200);
    expect(planRes.body.plan.cases.map((c: { id: string }) => c.id)).toEqual(CASES);

    // Step 2: the case status route takes the mark through the resolver.
    const res = await markCase("FX-TC-001", { override: "passed" });
    expect(res.status).toBe(200);
    expect(res.body.statusOverride.status).toBe("passed");
    const written = resultsFile().caseResults["FX-TC-001"];
    expect(written.statusOverride?.status).toBe("passed");
    expect(written.statusOverride?.author).toEqual(OPERATOR);

    // Step 3: the gates route reads the gate of the spec from the Spec Bench's
    // workspace, where the marks are, through the "gate" purpose of the
    // resolver. The project checkout holds no results, so a gate read from it
    // would be stale: a passed gate shows that the Spec Bench was admitted.
    vi.mocked(workUnitLoader.loadVerifyUnitsWithDiagnostics).mockReturnValueOnce({
      loaded: [
        {
          slug: "fixture-spec",
          unit: {
            id: GATE,
            title: `Verify ${GATE}`,
            type: "task",
            kind: "verify",
            description: "gate",
            acceptance_criteria: [],
            depends_on: [],
            covers: [],
            implements: {
              requirement_ids: [],
              user_story_ids: [],
              test_case_ids: ["FX-TC-001", "FX-TC-002"],
            },
          },
        } as never,
      ],
      invalidSpecs: [],
    });
    const gatesRes = await request(app).get("/api/projects/demo/gates?slug=fixture-spec");
    expect(gatesRes.status).toBe(200);
    expect(gatesRes.body.gates).toHaveLength(1);
    expect(gatesRes.body.gates[0]).toMatchObject({
      gateId: GATE,
      status: "passed",
      unresolvedCaseIds: [],
    });

    // The focus route reaches the resolver's "focus" purpose through the bench
    // manager, as the real setFocusedSpecPath does before it writes anything.
    vi.mocked(benchManager.setFocusedSpecPath).mockImplementation((projectId, benchId) => {
      const target = benchManager.getBench(projectId, benchId);
      if (!target) throw new benchManager.BenchError("Bench not found", "NOT_FOUND");
      const host = resolveTestbenchHost(target, "focus");
      if (!host.ok) throw new benchManager.BenchError(host.error, host.code ?? "NOT_TESTBENCH");
      return target;
    });
    // Step 4: the refocus route is refused for the Spec Bench, and the bench
    // keeps its spec.
    const focusedBefore = bench.focusedSpecPath;
    vi.mocked(stateService.updateBench).mockClear();
    const focusRes = await request(app)
      .put(`${marks}/focus`)
      .send({ focusedSpecPath: path.join(repo, ".specifications", "other-spec") });
    expect(focusRes.status).toBe(400);
    expect(focusRes.body.code).toBe("NOT_TESTBENCH");
    expect(bench.focusedSpecPath).toBe(focusedBefore);
    expect(stateService.updateBench).not.toHaveBeenCalled();

    // The same answers, from the resolver itself: the "gate" and "read"
    // purposes admit a Spec Bench and root at its workspace.
    for (const purpose of ["gate", "read"] as const) {
      const resolved = resolveTestbenchHost(bench, purpose, repo);
      expect(resolved.ok, purpose).toBe(true);
      if (resolved.ok) {
        expect(resolved.host.rootPath).toBe(bench.workspacePath);
        expect(resolved.host.slug).toBe("fixture-spec");
        expect(resolved.host.refocusable).toBe(false);
      }
    }
    // And the "focus" purpose refuses it.
    const focus = resolveTestbenchHost(bench, "focus");
    expect(focus.ok).toBe(false);
    if (!focus.ok) {
      expect(focus.status).toBe(400);
      expect(focus.code).toBe("NOT_TESTBENCH");
    }
    expect(getTestbenchHostProvider("specbench")?.refocusable).toBe(false);
  });

  it("SB-TC-064 a Not met mark stores its evidence, files a fix unit that blocks the gate, and the blocker clears on unit.changed done with a passing result", async () => {
    openSitting();
    // Step 1: the mark carries a note and a screenshot.
    const res = await markCase("FX-TC-001", {
      override: "failed",
      evidence: { note: "The banner never shows.", screenshot: SCREENSHOT },
    });
    expect(res.status).toBe(200);
    const screenshotPath: string = res.body.evidence.screenshot;
    expect(screenshotPath).toMatch(/^evidence\/FX-TC-001\/.+\.png$/);
    expect(fs.existsSync(path.join(specFolder, screenshotPath))).toBe(true);
    const written = resultsFile().caseResults["FX-TC-001"];
    expect(written.statusOverride?.status).toBe("failed");
    expect(written.notes.at(-1)?.text).toBe(
      `The banner never shows.\nScreenshot: ${screenshotPath}`,
    );
    expect(written.notes.at(-1)?.author.name).toBe(OPERATOR.name);
    expect(fileFixIssueAndBlock).toHaveBeenCalledWith("demo", {
      repoFullName: "example/fixture",
      failedCaseId: "FX-TC-001",
      gateRef: "example/fixture#12",
      notes: "The banner never shows.",
    });
    expect(res.body.fixUnit).toMatchObject({ caseId: "FX-TC-001", fixRef: FIX_REF });

    // Step 2: the sitting lists the fix unit and the gate reads blocked.
    let snapshot = await request(app).get("/api/projects/demo/benches/1/delivery");
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.sitting.fixUnitBlockers).toEqual([
      { caseId: "FX-TC-001", fixRef: FIX_REF, filedAt: "2026-10-16T10:00:00.000Z" },
    ]);
    expect(snapshot.body.sitting.blocked).toBe(true);
    expect(stateService.updateBench).toHaveBeenCalled();

    // A second Not met mark of the same case files nothing again.
    const again = await markCase("FX-TC-001", { override: "failed" });
    expect(again.body.fixUnit.alreadyFiled).toBe(true);
    expect(fileFixIssueAndBlock).toHaveBeenCalledTimes(1);

    // Step 3: a passing result alone does not clear it; the unit.changed
    // moving the fix unit to done then does.
    expect((await markCase("FX-TC-001", { override: "passed" })).status).toBe(200);
    snapshot = await request(app).get("/api/projects/demo/benches/1/delivery");
    expect(snapshot.body.sitting.blocked).toBe(true);
    const event = await request(app)
      .post(`${DELIVERY_EVENT_HOOK_PATH}?projectId=demo&benchId=1`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        events: [
          {
            $schema: DELIVERY_EVENT_SCHEMA_ID,
            schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
            delivery_id: "fixture-delivery",
            type: "unit.changed",
            seq: 8,
            ts: "2026-10-16T10:30:00Z",
            unit_id: "E",
            payload: { status: "done" },
          },
        ],
      });
    expect(event.status).toBe(202);
    snapshot = await request(app).get("/api/projects/demo/benches/1/delivery");
    expect(snapshot.body.sitting.fixUnitBlockers).toBeUndefined();
    expect(snapshot.body.sitting.blocked).toBeUndefined();
    expect(bench.deliverySitting?.fixUnitBlockers).toBeUndefined();
    // Every gating case of the gate is met, so the gate reads passed.
    expect(snapshot.body.gatesById[GATE].state.status).toBe("passed");
  });

  it("a passing mark after the fix unit is done clears the blocker", async () => {
    openSitting();
    await markCase("FX-TC-001", { override: "failed", evidence: { note: "Broken." } });
    expect(bench.deliverySitting?.fixUnitBlockers).toHaveLength(1);
    const event = await request(app)
      .post(`${DELIVERY_EVENT_HOOK_PATH}?projectId=demo&benchId=1`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        $schema: DELIVERY_EVENT_SCHEMA_ID,
        schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
        delivery_id: "fixture-delivery",
        type: "unit.changed",
        seq: 8,
        ts: "2026-10-16T10:30:00Z",
        unit_id: "E",
        payload: { status: "done" },
      });
    expect(event.status).toBe(202);
    // The case still reads failed, so the blocker holds.
    expect(bench.deliverySitting?.fixUnitBlockers).toHaveLength(1);
    const res = await markCase("FX-TC-001", { override: "passed" });
    expect(res.status).toBe(200);
    expect(res.body.clearedFixUnits).toEqual([expect.objectContaining({ fixRef: FIX_REF })]);
    expect(bench.deliverySitting?.fixUnitBlockers).toBeUndefined();
  });

  it("a gate with no tracker issue files no fix unit and says why, and the mark still lands", async () => {
    openSitting();
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([]);
    const res = await markCase("FX-TC-001", { override: "failed" });
    expect(res.status).toBe(200);
    expect(res.body.fixUnitError.code).toBe("GATE_UNTRACKED");
    expect(resultsFile().caseResults["FX-TC-001"].statusOverride?.status).toBe("failed");
    expect(fileFixIssueAndBlock).not.toHaveBeenCalled();
  });

  it("malformed evidence is a 400 before any write", async () => {
    openSitting();
    const res = await markCase("FX-TC-001", {
      override: "failed",
      evidence: { screenshot: "data:text/plain;base64,aGVsbG8=" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EVIDENCE");
    expect(resultsFile().caseResults["FX-TC-001"]).toBeUndefined();
    expect(fs.existsSync(path.join(specFolder, "evidence"))).toBe(false);
  });

  it("SB-TC-065 a mark is refused with 400 outside a sitting and with 409 CROSSCHECK_BLOCKED under a blocking class", async () => {
    // Step 1: no sitting open.
    const outside = await markCase("FX-TC-001", { override: "passed" });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toBe(SPECBENCH_NO_SITTING_ERROR);
    expect(outside.body.error).toMatch(/Marks are not allowed/);
    // A sitting still preparing is not open either.
    bench.deliverySitting = { gateId: GATE, state: "preparing" };
    expect((await markCase("FX-TC-001", { override: "passed" })).status).toBe(400);
    // The other mark routes refuse the same way.
    expect(
      (await request(app).post(`${marks}/cases/FX-TC-001/notes`).send({ text: "A note." })).status,
    ).toBe(400);

    // Step 2: a sitting open, under a gate-state-differs disagreement.
    openSitting();
    vi.mocked(readDeliveryCrossCheck).mockResolvedValue({
      disagreements: [
        { class: "gate-state-differs", blocking: true, unitId: null, gateId: GATE, detail: "" },
      ],
      refreshedAt: UPDATED_AT,
      sourceError: null,
    } as never);
    const blocked = await markCase("FX-TC-001", { override: "passed" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("CROSSCHECK_BLOCKED");
    expect(blocked.body.classes).toEqual(["gate-state-differs"]);
    expect(resultsFile().caseResults["FX-TC-001"]).toBeUndefined();
  });
});
