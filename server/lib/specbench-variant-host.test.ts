import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBench } from "../test/fixtures.js";
import { registerSpecbenchVariantHost, specbenchVariantHost } from "./specbench-variant-host.js";
import * as registry from "../services/variant-host-registry.js";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
} from "@roubo/shared/delivery-observation-contract";
import {
  deliveryCrossCheckRunCount,
  forgetDeliveryCrossCheck,
  readDeliveryCrossCheck,
  refreshDeliveryCrossCheckOnEvents,
  setDeliveryCrossCheckDeps,
} from "../services/delivery-cross-check-loader.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-specbench-host-")));
});

afterEach(() => {
  registry.unregisterVariantHost("specbench");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function specBench(overrides: Parameters<typeof makeBench>[0] = {}) {
  const specFolder = path.join(tmp, "repo", ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  return makeBench({
    variant: "specbench",
    workspacePath: path.join(tmp, "ws", "bench-1"),
    focusedSpecPath: specFolder,
    deliveryBindMode: "launch",
    ...overrides,
  });
}

describe("VariantHostRegistry defaults", () => {
  it("a bench whose variant has no host keeps its workspace, its state and its teardown", async () => {
    const plain = makeBench();
    const testbench = makeBench({
      variant: "testbench",
      focusedSpecPath: "/r/.specifications/s/test-cases.json",
    });
    for (const bench of [plain, testbench]) {
      expect(registry.componentRoot(bench)).toBe(bench.workspacePath);
      expect(await registry.verifyVariantState(bench)).toEqual({ ok: true });
      expect(registry.teardownLabel(bench)).toBeUndefined();
      const ctx = { project: undefined, removeWorktree: vi.fn(), stopSession: vi.fn() };
      await registry.beforeTeardown(bench, ctx);
      expect(ctx.removeWorktree).not.toHaveBeenCalled();
      expect(ctx.stopSession).not.toHaveBeenCalled();
    }
  });

  it("routes a variant's ports to the host that registered for it", () => {
    registerSpecbenchVariantHost();
    expect(registry.getVariantHost("specbench")).toBe(specbenchVariantHost);
    expect(registry.getVariantHost("testbench")).toBeUndefined();
    expect(registry.getVariantHost(undefined)).toBeUndefined();
    expect(registry.teardownLabel(specBench())).toBe("Releasing gate pin and session");
  });
});

describe("Spec Bench host: componentRoot", () => {
  it("is the bench workspace while no gate pin is open", () => {
    const bench = specBench();
    expect(specbenchVariantHost.componentRoot(bench)).toBe(bench.workspacePath);
  });

  it("is the pin worktree while a gate sitting has one", () => {
    const pin = path.join(tmp, "ws", "bench-1-pin");
    const bench = specBench({ gatePin: { gateId: "G1", workspacePath: pin, createdAt: "now" } });
    expect(specbenchVariantHost.componentRoot(bench)).toBe(pin);
  });

  it("falls back to the workspace when the recorded pin path fails the safe-path allowlist", () => {
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: "/tmp/pin;rm -rf ~", createdAt: "now" },
    });
    expect(specbenchVariantHost.componentRoot(bench)).toBe(bench.workspacePath);
  });
});

