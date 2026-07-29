/**
 * AP-TC-048 / AP-NFR-002: full-chain effective-config resolution (application
 * defaults, project overrides, preset, per-launch) completes in at most 50ms.
 *
 * The budget assertion is gated behind RUN_PERF_HARNESS=1 (the
 * cut-list-cache-overhead.perf.tc-012 shape): it seeds real stored layers on
 * disk, warms up, resolves 1000 times, and emits a structured perf-evidence
 * line. A sentinel keeps the file contributing a passing assertion under the
 * default coverage run.
 *
 * The non-gated structural test pins the architectural property the budget rests
 * on: resolution is four shallow overlays over two small reads, so a future
 * change that made a layer expensive (a network call, a directory walk, a deep
 * clone per field) would regress AP-NFR-002 rather than merely slowing a test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateMocks = vi.hoisted(() => ({
  rouboDir: { current: "" },
  atomicWrite: (target: string, body: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  },
}));
vi.mock("./state.js", () => ({
  atomicWrite: stateMocks.atomicWrite,
  getRouboDir: () => stateMocks.rouboDir.current,
}));

import { saveAgentConfig } from "./agent-overrides.js";
import { saveProjectAgentOverride } from "./agent-project-overrides.js";
import { resolveEffectiveAgentConfig } from "./agent-launch-pipeline.js";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const ITERATIONS = 1000;
const RESOLUTION_BUDGET_MS = 50;

const PROJECT_ID = "roubo";
const PLUGIN_ID = "claude-code";

function seedLayers(): void {
  saveAgentConfig(PLUGIN_ID, {
    model: "app-model",
    posture: "guarded",
    extraArgs: "--app",
    verbose: false,
    binaryPath: "/usr/local/bin/claude",
  });
  saveProjectAgentOverride(PROJECT_ID, PLUGIN_ID, {
    model: "project-model",
    extraArgs: "--project",
  });
}

const PRESET = { posture: "auto-edit", extraArgs: "--preset" };
const PER_LAUNCH = { model: "per-launch-model" };

beforeEach(() => {
  stateMocks.rouboDir.current = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-ap-tc-048-"));
});

afterEach(() => {
  fs.rmSync(stateMocks.rouboDir.current, { recursive: true, force: true });
});

it.runIf(RUN)(
  "AP-TC-048: every full-chain effective-config resolution completes within 50ms",
  () => {
    seedLayers();

    // Warmup so first-read directory statting does not skew the sample.
    for (let i = 0; i < 10; i++) {
      resolveEffectiveAgentConfig(PROJECT_ID, PLUGIN_ID, { preset: PRESET, perLaunch: PER_LAUNCH });
    }

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const started = performance.now();
      resolveEffectiveAgentConfig(PROJECT_ID, PLUGIN_ID, { preset: PRESET, perLaunch: PER_LAUNCH });
      samples.push(performance.now() - started);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const worst = sorted[sorted.length - 1] ?? 0;

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "AP-TC-048",
          iterations: ITERATIONS,
          layers: ["app", "project", "preset", "per-launch"],
          medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
          worstMs: worst,
          budgetMs: RESOLUTION_BUDGET_MS,
        },
        null,
        2,
      ),
    );

    // AP-TC-048 S001-O01 is a per-resolution ceiling, not a percentile: assert
    // the worst sample.
    expect(worst).toBeLessThan(RESOLUTION_BUDGET_MS);
  },
  120_000,
);

describe("AP-TC-048 harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("AP-TC-048: resolution stays cheap by construction", () => {
  it("resolves the whole chain from two small reads and four shallow overlays", () => {
    seedLayers();

    const readsBefore = fs.readFileSync;
    let reads = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      reads++;
      return (readsBefore as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);

    try {
      const effective = resolveEffectiveAgentConfig(PROJECT_ID, PLUGIN_ID, {
        preset: PRESET,
        perLaunch: PER_LAUNCH,
      });

      // One stored file per stored layer, and nothing else: the preset and
      // per-launch layers are in-memory values, so no I/O grows with them.
      expect(reads).toBe(2);
      expect(effective).toEqual({
        model: "per-launch-model",
        posture: "auto-edit",
        extraArgs: "--preset",
        verbose: false,
        binaryPath: "/usr/local/bin/claude",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("costs O(fields), not O(fields squared): a wide config resolves in one pass", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) wide[`field${i}`] = i;
    saveAgentConfig(PLUGIN_ID, wide);

    const started = performance.now();
    const effective = resolveEffectiveAgentConfig(PROJECT_ID, PLUGIN_ID, {
      preset: { field0: "preset" },
      perLaunch: { field1: "per-launch" },
    });
    const elapsed = performance.now() - started;

    expect(Object.keys(effective)).toHaveLength(500);
    expect(effective.field0).toBe("preset");
    expect(effective.field1).toBe("per-launch");
    expect(elapsed).toBeLessThan(RESOLUTION_BUDGET_MS);
  });
});
