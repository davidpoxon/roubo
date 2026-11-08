// The control outbox of a Spec Bench end to end against a real git repository
// (SB-FR-014, SB-FR-021, SB-FR-022, SB-NFR-001, SB-US-005, SB-US-008): an
// answer is a control in the bench's outbox, the session reads it from the
// token-gated controls endpoint, and an event reads it back. The create route,
// the bench manager, the delivery routes, the token registry, the record
// loader, the event log and the outbox are real; the state file write and the
// agent launch executor are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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
import {
  validateDeliveryControl,
  validateDeliveryControlReadResponse,
} from "@roubo/shared/delivery-control-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectOpenDecisions } from "@roubo/shared/delivery-selectors";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { makeConfig } from "../test/fixtures.js";

const hoisted = vi.hoisted(() => ({
  project: undefined as RegisteredProject | undefined,
  workspaces: "",
  persisted: [] as PersistedBench[],
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
  getSessionScrollback: vi.fn(),
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
import * as benchManager from "./bench-manager.js";
import * as sse from "./sse.js";
import benchesRouter from "../routes/benches.js";
import deliveryRouter from "../routes/delivery.js";
import deliveryHooksRouter from "../routes/delivery-hooks.js";
import { registerSpecbenchVariantHost } from "../lib/specbench-variant-host.js";
import { markObservation } from "../lib/testbench-store.js";
import { unregisterVariantHost } from "./variant-host-registry.js";
import {
  resetDeliveryLaunchExecutor,
  setDeliveryLaunchExecutor,
  whenDeliveryBound,
  type DeliveryLaunchRequest,
} from "./delivery-session-launcher.js";
import { forgetDeliveryEventLog } from "./delivery-event-log.js";
import { forgetDeliveryControlMemory, issueDeliveryControl } from "./delivery-control-outbox.js";
import { resolveGitIdentity } from "./git-helpers.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);
const DELIVERY_ID = "demo-delivery-1";
// The fixture record's open decision, and the one an agent already decided.
const OPEN_DECISION = "decision-1";
const DECIDED_DECISION = "decision-2";
const OPTION = "one file per unit";

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

function workspaceSpecFolder(bench: Bench): string {
  return path.join(bench.workspacePath, ".specifications", "fixture-spec");
}

function writeRecord(bench: Bench, record: unknown): void {
  fs.writeFileSync(
    path.join(workspaceSpecFolder(bench), "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function answered(seq: number, decisionId: string): Record<string, unknown> {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: DELIVERY_ID,
    type: "decision.answered",
    seq,
    ts: "2026-10-16T09:40:00Z",
    payload: { decision_id: decisionId, answer: OPTION },
  };
}

function postEvents(bench: Bench, token: string, events: unknown[]) {
  return request(app)
    .post(`/api/hooks/delivery-event?projectId=demo&benchId=${bench.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ events });
}

function readControls(bench: Bench, token: string | undefined, after?: string) {
  const query = after === undefined ? "" : `&after=${after}`;
  const req = request(app).get(
    `/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}${query}`,
  );
  if (token !== undefined) req.set("Authorization", `Bearer ${token}`);
  return req;
}

function answer(bench: Bench, decisionId: string, body: unknown = { option: OPTION }) {
  return request(app)
    .post(`/demo/benches/${bench.id}/delivery/decisions/${decisionId}/answer`)
    .send(body as object);
}

async function snapshotOf(bench: Bench): Promise<DeliverySnapshot> {
  const read = await request(app).get(`/demo/benches/${bench.id}/delivery`);
  expect(read.status).toBe(200);
  return read.body as DeliverySnapshot;
}

// Every file under a folder, by relative path, with a digest of its bytes.
function folderState(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(folder)) return out;
  for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(folder, full)] = crypto
      .createHash("sha256")
      .update(fs.readFileSync(full))
      .digest("hex");
  }
  return out;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-controls-")));
  repo = path.join(tmp, "repo");
  hoisted.workspaces = path.join(tmp, "workspaces");
  hoisted.persisted = [];
  fs.mkdirSync(repo);
  fs.mkdirSync(hoisted.workspaces);

  specFolder = path.join(repo, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), '{"cases":[]}\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Ada Operator");
  git(repo, "config", "user.email", "ada@example.test");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c");

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
  vi.mocked(sse.broadcastDeliveryFrame).mockClear();
  registerSpecbenchVariantHost();
  app = express();
  app.use(express.json());
  app.use("/", benchesRouter);
  app.use("/", deliveryRouter);
  app.use("/api/hooks", deliveryHooksRouter);
});

afterEach(() => {
  benchManager.dropProjectBenches("demo");
  unregisterVariantHost("specbench");
  resetDeliveryLaunchExecutor();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A launch-mode Spec Bench whose session has written the record, and its token.
async function benchWithRecord(): Promise<{ bench: Bench; token: string }> {
  const res = await request(app)
    .post("/demo/benches")
    .send({
      variant: "specbench",
      focusedSpecPath: ".specifications/fixture-spec",
      delivery: { mode: "launch" },
    });
  expect(res.status).toBe(201);
  const created = res.body as Bench;
  await benchManager.whenWorkspaceProvisioned("demo", created.id);
  await whenDeliveryBound("demo", created.id);
  const bench = benchManager.getBench("demo", created.id);
  if (!bench) throw new Error("bench vanished");
  fs.mkdirSync(workspaceSpecFolder(bench), { recursive: true });
  writeRecord(bench, fixtureRecord());
  const token = launches.at(-1)?.descriptor.token;
  if (token === undefined) throw new Error("no launch");
  return { bench, token };
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

describe("Answering a decision", () => {
  it("SB-TC-037 a decision is answered in place, read from the controls endpoint and applied on its read-back", async () => {
    const { bench, token } = await benchWithRecord();
    const identity = await resolveGitIdentity(bench.workspacePath);

    // Step 1: the answer is a control with the next control_seq, pending.
    const posted = await answer(bench, OPEN_DECISION);
    expect(posted.status).toBe(202);
    expect(validateDeliveryControl(posted.body).ok).toBe(true);
    expect(posted.body).toMatchObject({
      delivery_id: DELIVERY_ID,
      control_seq: 1,
      kind: "decision-answer",
      target_id: OPEN_DECISION,
      body: { option: OPTION },
      durability: "durable",
      status: "pending",
      author: { name: identity.name, email: identity.email },
    });
    // It is in the outbox in state.json before the answer.
    expect(lastPersisted(bench.id)?.deliveryControlQueue).toEqual([posted.body]);
    // The answer adds no event, so its frame is a `controls` one that a client
    // already holding seq 7 does not skip.
    expect(sse.broadcastDeliveryFrame).toHaveBeenCalledWith("demo", bench.id, 7, "controls");

    // The snapshot shows the decision answered and pending read-back.
    const pending = await snapshotOf(bench);
    expect(pending.controls).toEqual([posted.body]);
    expect(selectOpenDecisions(pending).map((d) => d.id)).toContain(OPEN_DECISION);

    // Step 2: the session reads the answer with the bench token.
    const read = await readControls(bench, token, "0");
    expect(read.status).toBe(200);
    expect(validateDeliveryControlReadResponse(read.body).ok).toBe(true);
    expect(read.body).toEqual({ controls: [posted.body], latestSeq: 1 });
    const none = await readControls(bench, token, "1");
    expect(none.body).toEqual({ controls: [], latestSeq: 1 });
    // A read leaves a durable control pending: only its read-back applies it.
    expect((await readControls(bench, token)).body.controls[0].status).toBe("pending");

    // Step 3: the read-back marks the answer applied and drops the decision.
    const echoed = await postEvents(bench, token, [answered(8, OPEN_DECISION)]);
    expect(echoed.status).toBe(202);
    const applied = await snapshotOf(bench);
    expect(applied.controls).toEqual([{ ...posted.body, status: "applied" }]);
    expect(selectOpenDecisions(applied).map((d) => d.id)).not.toContain(OPEN_DECISION);
    expect((await readControls(bench, token, "0")).body.controls[0].status).toBe("applied");
    expect(lastPersisted(bench.id)?.deliveryControlQueue?.[0]?.status).toBe("applied");
  });

  it("refuses an answer to an unknown, a settled or a waiting decision, and an option the decision does not offer", async () => {
    const { bench, token } = await benchWithRecord();

    const unknown = await answer(bench, "decision-9");
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("DECISION_NOT_FOUND");

    const decided = await answer(bench, DECIDED_DECISION, { option: "accept it" });
    expect(decided.status).toBe(409);
    expect(decided.body.code).toBe("DECISION_NOT_OPEN");

    const missing = await answer(bench, OPEN_DECISION, {});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: "INVALID_BODY", field: "option" });
    const foreign = await answer(bench, OPEN_DECISION, { option: "one file per repo" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: "INVALID_BODY", field: "option" });

    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);
    const again = await answer(bench, OPEN_DECISION, { option: "one file per stack" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "DECISION_ANSWER_PENDING", control_seq: 1 });

    await postEvents(bench, token, [answered(8, OPEN_DECISION)]);
    const settled = await answer(bench, OPEN_DECISION);
    expect(settled.status).toBe(409);
    expect(settled.body.code).toBe("DECISION_NOT_OPEN");

    // No refusal took a control_seq.
    expect((await readControls(bench, token, "0")).body.latestSeq).toBe(1);
  });
});

describe("The controls endpoint", () => {
  it("answers 401 without the token, with a wrong token or with another bench's token", async () => {
    const { bench } = await benchWithRecord();
    const { token: otherToken } = await benchWithRecord();
    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);

    for (const token of [undefined, "not-the-token", otherToken]) {
      const read = await readControls(bench, token, "0");
      expect(read.status).toBe(401);
      expect(read.body).toEqual({
        error: "A valid delivery token is required",
        code: "UNAUTHORIZED",
      });
    }
    // A query that names no Spec Bench gets the same 401.
    const nameless = await request(app)
      .get("/api/hooks/delivery-controls?projectId=demo&benchId=99")
      .set("Authorization", `Bearer ${otherToken}`);
    expect(nameless.status).toBe(401);
  });

  it("answers 400 INVALID_QUERY for an after that is not a non-negative integer, and ignores a key it does not know", async () => {
    const { bench, token } = await benchWithRecord();
    for (const after of ["-1", "x", "1.5"]) {
      const read = await readControls(bench, token, after);
      expect(read.status).toBe(400);
      expect(read.body).toMatchObject({ code: "INVALID_QUERY", field: "after" });
    }
    const open = await request(app)
      .get(`/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&after=0&wait=0`)
      .set("Authorization", `Bearer ${token}`);
    expect(open.status).toBe(200);
    expect(open.body).toEqual({ controls: [], latestSeq: 0 });
  });

  it("keeps the outbox across a server restart, and control_seq goes on from its last value", async () => {
    const { bench, token } = await benchWithRecord();
    const first = await answer(bench, OPEN_DECISION);
    expect(first.status).toBe(202);
    // A volatile control is the last one issued before the restart.
    const message = issueDeliveryControl(bench, {
      deliveryId: DELIVERY_ID,
      kind: "thread_message",
      targetId: OPEN_DECISION,
      body: { text: "Why one file per unit?" },
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(message.ok && message.control.control_seq).toBe(2);
    expect(lastPersisted(bench.id)?.deliveryControlSeq).toBe(2);

    // The restart: the bench comes back from its persisted record only.
    hoisted.persisted = [state.toPersistedBench(bench)];
    benchManager.dropProjectBenches("demo");
    forgetDeliveryEventLog();
    forgetDeliveryControlMemory();
    benchManager.initialize();
    const restarted = benchManager.getBench("demo", bench.id);
    if (!restarted) throw new Error("bench not restored");

    const read = await readControls(restarted, token, "0");
    expect(read.status).toBe(200);
    // The volatile control is not in the restored outbox, but its seq is not
    // issued again.
    expect(read.body).toEqual({ controls: [first.body], latestSeq: 2 });
    // The pending answer still holds the decision.
    expect((await answer(restarted, OPEN_DECISION)).body.code).toBe("DECISION_ANSWER_PENDING");

    const pause = issueDeliveryControl(restarted, {
      deliveryId: DELIVERY_ID,
      kind: "pause",
      body: {},
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(pause.ok && pause.control.control_seq).toBe(3);
    expect((await readControls(restarted, token, "1")).body.controls).toMatchObject([
      { control_seq: 3, kind: "pause", status: "pending" },
    ]);
    expect(lastPersisted(bench.id)?.deliveryControlQueue?.map((c) => c.control_seq)).toEqual([
      1, 3,
    ]);
    expect(lastPersisted(bench.id)?.deliveryControlSeq).toBe(3);
  });

  it("drops the outbox when the bench is cleared", async () => {
    const { bench } = await benchWithRecord();
    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);
    expect(bench.deliveryControlQueue).toHaveLength(1);

    benchManager.teardownBench("demo", bench.id, true);
    await cleared("demo", bench.id);

    expect(bench.deliveryControlQueue).toBeUndefined();
    expect(lastPersisted(bench.id)).not.toHaveProperty("deliveryControlQueue");
    expect(bench.deliveryControlSeq).toBeUndefined();
    expect(lastPersisted(bench.id)).not.toHaveProperty("deliveryControlSeq");
  });
});

describe("The control service", () => {
  it("validates every control against the control contract, and a control that fails takes no seq", async () => {
    const { bench, token } = await benchWithRecord();
    const author = { name: "Ada Operator", email: "ada@example.test" };

    const noNote = issueDeliveryControl(bench, {
      deliveryId: DELIVERY_ID,
      kind: "steering-note",
      body: { unit_ids: [] },
      author,
    });
    expect(noNote).toEqual({ ok: false, errors: [expect.stringMatching(/^body\.note: /)] });
    const noDelivery = issueDeliveryControl(bench, {
      deliveryId: "",
      kind: "pause",
      body: {},
      author,
    });
    expect(noDelivery.ok).toBe(false);
    expect(bench.deliveryControlQueue).toBeUndefined();

    // A volatile control is held for one read and never written to state.json:
    // only its seq is.
    const message = issueDeliveryControl(bench, {
      deliveryId: DELIVERY_ID,
      kind: "thread_message",
      targetId: OPEN_DECISION,
      body: { text: "Why one file per unit?" },
      author,
    });
    expect(message.ok && message.control).toMatchObject({
      control_seq: 1,
      durability: "volatile",
      status: "queued",
    });
    expect(bench.deliveryControlQueue).toBeUndefined();
    expect((await readControls(bench, token, "0")).body).toMatchObject({
      controls: [{ control_seq: 1, kind: "thread_message" }],
      latestSeq: 1,
    });
    expect((await readControls(bench, token, "0")).body).toEqual({ controls: [], latestSeq: 1 });
  });

  it("SB-TC-052 controls never write into the spec folder, and a mark changes only test-results.json", async () => {
    const { bench, token } = await benchWithRecord();
    const author = { name: "Ada Operator", email: "ada@example.test" };
    const workspaceFolder = workspaceSpecFolder(bench);
    const checkoutBefore = folderState(specFolder);
    const workspaceBefore = folderState(workspaceFolder);

    // Step 1: answer a decision, send a note, change a role and pause.
    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);
    const controls = [
      { kind: "steering-note" as const, body: { note: "Keep the parser strict.", unit_ids: [] } },
      { kind: "role-change" as const, targetId: "unit-coder", body: { tier: "large" } },
      { kind: "pause" as const, body: { reason: "Lunch" } },
    ];
    for (const control of controls) {
      const issued = issueDeliveryControl(bench, { deliveryId: DELIVERY_ID, author, ...control });
      expect(issued.ok).toBe(true);
    }

    expect(folderState(specFolder)).toEqual(checkoutBefore);
    expect(folderState(workspaceFolder)).toEqual(workspaceBefore);
    // Every control lands in the bench outbox only.
    const read = await readControls(bench, token, "0");
    expect(
      read.body.controls.map((c: { control_seq: number; kind: string }) => [c.control_seq, c.kind]),
    ).toEqual([
      [1, "decision-answer"],
      [2, "steering-note"],
      [3, "role-change"],
      [4, "pause"],
    ]);
    expect(lastPersisted(bench.id)?.deliveryControlQueue).toEqual(read.body.controls);

    // Step 2: a mark during a sitting goes through the results writer, and only
    // test-results.json changes.
    const plan: TestCasesPlan = {
      $schema: TEST_CASES_SCHEMA_ID,
      schemaVersion: TEST_CASES_SCHEMA_VERSION,
      specSlug: "fixture-spec",
      cases: [
        {
          id: "DEMO-TC-001",
          title: "The cache keeps one file per unit",
          area: "demo",
          level: 1,
          type: "functional",
          steps: [
            { id: "S1", instruction: "Build", observations: [{ id: "O1", expected: "One file" }] },
          ],
          tags: [],
          linked_requirement_ids: ["DEMO-FR-001"],
          linked_user_story_ids: [],
        },
      ],
    };
    fs.writeFileSync(path.join(workspaceFolder, "test-cases.json"), JSON.stringify(plan));
    const beforeMark = folderState(workspaceFolder);
    await markObservation(bench.workspacePath, "fixture-spec", "DEMO-TC-001", "O1", "pass");
    const afterMark = folderState(workspaceFolder);
    const changed = Object.keys({ ...beforeMark, ...afterMark }).filter(
      (file) => beforeMark[file] !== afterMark[file],
    );
    expect(changed).toEqual(["test-results.json"]);
    expect(folderState(specFolder)).toEqual(checkoutBefore);
  });
});
