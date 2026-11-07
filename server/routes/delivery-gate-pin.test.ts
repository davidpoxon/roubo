// The gate pin of a sitting (SB-FR-024, SB-NFR-006, SB-US-009): POST
// /delivery/sittings stops the bench components, adds a detached worktree at
// the gate commit beside the workspace, prepares it (submodules, benches.setup,
// the components' one-time setup), records gatePin, restarts the components
// that ran from the pin, waits for them, smoke-checks the build they serve, and
// only then records deliverySitting and answers; DELETE
// /delivery/sittings/current reverses it; a gate commit git does not know is
// refused before anything moves.
//
// The workspace is a real git repository, so every worktree here is one git
// made, and benches.setup and the submodule update run for real in the pin.
// Only the component stop and start of the bench manager are faked: a start
// notes the component root it ran at and puts the component on a local HTTP
// server that serves the `build.txt` of that root, so the smoke check probes a
// real URL.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench, ComponentStatus, RegisteredProject, RouboConfig } from "@roubo/shared";
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

vi.mock("../services/bench-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/bench-manager.js")>();
  return {
    getBench: vi.fn(),
    isBenchLive: vi.fn(() => true),
    whenWorkspaceProvisioned: vi.fn(async () => undefined),
    stopAllComponents: vi.fn(),
    startComponentsAndWait: vi.fn(),
    // The preparation of the pin runs for real.
    componentHasSetup: actual.componentHasSetup,
    runBenchSetupCommand: actual.runBenchSetupCommand,
    updateWorkspaceSubmodules: actual.updateWorkspaceSubmodules,
  };
});
vi.mock("../services/project-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/project-registry.js")>()),
  getProject: vi.fn(),
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
import * as projectRegistry from "../services/project-registry.js";
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
// The marker benches.setup writes in the directory it runs in.
const SETUP_MARKER = ".bench-setup-ran";

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
let config: RouboConfig;
let app: express.Express;
// The head each unit's record entry names, and the one git reports for its
// branch to the cross-check.
let recordHead: Record<UnitId, string>;
let gitHead: Record<UnitId, string>;
// The commits of the workspace, oldest first.
let commits: string[];
// The component root each faked start and stop ran at, in order.
let componentCalls: string[];
// The component names each faked start was asked for.
let startedNames: string[][];
// The one-time setup flag of each component as a faked start found it.
let setupAtStart: Record<string, boolean>[];
// Whether the setup marker was in the root a faked start ran at.
let setupRanBeforeStart: boolean[];
// How a faked start ends, and what the build server answers.
let startOutcome: "running" | "error";
let serverStatus: number;
// A faked start waits for this, when set, after it noted its call.
let holdStart: Promise<void> | undefined;
let startEntered: (() => void) | undefined;
let server: http.Server;
let serverUrl: string;
const base = "/api/projects/demo/benches/1/delivery";

