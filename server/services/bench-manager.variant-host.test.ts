// The bench manager consults the VariantHostRegistry at each component cwd
// site, in reconcile and in teardown (SB-FR-004, SB-NFR-008). A fake host for
// the `specbench` variant answers a root that is not the bench workspace, so
// every site that still used the workspace would show here. One test swaps in
// the real Spec Bench host to check a gate pin across a restart (SB-TC-009).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistedBench, RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { makeConfig } from "../test/fixtures.js";

const hoisted = vi.hoisted(() => ({
  project: undefined as RegisteredProject | undefined,
  persisted: [] as PersistedBench[],
  imperative: false,
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    ...actual,
    loadState: vi.fn(() => ({ benches: hoisted.persisted })),
    addBench: vi.fn(),
    updateBench: vi.fn(),
    removeBench: vi.fn(),
    loadSettings: vi.fn(() => ({ benches: {} })),
    getProjectPermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
    setProjectPermissions: vi.fn(),
  };
});
vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(() => hoisted.project),
  getProjects: vi.fn(() => []),
}));
vi.mock("./component-plugin-registry.js", () => ({
  resolveBinding: vi.fn(() => ({ pluginId: "fixture-plugin" })),
  isNotBound: vi.fn((b: { reason?: string }) => b.reason !== undefined),
}));
vi.mock("./plugin-manager.js", () => ({
  getRecord: vi.fn(() =>
    hoisted.imperative
      ? {
          manifest: {
            componentMode: "imperative",
            permissions: {
              network: { hosts: [] },
              credentials: { slots: [] },
              filesystem: { paths: [] },
              processes: false,
            },
          },
        }
      : undefined,
  ),
  invoke: vi.fn(async (_id: string, method: string) => {
    if (method === "translate")
      return { kind: "docker", composeFile: "compose.yml", service: "db" };
    if (method === "health") return { status: "running" };
    return undefined;
  }),
  registerBrokerContext: vi.fn(),
  unregisterBrokerContext: vi.fn(),
}));
vi.mock("./lifecycle-engine.js", () => ({
  runDescriptor: vi.fn(async () => ({ status: "running" })),
}));
vi.mock("./docker.js", () => ({
  getComposeProjectName: vi.fn(() => "roubo-demo-bench-1"),
  composeStop: vi.fn(async () => undefined),
  composeDown: vi.fn(async () => undefined),
  getContainerStatuses: vi.fn(async () => new Map()),
}));
vi.mock("./process-manager.js", () => ({
  stopProcess: vi.fn(async () => undefined),
  getProcessStatus: vi.fn(() => ({ alive: false, exitCode: null })),
  getProcessPid: vi.fn(),
}));
vi.mock("./terminal.js", () => ({ destroyBenchSessions: vi.fn(), destroySession: vi.fn() }));
vi.mock("./notification.js", () => ({ createNotification: vi.fn() }));
vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
  broadcastBenchStatus: vi.fn(),
  broadcastComponentStatusChange: vi.fn(),
  clearComponentStatusForBench: vi.fn(),
}));

import * as pluginManager from "./plugin-manager.js";
import * as dockerService from "./docker.js";
import { runDescriptor } from "./lifecycle-engine.js";
import * as benchManager from "./bench-manager.js";
import {
  registerVariantHost,
  unregisterVariantHost,
  type VariantHost,
} from "./variant-host-registry.js";
import { specbenchVariantHost } from "../lib/specbench-variant-host.js";

// The descriptor cache is module state keyed by project, bench and component,
// so each test takes a project id of its own.
let projectCount = 0;
let PID = "demo";
let tmp: string;
let workspace: string;
let root: string;
let host: VariantHost;

function liveBench() {
  const bench = benchManager.getBench(PID, 1);
  if (!bench) throw new Error("bench 1 is not live");
  return bench;
}

