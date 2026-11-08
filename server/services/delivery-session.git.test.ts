// A Spec Bench's delivery session, its token and its record end to end against
// a real git repository (SB-FR-002, SB-FR-003, SB-FR-009, SB-US-001, SB-US-002).
// The record is read from `.specifications/<slug>/` inside the bench workspace,
// so each test writes it there once the workspace exists, or commits it to the
// project so the worktree checks it out. The record goes with the workspace, and
// the bench never reads or writes the record in the checkout's spec folder.
// The create route, the bench manager, the delivery routes, the token registry
// and the record loader are real; the agent launch executor is a recording
// stand-in, so each test sees exactly the launch requests that reached it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import type { Bench, PersistedBench, RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_VERSION,
} from "@roubo/shared/delivery-observation-contract";
import { makeConfig } from "../test/fixtures.js";

const hoisted = vi.hoisted(() => ({
  project: undefined as RegisteredProject | undefined,
  workspaces: "",
  persisted: [] as PersistedBench[],
  // The terminal sessions that are live; any other session id reads as ended.
  liveSessions: new Set<string>(),
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    loadState: vi.fn(() => ({ benches: hoisted.persisted })),
    addBench: vi.fn(),
    updateBench: vi.fn(),
    removeBench: vi.fn(),
    getPersistedBenches: vi.fn(() => []),
    loadSettings: vi.fn(() => ({ benches: {} })),
    getProjectPermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
    setProjectPermissions: vi.fn(),
    getProjectWorkspacesDir: vi.fn(() => hoisted.workspaces),
    getWorkspacePath: vi.fn((_name: string, n: number) =>
      path.join(hoisted.workspaces, `bench-${n}`),
    ),
  };
});
vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(() => hoisted.project),
  getProjects: vi.fn(() => (hoisted.project ? [hoisted.project] : [])),
  resolveEnforceIssueDependencies: vi.fn(() => false),
}));
vi.mock("./port-allocator.js", () => ({
  allocatePorts: vi.fn((_c: unknown, n: number) => ({ backend: 5000 + n })),
}));
vi.mock("./plugin-manager.js", () => ({
  getRecord: vi.fn(() => undefined),
  invoke: vi.fn(),
  getComponentManifests: vi.fn(() => []),
}));
vi.mock("./terminal.js", () => ({
  destroyBenchSessions: vi.fn(),
  destroySession: vi.fn(() => true),
  createAgentSession: vi.fn(),
  getSession: vi.fn((id: string) => ({
    id,
    status: hoisted.liveSessions.has(id) ? "live" : "ended",
  })),
}));
vi.mock("./notification.js", () => ({
  createNotification: vi.fn(),
  dismissByKey: vi.fn(() => false),
  getNotifications: vi.fn(() => []),
}));
vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
  broadcastDeliveryFrame: vi.fn(),
  broadcastBenchStatus: vi.fn(),
  broadcastComponentStatusChange: vi.fn(),
  clearComponentStatusForBench: vi.fn(),
}));
vi.mock("./claude-settings-local.js", () => ({ injectPermissions: vi.fn() }));

import * as state from "./state.js";
import * as terminal from "./terminal.js";
import * as notification from "./notification.js";
import * as benchManager from "./bench-manager.js";
import benchesRouter from "../routes/benches.js";
import deliveryRouter from "../routes/delivery.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "../routes/delivery-hooks.js";
import * as sse from "./sse.js";
import { registerSpecbenchVariantHost } from "../lib/specbench-variant-host.js";
import { unregisterVariantHost } from "./variant-host-registry.js";
import {
  resetDeliveryLaunchExecutor,
  setDeliveryLaunchExecutor,
  whenDeliveryBound,
  type DeliveryLaunchRequest,
} from "./delivery-session-launcher.js";
import { hashDeliveryToken } from "./delivery-token-registry.js";
import {
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_EVENT_LOG_MAX,
  DELIVERY_EVENT_SPILL_CHUNK,
  DELIVERY_EVENT_SPILL_FILE,
} from "@roubo/shared/delivery-bench";
import { deliveryAcceptedSeq, forgetDeliveryEventLog } from "./delivery-event-log.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let tmp: string;
let repo: string;
let specFolder: string;
let app: express.Express;
let launches: DeliveryLaunchRequest[];

function fixtureRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as Record<string, unknown>;
}

// The record's place: `.specifications/fixture-spec/` inside the bench workspace.
function workspaceRecordPath(bench: Bench): string {
  return path.join(
    bench.workspacePath,
    ".specifications",
    "fixture-spec",
    "delivery-observation.json",
  );
}

function writeRecord(bench: Bench, record: unknown): void {
  fs.writeFileSync(workspaceRecordPath(bench), `${JSON.stringify(record, null, 2)}\n`);
}

// Places the record in the project's spec folder and commits it, so a bench
// created after this checks it out into its workspace.
function commitRecordToProject(record: unknown): void {
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "record");
}

function event(seq: number, type = "unit.changed"): Record<string, unknown> {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T09:40:00Z",
    unit_id: "C",
    payload: { status: "running" },
  };
}

// The event endpoint of a bench, as its launch descriptor names it.
function eventPath(bench: Bench): string {
  return `/api/hooks/delivery-event?projectId=demo&benchId=${bench.id}`;
}

