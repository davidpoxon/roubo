// The gate pin of a sitting (SB-FR-024, SB-NFR-006, SB-US-009): POST
// /delivery/sittings stops the bench components, adds a detached worktree at
// the gate commit beside the workspace, records gatePin and deliverySitting,
// and restarts the components from the pin; DELETE /delivery/sittings/current
// reverses it; a gate commit git does not know is refused before anything
// moves. The workspace is a real git repository, so every worktree here is
// one git made. The bench manager's component start and stop are mocked: they
// note the component root they ran at.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench, ComponentStatus } from "@roubo/shared";
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
  stopAllComponents: vi.fn(),
  startAllComponents: vi.fn(),
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
vi.mock("../services/git-helpers.js", () => ({
  resolveGitIdentity: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import * as stateService from "../services/state.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import { forgetDeliveryControlMemory } from "../services/delivery-control-outbox.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import type { DeliveryGitObservation } from "../lib/delivery-cross-check.js";
import {
  forgetDeliveryCrossCheck,
  setDeliveryCrossCheckDeps,
} from "../services/delivery-cross-check-loader.js";
import { specbenchVariantHost } from "../lib/specbench-variant-host.js";
import { computePlanHash } from "../lib/testbench-store.js";
import router from "./delivery.js";

const UPDATED_AT = "2026-10-16T09:30:00Z";
const BEFORE_UPDATE = "2026-10-16T09:00:00Z";
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
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
const PLAN_HASH = computePlanHash(plan);

let tmp: string;
let workspace: string;
let pin: string;
let specFolder: string;
let bench: Bench;
let app: express.Express;
// The head each unit's record entry names, and the one git reports for its
// branch to the cross-check.
let recordHead: Record<UnitId, string>;
let gitHead: Record<UnitId, string>;
// The commits of the workspace, oldest first.
let commits: string[];
// The component root each mocked start and stop ran at, in order.
let componentCalls: string[];
const base = "/api/projects/demo/benches/1/delivery";

function run(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

// Writes `build.txt` with `content` and commits it, returning the commit.
function commitBuild(content: string): string {
  fs.writeFileSync(path.join(workspace, "build.txt"), `${content}\n`);
  run(workspace, "add", "build.txt");
  run(workspace, "commit", "-q", "-m", content);
  return run(workspace, "rev-parse", "HEAD");
}

function record(): unknown {
  const stackOf: Record<UnitId, string> = { A: "A", B: "A", C: "A", D: "D" };
  const layerOf: Record<UnitId, number> = { A: 0, B: 1, C: 2, D: 0 };
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: PLAN_HASH,
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      gates: [
        {
          id: "gate-after-b",
          after: ["A", "B"],
          status: "passed",
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
      head: recordHead[id],
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
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(plan));
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: PLAN_HASH,
      caseResults: Object.fromEntries(
        CASES.map((id) => [id, { observationMarks: {}, derivedStatus: "passed", notes: [] }]),
      ),
      updatedAt: UPDATED_AT,
    }),
  );
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record(), null, 2)}\n`,
  );
}

function gitObservation(): DeliveryGitObservation {
  const observation: Record<string, DeliveryGitObservation[string]> = {};
  for (const id of UNITS) {
    observation[BRANCH[id]] = {
      localHead: gitHead[id],
      remoteHead: null,
      committedAt: BEFORE_UPDATE,
    };
  }
  return observation;
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/stacks")) {
    return Response.json([
      { name: "A", branches: [BRANCH.A, BRANCH.B, BRANCH.C] },
      { name: "D", branches: [BRANCH.D] },
    ]);
  }
  const baseOf: Record<UnitId, string> = { A: "main", B: BRANCH.A, C: BRANCH.B, D: "main" };
  return Response.json(
    UNITS.map((id) => ({
      state: "open",
      merged_at: null,
      head: { ref: BRANCH[id] },
      base: { ref: baseOf[id] },
      html_url: `https://github.com/example/fixture/pull/${id}`,
    })),
  );
}

