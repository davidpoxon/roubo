// The delivery read routes of a Spec Bench, over the record fixture
// (SB-FR-008, SB-FR-009, SB-FR-013): GET /delivery folds the record and the
// accepted events into a snapshot, and GET /delivery/events answers the
// accepted events above a seq, for one unit or all.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench, RegisteredProject, RouboConfig } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { DELIVERY_EVENT_SPILL_FILE, DELIVERY_UNIT_SPANS_FILE } from "@roubo/shared/delivery-bench";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));

// The read routes launch nothing; the launcher is mocked so its own
// collaborators (terminals, the token registry) stay out of this file.
vi.mock("../services/delivery-session-launcher.js", () => ({
  DeliveryLaunchBlockedError: class extends Error {},
  deliveryLaunchBlock: vi.fn(),
  handOutDeliveryToken: vi.fn(),
  launchDeliverySession: vi.fn(),
  whenDeliveryBound: vi.fn(async () => undefined),
}));

// The diff read looks the unit's head up across the project's mapped
// submodules in a meta-repo workspace.
vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

// The discussion thread reads whether the main session is live; the terminal
// service and its PTYs stay out of this file.
vi.mock("../services/terminal.js", () => ({
  getSession: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import { forgetDeliveryEventLog, ingestDeliveryEvents } from "../services/delivery-event-log.js";
import { computePlanHash } from "../lib/testbench-store.js";
import router from "./delivery.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);

function fixtureRecord(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function recordWithout(section: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fixtureRecord()).filter(([key]) => key !== section));
}

let tmp: string;
let specFolder: string;
let bench: Bench;
let app: express.Express;

function writeRecord(record: unknown): void {
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function event(seq: number, unitId: string | undefined, status = "running"): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type: "unit.changed",
    seq,
    ts: "2026-10-16T09:40:00Z",
    ...(unitId !== undefined && { unit_id: unitId }),
    payload: { status },
  };
}

// One row of the delivery tooling's outbox, `<spec>/delivery/outbox.jsonl`.
function outboxRow(envelope: DeliveryEvent): Record<string, unknown> {
  return { seq: envelope.seq, event: envelope.type, payload: envelope, posted: false };
}

function writeOutbox(rows: Record<string, unknown>[]): void {
  fs.mkdirSync(path.join(specFolder, "delivery"), { recursive: true });
  fs.writeFileSync(
    path.join(specFolder, "delivery", "outbox.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
}

// Accepts events through the bench's event log, as the ingest route does.
function accept(events: DeliveryEvent[]): void {
  const result = ingestDeliveryEvents(
    bench.projectId,
    bench.id,
    fixtureRecord(),
    events,
    path.join(specFolder, DELIVERY_EVENT_SPILL_FILE),
  );
  expect(result.ok).toBe(true);
}

const base = "/api/projects/demo/benches/1/delivery";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-routes-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    // The mode the fixture record states, so a load has no mode to move.
    deliveryDecisionMode: "auto",
  } as Bench;
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
  forgetDeliveryEventLog();
  app = express();
  // The server parses JSON bodies for every route (server/index.ts).
  app.use(express.json());
  app.use("/api/projects", router);
});