// Posts one envelope as it is, or a list of them as a batch { events: [...] }.
function postEvents(bench: Bench, token: string | undefined, body: unknown) {
  const req = request(app).post(eventPath(bench));
  if (token !== undefined) req.set("Authorization", `Bearer ${token}`);
  return req.send((Array.isArray(body) ? { events: body } : body) as object);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-delivery-")));
  repo = path.join(tmp, "repo");
  hoisted.workspaces = path.join(tmp, "workspaces");
  hoisted.persisted = [];
  fs.mkdirSync(repo);
  fs.mkdirSync(hoisted.workspaces);

  specFolder = path.join(repo, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), '{"cases":[]}\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");

  hoisted.project = {
    id: "demo",
    repoPath: repo,
    config: makeConfig(),
    configValid: true,
    settings: {
      ...DEFAULT_PROJECT_SETTINGS,
      worktreeSource: { branchFromDefault: false, pullLatest: false },
    },
  } as RegisteredProject;

  launches = [];
  hoisted.liveSessions.clear();
  setDeliveryLaunchExecutor({
    launch: async (req) => {
      launches.push(req);
      const sessionId = `session-${launches.length}`;
      hoisted.liveSessions.add(sessionId);
      return { sessionId };
    },
  });
  vi.mocked(state.updateBench).mockClear();
  vi.mocked(notification.createNotification).mockClear();
  registerSpecbenchVariantHost();
  app = express();
  app.use(express.json());
  app.use("/", benchesRouter);
  app.use("/", deliveryRouter);
  app.use("/api/hooks", deliveryHooksRouter);
  vi.mocked(sse.broadcastDeliveryFrame).mockClear();
});

afterEach(() => {
  benchManager.dropProjectBenches("demo");
  unregisterVariantHost("specbench");
  resetDeliveryLaunchExecutor();
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function createSpecBench(
  mode: "launch" | "attach",
): Promise<{ status: number; bench: Bench }> {
  const res = await request(app).post("/demo/benches").send({
    variant: "specbench",
    focusedSpecPath: ".specifications/fixture-spec",
    delivery: { mode },
  });
  const created = res.body as Bench;
  if (res.status !== 201) return { status: res.status, bench: created };
  await benchManager.whenWorkspaceProvisioned("demo", created.id);
  await whenDeliveryBound("demo", created.id);
  const live = benchManager.getBench("demo", created.id);
  if (!live) throw new Error("bench vanished");
  return { status: res.status, bench: live };
}

function lastPersisted(benchId: number): PersistedBench | undefined {
  const calls = vi.mocked(state.updateBench).mock.calls.filter(([b]) => b.id === benchId);
  return calls.at(-1)?.[0];
}

async function cleared(projectId: string, benchId: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!benchManager.getBench(projectId, benchId)) return;
    const bench = benchManager.getBench(projectId, benchId);
    if (bench?.status === "error") throw new Error(`teardown failed: ${bench.error}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("teardown did not finish");
}

describe("Launch mode", () => {
  it("SB-TC-003: Set up launches the main delivery session with the event endpoint and token", async () => {
    // Step 1: set up in launch mode and capture the descriptor.
    const { status, bench } = await createSpecBench("launch");
    expect(status).toBe(201);
    expect(launches).toHaveLength(1);
    const [launch] = launches;
    const { descriptor } = launch;
    expect(descriptor.eventUrl).toMatch(
      new RegExp(
        `^http://localhost:\\d+/api/hooks/delivery-event\\?projectId=demo&benchId=${bench.id}$`,
      ),
    );
    expect(descriptor.controlsUrl).toMatch(
      new RegExp(`/api/hooks/delivery-controls\\?projectId=demo&benchId=${bench.id}$`),
    );
    expect(typeof descriptor.token).toBe("string");
    expect(descriptor.token.length).toBeGreaterThanOrEqual(32);
    expect(descriptor).not.toHaveProperty("resume");
    expect(launch.workspacePath).toBe(bench.workspacePath);
    expect(fs.existsSync(launch.workspacePath)).toBe(true);
    expect(launch.specSlug).toBe("fixture-spec");
    expect(terminal.createAgentSession).not.toHaveBeenCalled();
    expect(bench.deliverySessionId).toBe("session-1");

    // Step 2: the persisted bench carries the hash and never the plain token.
    const persisted = lastPersisted(bench.id);
    expect(persisted?.deliveryTokenHash).toBe(hashDeliveryToken(descriptor.token));
    expect(JSON.stringify(persisted)).not.toContain(descriptor.token);
    expect(JSON.stringify(state.toPersistedBench(bench))).not.toContain(descriptor.token);
    expect(JSON.stringify(bench)).not.toContain(descriptor.token);

    // Step 3: one event posted to the descriptor's URL with its token is
    // accepted, once the session has written the record (last_event_seq 7).
    writeRecord(bench, fixtureRecord());
    const url = new URL(descriptor.eventUrl);
    const posted = await request(app)
      .post(`${url.pathname}${url.search}`)
      .set("Authorization", `Bearer ${descriptor.token}`)
      .send(event(8));
    expect(posted.status).toBe(202);
    expect(posted.body).toEqual({ acceptedSeq: 8 });
  });

  it("refuses an event without the token, with another token, or with a malformed body", async () => {
    const { bench } = await createSpecBench("launch");

    const bare = await postEvents(bench, undefined, event(8));
    expect(bare.status).toBe(401);
    const other = await postEvents(bench, "not-the-token", event(8));
    expect(other.status).toBe(401);

    const token = launches[0].descriptor.token;
    const malformed = await postEvents(bench, token, { ...event(8), seq: 0 });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_EVENT");
    expect(malformed.body.error).toMatch(/seq/);
  });

  it("revokes the delivery token when the bench is cleared", async () => {
    const { bench } = await createSpecBench("launch");
    const token = launches[0].descriptor.token;
    expect(bench.deliveryTokenHash).toBeDefined();

    benchManager.teardownBench("demo", bench.id, true);
    await cleared("demo", bench.id);

    expect(bench.deliveryTokenHash).toBeUndefined();
    const persisted = lastPersisted(bench.id);
    expect(persisted).toBeDefined();
    expect(persisted).not.toHaveProperty("deliveryTokenHash");
    expect(JSON.stringify(persisted)).not.toContain(token);
  });
});

