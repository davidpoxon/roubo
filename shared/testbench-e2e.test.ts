// Integration-level E2E test for the schema author -> generate -> validate
// journey, asserting the authoritative e2e_flow case TC-056 end to end (#442).
//
// This is the journey's drift guard: it exercises the full pipeline through the
// already-pure, importable seams of the slices it spans, rather than
// re-implementing any of them. The slices owned by this work unit are #405
// (versioned $id contracts), #408 (zod-to-JSON-Schema spike), #410 (runtime
// validators) and #411 (generate script + CI drift guard); a failing step is
// localised back to the owning slice via OWNING_SLICES below (FR-020).
//
// Validation note: the repo validates with zod (no ajv / JSON-Schema instance
// validator is a dependency). We therefore validate each conforming fixture via
// the zod validators (validateTestCases / validateTestResults), which are the
// exact contract the JSON Schema is generated from, AND assert the generated
// JSON Schema file's structural integrity (written, parses, $id present and
// semver-versioned). Introducing ajv to do strict JSON-Schema-instance
// validation is deliberately avoided (no new dependency); see #442.

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import {
  TestCasesPlanSchema,
  TestResultsFileSchema,
  validateTestCases,
  validateTestResults,
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
  type TestResultsFile,
} from "./testbench-contracts.js";
import { renderSchema } from "../scripts/generate-schema.js";

// The slices this journey integrates, from #442's blocked_by / covers set.
// Reported when a step diverges so a failure is attributable (FR-020).
const OWNING_SLICES = "#405, #408, #410, #411";

// A semver-versioned $id URI ends in /vX.Y.Z.json (the #408 spike decision).
const SEMVER_ID = /\/v\d+\.\d+\.\d+\.json$/;

// Canonical TC-056 step labels, declared once as the single source of truth.
// They are both the labels the journey runs under and the expected sequence the
// terminal drift guard asserts against (AC5): if a step is dropped or reordered,
// the recorded run no longer equals TC056_SEQUENCE and the test fails.
const TC056_STEPS = {
  generateCases:
    "Run the generate script targeting the test-cases schema, then confirm schema/test-cases.schema.json is written",
  generateResults:
    "Run the generate script targeting the test-results schema, then confirm schema/test-results.schema.json is written",
  validateCases:
    "Validate a conforming test-cases.json fixture against the generated test-cases schema",
  validateResults:
    "Validate a conforming test-results.json fixture against the generated test-results schema",
} as const;
const TC056_SEQUENCE = [
  TC056_STEPS.generateCases,
  TC056_STEPS.generateResults,
  TC056_STEPS.validateCases,
  TC056_STEPS.validateResults,
];

// ── Conforming fixtures (AC3, AC4) ──
//
// The results fixture references a case id present in the plan fixture, and is
// validated without editing the plan (FR-020). Shapes mirror the makePlan() /
// makeResults() fixtures in testbench-contracts.test.ts.

const PLAN_CASE_ID = "TC-001";

function makePlan(): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: "testbench",
    cases: [
      {
        id: PLAN_CASE_ID,
        title: "Reviewer marks an observation",
        area: "testbench",
        level: 1,
        type: "e2e_flow",
        priority: "P0",
        preconditions: ["A focused spec is bound to the bench"],
        steps: [
          {
            id: "S1",
            instruction: "Open the TestBench tab",
            observations: [{ id: "O1", expected: "The case list renders" }],
          },
        ],
        tags: ["smoke"],
        linked_requirement_ids: ["FR-001"],
        linked_user_story_ids: [],
      },
    ],
  };
}

function makeResults(): TestResultsFile {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash: "sha256:abc",
    benches: {
      "bench-1": {
        updatedAt: "2026-06-08T00:00:00.000Z",
        // Keyed by the plan's case id only; the plan is never embedded or edited.
        caseResults: {
          [PLAN_CASE_ID]: {
            observationMarks: {
              O1: {
                result: "pass",
                author: { name: "David", email: "david@poxon.au" },
                timestamp: "2026-06-08T00:00:00.000Z",
              },
            },
            derivedStatus: "passed",
            notes: [],
          },
        },
      },
    },
  };
}

// ── FR-020 failure-output wrapper ──
//
// Each TC-056 step runs inside step(): on divergence it reports the diverging
// e2e_flow step label, the expected-vs-actual, and the owning slice issue(s),
// so a failure is attributable to a slice rather than the whole journey.
async function step<T>(label: string, expectation: string, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `TC-056 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${OWNING_SLICES}`,
      { cause },
    );
  }
}

// Generate into a clean temp schema/ dir, honouring TC-056's "no prior schema/
// output files exist" precondition without overwriting the repo's committed
// schema/ files (the test stays non-destructive).
const outDir = mkdtempSync(join(tmpdir(), "testbench-e2e-schema-"));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

