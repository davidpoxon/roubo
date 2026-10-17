// The Spec Bench variant end to end against a real git repository (SB-FR-001,
// SB-FR-004). The create route, the bench manager, the VariantHostRegistry and
// the delivery domain's Spec Bench host are all real, so these tests see what
// stays on disk: the bench workspace, the gate pin worktree, and the checkout's
// spec folder with test-results.json and the delivery record that the bench
// keeps there from its workspace.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import type { Bench, RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { makeConfig } from "../test/fixtures.js";

const hoisted = vi.hoisted(() => ({
  project: undefined as RegisteredProject | undefined,
  workspaces: "",
  // What each stopped session saw on disk when it stopped: the trace that
  // proves the order pin, then session, then workspace.
  stoppedSessions: [] as Array<{ sessionId: string; pinExists: boolean; workspaceExists: boolean }>,
  pinPath: "",
  workspacePathOf: new Map<number, string>(),
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    loadState: vi.fn(() => ({ benches: [] })),
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
  destroySession: vi.fn((sessionId: string) => {
    const ws = [...hoisted.workspacePathOf.values()][0] ?? "";
    hoisted.stoppedSessions.push({
      sessionId,
      pinExists: fs.existsSync(hoisted.pinPath),
      workspaceExists: fs.existsSync(ws),
    });
    return true;
  }),
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
import * as benchManager from "./bench-manager.js";
import router from "../routes/benches.js";
import { registerSpecbenchVariantHost } from "../lib/specbench-variant-host.js";
import { unregisterVariantHost } from "./variant-host-registry.js";

const DELIVERY_FIELDS = [
  "deliveryBindMode",
  "gatePin",
  "deliveryTokenHash",
  "deliverySitting",
  "deliveryLastViewedSeq",
  "deliveryFirstSeenBlocking",
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let tmp: string;
let repo: string;
let specFolder: string;
let app: express.Express;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-specbench-")));
  repo = path.join(tmp, "repo");
  hoisted.workspaces = path.join(tmp, "workspaces");
  hoisted.stoppedSessions = [];
  hoisted.workspacePathOf.clear();
  fs.mkdirSync(repo);
  fs.mkdirSync(hoisted.workspaces);

  // The fixture project: a spec `fixture-spec` with a results file, committed
  // so the checkout is the project's own. The delivery record is written by the
  // session into the bench workspace, so each test that needs one writes it
  // there.
  specFolder = path.join(repo, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(path.join(specFolder, "test-results.json"), '{"results":[]}\n');
  fs.writeFileSync(
    path.join(repo, ".specifications", "fixture-spec", "test-cases.json"),
    '{"cases":[]}\n',
  );
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

  registerSpecbenchVariantHost();
  app = express();
  app.use(express.json());
  app.use("/", router);
});

afterEach(async () => {
  benchManager.dropProjectBenches("demo");
  unregisterVariantHost("specbench");
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function provisioned(bench: Bench): Promise<Bench> {
  await benchManager.whenWorkspaceProvisioned(bench.projectId, bench.id);
  const live = benchManager.getBench(bench.projectId, bench.id);
  if (!live) throw new Error("bench vanished");
  hoisted.workspacePathOf.set(live.id, live.workspacePath);
  return live;
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

async function createSpecBench(): Promise<Bench> {
  const res = await request(app)
    .post("/demo/benches")
    .send({
      variant: "specbench",
      focusedSpecPath: ".specifications/fixture-spec",
      delivery: { mode: "launch" },
    });
  expect(res.status).toBe(201);
  return provisioned(res.body as Bench);
}

describe("Spec Bench set-up through the normal path", () => {
  it("SB-TC-001: claims a number, ports and a workspace and lists beside the existing benches", async () => {
    const plainRes = await request(app).post("/demo/benches").send({});
    expect(plainRes.status).toBe(201);
    await provisioned(plainRes.body as Bench);

    const res = await request(app)
      .post("/demo/benches")
      .send({
        variant: "specbench",
        focusedSpecPath: ".specifications/fixture-spec",
        delivery: { mode: "launch" },
      });

    expect(res.status).toBe(201);
    expect(res.body.variant).toBe("specbench");
    expect(res.body.id).toBe(2);
    expect(res.body.ports).toEqual({ backend: 5002 });
    expect(res.body.workspacePath).toBe(path.join(hoisted.workspaces, "bench-2"));
    expect(res.body.focusedSpecPath).toBe(specFolder);
    expect(res.body.deliveryBindMode).toBe("launch");

    const bench = await provisioned(res.body as Bench);
    expect(bench.status).toBe("idle");
    expect(fs.existsSync(bench.workspacePath)).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(bench.workspacePath);
    expect(state.addBench).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, variant: "specbench", deliveryBindMode: "launch" }),
    );

    const list = await request(app).get("/demo/benches");
    expect(list.status).toBe(200);
    expect(list.body.map((b: Bench) => [b.id, b.variant])).toEqual([
      [1, undefined],
      [2, "specbench"],
    ]);
  });

  it("accepts attach mode as well as launch", async () => {
    const res = await request(app)
      .post("/demo/benches")
      .send({
        variant: "specbench",
        focusedSpecPath: specFolder,
        delivery: { mode: "attach" },
      });
    expect(res.status).toBe(201);
    expect(res.body.deliveryBindMode).toBe("attach");
    await provisioned(res.body as Bench);
  });
});

describe("Spec Bench create validation", () => {
  it("SB-TC-002: rejects an unknown variant, then a missing focus path, with a 400 naming the field and creates nothing", async () => {
    const res = await request(app).post("/demo/benches").send({ variant: "specbenchx" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_VARIANT");
    expect(res.body.error).toMatch(/variant/);
    expect(res.body.error).toContain("specbenchx");
    expect(benchManager.getBenches("demo")).toEqual([]);
    expect(fs.readdirSync(hoisted.workspaces)).toEqual([]);

    // Step 2: the right variant with a focus path that does not exist.
    const noFocus = await request(app)
      .post("/demo/benches")
      .send({
        variant: "specbench",
        focusedSpecPath: ".specifications/no-such-spec",
        delivery: { mode: "launch" },
      });

    expect(noFocus.status).toBe(400);
    expect(noFocus.body.code).toBe("INVALID_FOCUS");
    expect(noFocus.body.error).toMatch(/focusedSpecPath/);
    expect(noFocus.body.error).toContain(".specifications/no-such-spec");
    expect(benchManager.getBenches("demo")).toEqual([]);
    expect(fs.readdirSync(hoisted.workspaces)).toEqual([]);
  });

  it("rejects a missing focus path, a focus path outside the repository and a missing delivery mode", async () => {
    const missing = await request(app)
      .post("/demo/benches")
      .send({ variant: "specbench", delivery: { mode: "launch" } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/focusedSpecPath/);

    const escaping = await request(app)
      .post("/demo/benches")
      .send({ variant: "specbench", focusedSpecPath: "/etc", delivery: { mode: "launch" } });
    expect(escaping.status).toBe(400);
    expect(escaping.body.error).toMatch(/focusedSpecPath/);

    const noMode = await request(app)
      .post("/demo/benches")
      .send({ variant: "specbench", focusedSpecPath: ".specifications/fixture-spec" });
    expect(noMode.status).toBe(400);
    expect(noMode.body.code).toBe("INVALID_DELIVERY");
    expect(noMode.body.error).toMatch(/delivery\.mode/);

    const badMode = await request(app)
      .post("/demo/benches")
      .send({
        variant: "specbench",
        focusedSpecPath: ".specifications/fixture-spec",
        delivery: { mode: "detach" },
      });
    expect(badMode.status).toBe(400);
    expect(badMode.body.error).toMatch(/delivery\.mode/);

    expect(benchManager.getBenches("demo")).toEqual([]);
    expect(fs.readdirSync(hoisted.workspaces)).toEqual([]);
  });
});

describe("Clear bench on a Spec Bench", () => {
  it("SB-TC-005: removes the pin, then stops the session, then removes the workspace, and keeps the record", async () => {
    const bench = await createSpecBench();
    // The session's record, where it writes it: the spec folder of the workspace.
    const workspaceSpecFolder = path.join(bench.workspacePath, ".specifications", "fixture-spec");
    const recordBefore = `${JSON.stringify({ delivery_id: "demo-delivery-1", seq: 7 }, null, 2)}\n`;
    fs.writeFileSync(path.join(workspaceSpecFolder, "delivery-observation.json"), recordBefore);
    const recordPath = path.join(specFolder, "delivery-observation.json");
    expect(fs.existsSync(recordPath)).toBe(false);
    const resultsPath = path.join(specFolder, "test-results.json");
    const resultsBefore = fs.readFileSync(resultsPath, "utf8");

    // An open gate sitting: a pin worktree at the gate's head and its session.
    hoisted.pinPath = path.join(hoisted.workspaces, "bench-1-pin-G1");
    git(repo, "worktree", "add", "-q", "--detach", hoisted.pinPath, "HEAD");
    bench.gatePin = {
      gateId: "G1",
      workspacePath: hoisted.pinPath,
      createdAt: new Date().toISOString(),
    };
    bench.deliverySitting = { gateId: "G1", sessionId: "sitting-1", openedAt: "now" };

    benchManager.teardownBench("demo", bench.id, true);
    expect(bench.teardownSteps[0]).toMatchObject({ id: "variant" });
    await cleared("demo", bench.id);

    // Pin first: it was gone when the session stopped. Session second: the
    // workspace was still there when it stopped. Workspace last: it is gone now.
    expect(hoisted.stoppedSessions).toEqual([
      { sessionId: "sitting-1", pinExists: false, workspaceExists: true },
    ]);
    expect(fs.existsSync(bench.workspacePath)).toBe(false);

    // The record outlives the workspace in the checkout's spec folder, byte for
    // byte as the session wrote it, beside the checkout's own results file.
    expect(fs.readFileSync(recordPath, "utf8")).toBe(recordBefore);
    expect(fs.readFileSync(resultsPath, "utf8")).toBe(resultsBefore);

    const worktrees = git(repo, "worktree", "list", "--porcelain");
    expect(worktrees).not.toContain(hoisted.pinPath);
    expect(worktrees).not.toContain(bench.workspacePath);
  });

  it("clears a Spec Bench with no open sitting and no record, and still keeps the spec folder", async () => {
    const bench = await createSpecBench();
    benchManager.teardownBench("demo", bench.id, true);
    await cleared("demo", bench.id);

    expect(hoisted.stoppedSessions).toEqual([]);
    expect(fs.existsSync(bench.workspacePath)).toBe(false);
    expect(fs.existsSync(path.join(specFolder, "delivery-observation.json"))).toBe(false);
    expect(fs.existsSync(path.join(specFolder, "test-results.json"))).toBe(true);
  });
});

describe("Benches without the Spec Bench variant", () => {
  it("SB-TC-008: a plain bench and a testbench bench carry no delivery field and no variant teardown step", async () => {
    const plain = await request(app).post("/demo/benches").send({});
    const testbench = await request(app)
      .post("/demo/benches")
      .send({
        variant: "testbench",
        focusedSpecPath: ".specifications/fixture-spec/test-cases.json",
      });
    expect(plain.status).toBe(201);
    expect(testbench.status).toBe(201);
    expect(testbench.body.variant).toBe("testbench");

    for (const body of [plain.body, testbench.body]) {
      for (const field of DELIVERY_FIELDS) expect(body).not.toHaveProperty(field);
      const live = await provisioned(body as Bench);
      for (const field of DELIVERY_FIELDS) {
        expect(state.toPersistedBench(live)).not.toHaveProperty(field);
      }
      expect(live.workspacePath).toBe(body.workspacePath);
    }

    benchManager.teardownBench("demo", plain.body.id, true);
    const steps = benchManager.getBench("demo", plain.body.id)?.teardownSteps ?? [];
    expect(steps.map((s) => s.id)).not.toContain("variant");
    expect(steps[0]?.id).toBe("terminals");
    await cleared("demo", plain.body.id);
  });
});