function invokeCalls(method: string): unknown[] {
  return vi
    .mocked(pluginManager.invoke)
    .mock.calls.filter((c) => c[1] === method)
    .map((c) => c[2]);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-variant-host-")));
  workspace = path.join(tmp, "bench-1");
  root = path.join(tmp, "bench-1-pin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(root);
  hoisted.imperative = false;
  PID = `demo-${++projectCount}`;
  hoisted.project = {
    id: PID,
    repoPath: path.join(tmp, "repo"),
    config: makeConfig(),
    configValid: true,
    settings: DEFAULT_PROJECT_SETTINGS,
  } as RegisteredProject;
  hoisted.persisted = [
    {
      id: 1,
      projectId: PID,
      branch: "bench-1",
      workspacePath: workspace,
      ports: { backend: 5001 },
      createdAt: "2026-01-01T00:00:00.000Z",
      variant: "specbench",
      focusedSpecPath: path.join(tmp, "repo", ".specifications", "fixture-spec"),
      deliveryBindMode: "launch",
      componentSetupState: { backend: true },
    },
  ];
  host = {
    teardownLabel: "Releasing fixture state",
    componentRoot: vi.fn(() => root),
    verifyVariantState: vi.fn(() => ({ ok: true as const })),
    beforeTeardown: vi.fn(async () => undefined),
  };
  registerVariantHost("specbench", host);
  benchManager.dropProjectBenches(PID);
  benchManager.initialize();
});

