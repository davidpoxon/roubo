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
 *
 * SATCA-TC-043 / SATCA-NFR-002 (#771) rides the same fixture for the second
 * per-spec read discovery grew: the lifecycle manifest read added by #765. That
 * budget is relative ("no more than 15% above the pre-change baseline"), and
 * there is no lifecycle-off toggle to time the pre-change code against, so the
 * baseline is DERIVED inside the run: withMs is a full discoverSpecs pass,
 * deltaMs is an isolated readSpecLifecycle pass over the same 25 slugs, and the
 * baseline is withMs - deltaMs. That is a within-run derivation, not a
 * historical measurement of pre-#765 code; it holds because computeLifecycle is
 * a single call inside discovery's existing per-spec loop, so the work it added
 * is exactly that isolated pass. An absolute millisecond baseline would be
 * machine-dependent and could not be asserted on at all.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSpecs, type SpecStatusCounts } from "./testbench-spec-discovery.js";
import { readSpecLifecycle } from "./testbench-spec-lifecycle.js";
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
// SATCA-NFR-002: the lifecycle read may add no more than 15% on top of the
// baseline discovery cost. Fewer iterations than the isolated-delta harness
// above because each one is a whole discoverSpecs pass over 25 x 500 cases.
const DISCOVERY_ITERATIONS = 10;
const LIFECYCLE_BUDGET_RATIO = 0.15;
// Every fifth fixture spec carries a lifecycle record (5 of 25), alternating
// plain-archived and superseded. The other 20 have no manifest.json at all, so
// one pass exercises both the reader's hit path and its far more common
// fail-open miss (the ENOENT early return), which is what discovery actually
// sees in a repo where a handful of specs have been archived.
const ARCHIVED_EVERY = 5;
const ARCHIVED_COUNT = SPEC_COUNT / ARCHIVED_EVERY;

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

// The lifecycle subtree a given fixture spec carries, or null when it should
// have no manifest.json at all. Alternates plain-archived and superseded so both
// record shapes (SATCA-FR-013) are validated on the measured path.
function lifecycleRecordFor(index: number): Record<string, unknown> | null {
  if (index % ARCHIVED_EVERY !== 0) return null;
  return index % (ARCHIVED_EVERY * 2) === 0
    ? { archived: true, reason: "Shipped" }
    : { archived: true, supersededBy: `spec-${String(index + 1).padStart(2, "0")}` };
}

// Write a spec's manifest.json carrying the lifecycle subtree plus the sibling
// keys product-dev owns, so the reader does the real pluck-and-validate rather
// than parsing a one-key file.
function writeManifest(slug: string, lifecycle: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(repo, ".specifications", slug, "manifest.json"),
    JSON.stringify(
      {
        schema_version: "1.0.0",
        slug,
        stage: "breakdown",
        id_code: "PERF",
        id_counters: { FR: 12, NFR: 4, US: 6, TC: 43 },
        spikes: [],
        lifecycle,
      },
      null,
      2,
    ),
  );
}

// One isolated pass of exactly the work #765 added to discovery: readSpecLifecycle
// once per slug, over the same 25 slugs discoverSpecs walks. computeLifecycle is a
// single call in discovery's existing per-spec loop, so this pass is the whole of
// the delta. Returns a running sink so the engine cannot elide the work.
function runLifecyclePass(): number {
  let sink = 0;
  for (const slug of plans.keys()) {
    const { lifecycle, recordError } = readSpecLifecycle(repo, slug);
    sink += (lifecycle !== null ? 1 : 0) + (recordError !== null ? 1 : 0);
  }
  return sink;
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
    const lifecycle = lifecycleRecordFor(s);
    if (lifecycle) writeManifest(slug, lifecycle);
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

describe("SATCA-TC-043: discovery reads each spec's lifecycle record once", () => {
  it("resolves the archived fixture specs and leaves the manifest-less ones live", () => {
    const { specs } = discoverSpecs(repo);
    expect(specs).toHaveLength(SPEC_COUNT);
    const archived = specs.filter((s) => s.lifecycle.archived);
    expect(archived).toHaveLength(ARCHIVED_COUNT);
    // Both record shapes survive the read, and nothing degraded.
    expect(archived.filter((s) => s.lifecycle.supersededBy !== null)).toHaveLength(2);
    expect(archived.filter((s) => s.lifecycle.reason !== null)).toHaveLength(3);
    expect(specs.every((s) => s.lifecycle.recordError === null)).toBe(true);
  });

  it("the isolated lifecycle pass sees the same records discovery does", () => {
    expect(runLifecyclePass()).toBe(ARCHIVED_COUNT);
  });

  // The Technical Note on #771: the manifest is one small file per spec, so a
  // regression here means something is being read more than once. Pinned as an
  // assertion rather than left as prose, and non-gated so it guards every run.
  it("opens manifest.json exactly once per spec per discoverSpecs pass", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    try {
      const { specs } = discoverSpecs(repo);
      expect(specs).toHaveLength(SPEC_COUNT);
      const manifestReads = readFileSync.mock.calls
        .map(([target]) => String(target))
        .filter((target) => target.endsWith(`${path.sep}manifest.json`));
      // One attempt per spec (a miss still costs one open), and no slug twice.
      expect(manifestReads).toHaveLength(SPEC_COUNT);
      expect(new Set(manifestReads).size).toBe(SPEC_COUNT);
    } finally {
      readFileSync.mockRestore();
    }
  });
});

it.runIf(RUN)(
  "SATCA-TC-043: the lifecycle read adds <= 15% over 25 specs of discovery",
  () => {
    // Warm up both passes (module/JIT + fs cache) so the first sample of either
    // does not skew its own p95 against the other's.
    for (let w = 0; w < WARMUP; w++) {
      discoverSpecs(repo);
      runLifecyclePass();
    }

    const withSamples: number[] = [];
    const deltaSamples: number[] = [];
    let sink = 0;
    for (let i = 0; i < DISCOVERY_ITERATIONS; i++) {
      const t0 = performance.now();
      sink += discoverSpecs(repo).specs.length;
      withSamples.push(performance.now() - t0);

      const t1 = performance.now();
      sink += runLifecyclePass();
      deltaSamples.push(performance.now() - t1);
    }

    const withMs = p95(withSamples);
    const deltaMs = p95(deltaSamples);
    // Derived, not historical: see the file header.
    const baselineMs = withMs - deltaMs;
    const ratio = baselineMs > 0 ? deltaMs / baselineMs : Number.POSITIVE_INFINITY;

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "SATCA-TC-043",
          surface: "discovery",
          specCount: SPEC_COUNT,
          archivedCount: ARCHIVED_COUNT,
          iterations: DISCOVERY_ITERATIONS,
          withMs,
          deltaMs,
          baselineMs,
          ratio,
          budgetRatio: LIFECYCLE_BUDGET_RATIO,
        },
        null,
        2,
      ),
    );

    expect(sink).toBeGreaterThan(0);
    expect(baselineMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThanOrEqual(LIFECYCLE_BUDGET_RATIO * baselineMs);
  },
  120_000,
);

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