// Mirror the real generate pipeline's per-artifact render + write, targeted at
// the temp dir. Returns the written path so the test can assert on it.
async function generateInto(
  schema: typeof TestCasesPlanSchema | typeof TestResultsFileSchema,
  fileName: string,
): Promise<string> {
  const outPath = join(outDir, fileName);
  const serialized = await renderSchema(schema, outPath);
  writeFileSync(outPath, serialized);
  return outPath;
}

describe("TestBench schema E2E (TC-056): author -> generate -> validate", () => {
  it("runs the full journey end to end and matches TC-056", async () => {
    // Record each step as it completes, so the terminal assertion can guard the
    // executed sequence against the canonical TC-056 order (AC5), not merely the
    // presence of the output files.
    const executed: string[] = [];
    const track = async <T>(
      label: string,
      expectation: string,
      body: () => T | Promise<T>,
    ): Promise<T> => {
      const result = await step(label, expectation, body);
      executed.push(label);
      return result;
    };

    // Step 1 + 2: generate the test-cases schema; confirm it is written with a
    // semver-versioned $id (AC1).
    const casesPath = await track(
      TC056_STEPS.generateCases,
      "The file exists and contains a $id with a semver-versioned URI",
      async () => {
        const outPath = await generateInto(TestCasesPlanSchema, "test-cases.schema.json");
        expect(existsSync(outPath)).toBe(true);
        const written = JSON.parse(readFileSync(outPath, "utf8"));
        expect(written.$id).toBe(TEST_CASES_SCHEMA_ID);
        expect(written.$id).toMatch(SEMVER_ID);
        return outPath;
      },
    );

    // Step 3 + 4: same for the test-results schema (AC2).
    const resultsPath = await track(
      TC056_STEPS.generateResults,
      "The file exists and contains a $id with a semver-versioned URI",
      async () => {
        const outPath = await generateInto(TestResultsFileSchema, "test-results.schema.json");
        expect(existsSync(outPath)).toBe(true);
        const written = JSON.parse(readFileSync(outPath, "utf8"));
        expect(written.$id).toBe(TEST_RESULTS_SCHEMA_ID);
        expect(written.$id).toMatch(SEMVER_ID);
        return outPath;
      },
    );

    // Step 5: validate a conforming test-cases fixture, zero errors (AC3).
    const plan = makePlan();
    await track(TC056_STEPS.validateCases, "Validation passes with zero errors", () => {
      const result = validateTestCases(plan);
      // On failure surface the actual field errors as the actual value.
      if (!result.ok) throw new Error(result.errors.join("; "));
      expect(result.ok).toBe(true);
    });

    // Step 6: validate a conforming test-results fixture, zero errors, and
    // confirm it references the plan's case ids without editing the plan (AC4).
    await track(
      TC056_STEPS.validateResults,
      "Validation passes with zero errors and the results reference case ids without requiring edits to test-cases.json",
      () => {
        const planSnapshot = JSON.stringify(plan);
        const results = makeResults();
        const result = validateTestResults(results);
        if (!result.ok) throw new Error(result.errors.join("; "));
        expect(result.ok).toBe(true);
        // The results key the plan's case id, and validating them left the plan
        // untouched (no edit to test-cases.json was required).
        expect(Object.keys(results.benches["bench-1"].caseResults)).toEqual([plan.cases[0].id]);
        expect(JSON.stringify(plan)).toBe(planSnapshot);
      },
    );

    // Step 7 (AC5): the integrated run matches TC-056's step sequence end to
    // end. Assert the recorded steps equal the canonical TC-056 order (so a
    // dropped or reordered step fails the drift guard), and that both generated
    // files are on disk as the journey's terminal state.
    expect(executed).toEqual(TC056_SEQUENCE);
    expect(existsSync(casesPath)).toBe(true);
    expect(existsSync(resultsPath)).toBe(true);
  });

  // AC6 / FR-020: prove the failure-output wrapper localises a diverging step,
  // reporting expected-vs-actual and the owning slice issue(s).
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", async () => {
    await expect(
      step(
        "Validate a conforming test-cases.json fixture",
        "Validation passes with zero errors",
        () => {
          // Drive a real validator failure: a non-conforming plan (missing specSlug).
          const bad = makePlan() as unknown as Record<string, unknown>;
          delete bad.specSlug;
          const result = validateTestCases(bad);
          if (!result.ok) throw new Error(result.errors.join("; "));
        },
      ),
    ).rejects.toThrow(/TC-056 step diverged: "Validate a conforming test-cases.json fixture"/);

    // The same failure carries the expected, the actual, and the owning slices.
    const captured = await step(
      "Validate a conforming test-cases.json fixture",
      "Validation passes with zero errors",
      () => {
        const bad = makePlan() as unknown as Record<string, unknown>;
        delete bad.specSlug;
        const result = validateTestCases(bad);
        if (!result.ok) throw new Error(result.errors.join("; "));
      },
    ).catch((e: Error) => e.message);

    expect(captured).toContain("expected: Validation passes with zero errors");
    expect(captured).toContain("actual:");
    expect(captured).toContain("specSlug");
    expect(captured).toContain(`owning slice(s): ${OWNING_SLICES}`);
  });
});