// The worktrees git lists for the workspace's repository: path to HEAD, with
// `detached` noted.
function worktrees(): Map<string, { head: string; detached: boolean }> {
  const list = new Map<string, { head: string; detached: boolean }>();
  for (const block of run(workspace, "worktree", "list", "--porcelain").split("\n\n")) {
    const lines = block.split("\n");
    const where = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length);
    if (where !== undefined && head !== undefined) {
      list.set(where, { head, detached: lines.includes("detached") });
    }
  }
  return list;
}

function componentStatus(): ComponentStatus["status"] | undefined {
  return bench.components.web?.status;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delivery-gate-pin-")));
  workspace = path.join(tmp, "workspace");
  pin = `${workspace}-pin`;
  fs.mkdirSync(workspace);
  run(workspace, "init", "-q", "-b", "main");
  commits = ["one", "two", "three"].map(commitBuild);
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  // A, B and C on one stack at the first three commits; the gate after B runs
  // after A and B, so its commit is B's head.
  recordHead = { A: commits[0], B: commits[1], C: commits[2], D: commits[0] };
  gitHead = { ...recordHead };
  writeSpec();

  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: specFolder,
    workspacePath: workspace,
    deliveryDecisionMode: "auto",
    deliveryBindMode: "launch",
    status: "active",
    ports: { web: 5173 },
    components: { web: { name: "web", status: "running", setupComplete: true } },
    notifications: [],
  } as unknown as Bench;
  componentCalls = [];
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(benchManager.stopAllComponents).mockReset();
  vi.mocked(benchManager.stopAllComponents).mockImplementation(async () => {
    componentCalls.push(`stop ${specbenchVariantHost.componentRoot(bench)}`);
    bench.components.web.status = "stopped";
  });
  vi.mocked(benchManager.startAllComponents).mockReset();
  vi.mocked(benchManager.startAllComponents).mockImplementation(() => {
    componentCalls.push(`start ${specbenchVariantHost.componentRoot(bench)}`);
    bench.components.web.status = "running";
    return bench;
  });
  vi.mocked(stateService.updateBench).mockClear();
  vi.mocked(resolveGitIdentity).mockResolvedValue({
    name: "Ada Operator",
    email: "ada@example.test",
  });
  setDeliveryCrossCheckDeps({
    readGit: async () => gitObservation(),
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

async function crossCheckClasses(): Promise<string[]> {
  const res = await request(app).get(`${base}/crosscheck`);
  expect(res.status).toBe(200);
  return (res.body.disagreements as { class: string }[]).map((d) => d.class);
}

async function openSitting(): Promise<request.Response> {
  expect(await crossCheckClasses()).toEqual([]);
  return request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
}

describe("the gate pin of a sitting", () => {
  it("SB-TC-059 opening a sitting pins a detached worktree at the gate commit on the bench ports", async () => {
    // Step 1: the sitting opens, and the components restart from the pin.
    const res = await openSitting();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      gateId: "gate-after-b",
      openedAt: expect.any(String) as unknown as string,
      commit: commits[1],
      state: "open",
      resultsSpecPath: specFolder,
    });
    expect(componentCalls).toEqual([`stop ${workspace}`, `start ${pin}`]);
    expect(componentStatus()).toBe("running");
    expect(bench.ports).toEqual({ web: 5173 });

    // Step 2: git lists a detached worktree at the gate commit.
    expect(worktrees().get(pin)).toEqual({ head: commits[1], detached: true });

    // Step 3: the bench record holds the pin and the sitting, persisted.
    expect(bench.gatePin).toEqual({
      gateId: "gate-after-b",
      workspacePath: pin,
      commit: commits[1],
      createdAt: res.body.openedAt as string,
    });
    expect(bench.deliverySitting).toEqual(res.body);
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.objectContaining({ gatePin: bench.gatePin, deliverySitting: res.body }),
    );

    // Step 4: what the components serve is the pinned commit's build.
    expect(specbenchVariantHost.componentRoot(bench)).toBe(pin);
    expect(fs.readFileSync(path.join(pin, "build.txt"), "utf8")).toBe("two\n");
    expect(fs.readFileSync(path.join(workspace, "build.txt"), "utf8")).toBe("three\n");
  });

  it("SB-TC-060 closing a sitting removes the pin and restores the live build", async () => {
    expect((await openSitting()).status).toBe(201);
    componentCalls = [];

    const res = await request(app).delete(`${base}/sittings/current`);
    expect(res.status).toBe(204);
    expect(fs.existsSync(pin)).toBe(false);
    expect(worktrees().has(pin)).toBe(false);
    expect(bench.gatePin).toBeUndefined();
    expect(bench.deliverySitting).toBeUndefined();
    const persisted = vi.mocked(stateService.updateBench).mock.lastCall?.[0];
    expect(persisted).not.toHaveProperty("gatePin");
    expect(persisted).not.toHaveProperty("deliverySitting");
    expect(componentCalls).toEqual([`stop ${pin}`, `start ${workspace}`]);
    expect(specbenchVariantHost.componentRoot(bench)).toBe(workspace);

    // A second close finds no sitting.
    const again = await request(app).delete(`${base}/sittings/current`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("SITTING_NOT_FOUND");
  });

  it("SB-TC-061 the pin holds its commit across a stack rebase", async () => {
    // Step 1: a sitting opens, then the stack head moves two commits on.
    expect((await openSitting()).status).toBe(201);
    commits.push(commitBuild("four"), commitBuild("five"));
    gitHead = { ...gitHead, B: commits[4] };

    // Step 2: the build served is still the pinned commit.
    expect(specbenchVariantHost.componentRoot(bench)).toBe(pin);
    expect(fs.readFileSync(path.join(pin, "build.txt"), "utf8")).toBe("two\n");
    expect(worktrees().get(pin)).toEqual({ head: commits[1], detached: true });

    // Step 3: the cross-check may list head-commit-differs, and the sitting
    // stays open.
    forgetDeliveryCrossCheck();
    expect(await crossCheckClasses()).toContain("head-commit-differs");
    expect(bench.deliverySitting).toMatchObject({ gateId: "gate-after-b", state: "open" });
    expect(bench.gatePin?.commit).toBe(commits[1]);

    // Step 4: reconcile after a restart verifies the pin.
    expect(specbenchVariantHost.verifyVariantState(bench)).toEqual({ ok: true });
  });

  it("SB-TC-066 opening a sitting at an unknown commit is refused", async () => {
    const unknown = "f".repeat(40);
    recordHead = { ...recordHead, B: unknown };
    gitHead = { ...gitHead, B: unknown };
    writeSpec();

    const res = await openSitting();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("GATE_COMMIT_UNKNOWN");
    expect(res.body.error).toContain(unknown);
    expect(res.body.error).toMatch(/unknown/);
    expect(fs.existsSync(pin)).toBe(false);
    expect([...worktrees().keys()]).toEqual([workspace]);
    expect(benchManager.stopAllComponents).not.toHaveBeenCalled();
    expect(benchManager.startAllComponents).not.toHaveBeenCalled();
    expect(componentStatus()).toBe("running");
    expect(specbenchVariantHost.componentRoot(bench)).toBe(workspace);
    expect(bench.gatePin).toBeUndefined();
    expect(bench.deliverySitting).toBeUndefined();
  });

  it("answers 409 GATE_COMMIT_MISSING when the gate's top unit has no head", async () => {
    const withoutHead = record() as { units: { id: string; head?: string }[] };
    for (const unit of withoutHead.units) if (unit.id === "B") delete unit.head;
    fs.writeFileSync(
      path.join(specFolder, "delivery-observation.json"),
      `${JSON.stringify(withoutHead, null, 2)}\n`,
    );
    const res = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "GATE_COMMIT_MISSING", gateId: "gate-after-b" });
    expect(fs.existsSync(pin)).toBe(false);
  });

  it("keeps the components stopped across the pin when none ran", async () => {
    bench.components.web.status = "stopped";
    expect((await openSitting()).status).toBe(201);
    expect(componentCalls).toEqual([]);
    expect(worktrees().get(pin)?.head).toBe(commits[1]);
  });
});
