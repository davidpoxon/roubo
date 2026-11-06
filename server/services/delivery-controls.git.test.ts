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
import { selectOpenDecisions, selectReviewStack } from "@roubo/shared/delivery-selectors";
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
import {
  forgetDeliveryControlMemory,
  hasDeliveryControlWaiter,
  issueDeliveryControl,
  releaseDeliveryControlWaiters,
} from "./delivery-control-outbox.js";
import { mintDeliveryToken, revokeDeliveryToken } from "./delivery-token-registry.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
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

// The app on a real port, for reads that stay open across other requests.
let listening: Server | undefined;

async function baseUrl(): Promise<string> {
  if (listening === undefined) {
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    listening = server;
  }
  return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

interface HeldReply {
  status: number;
  body: Record<string, unknown>;
  // When the reply arrived, by performance.now().
  at: number;
}

// Starts a control read with a wait over a real connection.
async function startRead(
  bench: Bench,
  token: string,
  after: number,
  wait: number,
  signal?: AbortSignal,
): Promise<HeldReply> {
  const url = `${await baseUrl()}/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&after=${after}&wait=${wait}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    at: performance.now(),
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Starts a control read with a wait, and resolves once the bench holds it.
async function holdRead(
  bench: Bench,
  token: string,
  after: number,
  wait: number,
  signal?: AbortSignal,
): Promise<{ reply: Promise<HeldReply> }> {
  expect(hasDeliveryControlWaiter(bench)).toBe(false);
  const reply = startRead(bench, token, after, wait, signal);
  // Keep a rejection from going unhandled while the hold is awaited.
  reply.catch(() => undefined);
  await until(() => hasDeliveryControlWaiter(bench), "the read to be held");
  return { reply };
}

function threadMessage(bench: Bench, text: string) {
  const issued = issueDeliveryControl(bench, {
    deliveryId: DELIVERY_ID,
    kind: "thread_message",
    targetId: OPEN_DECISION,
    body: { text },
    author: { name: "Ada Operator", email: "ada@example.test" },
  });
  if (!issued.ok) throw new Error(issued.errors.join("; "));
  return issued.control;
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

afterEach(async () => {
  releaseDeliveryControlWaiters();
  if (listening !== undefined) {
    const server = listening;
    listening = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  benchManager.dropProjectBenches("demo");
  unregisterVariantHost("specbench");
  resetDeliveryLaunchExecutor();
  forgetDeliveryEventLog();
  forgetDeliveryControlMemory();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A launch-mode Spec Bench whose session has written the record, and its token.
async function benchWithRecord(): Promise<{ bench: Bench; token: string }> {
  const res = await request(app).post("/demo/benches").send({
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

  it("SB-TC-042 an answer outside the options is 400 naming option with no control appended, an unknown decision 404 and an applied one 409", async () => {
    const { bench, token } = await benchWithRecord();

    const foreign = await answer(bench, OPEN_DECISION, { option: "one file per repo" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: "INVALID_BODY", field: "option" });
    expect(await readControls(bench, token, "0")).toMatchObject({
      body: { controls: [], latestSeq: 0 },
    });

    const unknown = await answer(bench, "decision-9");
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("DECISION_NOT_FOUND");

    // A decision whose answer was read back, and one whose default was applied.
    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);
    await postEvents(bench, token, [answered(8, OPEN_DECISION)]);
    const applied = await answer(bench, OPEN_DECISION);
    expect(applied.status).toBe(409);
    expect(applied.body).toMatchObject({ code: "DECISION_NOT_OPEN", status: "answered" });

    await postEvents(bench, token, [
      raised(9, "decision-3"),
      decisionEvent(10, "decision.defaulted", { decision_id: "decision-3" }),
    ]);
    const defaulted = await answer(bench, "decision-3", { option: "two" });
    expect(defaulted.status).toBe(409);
    expect(defaulted.body).toMatchObject({ code: "DECISION_NOT_OPEN", status: "defaulted" });

    expect((await readControls(bench, token, "0")).body.latestSeq).toBe(1);
  });
});

function decisionEvent(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: DELIVERY_ID,
    type,
    seq,
    ts: "2026-10-16T09:40:00Z",
    payload,
  };
}

function raised(seq: number, decisionId: string): Record<string, unknown> {
  return decisionEvent(seq, "decision.raised", {
    decision_id: decisionId,
    question: "One or two?",
    options: ["one", "two"],
    default: "one",
  });
}

function overturn(bench: Bench, decisionId: string, body: unknown) {
  return request(app)
    .post(`/demo/benches/${bench.id}/delivery/decisions/${decisionId}/overturn`)
    .send(body as object);
}

describe("Overturning a default", () => {
  it("SB-TC-038 a defaulted decision shows its default applied, takes an overturn control that the controls endpoint lists, and shows the new option on its read-back", async () => {
    const { bench, token } = await benchWithRecord();

    // An open decision has no default applied to overturn.
    const open = await overturn(bench, OPEN_DECISION, { option: "one file per stack" });
    expect(open.status).toBe(409);
    expect(open.body).toMatchObject({ code: "DECISION_NOT_DEFAULTED", status: "open" });

    // The session goes on with the default.
    expect(
      (await postEvents(bench, token, [decisionEvent(8, "decision.defaulted", { decision_id: OPEN_DECISION })]))
        .status,
    ).toBe(202);
    const defaulted = (await snapshotOf(bench)).decisionsById[OPEN_DECISION];
    expect(defaulted).toMatchObject({ status: "defaulted", chosen: OPTION });

    // The applied option and one the decision does not offer are refused.
    const same = await overturn(bench, OPEN_DECISION, { option: OPTION });
    expect(same.status).toBe(400);
    expect(same.body).toMatchObject({ code: "INVALID_BODY", field: "option" });
    const foreign = await overturn(bench, OPEN_DECISION, { option: "one file per repo" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: "INVALID_BODY", field: "option" });
    expect((await overturn(bench, "decision-9", { option: "one" })).status).toBe(404);

    // The overturn is a control on the controls endpoint.
    const posted = await overturn(bench, OPEN_DECISION, { option: "one file per stack" });
    expect(posted.status).toBe(202);
    expect(validateDeliveryControl(posted.body).ok).toBe(true);
    expect(posted.body).toMatchObject({
      control_seq: 1,
      kind: "overturn",
      target_id: OPEN_DECISION,
      body: { option: "one file per stack" },
      status: "pending",
    });
    expect(sse.broadcastDeliveryFrame).toHaveBeenCalledWith("demo", bench.id, 8, "controls");
    expect((await readControls(bench, token, "0")).body).toEqual({
      controls: [posted.body],
      latestSeq: 1,
    });

    const again = await overturn(bench, OPEN_DECISION, { option: "one file per stack" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "DECISION_OVERTURN_PENDING", control_seq: 1 });

    // The read-back applies the control and the new option.
    await postEvents(bench, token, [
      decisionEvent(9, "decision.overturned", {
        decision_id: OPEN_DECISION,
        option: "one file per stack",
      }),
    ]);
    const applied = await snapshotOf(bench);
    expect(applied.controls).toEqual([{ ...posted.body, status: "applied" }]);
    expect(applied.decisionsById[OPEN_DECISION]).toMatchObject({
      status: "overturned",
      chosen: "one file per stack",
    });
    const settled = await overturn(bench, OPEN_DECISION, { option: OPTION });
    expect(settled.status).toBe(409);
    expect(settled.body.code).toBe("DECISION_NOT_DEFAULTED");
  });
});

// A second agent decision, decided after the fixture's, so the fixture's is
// the older card.
const LATER_DECISION = "decision-3";

function agentDecided(seq: number): Record<string, unknown> {
  return decisionEvent(seq, "decision.decided", {
    decision_id: LATER_DECISION,
    question: "Does the lexer keep comments?",
    options: ["keep them", "drop them"],
    default: "drop them",
    chosen: "drop them",
    author: "agent",
    rationale: "Nothing reads them.",
    affected_units: ["C"],
    decided_at: "2026-10-16T09:30:00Z",
  });
}

function reviewOutcome(seq: number, decisionId: string, status: string): Record<string, unknown> {
  return decisionEvent(seq, "review.outcome", { decision_id: decisionId, status });
}

function accept(bench: Bench, decisionId: string, body: unknown = {}) {
  return request(app)
    .post(`/demo/benches/${bench.id}/delivery/decisions/${decisionId}/accept`)
    .send(body as object);
}

function reviewCardIds(snapshot: DeliverySnapshot): string[] {
  return selectReviewStack(snapshot).flatMap((card) =>
    card.kind === "decision" ? [card.id] : [],
  );
}

// A bench whose record states an open review of the fixture's agent decision
// and a later one.
async function benchWithOpenReview(): Promise<{ bench: Bench; token: string }> {
  const opened = await benchWithRecord();
  const posted = await postEvents(opened.bench, opened.token, [
    agentDecided(8),
    decisionEvent(9, "review.opened", {
      trigger: "boundary",
      unreviewed: [DECIDED_DECISION, LATER_DECISION],
    }),
  ]);
  expect(posted.status).toBe(202);
  const snapshot = await snapshotOf(opened.bench);
  expect(snapshot.review.status).toBe("open");
  expect(reviewCardIds(snapshot)).toEqual([DECIDED_DECISION, LATER_DECISION]);
  return opened;
}

describe("Review actions on an agent decision", () => {
  it("SB-TC-085 the operator accepts and overturns cards at an open review", async () => {
    const { bench, token } = await benchWithOpenReview();

    // Step 1: Accept on the older card is a review_accept control.
    const accepted = await accept(bench, DECIDED_DECISION);
    expect(accepted.status).toBe(202);
    expect(validateDeliveryControl(accepted.body).ok).toBe(true);
    expect(accepted.body).toMatchObject({
      kind: "review_accept",
      target_id: DECIDED_DECISION,
      status: "pending",
      reviewAction: true,
    });
    expect(sse.broadcastDeliveryFrame).toHaveBeenCalledWith("demo", bench.id, 9, "controls");

    // Step 2: the review.outcome removes the card and applies the control.
    expect(
      (await postEvents(bench, token, [reviewOutcome(10, DECIDED_DECISION, "accepted")])).status,
    ).toBe(202);
    const afterOutcome = await snapshotOf(bench);
    expect(reviewCardIds(afterOutcome)).toEqual([LATER_DECISION]);
    expect(afterOutcome.controls).toEqual([{ ...accepted.body, status: "applied" }]);

    // Step 3: Overturn of the other card with its other option.
    const overturned = await overturn(bench, LATER_DECISION, { option: "keep them" });
    expect(overturned.status).toBe(202);
    expect(overturned.body).toMatchObject({
      kind: "overturn",
      target_id: LATER_DECISION,
      body: { option: "keep them" },
      status: "pending",
      reviewAction: true,
    });

    // Step 4: an option the decision does not list, and the one it chose.
    const foreign = await overturn(bench, LATER_DECISION, { option: "comment them out" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: "INVALID_OPTION", field: "option" });
    const chosen = await overturn(bench, LATER_DECISION, { option: "drop them" });
    expect(chosen.status).toBe(400);
    expect(chosen.body).toMatchObject({ code: "INVALID_OPTION", field: "option" });
  });

  it("SB-TC-086 an early accept during a run is pending until a review.outcome reads it back", async () => {
    const { bench, token } = await benchWithRecord();
    expect((await snapshotOf(bench)).review.status).not.toBe("open");

    const accepted = await accept(bench, DECIDED_DECISION);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ kind: "review_accept", status: "pending" });
    const during = await snapshotOf(bench);
    expect(reviewCardIds(during)).toEqual([DECIDED_DECISION]);
    expect(during.controls[0]?.status).toBe("pending");

    // The unit boundary, then the outcome.
    const posted = await postEvents(bench, token, [
      { ...decisionEvent(8, "unit.changed", { status: "done" }), unit_id: "D" },
      reviewOutcome(9, DECIDED_DECISION, "accepted"),
    ]);
    expect(posted.status).toBe(202);
    const after = await snapshotOf(bench);
    expect(reviewCardIds(after)).toEqual([]);
    expect(after.controls[0]?.status).toBe("applied");
  });

  it("SB-TC-087 a review action is refused for a wrong card state, and an unread action is superseded", async () => {
    const { bench, token } = await benchWithOpenReview();

    // Step 1: a decision the session asked is not a review card.
    const asked = await accept(bench, OPEN_DECISION);
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe("NOT_AGENT_DECISION");

    // Step 2: an unknown decision.
    const unknown = await accept(bench, "decision-99");
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("DECISION_NOT_FOUND");

    // Step 3: an accept, then an overturn before the tooling reads.
    const first = await accept(bench, DECIDED_DECISION);
    expect(first.status).toBe(202);
    const second = await overturn(bench, DECIDED_DECISION, { option: "accept it" });
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ kind: "overturn", control_seq: 2 });
    const superseded = await snapshotOf(bench);
    expect(superseded.controls.map((c) => [c.control_seq, c.status])).toEqual([
      [1, "superseded"],
      [2, "pending"],
    ]);
    expect(lastPersisted(bench.id)?.deliveryControlQueue?.[0]?.status).toBe("superseded");

    // Step 4: the tooling reads only the overturn, which is then delivered,
    // and nothing replaces it.
    const read = await readControls(bench, token, "0");
    expect(read.status).toBe(200);
    expect(validateDeliveryControlReadResponse(read.body).ok).toBe(true);
    expect(read.body).toEqual({
      controls: [{ ...second.body, status: "delivered" }],
      latestSeq: 2,
    });
    const late = await accept(bench, DECIDED_DECISION);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "REVIEW_ACTION_DELIVERED", control_seq: 2 });
    const lateOverturn = await overturn(bench, DECIDED_DECISION, { option: "accept it" });
    expect(lateOverturn.status).toBe(409);
    expect(lateOverturn.body.code).toBe("REVIEW_ACTION_DELIVERED");

    // Step 5: after the outcome, the card is reviewed.
    await postEvents(bench, token, [reviewOutcome(10, DECIDED_DECISION, "overturned")]);
    expect((await snapshotOf(bench)).controls[1]?.status).toBe("applied");
    const reviewed = await accept(bench, DECIDED_DECISION);
    expect(reviewed.status).toBe(409);
    expect(reviewed.body).toMatchObject({ code: "ALREADY_REVIEWED", status: "overturned" });
  });

  it("SB-TC-085 a pending overturn is superseded by a review.outcome that accepts the decision", async () => {
    const { bench, token } = await benchWithOpenReview();
    const overturned = await overturn(bench, LATER_DECISION, { option: "keep them" });
    expect(overturned.status).toBe(202);

    // The session accepts the decision on its own before the tooling reads.
    const posted = await postEvents(bench, token, [reviewOutcome(10, LATER_DECISION, "accepted")]);
    expect(posted.status).toBe(202);
    const after = await snapshotOf(bench);
    expect(after.controls.map((c) => [c.control_seq, c.status])).toEqual([[1, "superseded"]]);
    expect(lastPersisted(bench.id)?.deliveryControlQueue?.[0]?.status).toBe("superseded");

    const read = await readControls(bench, token, "0");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ controls: [], latestSeq: 1 });
    expect((await snapshotOf(bench)).controls[0]?.status).toBe("superseded");
  });

  it("SB-TC-087 a read with a wait whose only control above the cursor is superseded is held until the wait ends or a control is issued", async () => {
    const { bench, token } = await benchWithOpenReview();
    expect((await accept(bench, DECIDED_DECISION)).status).toBe(202);
    expect(
      (await postEvents(bench, token, [reviewOutcome(10, DECIDED_DECISION, "overturned")])).status,
    ).toBe(202);
    expect((await snapshotOf(bench)).controls.map((c) => [c.control_seq, c.status])).toEqual([
      [1, "superseded"],
    ]);

    // Nothing to serve above the cursor: the read is held until its wait ends.
    const started = performance.now();
    const quiet = await holdRead(bench, token, 0, 500);
    const timedOut = await quiet.reply;
    expect(timedOut.status).toBe(200);
    expect(timedOut.body).toEqual({ controls: [], latestSeq: 1 });
    expect(timedOut.at - started).toBeGreaterThanOrEqual(450);

    // The same read is held again, and a newly issued control ends it.
    const again = await holdRead(bench, token, 0, 5000);
    const pause = issueDeliveryControl(bench, {
      deliveryId: DELIVERY_ID,
      kind: "pause",
      body: {},
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(pause.ok).toBe(true);
    const woken = await again.reply;
    expect(woken.status).toBe(200);
    expect(woken.body).toMatchObject({
      controls: [{ control_seq: 2, kind: "pause" }],
      latestSeq: 2,
    });
    expect((woken.body.controls as unknown[]).length).toBe(1);
  }, 10_000);

  it("SB-TC-085 a pending accept is superseded by a review.outcome that overturns the decision", async () => {
    const { bench, token } = await benchWithOpenReview();
    const accepted = await accept(bench, DECIDED_DECISION);
    expect(accepted.status).toBe(202);

    const posted = await postEvents(bench, token, [
      reviewOutcome(10, DECIDED_DECISION, "overturned"),
    ]);
    expect(posted.status).toBe(202);
    expect((await snapshotOf(bench)).controls.map((c) => c.status)).toEqual(["superseded"]);

    const read = await readControls(bench, token, "0");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ controls: [], latestSeq: 1 });
  });

  it("SB-TC-087 a delivered review action is applied by its own outcome and superseded by the other", async () => {
    const { bench, token } = await benchWithOpenReview();
    const accepted = await accept(bench, DECIDED_DECISION);
    const overturned = await overturn(bench, LATER_DECISION, { option: "keep them" });
    expect(accepted.status).toBe(202);
    expect(overturned.status).toBe(202);
    const read = await readControls(bench, token, "0");
    expect(read.body.controls.map((c: { status: string }) => c.status)).toEqual([
      "delivered",
      "delivered",
    ]);

    // The accept reads back as applied; the overturn's decision was accepted
    // instead, so the overturn is superseded.
    const posted = await postEvents(bench, token, [
      reviewOutcome(10, DECIDED_DECISION, "accepted"),
      reviewOutcome(11, LATER_DECISION, "accepted"),
    ]);
    expect(posted.status).toBe(202);
    expect((await snapshotOf(bench)).controls.map((c) => [c.control_seq, c.status])).toEqual([
      [1, "applied"],
      [2, "superseded"],
    ]);
    // A read serves the applied accept as applied, and never the overturn.
    const again = await readControls(bench, token, "0");
    expect(
      again.body.controls.map((c: { control_seq: number; status: string }) => [
        c.control_seq,
        c.status,
      ]),
    ).toEqual([[1, "applied"]]);
    expect(again.body.latestSeq).toBe(2);
  });

  it("an accept or an overturn sent again before the tooling reads answers with the same control", async () => {
    const { bench } = await benchWithOpenReview();
    const first = await accept(bench, DECIDED_DECISION);
    const again = await accept(bench, DECIDED_DECISION);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);

    const overturned = await overturn(bench, LATER_DECISION, { option: "keep them" });
    const overturnedAgain = await overturn(bench, LATER_DECISION, { option: "keep them" });
    expect(overturnedAgain.status).toBe(202);
    expect(overturnedAgain.body).toEqual(overturned.body);
    expect((await snapshotOf(bench)).controls).toHaveLength(2);
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
      .get(`/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&after=0&wait=0&cursor=x`)
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

  it("SB-TC-100 a read with a wait is held, returns as soon as a control is appended, and ends on a second read, a revoke or a bad wait", async () => {
    const { bench, token } = await benchWithRecord();
    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);

    // Step 1: a wait of 5,000 ms with no new control stays open, then returns
    // 200 with an empty list and the latest sequence number.
    const started = performance.now();
    const quiet = await holdRead(bench, token, 1, 5000);
    const timedOut = await quiet.reply;
    expect(timedOut.status).toBe(200);
    expect(timedOut.body).toEqual({ controls: [], latestSeq: 1 });
    expect(validateDeliveryControlReadResponse(timedOut.body).ok).toBe(true);
    expect(timedOut.at - started).toBeGreaterThanOrEqual(4900);
    expect(hasDeliveryControlWaiter(bench)).toBe(false);

    // Step 2: the same read again returns a thread message from the bench
    // before its wait ends.
    const again = await holdRead(bench, token, 1, 5000);
    const sentAt = performance.now();
    const message = threadMessage(bench, "Why one file per unit?");
    const woken = await again.reply;
    expect(woken.status).toBe(200);
    expect(woken.body).toEqual({ controls: [message], latestSeq: 2 });
    expect(woken.at - sentAt).toBeLessThan(2000);

    // Step 3: a second held read for the same bench ends the first with the
    // superseded reply, and is held in its place.
    const first = await holdRead(bench, token, 2, 5000);
    const second = startRead(bench, token, 2, 5000);
    const superseded = await first.reply;
    expect(superseded.status).toBe(200);
    expect(superseded.body).toEqual({ controls: [], superseded: true });
    expect(validateDeliveryControlReadResponse(superseded.body).ok).toBe(true);
    await until(() => hasDeliveryControlWaiter(bench), "the second read to be held");
    const pause = issueDeliveryControl(bench, {
      deliveryId: DELIVERY_ID,
      kind: "pause",
      body: {},
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    expect(pause.ok).toBe(true);
    expect((await second).body).toMatchObject({ controls: [{ control_seq: 3 }], latestSeq: 3 });

    // Step 4: a wait over 25,000 ms is refused.
    const tooLong = await request(app)
      .get(`/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&after=3&wait=30000`)
      .set("Authorization", `Bearer ${token}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({ code: "INVALID_WAIT", field: "wait" });

    // Step 5: a token revoke ends a held read with 401.
    const revoked = await holdRead(bench, token, 3, 5000);
    revokeDeliveryToken(bench);
    const refused = await revoked.reply;
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ code: "UNAUTHORIZED" });
    expect(hasDeliveryControlWaiter(bench)).toBe(false);
  }, 20_000);

  it("SB-TC-100 a read with no wait after a mixed batch returns every control in sequence order, and latestSeq is the highest", async () => {
    const { bench, token } = await benchWithRecord();
    expect((await answer(bench, OPEN_DECISION)).status).toBe(202);

    // Step 6: an overturn and a thread message, then a read with no wait.
    const overturn = issueDeliveryControl(bench, {
      deliveryId: DELIVERY_ID,
      kind: "overturn",
      targetId: DECIDED_DECISION,
      body: { option: OPTION, reason: "Prefer one file per unit" },
      author: { name: "Ada Operator", email: "ada@example.test" },
    });
    if (!overturn.ok) throw new Error(overturn.errors.join("; "));
    const message = threadMessage(bench, "Why accept it?");

    const read = await request(app)
      .get(`/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&after=1&wait=0`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ controls: [overturn.control, message], latestSeq: 3 });
    // A read with a wait returns at once when a control above `after` is there.
    // The thread message was served once, so only the overturn is left.
    const started = performance.now();
    const durableOnly = await startRead(bench, token, 1, 5000);
    expect(durableOnly.body).toEqual({ controls: [overturn.control], latestSeq: 3 });
    expect(durableOnly.at - started).toBeLessThan(2000);
    expect(hasDeliveryControlWaiter(bench)).toBe(false);
  });

  it("SB-TC-101 each of 20 controls appended to a held read reaches it within 2 seconds", async () => {
    const { bench, token } = await benchWithRecord();
    const author = { name: "Ada Operator", email: "ada@example.test" };
    const latencies: number[] = [];
    for (let seq = 1; seq <= 20; seq++) {
      const held = await holdRead(bench, token, seq - 1, 5000);
      const appendedAt = performance.now();
      const issued =
        seq % 2 === 0
          ? issueDeliveryControl(bench, {
              deliveryId: DELIVERY_ID,
              kind: "steering-note",
              body: { note: `Note ${seq}`, unit_ids: [] },
              author,
            })
          : issueDeliveryControl(bench, {
              deliveryId: DELIVERY_ID,
              kind: "thread_message",
              targetId: OPEN_DECISION,
              body: { text: `Message ${seq}` },
              author,
            });
      if (!issued.ok) throw new Error(issued.errors.join("; "));
      const reply = await held.reply;
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ controls: [issued.control], latestSeq: seq });
      latencies.push(reply.at - appendedAt);
    }
    expect(latencies).toHaveLength(20);
    for (const latency of latencies) expect(latency).toBeLessThan(2000);
  });

  it("answers 400 INVALID_WAIT for a wait that is not an integer from 0 to 25,000, and 401 for a bad token", async () => {
    const { bench, token } = await benchWithRecord();
    for (const wait of ["-1", "x", "1.5", "25001", ""]) {
      const read = await request(app)
        .get(`/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&wait=${wait}`)
        .set("Authorization", `Bearer ${token}`);
      expect(read.status).toBe(400);
      expect(read.body).toMatchObject({ code: "INVALID_WAIT", field: "wait" });
    }
    const atCap = startRead(bench, token, 0, 25_000);
    await until(() => hasDeliveryControlWaiter(bench), "the read at the cap to be held");
    releaseDeliveryControlWaiters();
    expect((await atCap).body).toEqual({ controls: [], latestSeq: 0 });

    const bad = await request(app)
      .get(`/api/hooks/delivery-controls?projectId=demo&benchId=${bench.id}&wait=1000`)
      .set("Authorization", "Bearer not-the-token");
    expect(bad.status).toBe(401);
    expect(hasDeliveryControlWaiter(bench)).toBe(false);
  });

  it("drops the waiter when the reader closes, ends a held read with 200 and an empty list on shutdown, and with 401 on a new token", async () => {
    const { bench, token } = await benchWithRecord();

    const aborter = new AbortController();
    const closing = await holdRead(bench, token, 0, 5000, aborter.signal);
    aborter.abort();
    await expect(closing.reply).rejects.toThrow();
    await until(() => !hasDeliveryControlWaiter(bench), "the waiter to go");

    const shutdown = await holdRead(bench, token, 0, 5000);
    releaseDeliveryControlWaiters();
    const ended = await shutdown.reply;
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ controls: [], latestSeq: 0 });

    // A new token, as a relaunch mints, ends a read held with the old one.
    const stale = await holdRead(bench, token, 0, 5000);
    const fresh = mintDeliveryToken(bench);
    expect((await stale.reply).status).toBe(401);
    const read = await readControls(bench, fresh, "0");
    expect(read.status).toBe(200);
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