afterEach(() => {
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GET /:projectId/benches/:id/delivery", () => {
  it("answers 200 with the snapshot folded from the record and the accepted events", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D", "done")]);

    const res = await request(app).get(base);

    expect(res.status).toBe(200);
    expect(res.body.deliveryId).toBe("demo-delivery-1");
    expect(res.body.seq).toBe(9);
    expect(res.body.unitsById.C.status).toBe("running");
    expect(res.body.unitsById.D.status).toBe("done");
    expect(res.body.gap).toBeUndefined();
  });

  describe("SB-TC-022 progress from the spec's plan and results in the workspace", () => {
    const plan: TestCasesPlan = {
      $schema: TEST_CASES_SCHEMA_ID,
      schemaVersion: "1.2.0",
      specSlug: "fixture-spec",
      cases: ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"].map((id) => ({
        id,
        title: id,
        area: "demo",
        level: 1,
        type: "functional",
        steps: [],
        tags: [],
        linked_requirement_ids: [id === "DEMO-TC-003" ? "DEMO-FR-002" : "DEMO-FR-001"],
        linked_user_story_ids: [],
      })),
    };
    const passed = { observationMarks: {}, derivedStatus: "passed", notes: [] };

    function writeSpec(planHash: string): void {
      fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(plan));
      fs.writeFileSync(
        path.join(specFolder, "test-results.json"),
        JSON.stringify({
          $schema: TEST_RESULTS_SCHEMA_ID,
          schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
          planHash,
          caseResults: { "DEMO-TC-001": passed, "DEMO-TC-002": passed },
          updatedAt: "2026-10-16T09:30:00Z",
        }),
      );
    }

    it("SB-TC-022 serves the cases met, the requirements covered and each case's verify record and pull request", async () => {
      const hash = computePlanHash(plan);
      const record = fixtureRecord();
      writeRecord({
        ...record,
        plan_hash: hash,
        units: record.units.map((unit) =>
          unit.id === "B" ? { ...unit, pr_url: "https://github.com/demo/demo/pull/2" } : unit,
        ),
      });
      writeSpec(hash);

      const res = await request(app).get(base);

      expect(res.status).toBe(200);
      expect(res.body.progress.cases).toEqual({ met: 2, total: 3 });
      expect(res.body.progress.requirements).toEqual({ met: 1, total: 2 });
      expect(res.body.progress.caseList[0]).toEqual({
        id: "DEMO-TC-001",
        title: "DEMO-TC-001",
        met: true,
        result: passed,
        metBy: "B",
        prUrl: "https://github.com/demo/demo/pull/2",
      });
      expect(res.body.gatesById["gate-after-b"].state.status).toBe("passed");
    });

    it("SB-TC-022 counts nothing met when the results were written for another plan", async () => {
      const hash = computePlanHash(plan);
      writeRecord({ ...fixtureRecord(), plan_hash: hash });
      writeSpec("an-older-plan-hash");

      const res = await request(app).get(base);

      expect(res.status).toBe(200);
      expect(res.body.progress.cases).toEqual({ met: 0, total: 3 });
      expect(res.body.gatesById["gate-after-b"].state.status).toBe("stale");
    });

    it("SB-TC-022 leaves a retired case out of the progress totals and the gate's set", async () => {
      const retiredPlan: TestCasesPlan = {
        ...plan,
        cases: plan.cases.map((testCase) =>
          testCase.id === "DEMO-TC-002"
            ? { ...testCase, lifecycle: { state: "retired", reason: "Obsolete" } }
            : testCase,
        ),
      };
      const hash = computePlanHash(retiredPlan);
      writeRecord({ ...fixtureRecord(), plan_hash: hash });
      fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(retiredPlan));
      fs.writeFileSync(
        path.join(specFolder, "test-results.json"),
        JSON.stringify({
          $schema: TEST_RESULTS_SCHEMA_ID,
          schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
          planHash: hash,
          caseResults: { "DEMO-TC-001": passed },
          updatedAt: "2026-10-16T09:30:00Z",
        }),
      );

      const res = await request(app).get(base);

      expect(res.status).toBe(200);
      // DEMO-TC-002 has no result: counted, it would hold the gate pending.
      expect(res.body.progress.cases).toEqual({ met: 1, total: 2 });
      expect(res.body.progress.requirements).toEqual({ met: 1, total: 2 });
      expect(res.body.progress.caseList.map((entry: { id: string }) => entry.id)).toEqual([
        "DEMO-TC-001",
        "DEMO-TC-003",
      ]);
      expect(res.body.gatesById["gate-after-b"].state.status).toBe("passed");
      expect(res.body.gatesById["gate-after-b"].state.lifecycleExcludedCaseIds).toEqual([
        "DEMO-TC-002",
      ]);
    });

    it("SB-TC-022 reports no totals while the workspace has no plan", async () => {
      writeRecord(fixtureRecord());

      const res = await request(app).get(base);

      expect(res.status).toBe(200);
      expect(res.body.progress).toEqual({
        cases: { met: 0, total: 0 },
        requirements: { met: 0, total: 0 },
        caseList: [],
      });
    });
  });

  it("answers 404 NOT_SPEC_BENCH for a bench that is not a Spec Bench", async () => {
    bench = { ...bench, variant: "default" } as Bench;
    writeRecord(fixtureRecord());

    const res = await request(app).get(base);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_SPEC_BENCH" });
    expect(typeof res.body.error).toBe("string");
  });

  it("answers 404 NOT_FOUND for a bench that does not exist", async () => {
    const res = await request(app).get("/api/projects/demo/benches/2/delivery");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 409 DELIVERY_NONCONFORMANT naming the missing section", async () => {
    writeRecord(recordWithout("budget"));

    const res = await request(app).get(base);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "budget" });
  });

  it("answers 409 DELIVERY_RECORD_MISSING while the workspace has no record", async () => {
    const res = await request(app).get(base);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });
  });
});