describe("Spec Bench host: verifyVariantState", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

  it("is sound while the spec folder and the pin are on disk", async () => {
    const pin = path.join(tmp, "pin");
    fs.mkdirSync(pin);
    const bench = specBench({ gatePin: { gateId: "G1", workspacePath: pin, createdAt: "now" } });
    expect(await specbenchVariantHost.verifyVariantState(bench)).toEqual({ ok: true });
  });

  it("reports a missing spec folder", async () => {
    const bench = specBench({ focusedSpecPath: path.join(tmp, "repo", ".specifications", "gone") });
    const result = await specbenchVariantHost.verifyVariantState(bench);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Spec folder not found/);
  });

  it("reports a missing pin worktree", async () => {
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: path.join(tmp, "no-pin"), createdAt: "now" },
    });
    const result = await specbenchVariantHost.verifyVariantState(bench);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Gate pin worktree not found for gate G1/);
  });

  it("SB-TC-009 reads the pin's commit without blocking: the event loop turns before the check settles", async () => {
    const workspace = path.join(tmp, "ws", "bench-1");
    fs.mkdirSync(workspace, { recursive: true });
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "commit", "-q", "--allow-empty", "-m", "one");
    const commit = git(workspace, "rev-parse", "HEAD");
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: workspace, commit, createdAt: "now" },
    });
    const pending = specbenchVariantHost.verifyVariantState(bench);
    // A check that read the commit synchronously would have settled before
    // this line, so its continuation would win the race on a microtask. An
    // awaited child process cannot finish before the next macrotask runs.
    const tick = new Promise<"tick">((resolve) => setImmediate(() => resolve("tick")));
    const first = await Promise.race([pending.then(() => "check" as const), tick]);
    expect(first).toBe("tick");
    expect(await pending).toEqual({ ok: true });
  });

  it("SB-TC-009 verifies a submodule's gate commit in that submodule of the pin", async () => {
    const pin = path.join(tmp, "ws", "bench-1-pin");
    const sub = path.join(pin, "app");
    fs.mkdirSync(sub, { recursive: true });
    git(pin, "init", "-q", "-b", "main");
    git(pin, "commit", "-q", "--allow-empty", "-m", "superproject");
    git(sub, "init", "-q", "-b", "main");
    git(sub, "commit", "-q", "--allow-empty", "-m", "one");
    const first = git(sub, "rev-parse", "HEAD");
    git(sub, "commit", "-q", "--allow-empty", "-m", "two");
    const second = git(sub, "rev-parse", "HEAD");
    const pinned = (submodulePath: string, commit: string) =>
      specBench({
        gatePin: { gateId: "G1", workspacePath: pin, commit, submodulePath, createdAt: "now" },
      });

    expect(await specbenchVariantHost.verifyVariantState(pinned("app", second))).toEqual({
      ok: true,
    });
    const moved = await specbenchVariantHost.verifyVariantState(pinned("app", first));
    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.error).toContain(`expected commit ${first}, found ${second}`);
    // A recorded submodule path that leaves the pin is never read.
    const outside = await specbenchVariantHost.verifyVariantState(pinned("../elsewhere", second));
    expect(outside.ok).toBe(false);
    expect(!outside.ok && outside.error).toContain(`expected commit ${second}, found none`);
  });

  it("SB-TC-009 a server restart with a pinned bench verifies the pin path and commit against the bench record", async () => {
    const workspace = path.join(tmp, "ws", "bench-1");
    fs.mkdirSync(workspace, { recursive: true });
    git(workspace, "init", "-q", "-b", "main");
    const commits = ["one", "two"].map((content) => {
      fs.writeFileSync(path.join(workspace, "build.txt"), `${content}\n`);
      git(workspace, "add", "build.txt");
      git(workspace, "commit", "-q", "-m", content);
      return git(workspace, "rev-parse", "HEAD");
    });
    const pin = `${workspace}-pin`;
    git(workspace, "worktree", "add", "--detach", pin, commits[0]);
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: pin, commit: commits[0], createdAt: "now" },
      deliverySitting: { gateId: "G1", openedAt: "now", commit: commits[0], state: "open" },
    });

    // Step 1: the pin is at the recorded commit, so the bench is sound and
    // reconcile returns it to its previous status.
    expect(await specbenchVariantHost.verifyVariantState(bench)).toEqual({ ok: true });

    // Step 2: the pin moved to another commit by hand.
    git(pin, "checkout", "-q", "--detach", commits[1]);
    const moved = await specbenchVariantHost.verifyVariantState(bench);
    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.error).toContain(`expected commit ${commits[0]}`);
    expect(!moved.ok && moved.error).toContain(`found ${commits[1]}`);

    // And the pin gone: the error names the expected commit and finds none.
    git(workspace, "worktree", "remove", "--force", pin);
    const missing = await specbenchVariantHost.verifyVariantState(bench);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toMatch(/Gate pin worktree not found for gate G1/);
    expect(!missing.ok && missing.error).toContain(`expected commit ${commits[0]}, found none`);
  });
});

