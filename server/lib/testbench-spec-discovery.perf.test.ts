/**
 * TSPF-TC-009 / TSPF-NFR-002: the per-spec verification aggregation (#482) adds
 * under 200ms at p95 to spec discovery at the NFR fixture size (25 specs x 500
 * cases, each with a hash-matching results sidecar).
 *
 * The added server work per discovery call is, per spec: one sidecar load
 * (read + JSON.parse + schema validate, via loadResultsFile), one sha256 over the
 * already-parsed plan (computePlanHash), and one effective-status tally over the
 * plan's cases. There is no runtime aggregation-off toggle, so this isolates and
 * times exactly that delta rather than diffing two full-discovery runs: one pass
 * over the whole fixture is what discovery does per call. The budget assertion is
 * gated behind RUN_PERF_HARNESS=1 (the repo's perf convention, mirroring
 * CLI-TC-011 / TC-012): warmup + measured iterations, inline p95, a structured
 * perf-evidence log. A sentinel keeps the file contributing a passing assertion
 * under the default coverage run, and a non-gated structural test pins that the
 * real discoverSpecs aggregates the fixture correctly (so the measured delta is
 * the real work, not a stub).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSpecs, type SpecStatusCounts } from "./testbench-spec-discovery.js";
import { computePlanHash, loadResultsFile } from "./testbench-store.js";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type CaseResult,
  type CaseStatus,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const SPEC_COUNT = 25;
const CASE_COUNT = 500;
const WARMUP = 3;
const ITERATIONS = 30;
const BUDGET_MS = 200;

// The five effective statuses, cycled across a spec's cases so the fixture's
// tally splits evenly (500 / 5 = 100 each) and the status loop exercises every
// branch.
const CASE_STATUSES: CaseStatus[] = ["not_started", "in_progress", "passed", "failed", "blocked"];

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function zeroCounts(): SpecStatusCounts {
  return { not_started: 0, in_progress: 0, passed: 0, failed: 0, blocked: 0 };
}

let repo: string;
const plans = new Map<string, TestCasesPlan>();

function planFor(slug: string): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: slug,
    cases: Array.from({ length: CASE_COUNT }, (_, j) => ({
      id: `TC-${String(j + 1).padStart(4, "0")}`,
      title: `Case ${j + 1}`,
      area: "perf-area",
      level: 1,
      type: "functional",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "do",
          observations: [{ id: "O1", expected: "ok" }],
        },
      ],
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
    })),
  };
}

// Write one spec's test-cases.json and a valid, plan-hash-matching
// test-results.json sidecar with a recorded result for every case (statuses
// cycled through CASE_STATUSES).
function writeSpecAndResults(slug: string, plan: TestCasesPlan): void {
  const dir = path.join(repo, ".specifications", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-cases.json"), JSON.stringify(plan, null, 2));

  const caseResults: Record<string, unknown> = {};
  plan.cases.forEach((planCase, j) => {
    caseResults[planCase.id] = {
      observationMarks: {},
      derivedStatus: CASE_STATUSES[j % CASE_STATUSES.length],
      notes: [],
    };
  });

  fs.writeFileSync(
    path.join(dir, "test-results.json"),
    JSON.stringify(
      {
        $schema: TEST_RESULTS_SCHEMA_ID,
        schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
        planHash: computePlanHash(plan),
        caseResults,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ),
  );
}

// The time-critical delta discovery added for #482, isolated to exactly the
// per-spec aggregation work (loadResultsFile + computePlanHash + effective-status
// tally over the current plan's cases). Mirrors computeVerification's measured
// core.
function aggregateDelta(
  slug: string,
  plan: TestCasesPlan,
): {
  counts: SpecStatusCounts;
  planHashMatch: boolean;
} {
  const { file } = loadResultsFile(repo, slug);
  const planHash = computePlanHash(plan);
  const planHashMatch = file !== null && file.planHash === planHash;
  const caseResults: Record<string, CaseResult> = file?.caseResults ?? {};
  const counts = zeroCounts();
  for (const planCase of plan.cases) {
    const cr = Object.prototype.hasOwnProperty.call(caseResults, planCase.id)
      ? caseResults[planCase.id]
      : undefined;
    const effective: CaseStatus = cr?.statusOverride?.status ?? cr?.derivedStatus ?? "not_started";
    counts[effective] += 1;
  }
  return { counts, planHashMatch };
}

// One full aggregation pass over the whole fixture: what discovery does per call.
// Returns a running sink so the engine cannot elide the work.
function runAggregationPass(): number {
  let sink = 0;
  for (const [slug, plan] of plans) {
    const { counts, planHashMatch } = aggregateDelta(slug, plan);
    sink += counts.passed + counts.failed + (planHashMatch ? 1 : 0);
  }
  return sink;
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "tb-discovery-perf-"));
  for (let s = 0; s < SPEC_COUNT; s++) {
    const slug = `spec-${String(s).padStart(2, "0")}`;
    const plan = planFor(slug);
    plans.set(slug, plan);
    writeSpecAndResults(slug, plan);
  }
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  plans.clear();
});

describe("TSPF-TC-009: discovery aggregates the 25x500 fixture correctly", () => {
  it("returns all 25 specs, each with a hash-matching sidecar and a full 500-case tally", () => {
    const { specs, invalid } = discoverSpecs(repo);
    expect(invalid).toEqual([]);
    expect(specs).toHaveLength(SPEC_COUNT);
    for (const spec of specs) {
      expect(spec.caseCount).toBe(CASE_COUNT);
      const v = spec.verification;
      expect(v.resultsPresent).toBe(true);
      expect(v.resultsValid).toBe(true);
      expect(v.planHashMatch).toBe(true);
      expect(v.aggregationError).toBe(false);
      const sum = Object.values(v.statusCounts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(CASE_COUNT);
      // 500 cases cycled across five statuses => exactly 100 each.
      expect(v.statusCounts).toEqual({
        not_started: 100,
        in_progress: 100,
        passed: 100,
        failed: 100,
        blocked: 100,
      });
    }
  });

  it("the isolated aggregation delta matches discovery's per-spec tally", () => {
    const plan = plans.get("spec-00");
    expect(plan).toBeDefined();
    const { counts, planHashMatch } = aggregateDelta("spec-00", plan as TestCasesPlan);
    expect(planHashMatch).toBe(true);
    expect(counts).toEqual({
      not_started: 100,
      in_progress: 100,
      passed: 100,
      failed: 100,
      blocked: 100,
    });
  });
});

it.runIf(RUN)(
  "TSPF-TC-009: aggregation delta p95 < 200ms over 25 specs x 500 cases",
  () => {
    // Warm up (module/JIT + fs cache) so the first pass does not skew the sample.
    for (let w = 0; w < WARMUP; w++) runAggregationPass();

    const samples: number[] = [];
    let sink = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      sink += runAggregationPass();
      samples.push(performance.now() - t0);
    }

    const p95Ms = p95(samples);
    const maxMs = Math.max(...samples);

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "TSPF-TC-009",
          specCount: SPEC_COUNT,
          caseCount: CASE_COUNT,
          iterations: ITERATIONS,
          p95Ms,
          maxMs,
        },
        null,
        2,
      ),
    );

    expect(sink).toBeGreaterThan(0);
    expect(p95Ms).toBeLessThan(BUDGET_MS);
  },
  120_000,
);

describe("TSPF-TC-009 harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});