describe("GET /:projectId/benches/:id/delivery/events", () => {
  it("answers every accepted event above the record with the accepted seq", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, undefined)]);

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(200);
    expect(res.body.acceptedSeq).toBe(10);
    expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([8, 9, 10]);
  });

  it("answers the accepted seq of the record when no event was accepted yet", async () => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], acceptedSeq: 7 });
  });

  it("filters to the unit by the envelope unit_id, in seq order", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, "C", "done"), event(11, undefined)]);

    const res = await request(app).get(`${base}/events?unit=C`);

    expect(res.status).toBe(200);
    expect(res.body.acceptedSeq).toBe(11);
    expect(res.body.events.map((e: DeliveryEvent) => [e.seq, e.unit_id])).toEqual([
      [8, "C"],
      [10, "C"],
    ]);
    expect(res.body.folded).toBe(0);
  });

  it("SB-FR-013 counts the unit's events the record carries apart from no events", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, "C", "done")]);
    writeRecord({ ...fixtureRecord(), last_event_seq: 9 });

    const carried = await request(app).get(`${base}/events?unit=C`);
    expect(carried.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([10]);
    expect(carried.body.folded).toBe(1);

    const none = await request(app).get(`${base}/events?unit=B`);
    expect(none.body).toEqual({ events: [], acceptedSeq: 10, folded: 0 });

    // Without unit the body carries no count.
    const all = await request(app).get(`${base}/events`);
    expect(all.body.folded).toBeUndefined();
  });

  it("honours after, alone and with unit", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, "C"), event(11, "C")]);

    const above = await request(app).get(`${base}/events?after=9`);
    expect(above.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([10, 11]);

    const unitAbove = await request(app).get(`${base}/events?after=10&unit=C`);
    expect(unitAbove.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([11]);
    expect(unitAbove.body.acceptedSeq).toBe(11);

    const none = await request(app).get(`${base}/events?after=11`);
    expect(none.body).toEqual({ events: [], acceptedSeq: 11 });
  });

  it("reads the spill file as well as memory, in seq order", async () => {
    writeRecord(fixtureRecord());
    fs.writeFileSync(
      path.join(specFolder, DELIVERY_EVENT_SPILL_FILE),
      `${JSON.stringify(event(8, "C"))}\n${JSON.stringify(event(9, "D"))}\n`,
    );
    // The log holds nothing in memory yet: the read seeds it from the record.
    const res = await request(app).get(`${base}/events?unit=C`);

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([8]);
  });

  describe("#1659 the unit's events the record carries, from the delivery outbox", () => {
    it("lists them before the accepted events above the record, for the unit only", async () => {
      writeRecord(fixtureRecord());
      writeOutbox([
        outboxRow(event(1, "C")),
        outboxRow(event(2, "D")),
        outboxRow(event(3, "C", "review")),
        outboxRow(event(4, undefined)),
      ]);
      accept([event(8, "C", "done"), event(9, "D")]);

      const res = await request(app).get(`${base}/events?unit=C`);

      expect(res.status).toBe(200);
      expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([1, 3, 8]);
      expect(res.body.acceptedSeq).toBe(9);
      expect(res.body.folded).toBe(2);
      // The feed of the whole delivery stays the events above the record: the
      // snapshot already folds the ones below it.
      const all = await request(app).get(`${base}/events`);
      expect(all.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([8, 9]);
    });

    it("honours after over the outbox events", async () => {
      writeRecord(fixtureRecord());
      writeOutbox([outboxRow(event(1, "C")), outboxRow(event(3, "C"))]);

      const res = await request(app).get(`${base}/events?unit=C&after=2`);

      expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([3]);
    });

    it("leaves out a row above the record, a torn line, a foreign delivery and a bad envelope", async () => {
      writeRecord(fixtureRecord());
      const foreign = { ...event(2, "C"), delivery_id: "another-delivery" };
      const lines = [
        JSON.stringify(outboxRow(event(1, "C"))),
        JSON.stringify(outboxRow(foreign)),
        JSON.stringify({ seq: 3, event: "unit.changed", payload: { seq: 3 }, posted: false }),
        "not json",
        // The record is at seq 7: the log, not the outbox, answers above it.
        JSON.stringify(outboxRow(event(8, "C"))),
        JSON.stringify(outboxRow(event(5, "C"))).slice(0, 40),
      ];
      fs.mkdirSync(path.join(specFolder, "delivery"), { recursive: true });
      fs.writeFileSync(path.join(specFolder, "delivery", "outbox.jsonl"), lines.join("\n"));

      const res = await request(app).get(`${base}/events?unit=C`);

      expect(res.status).toBe(200);
      expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([1]);
      expect(res.body.folded).toBe(1);
    });

    it("counts an event once that the outbox and the unit span both hold", async () => {
      writeRecord(fixtureRecord());
      accept([event(8, "C"), event(9, "C")]);
      writeRecord({ ...fixtureRecord(), last_event_seq: 9 });
      writeOutbox([outboxRow(event(8, "C")), outboxRow(event(9, "C"))]);

      const res = await request(app).get(`${base}/events?unit=C`);

      expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([8, 9]);
      expect(res.body.folded).toBe(2);
    });
  });

  it.each(["-1", "1.5", "abc", ""])("answers 400 INVALID_QUERY for after=%s", async (after) => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events?after=${after}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_QUERY", field: "after" });
    expect(typeof res.body.error).toBe("string");
  });

  it("answers 400 INVALID_QUERY for a unit given twice", async () => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events?unit=C&unit=D`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_QUERY", field: "unit" });
  });

  it("answers 404 NOT_SPEC_BENCH for a bench that is not a Spec Bench", async () => {
    bench = { ...bench, variant: "default" } as Bench;
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_SPEC_BENCH" });
  });

  it("answers 409 DELIVERY_NONCONFORMANT naming the missing section", async () => {
    writeRecord(recordWithout("lifecycle"));

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "lifecycle" });
  });

  it("answers 409 DELIVERY_RECORD_MISSING while the workspace has no record", async () => {
    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });
  });
});

// A git repository in the bench workspace: the trunk at one commit, and the
// stack's two layers on a branch off it, with the workspace back on the trunk.
function git(...args: string[]): string {
  return gitIn(bench.workspacePath, ...args);
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

function commitFile(name: string, content: string, repo = bench.workspacePath): string {
  fs.writeFileSync(path.join(repo, name), content);
  gitIn(repo, "add", "--", name);
  gitIn(repo, "commit", "-q", "-m", `add ${name}`);
  return gitIn(repo, "rev-parse", "HEAD");
}

function stackRepo(repo = bench.workspacePath): { trunk: string; layerA: string; layerB: string } {
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  const trunk = commitFile("trunk.txt", "trunk\n", repo);
  gitIn(repo, "checkout", "-q", "-b", "stack");
  const layerA = commitFile("layer-a.txt", "the base layer\n", repo);
  const layerB = commitFile("layer-b.txt", "the second layer\n", repo);
  gitIn(repo, "checkout", "-q", "main");
  return { trunk, layerA, layerB };
}

// A meta-repo workspace: its own repository, and the stack in the repository of
// the mapped submodule `app` inside it, as a delivery's units commit there.
function metaRepoStack(): { trunk: string; layerA: string; layerB: string } {
  git("init", "-q", "-b", "main");
  commitFile("meta.txt", "the meta-repo\n");
  const stack = stackRepo(path.join(bench.workspacePath, "app"));
  const config = { layout: { type: "meta-repo", submodules: { app: "app" } } } as RouboConfig;
  vi.mocked(projectRegistry.getProject).mockImplementation((projectId) =>
    projectId === bench.projectId
      ? ({ id: projectId, config } as unknown as RegisteredProject)
      : undefined,
  );
  return stack;
}

function recordWithHeads(heads: Record<string, string>): DeliveryRecord {
  const record = fixtureRecord();
  return {
    ...record,
    units: record.units.map((unit) =>
      Object.hasOwn(heads, unit.id)
        ? { ...unit, head: heads[unit.id] }
        : { ...unit, head: undefined },
    ),
  };
}

describe("GET /:projectId/benches/:id/delivery/units/:unitId/diff", () => {
  it("answers the diff from the head of the layer below to the unit's head", async () => {
    const { layerA, layerB } = stackRepo();
    writeRecord(recordWithHeads({ A: layerA, B: layerB }));

    const res = await request(app).get(`${base}/units/B/diff`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unit: "B", base: layerA, head: layerB, truncated: false });
    expect(res.body.diff).toContain("+++ b/layer-b.txt");
    expect(res.body.diff).toContain("+the second layer");
    expect(res.body.diff).not.toContain("layer-a.txt");
  });

  it("answers the diff from the stack base for the unit at the base of its stack", async () => {
    const { trunk, layerA, layerB } = stackRepo();
    writeRecord(recordWithHeads({ A: layerA, B: layerB }));

    const res = await request(app).get(`${base}/units/A/diff`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unit: "A", base: trunk, head: layerA });
    expect(res.body.diff).toContain("+++ b/layer-a.txt");
    expect(res.body.diff).not.toContain("layer-b.txt");
  });

  it("answers an empty diff while the unit has no head", async () => {
    writeRecord(recordWithHeads({}));

    const res = await request(app).get(`${base}/units/D/diff`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unit: "D", base: null, head: null, diff: "", truncated: false });
  });

  it("answers 409 DELIVERY_DIFF_UNAVAILABLE for a head that is not a commit id", async () => {
    writeRecord(recordWithHeads({ A: "--output=/tmp/x" }));

    const res = await request(app).get(`${base}/units/A/diff`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_DIFF_UNAVAILABLE" });
  });

  it("answers 409 DELIVERY_DIFF_UNAVAILABLE when the workspace does not hold the commits", async () => {
    stackRepo();
    writeRecord(recordWithHeads({ A: "0123456789abcdef0123456789abcdef01234567" }));

    const res = await request(app).get(`${base}/units/A/diff`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_DIFF_UNAVAILABLE" });
  });

  it("#1659 answers the diff in the mapped submodule that holds the unit's commits", async () => {
    const { trunk, layerA, layerB } = metaRepoStack();
    writeRecord(recordWithHeads({ A: layerA, B: layerB }));

    const upper = await request(app).get(`${base}/units/B/diff`);
    expect(upper.status).toBe(200);
    expect(upper.body).toMatchObject({ unit: "B", base: layerA, head: layerB });
    expect(upper.body.diff).toContain("+++ b/layer-b.txt");

    // The stack base is the merge base with the submodule's HEAD, not the
    // meta-repo's.
    const lower = await request(app).get(`${base}/units/A/diff`);
    expect(lower.status).toBe(200);
    expect(lower.body).toMatchObject({ unit: "A", base: trunk, head: layerA });
    expect(lower.body.diff).toContain("+++ b/layer-a.txt");
  });

  it("#1659 names the repositories it searched when none holds the head", async () => {
    metaRepoStack();
    writeRecord(recordWithHeads({ A: "0123456789abcdef0123456789abcdef01234567" }));

    const res = await request(app).get(`${base}/units/A/diff`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DELIVERY_DIFF_UNAVAILABLE");
    expect(res.body.error).toContain("the workspace root, app");
    expect(res.body.error).not.toContain("fatal");
  });

  it("answers 404 UNIT_NOT_FOUND for a unit the record does not carry", async () => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/units/Z/diff`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "UNIT_NOT_FOUND" });
  });
});