describe("Spec Bench host: beforeTeardown", () => {
  it("removes the pin before it stops the session, and never touches the spec folder", async () => {
    const pin = path.join(tmp, "ws", "bench-1-pin");
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: pin, createdAt: "now" },
      deliverySitting: { gateId: "G1", sessionId: "s-1", openedAt: "now" },
    });
    const calls: string[] = [];
    await specbenchVariantHost.beforeTeardown(bench, {
      project: undefined,
      removeWorktree: async (p) => {
        calls.push(`pin ${p}`);
      },
      stopSession: (id) => {
        calls.push(`session ${id}`);
      },
    });

    expect(calls).toEqual([`pin ${pin}`, "session s-1"]);
    expect(bench.gatePin).toBeUndefined();
    expect(bench.deliverySitting).toBeUndefined();
    expect(fs.existsSync(bench.focusedSpecPath ?? "")).toBe(true);
  });

  it("stops at the pin when its removal fails, so the session is not stopped out of order", async () => {
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: path.join(tmp, "pin"), createdAt: "now" },
      deliverySitting: { gateId: "G1", sessionId: "s-1", openedAt: "now" },
    });
    const stopSession = vi.fn();
    await expect(
      specbenchVariantHost.beforeTeardown(bench, {
        project: undefined,
        removeWorktree: async () => {
          throw new Error("worktree busy");
        },
        stopSession,
      }),
    ).rejects.toThrow("worktree busy");
    expect(stopSession).not.toHaveBeenCalled();
    expect(bench.gatePin).toBeDefined();
  });

  it("leaves the checkout's spec folder and its files untouched, and never copies the workspace record there", async () => {
    const bench = specBench({
      deliverySitting: { gateId: "G1", sessionId: "s-1", openedAt: "now" },
    });
    const checkout = bench.focusedSpecPath ?? "";
    fs.writeFileSync(path.join(checkout, "test-results.json"), '{"results":[]}\n');
    fs.writeFileSync(path.join(checkout, "delivery-observation.json"), '{"checkout":1}\n');
    const workspaceFolder = path.join(bench.workspacePath, ".specifications", "fixture-spec");
    fs.mkdirSync(workspaceFolder, { recursive: true });
    fs.writeFileSync(path.join(workspaceFolder, "delivery-observation.json"), '{"seq":7}\n');

    await specbenchVariantHost.beforeTeardown(bench, {
      project: undefined,
      removeWorktree: vi.fn(),
      stopSession: vi.fn(),
    });

    expect(fs.readdirSync(checkout).sort()).toEqual([
      "delivery-observation.json",
      "test-results.json",
    ]);
    expect(fs.readFileSync(path.join(checkout, "delivery-observation.json"), "utf8")).toBe(
      '{"checkout":1}\n',
    );
    expect(fs.readFileSync(path.join(checkout, "test-results.json"), "utf8")).toBe(
      '{"results":[]}\n',
    );
  });

  it("stops the bench's cross-check on Clear bench: its watch closes and an event runs no refresh", async () => {
    const bench = specBench();
    fs.mkdirSync(path.join(bench.workspacePath, ".specifications", "fixture-spec"), {
      recursive: true,
    });
    const close = vi.fn();
    setDeliveryCrossCheckDeps({
      readGit: async () => ({}),
      resolveGitHubRepository: async () => null,
      githubToken: async () => null,
      fetch: vi.fn(),
      watch: () => ({ close }),
    });
    try {
      await readDeliveryCrossCheck(bench);
      expect(deliveryCrossCheckRunCount(bench.projectId, bench.id)).toBe(1);

      await specbenchVariantHost.beforeTeardown(bench, {
        project: undefined,
        removeWorktree: vi.fn(),
        stopSession: vi.fn(),
      });

      expect(close).toHaveBeenCalledTimes(1);
      expect(deliveryCrossCheckRunCount(bench.projectId, bench.id)).toBe(0);
      await refreshDeliveryCrossCheckOnEvents(bench, [
        {
          $schema: DELIVERY_EVENT_SCHEMA_ID,
          schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
          delivery_id: "fixture-delivery",
          type: "unit.boundary",
          seq: 8,
          ts: "2026-10-16T09:40:00Z",
          payload: {},
        },
      ]);
      expect(deliveryCrossCheckRunCount(bench.projectId, bench.id)).toBe(0);
    } finally {
      forgetDeliveryCrossCheck();
      setDeliveryCrossCheckDeps();
    }
  });

  it("does nothing beyond clearing the fields when no sitting is open", async () => {
    const bench = specBench();
    const ctx = { project: undefined, removeWorktree: vi.fn(), stopSession: vi.fn() };
    await specbenchVariantHost.beforeTeardown(bench, ctx);
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    expect(ctx.stopSession).not.toHaveBeenCalled();
  });
});
