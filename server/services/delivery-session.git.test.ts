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
  getNotifications: vi.fn(() => []),
}));
vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
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
import { registerSpecbenchVariantHost } from "../lib/specbench-variant-host.js";
import { unregisterVariantHost } from "./variant-host-registry.js";
import {
  resetDeliveryLaunchExecutor,
  setDeliveryLaunchExecutor,
  whenDeliveryBound,
  type DeliveryLaunchRequest,
} from "./delivery-session-launcher.js";
import { hashDeliveryToken } from "./delivery-token-registry.js";

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
});

afterEach(() => {
  benchManager.dropProjectBenches("demo");
  unregisterVariantHost("specbench");
  resetDeliveryLaunchExecutor();
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
      new RegExp(`^http://localhost:\\d+/api/projects/demo/benches/${bench.id}/delivery/events$`),
    );
    expect(descriptor.controlsUrl).toMatch(
      new RegExp(`/api/projects/demo/benches/${bench.id}/delivery/controls$`),
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

    // Step 3: one event posted with the descriptor's token is accepted.
    const posted = await request(app)
      .post(new URL(descriptor.eventUrl).pathname.replace(/^\/api\/projects/, ""))
      .set("Authorization", `Bearer ${descriptor.token}`)
      .send(event(8));
    expect(posted.status).toBe(202);
    expect(posted.body).toMatchObject({ seq: 8 });
  });

  it("refuses an event without the token, with another token, or with a malformed body", async () => {
    const { bench } = await createSpecBench("launch");
    const url = `/demo/benches/${bench.id}/delivery/events`;

    const bare = await request(app).post(url).send(event(8));
    expect(bare.status).toBe(401);
    const other = await request(app)
      .post(url)
      .set("Authorization", "Bearer not-the-token")
      .send(event(8));
    expect(other.status).toBe(401);

    const token = launches[0].descriptor.token;
    const malformed = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...event(8), seq: 0 });
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
      new RegExp(`/api/projects/demo/benches/${bench.id}/delivery/events$`),
    );
    expect(handout.body.controlsUrl).toMatch(/\/delivery\/controls$/);
    expect(handout.body).not.toHaveProperty("resume");
    const token = handout.body.token as string;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(launches).toHaveLength(0);

    // Only the hash is on the bench and in its persisted record.
    expect(bench.deliveryTokenHash).toBe(hashDeliveryToken(token));
    expect(JSON.stringify(lastPersisted(bench.id))).not.toContain(token);
    expect(JSON.stringify(bench)).not.toContain(token);

    const posted = await request(app)
      .post(`/demo/benches/${bench.id}/delivery/events`)
      .set("Authorization", `Bearer ${token}`)
      .send(event(8));
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
    const posted = await request(app)
      .post(`/demo/benches/${bench.id}/delivery/events`)
      .set("Authorization", `Bearer ${token}`)
      .send(event(8));
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
    expect(mismatch.body.supported).toBe("1.0.0");
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

    const posted = await request(app)
      .post(`/demo/benches/${bench.id}/delivery/events`)
      .set("Authorization", `Bearer ${token}`)
      .send(event(8));
    expect(posted.status).toBe(202);
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