function timedEvent(seq: number, unitId: string, ts: string): DeliveryEvent {
  return { ...event(seq, unitId), ts };
}

describe("the unit span file of the folded events", () => {
  it("SB-TC-031 keeps a folded unit's timeline count across a server restart", async () => {
    writeRecord(fixtureRecord());
    accept([
      timedEvent(8, "A", "2026-10-16T09:40:00Z"),
      timedEvent(9, "B", "2026-10-16T09:42:00Z"),
      timedEvent(10, "A", "2026-10-16T09:45:00Z"),
    ]);
    // The record passes A's events, so they leave the log, and the span file
    // beside the spill file holds their span.
    writeRecord({ ...fixtureRecord(), last_event_seq: 10 });
    expect(fs.existsSync(path.join(specFolder, DELIVERY_UNIT_SPANS_FILE))).toBe(true);

    // Roubo restarts: a fresh event-log module, and the routes over it.
    vi.resetModules();
    const fresh = await import("./delivery.js");
    const freshBenches = await import("../services/bench-manager.js");
    vi.mocked(freshBenches.getBench).mockImplementation((projectId, benchId) =>
      projectId === bench.projectId && benchId === bench.id ? bench : undefined,
    );
    const restarted = express();
    restarted.use("/api/projects", fresh.default);

    const timeline = await request(restarted).get(`${base}/events?unit=A`);
    expect(timeline.body).toEqual({ events: [], acceptedSeq: 10, folded: 2 });
    const other = await request(restarted).get(`${base}/events?unit=B`);
    expect(other.body).toMatchObject({ folded: 1 });
  });

  it("ignores a span file of another delivery after a restart", async () => {
    writeRecord({ ...fixtureRecord(), last_event_seq: 10 });
    fs.writeFileSync(
      path.join(specFolder, DELIVERY_UNIT_SPANS_FILE),
      JSON.stringify({
        delivery_id: "another-delivery",
        units: {
          A: {
            first: { seq: 8, ts: "2026-10-16T09:40:00Z" },
            last: { seq: 9, ts: "2026-10-16T09:45:00Z" },
            seqs: [8, 9],
          },
        },
      }),
    );

    const timeline = await request(app).get(`${base}/events?unit=A`);
    expect(timeline.body).toMatchObject({ folded: 0 });
  });
});