afterEach(() => {
  benchManager.dropProjectBenches(PID);
  // A module mock keeps its implementation across tests (restoreMocks does not
  // reset it), so a test that reports a running container hands it back here.
  vi.mocked(dockerService.getContainerStatuses).mockImplementation(async () => new Map());
  unregisterVariantHost("specbench");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("component cwd sites consult the variant host", () => {
  it("SB-FR-004: a declarative start translates and runs at the component root", async () => {
    await benchManager.startComponent(PID, 1, "backend");

    const [translate] = invokeCalls("translate") as Array<{ context: { workspacePath: string } }>;
    expect(translate.context.workspacePath).toBe(root);
    const lifecycleCtx = vi.mocked(runDescriptor).mock.calls[0][1];
    expect(lifecycleCtx.workspacePath).toBe(root);
  });

  it("SB-FR-004: a declarative stop resolves the descriptor and stops compose at the component root", async () => {
    await benchManager.stopComponent(PID, 1, "backend");

    const [translate] = invokeCalls("translate") as Array<{ context: { workspacePath: string } }>;
    expect(translate.context.workspacePath).toBe(root);
    expect(dockerService.composeStop).toHaveBeenCalledWith(
      "roubo-demo-bench-1",
      "compose.yml",
      root,
      "db",
    );
  });

  it("SB-FR-004: an imperative start, health check and stop all run at the component root", async () => {
    hoisted.imperative = true;
    await benchManager.startComponent(PID, 1, "backend");
    expect(invokeCalls("start")).toEqual([expect.objectContaining({ workspacePath: root })]);

    const bench = liveBench();
    bench.components.backend.status = "running";
    bench.components.backend.startedAt = undefined;
    await benchManager.refreshComponentStatuses();
    expect(invokeCalls("health")).toEqual([expect.objectContaining({ workspacePath: root })]);

    await benchManager.stopComponent(PID, 1, "backend");
    expect(invokeCalls("stop")).toEqual([expect.objectContaining({ workspacePath: root })]);
    expect(invokeCalls("cleanup")).toEqual([expect.objectContaining({ workspacePath: root })]);
  });

  it("a bench with no variant still runs its components in its workspace", async () => {
    hoisted.persisted = [
      { ...hoisted.persisted[0], variant: undefined, deliveryBindMode: undefined },
    ];
    benchManager.dropProjectBenches(PID);
    benchManager.initialize();

    await benchManager.startComponent(PID, 1, "backend");
    const [translate] = invokeCalls("translate") as Array<{ context: { workspacePath: string } }>;
    expect(translate.context.workspacePath).toBe(workspace);
    expect(host.componentRoot).not.toHaveBeenCalled();
    const bench = liveBench();
    expect(bench).not.toHaveProperty("deliveryBindMode");
  });
});

describe("reconcile and teardown consult the variant host", () => {
  it("SB-FR-004: reconcile puts a bench in error when its variant state is not sound", async () => {
    vi.mocked(host.verifyVariantState).mockReturnValue({
      ok: false,
      error: "Spec folder not found",
    });
    await benchManager.reconcile();
    const bench = liveBench();
    expect(host.verifyVariantState).toHaveBeenCalledWith(bench);
    expect(bench.status).toBe("error");
    expect(bench.error).toBe("Spec folder not found");
  });

  it("SB-TC-009 a server restart with a pinned bench verifies the pin and errors when it moved", async () => {
    // The real Spec Bench host, spied so the test sees what reconcile asked it.
    const verify = vi.fn(specbenchVariantHost.verifyVariantState);
    registerVariantHost("specbench", { ...specbenchVariantHost, verifyVariantState: verify });

    // The bench workspace is a repository with two commits; the gate pin is a
    // detached worktree of it at the first.
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
        { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      ).trim();
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "gate commit");
    const gateCommit = git(workspace, "rev-parse", "HEAD");
    git(workspace, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "later commit");
    const laterCommit = git(workspace, "rev-parse", "HEAD");
    fs.rmSync(root, { recursive: true, force: true });
    git(workspace, "worktree", "add", "-q", "--detach", root, gateCommit);
    fs.mkdirSync(path.join(tmp, "repo", ".specifications", "fixture-spec"), { recursive: true });

    // S001: a sitting is open, so the bench records the pin and its commit.
    hoisted.persisted = [
      {
        ...hoisted.persisted[0],
        gatePin: {
          gateId: "gate-after-a",
          workspacePath: root,
          commit: gateCommit,
          createdAt: "2026-01-01T01:00:00.000Z",
        },
        deliverySitting: {
          gateId: "gate-after-a",
          commit: gateCommit,
          openedAt: "2026-01-01T01:00:00.000Z",
        },
      },
    ];
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-demo-bench-1/db", { status: "running", id: "c1" }]]),
    );
    const restart = async () => {
      benchManager.dropProjectBenches(PID);
      benchManager.initialize();
      verify.mockClear();
      await benchManager.reconcile();
      return liveBench();
    };
    const before = await restart();
    const previousStatus = before.status;
    expect(previousStatus).toBe("active");

    // Restart: reconcile verifies the pin path and commit against the bench
    // record, and the bench comes back with its previous status.
    const restarted = await restart();
    expect(verify).toHaveBeenCalledTimes(1);
    const [verified] = verify.mock.calls[0];
    expect(verified.gatePin).toMatchObject({
      gateId: "gate-after-a",
      workspacePath: root,
      commit: gateCommit,
    });
    await expect(verify.mock.results[0].value).resolves.toEqual({ ok: true });
    expect(restarted.status).toBe(previousStatus);
    expect(restarted.error).toBeUndefined();

    // S002: the pin worktree is moved to another commit by hand, then the
    // server restarts again. The bench is in error, naming both commits.
    git(root, "checkout", "-q", "--detach", laterCommit);
    const moved = await restart();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(moved.status).toBe("error");
    expect(moved.error).toContain(`expected commit ${gateCommit}`);
    expect(moved.error).toContain(`found ${laterCommit}`);
  });

  it("teardown runs the variant's beforeTeardown first, before the terminals close", async () => {
    const order: string[] = [];
    vi.mocked(host.beforeTeardown).mockImplementation(async () => {
      order.push("variant");
    });
    const terminal = await import("./terminal.js");
    vi.mocked(terminal.destroyBenchSessions).mockImplementation(() => {
      order.push("terminals");
    });

    const bench = benchManager.teardownBench(PID, 1, false);
    expect(bench.teardownSteps.map((s) => s.id)[0]).toBe("variant");
    for (let i = 0; i < 100 && benchManager.getBench(PID, 1); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(benchManager.getBench(PID, 1)).toBeUndefined();
    expect(order).toEqual(["variant", "terminals"]);
  });

  it("a failing beforeTeardown keeps the bench so Clear can run again", async () => {
    vi.mocked(host.beforeTeardown).mockRejectedValue(new Error("pin busy"));
    benchManager.teardownBench(PID, 1, false);
    for (let i = 0; i < 100 && benchManager.getBench(PID, 1)?.status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const bench = liveBench();
    expect(bench.status).toBe("error");
    expect(bench.error).toMatch(/pin busy/);
    expect(bench.teardownSteps.find((s) => s.id === "variant")?.status).toBe("error");
  });
});
