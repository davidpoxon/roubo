import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeBench } from "../test/fixtures.js";
import { registerSpecbenchVariantHost, specbenchVariantHost } from "./specbench-variant-host.js";
import * as registry from "../services/variant-host-registry.js";

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
      expect(registry.verifyVariantState(bench)).toEqual({ ok: true });
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
  it("is sound while the spec folder and the pin are on disk", () => {
    const pin = path.join(tmp, "pin");
    fs.mkdirSync(pin);
    const bench = specBench({ gatePin: { gateId: "G1", workspacePath: pin, createdAt: "now" } });
    expect(specbenchVariantHost.verifyVariantState(bench)).toEqual({ ok: true });
  });

  it("reports a missing spec folder", () => {
    const bench = specBench({ focusedSpecPath: path.join(tmp, "repo", ".specifications", "gone") });
    const result = specbenchVariantHost.verifyVariantState(bench);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Spec folder not found/);
  });

  it("reports a missing pin worktree", () => {
    const bench = specBench({
      gatePin: { gateId: "G1", workspacePath: path.join(tmp, "no-pin"), createdAt: "now" },
    });
    const result = specbenchVariantHost.verifyVariantState(bench);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Gate pin worktree not found for gate G1/);
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

  it("does nothing beyond clearing the fields when no sitting is open", async () => {
    const bench = specBench();
    const ctx = { project: undefined, removeWorktree: vi.fn(), stopSession: vi.fn() };
    await specbenchVariantHost.beforeTeardown(bench, ctx);
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    expect(ctx.stopSession).not.toHaveBeenCalled();
  });
});