describe("Attach mode", () => {
  it("SB-TC-004: Attach adopts an existing delivery record without launching a session", async () => {
    // Step 1: the record is committed to the project's spec folder, so the
    // bench workspace checks it out; attach answers 201 and launches nothing.
    commitRecordToProject(fixtureRecord());
    const { status, bench } = await createSpecBench("attach");
    expect(fs.existsSync(workspaceRecordPath(bench))).toBe(true);
    expect(status).toBe(201);
    expect(bench.deliveryBindMode).toBe("attach");
    expect(launches).toHaveLength(0);
    expect(terminal.createAgentSession).not.toHaveBeenCalled();

    // Step 2: the snapshot reflects the record.
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(200);
    expect(Object.keys(read.body.unitsById).sort()).toEqual(["A", "B", "C", "D"]);
    expect(read.body.stacks).toEqual({ A: ["A", "B", "C"], D: ["D"] });
    expect(Object.keys(read.body.gatesById).sort()).toEqual(["gate-after-b", "gate-after-c"]);
    expect(Object.keys(read.body.decisionsById).sort()).toEqual(["decision-1", "decision-2"]);
    expect(read.body.budget).toEqual({ estimate_usd: 3.2, soft_budget_usd: 5, spent_usd: 0.42 });
    expect(read.body.lifecycle).toMatchObject({ state: "running", armed: true });

    // Step 3: resume launches with the record's resume argument, on a token
    // that replaces the one the attach handout gave out.
    const handout = await request(app).post(`/demo/benches/${bench.id}/delivery/attach`).send({});
    expect(handout.status).toBe(201);
    const hashBefore = bench.deliveryTokenHash;
    expect(hashBefore).toMatch(/^[0-9a-f]{64}$/);
    const resumed = await request(app).post(`/demo/benches/${bench.id}/delivery/resume`).send({});
    expect(resumed.status).toBe(202);
    expect(launches).toHaveLength(1);
    expect(launches[0].descriptor.resume).toBe("demo-delivery-1");
    expect(launches[0].workspacePath).toBe(bench.workspacePath);
    // Resume mints a fresh token.
    expect(bench.deliveryTokenHash).toBe(hashDeliveryToken(launches[0].descriptor.token));
    expect(bench.deliveryTokenHash).not.toBe(hashBefore);
  });

  it("the attach handout gives the attached session a token it can post events with, and launches nothing", async () => {
    const { bench } = await createSpecBench("attach");
    writeRecord(bench, fixtureRecord());
    // Nothing is minted until the handout: no one would hold the token.
    expect(bench.deliveryTokenHash).toBeUndefined();

    const handout = await request(app).post(`/demo/benches/${bench.id}/delivery/attach`).send({});
    expect(handout.status).toBe(201);
    expect(handout.headers["cache-control"]).toBe("no-store");
    expect(handout.body.eventUrl).toMatch(
      new RegExp(`/api/hooks/delivery-event\\?projectId=demo&benchId=${bench.id}$`),
    );
    expect(handout.body.controlsUrl).toMatch(/\/api\/hooks\/delivery-controls\?/);
    expect(handout.body).not.toHaveProperty("resume");
    const token = handout.body.token as string;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(launches).toHaveLength(0);

    // Only the hash is on the bench and in its persisted record.
    expect(bench.deliveryTokenHash).toBe(hashDeliveryToken(token));
    expect(JSON.stringify(lastPersisted(bench.id))).not.toContain(token);
    expect(JSON.stringify(bench)).not.toContain(token);

    const posted = await postEvents(bench, token, event(8));
    expect(posted.status).toBe(202);
  });

  it("reads the committed record in the workspace and leaves a newer uncommitted checkout record untouched on Clear bench", async () => {
    // A is committed; the checkout then holds B, uncommitted.
    const committed = fixtureRecord();
    commitRecordToProject(committed);
    const committedText = `${JSON.stringify(committed, null, 2)}\n`;
    const edited = fixtureRecord();
    (edited.budget as Record<string, unknown>).estimate_usd = 9.9;
    const editedText = `${JSON.stringify(edited, null, 2)}\n`;
    const checkoutRecord = path.join(specFolder, "delivery-observation.json");
    fs.writeFileSync(checkoutRecord, editedText);

    const { status, bench } = await createSpecBench("attach");
    expect(status).toBe(201);
    expect(fs.readFileSync(workspaceRecordPath(bench), "utf8")).toBe(committedText);
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(200);
    expect(read.body.budget.estimate_usd).toBe(3.2);

    benchManager.teardownBench("demo", bench.id, true);
    await cleared("demo", bench.id);

    expect(fs.existsSync(bench.workspacePath)).toBe(false);
    expect(fs.readFileSync(checkoutRecord, "utf8")).toBe(editedText);
  });

  it("refuses resume while the record does not conform, and launches nothing", async () => {
    const record = fixtureRecord();
    delete record.budget;
    const { bench } = await createSpecBench("attach");
    writeRecord(bench, record);

    const resumed = await request(app).post(`/demo/benches/${bench.id}/delivery/resume`).send({});
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "budget" });
    expect(launches).toHaveLength(0);
  });
});