function run(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

// Writes `build.txt` with `content` in `cwd` and commits it, returning the commit.
function commitBuild(content: string, cwd = workspace): string {
  fs.writeFileSync(path.join(cwd, "build.txt"), `${content}\n`);
  run(cwd, "add", "build.txt");
  run(cwd, "commit", "-q", "-m", content);
  return run(cwd, "rev-parse", "HEAD");
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

function makeConfig(overrides: Partial<RouboConfig> = {}): RouboConfig {
  return {
    project: { name: "fixture", displayName: "Fixture", repo: "example/fixture" },
    layout: { type: "single-repo" },
    components: {
      web: { plugin: { id: "process" }, config: { command: "npm start", setup: "npm install" } },
      worker: { plugin: { id: "process" }, config: { command: "npm run worker" } },
    },
    ports: { web: { base: 5173 } },
    benches: { max: 5, setup: `printf ran > ${SETUP_MARKER}`, shell: true },
    ...overrides,
  } as unknown as RouboConfig;
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delivery-gate-pin-")));
  workspace = path.join(tmp, "workspace");
  pin = `${workspace}-pin`;
  fs.mkdirSync(workspace);
  run(workspace, "init", "-q", "-b", "main");
  commits = ["one", "two", "three"].map((content) => commitBuild(content));
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
    components: {
      web: { name: "web", status: "running", setupComplete: true },
      worker: { name: "worker", status: "stopped", setupComplete: true },
    },
    notifications: [],
  } as unknown as Bench;
  config = makeConfig();
  vi.mocked(projectRegistry.getProject).mockImplementation((projectId) =>
    projectId === bench.projectId
      ? ({ id: "demo", repoPath: workspace, config } as unknown as RegisteredProject)
      : undefined,
  );

  // The build server: serves the build.txt of the bench's component root.
  serverStatus = 200;
  server = http.createServer((_req, res) => {
    const root = specbenchVariantHost.componentRoot(bench);
    res.statusCode = serverStatus;
    res.end(fs.readFileSync(path.join(root, "build.txt"), "utf8"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  componentCalls = [];
  startedNames = [];
  setupAtStart = [];
  setupRanBeforeStart = [];
  startOutcome = "running";
  holdStart = undefined;
  startEntered = undefined;
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(benchManager.stopAllComponents).mockReset();
  vi.mocked(benchManager.stopAllComponents).mockImplementation(async () => {
    componentCalls.push(`stop ${specbenchVariantHost.componentRoot(bench)}`);
    for (const status of Object.values(bench.components)) status.status = "stopped";
  });
  vi.mocked(benchManager.startComponentsAndWait).mockReset();
  vi.mocked(benchManager.startComponentsAndWait).mockImplementation(async (_p, _b, names) => {
    const root = specbenchVariantHost.componentRoot(bench);
    componentCalls.push(`start ${root}`);
    startedNames.push([...names]);
    setupRanBeforeStart.push(fs.existsSync(path.join(root, SETUP_MARKER)));
    setupAtStart.push(
      Object.fromEntries(names.map((name) => [name, bench.components[name].setupComplete])),
    );
    startEntered?.();
    if (holdStart !== undefined) await holdStart;
    for (const name of names) {
      const status = bench.components[name];
      if (startOutcome === "error") {
        status.status = "error";
        status.error = "exit code 1";
      } else {
        status.status = "running";
        status.error = undefined;
        status.url = serverUrl;
        status.setupComplete = true;
      }
    }
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

afterEach(async () => {
  forgetDeliveryCrossCheck();
  setDeliveryCrossCheckDeps();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.chmodSync(tmp, 0o755);
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

// The state of a refused open: no pin, no records, the workspace serving.
function expectNoPin(): void {
  expect(fs.existsSync(pin)).toBe(false);
  expect([...worktrees().keys()]).toEqual([workspace]);
  expect(bench.gatePin).toBeUndefined();
  expect(bench.deliverySitting).toBeUndefined();
  expect(specbenchVariantHost.componentRoot(bench)).toBe(workspace);
}

describe("the gate pin of a sitting", () => {
  it("SB-TC-059 opening a sitting pins a detached worktree at the gate commit on the bench ports", async () => {
    // Step 1: the sitting opens, and the components that ran restart from the
    // pin, after benches.setup ran there and with their one-time setup to run.
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
    expect(startedNames).toEqual([["web"]]);
    expect(setupRanBeforeStart).toEqual([true]);
    expect(setupAtStart).toEqual([{ web: false }]);
    expect(fs.existsSync(path.join(workspace, SETUP_MARKER))).toBe(false);
    expect(componentStatus()).toBe("running");
    expect(bench.components.worker.status).toBe("stopped");
    expect(bench.ports).toEqual({ web: 5173 });

    // Step 2: git lists a detached worktree at the gate commit.
    expect(worktrees().get(pin)).toEqual({ head: commits[1], detached: true });

    // Step 3: the bench record holds the pin and the sitting, persisted.
    expect(bench.gatePin).toEqual({
      gateId: "gate-after-b",
      workspacePath: pin,
      commit: commits[1],
      workspaceSetupDone: ["web"],
      createdAt: res.body.openedAt as string,
    });
    expect(bench.deliverySitting).toEqual(res.body);
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.objectContaining({ gatePin: bench.gatePin, deliverySitting: res.body }),
    );

    // Step 4: the bench URL serves the pinned commit's build.
    expect(specbenchVariantHost.componentRoot(bench)).toBe(pin);
    const served = await fetch(bench.components.web.url as string);
    expect(await served.text()).toBe("two\n");
    expect(fs.readFileSync(path.join(workspace, "build.txt"), "utf8")).toBe("three\n");
  });

  it("SB-TC-059 answers only after the restarted components settle, and refuses a second open meanwhile with 409 SITTING_BUSY", async () => {
    expect(await crossCheckClasses()).toEqual([]);
    let release!: () => void;
    holdStart = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (startEntered = resolve));
    let answered = false;
    const first = request(app)
      .post(`${base}/sittings`)
      .send({ gateId: "gate-after-b" })
      .then((res) => {
        answered = true;
        return res;
      });
    await entered;

    const second = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("SITTING_BUSY");
    expect(answered).toBe(false);
    expect(bench.deliverySitting).toBeUndefined();

    release();
    const res = await first;
    expect(res.status).toBe(201);
    expect(bench.deliverySitting).toMatchObject({ gateId: "gate-after-b", state: "open" });
    expect(componentCalls).toEqual([`stop ${workspace}`, `start ${pin}`]);
  });

  it("SB-TC-059 refuses with 409 BUILD_NOT_SMOKE_CHECKED when a component does not start from the pin, and serves the workspace again", async () => {
    startOutcome = "error";
    const res = await openSitting();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BUILD_NOT_SMOKE_CHECKED");
    expect(res.body.error).toContain("component 'web' is error");
    expect(componentCalls).toEqual([
      `stop ${workspace}`,
      `start ${pin}`,
      `stop ${pin}`,
      `start ${workspace}`,
    ]);
    expectNoPin();
    // The workspace's setup flag is back: its setup is not run again.
    expect(setupAtStart.at(-1)).toEqual({ web: true });
    expect(stateService.updateBench).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ gatePin: expect.anything() as unknown }),
    );
  });

  it("SB-TC-059 refuses with 409 BUILD_NOT_SMOKE_CHECKED when the pinned build's URL answers 5xx", async () => {
    serverStatus = 503;
    const res = await openSitting();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BUILD_NOT_SMOKE_CHECKED");
    expect(res.body.error).toContain("answered 503");
    expect(componentCalls.at(-1)).toBe(`start ${workspace}`);
    expectNoPin();
  });

  it("SB-TC-059 refuses with 409 BUILD_NOT_SMOKE_CHECKED when benches.setup fails in the pin, before any component starts there", async () => {
    config = makeConfig({
      benches: { max: 5, setup: "echo no-install >&2; exit 3", shell: true },
    } as Partial<RouboConfig>);
    const res = await openSitting();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BUILD_NOT_SMOKE_CHECKED");
    expect(res.body.error).toContain("no-install");
    expect(componentCalls).toEqual([`stop ${workspace}`, `start ${workspace}`]);
    expectNoPin();
  });

  it("SB-TC-059 answers 500 GATE_PIN_FAILED when git cannot add the worktree, and restarts the components from the workspace", async () => {
    expect(await crossCheckClasses()).toEqual([]);
    // The workspaces root takes no new directory, so `worktree add` fails.
    fs.chmodSync(tmp, 0o555);
    let res: request.Response;
    try {
      res = await request(app).post(`${base}/sittings`).send({ gateId: "gate-after-b" });
    } finally {
      fs.chmodSync(tmp, 0o755);
    }
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("GATE_PIN_FAILED");
    expect(res.body.error).toContain(commits[1]);
    expect(componentCalls).toEqual([`stop ${workspace}`, `start ${workspace}`]);
    expectNoPin();
  });

  it("SB-TC-059 answers 409 GATE_PIN_PATH_TAKEN when git cannot remove a leftover at the pin path, with the components untouched", async () => {
    run(workspace, "worktree", "add", "-q", "--detach", pin, commits[0]);
    run(workspace, "worktree", "lock", pin);
    const res = await openSitting();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GATE_PIN_PATH_TAKEN");
    expect(res.body.error).toContain(pin);
    expect(benchManager.stopAllComponents).not.toHaveBeenCalled();
    expect(benchManager.startComponentsAndWait).not.toHaveBeenCalled();
    expect(componentStatus()).toBe("running");
    expect(worktrees().get(pin)?.head).toBe(commits[0]);
    expect(bench.gatePin).toBeUndefined();
    expect(bench.deliverySitting).toBeUndefined();
  });

  it("SB-TC-059 removes a leftover pin worktree before it pins the gate commit", async () => {
    run(workspace, "worktree", "add", "-q", "--detach", pin, commits[0]);
    const res = await openSitting();
    expect(res.status).toBe(201);
    expect(worktrees().get(pin)).toEqual({ head: commits[1], detached: true });
    expect(fs.readFileSync(path.join(pin, "build.txt"), "utf8")).toBe("two\n");
  });

  it("SB-TC-059 pins a meta-repo's submodule commit in that submodule of the pin", async () => {
    // A submodule `app` from its own repository, mapped by the project. The
    // gate commit is a commit of the workspace's `app` that its origin lacks.
    const origin = path.join(tmp, "app-origin");
    fs.mkdirSync(origin);
    run(origin, "init", "-q", "-b", "main");
    commitBuild("app one", origin);
    run(workspace, "submodule", "add", "-q", origin, "app");
    run(workspace, "commit", "-q", "-m", "add app");
    const superCommit = run(workspace, "rev-parse", "HEAD");
    const appCommit = commitBuild("app two", path.join(workspace, "app"));
    recordHead = { ...recordHead, B: appCommit };
    gitHead = { ...recordHead };
    writeSpec();
    config = makeConfig({
      layout: { type: "meta-repo", submodules: { app: "app" } },
    } as Partial<RouboConfig>);
    // The pin's submodule update clones the local origin.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
    try {
      const res = await openSitting();
      expect(res.status).toBe(201);
      expect(res.body.commit).toBe(appCommit);
      expect(bench.gatePin).toMatchObject({
        workspacePath: pin,
        commit: appCommit,
        submodulePath: "app",
      });
      expect(worktrees().get(pin)).toEqual({ head: superCommit, detached: true });
      expect(run(path.join(pin, "app"), "rev-parse", "HEAD")).toBe(appCommit);
      expect(fs.readFileSync(path.join(pin, "app", "build.txt"), "utf8")).toBe("app two\n");
      expect(setupRanBeforeStart).toEqual([true]);
      // Reconcile checks the submodule of the pin against the record.
      expect(await specbenchVariantHost.verifyVariantState(bench)).toEqual({ ok: true });

      const closed = await request(app).delete(`${base}/sittings/current`);
      expect(closed.status).toBe(204);
      expect(fs.existsSync(pin)).toBe(false);
      expect(worktrees().has(pin)).toBe(false);
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  });

  it("SB-TC-060 closing a sitting removes the pin and restores the live build", async () => {
    expect((await openSitting()).status).toBe(201);
    componentCalls = [];
    startedNames = [];

    const res = await request(app).delete(`${base}/sittings/current`);
    expect(res.status).toBe(204);
    expect(fs.existsSync(pin)).toBe(false);
    expect(worktrees().has(pin)).toBe(false);
    expect(bench.gatePin).toBeUndefined();
    expect(bench.deliverySitting).toBeUndefined();
    const persisted = vi.mocked(stateService.updateBench).mock.lastCall?.[0];
    expect(persisted).not.toHaveProperty("gatePin");
    expect(persisted).not.toHaveProperty("deliverySitting");
    // Only the component that ran restarts, from the workspace, with the
    // workspace's own setup flag back.
    expect(componentCalls).toEqual([`stop ${pin}`, `start ${workspace}`]);
    expect(startedNames).toEqual([["web"]]);
    expect(setupAtStart.at(-1)).toEqual({ web: true });
    expect(specbenchVariantHost.componentRoot(bench)).toBe(workspace);
    const served = await fetch(bench.components.web.url as string);
    expect(await served.text()).toBe("three\n");

    // A second close finds no sitting.
    const again = await request(app).delete(`${base}/sittings/current`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("SITTING_NOT_FOUND");
  });

  it("SB-TC-060 closing marks a component's setup pending again when it had not run in the workspace", async () => {
    bench.components.web.setupComplete = false;
    expect((await openSitting()).status).toBe(201);
    expect(bench.gatePin?.workspaceSetupDone).toEqual([]);
    expect(bench.components.web.setupComplete).toBe(true);

    expect((await request(app).delete(`${base}/sittings/current`)).status).toBe(204);
    expect(setupAtStart.at(-1)).toEqual({ web: false });
  });

  it("SB-TC-060 a close that cannot remove the pin answers 500 GATE_PIN_FAILED and keeps the sitting", async () => {
    const opened = await openSitting();
    expect(opened.status).toBe(201);
    run(workspace, "worktree", "lock", pin);
    componentCalls = [];
    vi.mocked(stateService.updateBench).mockClear();

    const res = await request(app).delete(`${base}/sittings/current`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("GATE_PIN_FAILED");
    expect(res.body.error).toContain(pin);
    expect(fs.existsSync(pin)).toBe(true);
    expect(bench.deliverySitting).toEqual(opened.body);
    expect(bench.gatePin).toMatchObject({ workspacePath: pin, commit: commits[1] });
    expect(stateService.updateBench).not.toHaveBeenCalled();
    // The components that ran restart, from the pin the sitting keeps.
    expect(componentCalls).toEqual([`stop ${pin}`, `start ${pin}`]);
    expect(componentStatus()).toBe("running");
  });

  it("SB-TC-061 the pin holds its commit across a stack rebase", async () => {
    // Step 1: a sitting opens, then the stack head moves two commits on.
    expect((await openSitting()).status).toBe(201);
    commits.push(commitBuild("four"), commitBuild("five"));
    gitHead = { ...gitHead, B: commits[4] };

    // Step 2: the build served is still the pinned commit.
    expect(specbenchVariantHost.componentRoot(bench)).toBe(pin);
    const served = await fetch(bench.components.web.url as string);
    expect(await served.text()).toBe("two\n");
    expect(worktrees().get(pin)).toEqual({ head: commits[1], detached: true });

    // Step 3: the cross-check may list head-commit-differs, and the sitting
    // stays open.
    forgetDeliveryCrossCheck();
    expect(await crossCheckClasses()).toContain("head-commit-differs");
    expect(bench.deliverySitting).toMatchObject({ gateId: "gate-after-b", state: "open" });
    expect(bench.gatePin?.commit).toBe(commits[1]);

    // Step 4: reconcile after a restart verifies the pin.
    expect(await specbenchVariantHost.verifyVariantState(bench)).toEqual({ ok: true });
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
    expect(benchManager.stopAllComponents).not.toHaveBeenCalled();
    expect(benchManager.startComponentsAndWait).not.toHaveBeenCalled();
    expect(componentStatus()).toBe("running");
    expectNoPin();
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

  it("SB-TC-059 keeps the components stopped across the pin when none ran, and still prepares the pin", async () => {
    bench.components.web.status = "stopped";
    expect((await openSitting()).status).toBe(201);
    expect(componentCalls).toEqual([]);
    expect(worktrees().get(pin)?.head).toBe(commits[1]);
    expect(fs.existsSync(path.join(pin, SETUP_MARKER))).toBe(true);
    // The pin's own start runs the component's one-time setup there.
    expect(bench.components.web.setupComplete).toBe(false);
  });
});