describe("One delivery session per bench", () => {
  it("answers 409 DELIVERY_SESSION_LIVE to a resume while the launched session still runs", async () => {
    const { bench } = await createSpecBench("launch");
    writeRecord(bench, fixtureRecord());
    expect(launches).toHaveLength(1);
    const token = launches[0].descriptor.token;
    const hashBefore = bench.deliveryTokenHash;

    const resumed = await request(app).post(`/demo/benches/${bench.id}/delivery/resume`).send({});
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ code: "DELIVERY_SESSION_LIVE", sessionId: "session-1" });
    // No second session, and the running session keeps its token.
    expect(launches).toHaveLength(1);
    expect(bench.deliveryTokenHash).toBe(hashBefore);
    const posted = await postEvents(bench, token, event(8));
    expect(posted.status).toBe(202);
  });

  it("resumes once the launched session has ended, and records the new session", async () => {
    const { bench } = await createSpecBench("launch");
    writeRecord(bench, fixtureRecord());
    hoisted.liveSessions.delete("session-1");

    const resumed = await request(app).post(`/demo/benches/${bench.id}/delivery/resume`).send({});
    expect(resumed.status).toBe(202);
    expect(resumed.body).toMatchObject({ resume: "demo-delivery-1", sessionId: "session-2" });
    expect(launches).toHaveLength(2);
    expect(bench.deliverySessionId).toBe("session-2");
  });

  it("launches one session when two resumes arrive together", async () => {
    const { bench } = await createSpecBench("attach");
    writeRecord(bench, fixtureRecord());
    const url = `/demo/benches/${bench.id}/delivery/resume`;

    const answers = await Promise.all([
      request(app).post(url).send({}),
      request(app).post(url).send({}),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([202, 409]);
    expect(launches).toHaveLength(1);
  });

  it.each(["clearing", "error"] as const)(
    "answers 409 BENCH_UNAVAILABLE to a resume while the bench is %s, and mints nothing",
    async (status) => {
      const { bench } = await createSpecBench("attach");
      writeRecord(bench, fixtureRecord());
      bench.status = status;

      const resumed = await request(app).post(`/demo/benches/${bench.id}/delivery/resume`).send({});
      expect(resumed.status).toBe(409);
      expect(resumed.body).toMatchObject({ code: "BENCH_UNAVAILABLE", status });
      expect(launches).toHaveLength(0);
      expect(bench.deliveryTokenHash).toBeUndefined();
    },
  );

  it("refuses the attach handout while the launched session runs or the bench is clearing", async () => {
    const { bench } = await createSpecBench("launch");
    const hashBefore = bench.deliveryTokenHash;

    const live = await request(app).post(`/demo/benches/${bench.id}/delivery/attach`).send({});
    expect(live.status).toBe(409);
    expect(live.body.code).toBe("DELIVERY_SESSION_LIVE");
    expect(live.body).not.toHaveProperty("token");

    hoisted.liveSessions.clear();
    const statusBefore = bench.status;
    bench.status = "clearing";
    const clearing = await request(app).post(`/demo/benches/${bench.id}/delivery/attach`).send({});
    expect(clearing.status).toBe(409);
    expect(clearing.body).toMatchObject({ code: "BENCH_UNAVAILABLE", status: "clearing" });
    expect(bench.deliveryTokenHash).toBe(hashBefore);
    bench.status = statusBefore;
  });
});

describe("Record loading", () => {
  it("SB-TC-015: A record missing a required section gives 409 DELIVERY_NONCONFORMANT naming the section, and conforms again once restored", async () => {
    // Step 1: remove the budget section and load the bench.
    const record = fixtureRecord();
    delete record.budget;
    const { bench } = await createSpecBench("attach");
    writeRecord(bench, record);

    // Step 2: the read is a 409 naming the section.
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(409);
    expect(read.body.code).toBe("DELIVERY_NONCONFORMANT");
    expect(read.body.section).toBe("budget");
    expect(read.body.error).toMatch(/budget/);

    // Step 4: restore the section and read again.
    writeRecord(bench, fixtureRecord());
    const restored = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(restored.status).toBe(200);
    expect(restored.body.budget.estimate_usd).toBe(3.2);
  });

  it("SB-TC-016: An invalid record is rejected on load with a named error", async () => {
    // Step 1: units as an object.
    const record = fixtureRecord();
    record.units = { A: (record.units as unknown[])[0] };
    const { bench } = await createSpecBench("attach");
    writeRecord(bench, record);

    const invalid = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe("DELIVERY_INVALID");
    expect(invalid.body.field).toBe("units");
    expect(invalid.body.error).toMatch(/units/);

    // Step 2: an unknown contract major version.
    writeRecord(bench, {
      ...fixtureRecord(),
      $schema: "https://roubo.dev/schema/delivery-record/v2.0.0.json",
      schemaVersion: "2.0.0",
    });
    const mismatch = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("DELIVERY_VERSION_MISMATCH");
    expect(mismatch.body.found).toBe("2.0.0");
    expect(mismatch.body.supported).toBe(DELIVERY_RECORD_SCHEMA_VERSION);
    expect(mismatch.body.error).toMatch(/2\.0\.0/);
  });

  it("validates the record again after a restart, and the persisted token still works", async () => {
    const { bench } = await createSpecBench("launch");
    writeRecord(bench, fixtureRecord());
    const token = launches[0].descriptor.token;

    // The restart: the bench comes back from its persisted record only.
    hoisted.persisted = [state.toPersistedBench(bench)];
    benchManager.dropProjectBenches("demo");
    benchManager.initialize();
    expect(benchManager.getBench("demo", bench.id)?.deliveryTokenHash).toBe(
      hashDeliveryToken(token),
    );

    const record = fixtureRecord();
    delete record.lifecycle;
    writeRecord(bench, record);
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(409);
    expect(read.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "lifecycle" });

    // The token still opens the endpoint, but no seq can be checked against a
    // record that does not conform, so the event waits for the record.
    const waiting = await postEvents(bench, token, event(8));
    expect(waiting.status).toBe(409);
    expect(waiting.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "lifecycle" });

    writeRecord(bench, fixtureRecord());
    const posted = await postEvents(bench, token, event(8));
    expect(posted.status).toBe(202);
    expect(posted.body).toEqual({ acceptedSeq: 8 });
  });

  it("reads the record from the bench workspace, not from the spec folder of the project checkout", async () => {
    const { bench } = await createSpecBench("attach");
    // A record written to the checkout after the workspace exists never reaches it.
    fs.writeFileSync(
      path.join(specFolder, "delivery-observation.json"),
      `${JSON.stringify(fixtureRecord(), null, 2)}\n`,
    );
    const missing = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("DELIVERY_RECORD_MISSING");

    writeRecord(bench, fixtureRecord());
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(200);
    expect(read.body.budget.estimate_usd).toBe(3.2);
  });

  it("answers 409 DELIVERY_RECORD_MISSING before the session writes a record", async () => {
    const { bench } = await createSpecBench("launch");
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(409);
    expect(read.body.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("answers 404 for a bench that is not a Spec Bench", async () => {
    const plain = await request(app).post("/demo/benches").send({});
    expect(plain.status).toBe(201);
    await benchManager.whenWorkspaceProvisioned("demo", plain.body.id);

    const read = await request(app).get(`/demo/benches/${plain.body.id}/delivery`);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe("NOT_SPEC_BENCH");
    expect((await request(app).get("/demo/benches/99/delivery")).status).toBe(404);
    expect(launches).toHaveLength(0);
  });
});

describe("Launching again without a record", () => {
  function failFirstLaunch(): void {
    let calls = 0;
    setDeliveryLaunchExecutor({
      launch: async (req) => {
        calls += 1;
        if (calls === 1) throw new Error("no agent plugin is installed");
        launches.push(req);
        const sessionId = `session-${launches.length}`;
        hoisted.liveSessions.add(sessionId);
        return { sessionId };
      },
    });
  }

  it("launches a launch-mode bench whose create-time launch failed, with no resume argument", async () => {
    failFirstLaunch();
    const { bench } = await createSpecBench("launch");
    expect(launches).toHaveLength(0);
    expect(notification.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: bench.id }),
      "agent-launch-failed",
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/no agent plugin/) }),
    );
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.body.code).toBe("DELIVERY_RECORD_MISSING");

    const launched = await request(app).post(`/demo/benches/${bench.id}/delivery/launch`).send({});
    expect(launched.status).toBe(202);
    expect(launched.body).toEqual({ sessionId: "session-1" });
    expect(launches).toHaveLength(1);
    expect(launches[0].descriptor).not.toHaveProperty("resume");
    expect(launches[0].workspacePath).toBe(bench.workspacePath);
    expect(bench.deliverySessionId).toBe("session-1");
    expect(bench.deliveryTokenHash).toBe(hashDeliveryToken(launches[0].descriptor.token));
  });

  it("refuses a launch while the launched session runs, once a record exists, and on an attached bench", async () => {
    const { bench } = await createSpecBench("launch");
    expect(launches).toHaveLength(1);
    const url = `/demo/benches/${bench.id}/delivery/launch`;

    const live = await request(app).post(url).send({});
    expect(live.status).toBe(409);
    expect(live.body).toMatchObject({ code: "DELIVERY_SESSION_LIVE", sessionId: "session-1" });

    hoisted.liveSessions.clear();
    writeRecord(bench, fixtureRecord());
    const present = await request(app).post(url).send({});
    expect(present.status).toBe(409);
    expect(present.body.code).toBe("DELIVERY_RECORD_PRESENT");

    const record = fixtureRecord();
    delete record.budget;
    writeRecord(bench, record);
    const nonconformant = await request(app).post(url).send({});
    expect(nonconformant.status).toBe(409);
    expect(nonconformant.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "budget" });

    const { bench: attached } = await createSpecBench("attach");
    const refused = await request(app)
      .post(`/demo/benches/${attached.id}/delivery/launch`)
      .send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("DELIVERY_NOT_LAUNCH_MODE");
    expect(launches).toHaveLength(1);
  });

  it("launches the session again once Cleanup & Retry re-provisions a launch-mode bench", async () => {
    const { bench } = await createSpecBench("launch");
    expect(launches).toHaveLength(1);
    // The bench ends in error, and its session with it.
    hoisted.liveSessions.clear();
    bench.status = "error";
    bench.error = "provisioning failed";

    const retried = await request(app).post(`/demo/benches/${bench.id}/cleanup-and-retry`).send({});
    expect(retried.status).toBe(200);
    await benchManager.whenWorkspaceProvisioned("demo", bench.id);
    await whenDeliveryBound("demo", bench.id);

    const live = benchManager.getBench("demo", bench.id);
    expect(live?.status).not.toBe("error");
    expect(launches).toHaveLength(2);
    expect(launches[1].descriptor).not.toHaveProperty("resume");
    expect(live?.deliverySessionId).toBe("session-2");
    expect(live?.deliveryTokenHash).toBe(hashDeliveryToken(launches[1].descriptor.token));
  });

  it("removes the record with the workspace on Cleanup & Retry, never copies it into the checkout, and launches with no resume argument", async () => {
    const { bench } = await createSpecBench("launch");
    expect(launches).toHaveLength(1);
    // The session wrote its record in the workspace, then the bench ended in error.
    writeRecord(bench, fixtureRecord());
    hoisted.liveSessions.clear();
    bench.status = "error";
    bench.error = "provisioning failed";

    const retried = await request(app).post(`/demo/benches/${bench.id}/cleanup-and-retry`).send({});
    expect(retried.status).toBe(200);
    await benchManager.whenWorkspaceProvisioned("demo", bench.id);
    await whenDeliveryBound("demo", bench.id);

    expect(fs.existsSync(path.join(specFolder, "delivery-observation.json"))).toBe(false);
    const live = benchManager.getBench("demo", bench.id);
    if (!live) throw new Error("bench vanished");
    expect(fs.existsSync(workspaceRecordPath(live))).toBe(false);
    expect(launches).toHaveLength(2);
    expect(launches[1].descriptor).not.toHaveProperty("resume");
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(409);
    expect(read.body.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("launches nothing after Cleanup & Retry of an attached bench", async () => {
    const { bench } = await createSpecBench("attach");
    bench.status = "error";
    bench.error = "provisioning failed";

    const retried = await request(app).post(`/demo/benches/${bench.id}/cleanup-and-retry`).send({});
    expect(retried.status).toBe(200);
    await benchManager.whenWorkspaceProvisioned("demo", bench.id);
    await whenDeliveryBound("demo", bench.id);
    expect(launches).toHaveLength(0);
  });

  it("checks the committed record out again on Cleanup & Retry of an attached bench and leaves a newer uncommitted checkout record untouched", async () => {
    // A is committed; the checkout then holds B, uncommitted.
    const committed = fixtureRecord();
    commitRecordToProject(committed);
    const committedText = `${JSON.stringify(committed, null, 2)}\n`;
    const edited = fixtureRecord();
    (edited.budget as Record<string, unknown>).estimate_usd = 9.9;
    const editedText = `${JSON.stringify(edited, null, 2)}\n`;
    const checkoutRecord = path.join(specFolder, "delivery-observation.json");
    fs.writeFileSync(checkoutRecord, editedText);

    const { bench } = await createSpecBench("attach");
    bench.status = "error";
    bench.error = "provisioning failed";

    const retried = await request(app).post(`/demo/benches/${bench.id}/cleanup-and-retry`).send({});
    expect(retried.status).toBe(200);
    await benchManager.whenWorkspaceProvisioned("demo", bench.id);
    await whenDeliveryBound("demo", bench.id);

    const live = benchManager.getBench("demo", bench.id);
    if (!live) throw new Error("bench vanished");
    expect(fs.readFileSync(workspaceRecordPath(live), "utf8")).toBe(committedText);
    expect(fs.readFileSync(checkoutRecord, "utf8")).toBe(editedText);
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(200);
    expect(read.body.budget.estimate_usd).toBe(3.2);
    expect(launches).toHaveLength(0);
  });
});

describe("Event ingest", () => {
  // A launch-mode bench whose session has written the record, and its token.
  async function benchWithRecord(lastEventSeq = 7): Promise<{ bench: Bench; token: string }> {
    const { bench } = await createSpecBench("launch");
    writeRecord(bench, { ...fixtureRecord(), last_event_seq: lastEventSeq });
    const token = launches.at(-1)?.descriptor.token;
    if (token === undefined) throw new Error("no launch");
    return { bench, token };
  }

  async function snapshotSeq(bench: Bench): Promise<number> {
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.status).toBe(200);
    return read.body.seq as number;
  }

  function restartServer(bench: Bench): void {
    hoisted.persisted = [state.toPersistedBench(bench)];
    benchManager.dropProjectBenches("demo");
    forgetDeliveryEventLog();
    benchManager.initialize();
  }

  it("SB-TC-012: Events are accepted only with the bench's token and in sequence", async () => {
    const { bench, token } = await benchWithRecord();
    const { token: otherToken } = await benchWithRecord();

    // Step 1: no bearer token, and nothing is applied.
    const bare = await postEvents(bench, undefined, [event(8)]);
    expect(bare.status).toBe(401);
    expect(await snapshotSeq(bench)).toBe(7);

    // Step 2: the token of another bench.
    const other = await postEvents(bench, otherToken, [event(8)]);
    expect(other.status).toBe(401);
    expect(await snapshotSeq(bench)).toBe(7);
    expect(sse.broadcastDeliveryFrame).not.toHaveBeenCalled();

    // Step 3: a valid batch with the right token.
    const batch = [event(8), event(9)];
    const accepted = await postEvents(bench, token, batch);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ acceptedSeq: 9 });
    expect(await snapshotSeq(bench)).toBe(9);

    // Step 4: the same batch again.
    const replay = await postEvents(bench, token, batch);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ code: "STALE_SEQ", field: "seq", acceptedSeq: 9 });
    expect(replay.body.error).toMatch(/seq/);
    expect(await snapshotSeq(bench)).toBe(9);
  });

  it("SB-TC-013: A malformed event is rejected with a 400 that names the field", async () => {
    const { bench, token } = await benchWithRecord();

    // Step 1: no type.
    const untyped = event(8);
    delete untyped.type;
    const noType = await postEvents(bench, token, untyped);
    expect(noType.status).toBe(400);
    expect(noType.body).toMatchObject({ code: "INVALID_EVENT", field: "type", index: 0 });
    expect(noType.body.error).toMatch(/type/);

    // Step 2: seq as a string.
    const stringSeq = await postEvents(bench, token, { ...event(8), seq: "8" });
    expect(stringSeq.status).toBe(400);
    expect(stringSeq.body).toMatchObject({ code: "INVALID_EVENT", field: "seq" });
    expect(stringSeq.body.error).toMatch(/seq/);

    // Step 3: the third event of a batch is malformed; the whole batch goes.
    const third = await postEvents(bench, token, [event(8), event(9), { ...event(10), ts: 5 }]);
    expect(third.status).toBe(400);
    expect(third.body).toMatchObject({ code: "INVALID_EVENT", field: "ts", index: 2 });
    expect(await snapshotSeq(bench)).toBe(7);
    expect(sse.broadcastDeliveryFrame).not.toHaveBeenCalled();
    const next = await postEvents(bench, token, event(8));
    expect(next.body).toEqual({ acceptedSeq: 8 });
  });

  it("SB-TC-014: Bench load validates the record, seeds the accepted sequence and drops old events", async () => {
    // Step 1: the record says 40.
    const { bench, token } = await benchWithRecord(40);
    expect(await snapshotSeq(bench)).toBe(40);

    // Step 2: 38 and 39 are dropped, 41 is accepted.
    const posted = await postEvents(bench, token, [event(38), event(39), event(41)]);
    expect(posted.status).toBe(202);
    expect(posted.body).toEqual({ acceptedSeq: 41 });
    expect(await snapshotSeq(bench)).toBe(41);

    // Step 3: after a restart the snapshot is rebuilt from the record, and the
    // accepted seq is seeded from it again.
    restartServer(bench);
    const live = benchManager.getBench("demo", bench.id);
    if (!live) throw new Error("bench vanished");
    expect(await snapshotSeq(live)).toBeGreaterThanOrEqual(40);
    const stale = await postEvents(live, token, [event(39), event(40)]);
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe("STALE_SEQ");
    const again = await postEvents(live, token, event(41));
    expect(again.body).toEqual({ acceptedSeq: 41 });
  });

  it("folds the accepted events over the record in GET /delivery", async () => {
    const { bench, token } = await benchWithRecord();
    await postEvents(bench, token, event(8));

    const res = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(res.status).toBe(200);
    expect(res.body.seq).toBe(8);
    expect(res.body.unitsById.C.status).toBe("running");
  });

  it("SB-TC-047: a unit.changed that jams B raises the delivery-jam notification keyed by B, and one that resumes B dismisses it", async () => {
    const { bench, token } = await benchWithRecord();
    vi.mocked(notification.dismissByKey).mockClear();

    // Step 1: B is jammed. The notification comes from the event type alone.
    const jammed = await postEvents(bench, token, {
      ...event(8),
      unit_id: "B",
      payload: { status: "jammed" },
    });
    expect(jammed.status).toBe(202);
    const jamCalls = vi
      .mocked(notification.createNotification)
      .mock.calls.filter(([, type]) => type === "delivery-jam");
    expect(jamCalls).toHaveLength(1);
    const [target, , source, metadata, , , dedupeKey] = jamCalls[0];
    expect(target.id).toBe(bench.id);
    expect(source).toBeUndefined();
    expect(metadata).toEqual({ unitId: "B", status: "jammed" });
    expect(dedupeKey).toBe("B");
    const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(read.body.jams).toEqual(["B"]);

    // Step 2: B moves on, and its notification is dismissed.
    const resumed = await postEvents(bench, token, {
      ...event(9),
      unit_id: "B",
      payload: { status: "running" },
    });
    expect(resumed.status).toBe(202);
    expect(notification.dismissByKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: bench.id }),
      "delivery-jam",
      "B",
    );
    const after = await request(app).get(`/demo/benches/${bench.id}/delivery`);
    expect(after.body.jams).toEqual([]);
  });

  it("broadcasts a delivery frame with the accepted seq for each accepted batch", async () => {
    const { bench, token } = await benchWithRecord();
    await postEvents(bench, token, [event(8), event(9)]);
    await postEvents(bench, token, event(10));
    expect(vi.mocked(sse.broadcastDeliveryFrame).mock.calls).toEqual([
      ["demo", bench.id, 9],
      ["demo", bench.id, 10],
    ]);
  });

  it("refuses an event that skips a seq, or names another delivery, and applies nothing", async () => {
    const { bench, token } = await benchWithRecord();
    const gap = await postEvents(bench, token, [event(8), event(10)]);
    expect(gap.status).toBe(400);
    expect(gap.body).toMatchObject({ code: "SEQ_GAP", field: "seq", expected: 9, got: 10 });

    const foreign = await postEvents(bench, token, { ...event(8), delivery_id: "another" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: "INVALID_EVENT", field: "delivery_id" });

    const empty = await postEvents(bench, token, []);
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("INVALID_EVENT");
    expect(await snapshotSeq(bench)).toBe(7);
  });

  it("takes a batch only in an events wrapper, and refuses a bare array or a non-array events", async () => {
    const { bench, token } = await benchWithRecord();
    const bare = await request(app)
      .post(eventPath(bench))
      .set("Authorization", `Bearer ${token}`)
      .send([event(8)]);
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ code: "INVALID_EVENT", field: "events" });

    const notArray = await postEvents(bench, token, { events: event(8) });
    expect(notArray.status).toBe(400);
    expect(notArray.body).toMatchObject({ code: "INVALID_EVENT", field: "events" });
    expect(await snapshotSeq(bench)).toBe(7);

    const wrapped = await postEvents(bench, token, { events: [event(8), event(9)] });
    expect(wrapped.status).toBe(202);
    expect(wrapped.body).toEqual({ acceptedSeq: 9 });
  });

  it("answers 401 for a query that names no Spec Bench", async () => {
    const { token } = await benchWithRecord();
    const none = await request(app)
      .post("/api/hooks/delivery-event?projectId=demo&benchId=99")
      .set("Authorization", `Bearer ${token}`)
      .send(event(8));
    expect(none.status).toBe(401);
    const bare = await request(app)
      .post("/api/hooks/delivery-event")
      .set("Authorization", `Bearer ${token}`)
      .send(event(8));
    expect(bare.status).toBe(401);
  });

  it("starts the sequence at 1 while the bench has no record yet", async () => {
    const { bench } = await createSpecBench("launch");
    const token = launches[0].descriptor.token;
    const early = await postEvents(bench, token, event(8));
    expect(early.body).toMatchObject({ code: "SEQ_GAP", expected: 1 });
    const first = await postEvents(bench, token, [event(1), event(2)]);
    expect(first.body).toEqual({ acceptedSeq: 2 });
  });

  // The spill file: beside the record in the bench workspace.
  function spillPath(bench: Bench): string {
    return path.join(path.dirname(workspaceRecordPath(bench)), DELIVERY_EVENT_SPILL_FILE);
  }

  function spilledSeqs(bench: Bench): number[] {
    return fs
      .readFileSync(spillPath(bench), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
  }

  // Posts the events from..to in batches of 100.
  async function postRange(bench: Bench, token: string, from: number, to: number): Promise<void> {
    for (let start = from; start <= to; start += 100) {
      const batch = Array.from({ length: Math.min(100, to - start + 1) }, (_, i) =>
        event(start + i),
      );
      const res = await postEvents(bench, token, batch);
      expect(res.status).toBe(202);
    }
  }

  it(`moves the oldest ${DELIVERY_EVENT_SPILL_CHUNK} events to the spill file when the log holds ${DELIVERY_EVENT_LOG_MAX}, and accepts the batch`, async () => {
    const { bench, token } = await benchWithRecord(0);
    await postRange(bench, token, 1, DELIVERY_EVENT_LOG_MAX);
    expect(fs.existsSync(spillPath(bench))).toBe(false);

    const next = await postEvents(bench, token, event(DELIVERY_EVENT_LOG_MAX + 1));
    expect(next.status).toBe(202);
    expect(next.headers["retry-after"]).toBeUndefined();
    expect(next.body).toEqual({ acceptedSeq: DELIVERY_EVENT_LOG_MAX + 1 });
    expect(spilledSeqs(bench)).toEqual(
      Array.from({ length: DELIVERY_EVENT_SPILL_CHUNK }, (_, i) => i + 1),
    );
    // The file is in the workspace only, never in the project checkout.
    expect(fs.existsSync(path.join(specFolder, DELIVERY_EVENT_SPILL_FILE))).toBe(false);

    // The snapshot folds the spilled events and the ones in memory in seq
    // order: a hole at any seq would stop the fold short of the last one.
    expect(await snapshotSeq(bench)).toBe(DELIVERY_EVENT_LOG_MAX + 1);

    // A full batch on top of a full log moves every event in memory out.
    const fullBatch = Array.from({ length: DELIVERY_EVENT_LOG_MAX }, (_, i) =>
      event(DELIVERY_EVENT_LOG_MAX + 2 + i),
    );
    // Under the production body parsers, so a full batch fits.
    const big = await request(productionBodyLimitApp())
      .post(eventPath(bench))
      .set("Authorization", `Bearer ${token}`)
      .send({ events: fullBatch });
    expect(big.status).toBe(202);
    expect(spilledSeqs(bench)).toEqual(
      Array.from({ length: DELIVERY_EVENT_LOG_MAX + 1 }, (_, i) => i + 1),
    );
    expect(await snapshotSeq(bench)).toBe(2 * DELIVERY_EVENT_LOG_MAX + 1);

    // Once the record carries the spilled events, the read skips them.
    writeRecord(bench, { ...fixtureRecord(), last_event_seq: 500 });
    expect(await snapshotSeq(bench)).toBe(2 * DELIVERY_EVENT_LOG_MAX + 1);
  });

  it("reads the spilled events again after a server restart", async () => {
    const { bench, token } = await benchWithRecord(0);
    await postRange(bench, token, 1, DELIVERY_EVENT_LOG_MAX + 1);
    restartServer(bench);
    const live = benchManager.getBench("demo", bench.id);
    if (!live) throw new Error("bench vanished");
    // Memory is gone; the spill file still carries 1..500 above the record.
    expect(await snapshotSeq(live)).toBe(DELIVERY_EVENT_SPILL_CHUNK);
  });

  it("answers a 5xx and applies nothing when the spill file cannot be written", async () => {
    const { bench, token } = await benchWithRecord(0);
    await postRange(bench, token, 1, DELIVERY_EVENT_LOG_MAX);
    vi.mocked(sse.broadcastDeliveryFrame).mockClear();
    // A folder in the spill file's place makes the append fail.
    fs.mkdirSync(spillPath(bench));

    const refused = await postEvents(bench, token, event(DELIVERY_EVENT_LOG_MAX + 1));
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(refused.body).toMatchObject({
      code: "EVENT_LOG_SPILL_FAILED",
      acceptedSeq: DELIVERY_EVENT_LOG_MAX,
    });
    expect(deliveryAcceptedSeq("demo", bench.id)).toBe(DELIVERY_EVENT_LOG_MAX);
    expect(sse.broadcastDeliveryFrame).not.toHaveBeenCalled();

    fs.rmdirSync(spillPath(bench));
    expect(await snapshotSeq(bench)).toBe(DELIVERY_EVENT_LOG_MAX);
    const retried = await postEvents(bench, token, event(DELIVERY_EVENT_LOG_MAX + 1));
    expect(retried.status).toBe(202);
    expect(spilledSeqs(bench)).toHaveLength(DELIVERY_EVENT_SPILL_CHUNK);
    expect(await snapshotSeq(bench)).toBe(DELIVERY_EVENT_LOG_MAX + 1);
  });

  // The body parsers as server/index.ts mounts them: the event route's own
  // parser first, then the global 210 KB one every other route reads with.
  function productionBodyLimitApp(withEventParser = true): express.Express {
    const prod = express();
    if (withEventParser) prod.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
    prod.use(express.json({ limit: "210kb" }));
    prod.use("/api/hooks", deliveryHooksRouter);
    return prod;
  }

  // A realistic envelope: a unit's status change with its title.
  function fullBatch(): Record<string, unknown>[] {
    return Array.from({ length: DELIVERY_EVENT_LOG_MAX }, (_, i) => ({
      ...event(i + 1),
      payload: { status: "running", title: "Token-gated event ingest" },
    }));
  }

  it(`accepts a batch of ${DELIVERY_EVENT_LOG_MAX} events in sequence under the production body limit`, async () => {
    const { bench, token } = await benchWithRecord(0);
    const batch = fullBatch();
    // The batch is over the global limit, so the route's own parser is what
    // lets it through.
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeGreaterThan(210 * 1024);

    const globalOnly = await request(productionBodyLimitApp(false))
      .post(eventPath(bench))
      .set("Authorization", `Bearer ${token}`)
      .send({ events: batch });
    expect(globalOnly.status).toBe(413);
    expect(await snapshotSeq(bench)).toBe(0);

    const accepted = await request(productionBodyLimitApp())
      .post(eventPath(bench))
      .set("Authorization", `Bearer ${token}`)
      .send({ events: batch });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ acceptedSeq: DELIVERY_EVENT_LOG_MAX });
    expect(await snapshotSeq(bench)).toBe(DELIVERY_EVENT_LOG_MAX);
  });

  it("answers a JSON 413 for an event body over the route's limit, and applies nothing", async () => {
    const { bench, token } = await benchWithRecord();
    const huge = { ...event(8), payload: { status: "running", blob: "x".repeat(3 * 1024 * 1024) } };
    const res = await request(productionBodyLimitApp())
      .post(eventPath(bench))
      .set("Authorization", `Bearer ${token}`)
      .send(huge);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(await snapshotSeq(bench)).toBe(7);
  });

  it("drops the bench's events, the spill file included, when the bench is cleared", async () => {
    const { bench, token } = await benchWithRecord(0);
    await postRange(bench, token, 1, DELIVERY_EVENT_LOG_MAX + 1);
    expect(fs.existsSync(spillPath(bench))).toBe(true);
    benchManager.teardownBench("demo", bench.id, true);
    await cleared("demo", bench.id);
    expect(deliveryAcceptedSeq("demo", bench.id)).toBeUndefined();
    expect(fs.existsSync(spillPath(bench))).toBe(false);
  });
});
