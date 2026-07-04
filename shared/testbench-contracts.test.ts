import { describe, it, expect } from "vitest";
import {
  validateTestCases,
  validateTestResults,
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  TargetingFieldSchema,
  CaseStatusSchema,
  type TestCasesPlan,
  type TestResultsFile,
} from "./testbench-contracts.js";

// A minimal conforming test-cases.json fixture (the source plan). The reserved
// targeting fields are deliberately absent here to prove they are optional.
function makePlan(): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: "testbench",
    cases: [
      {
        id: "TC-001",
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
        linked_user_story_ids: ["US-001"],
      },
    ],
  };
}

// A minimal conforming test-results.json fixture (the sidecar). References the
// case above by its stable id only; the plan is not embedded or edited. As of
// v2.0.0 (#493) case results sit at the top level (one file per worktree); there
// is no per-bench `benches` map.
function makeResults(): TestResultsFile {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash: "sha256:abc",
    updatedAt: "2026-06-08T00:00:00.000Z",
    caseResults: {
      "TC-001": {
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
  };
}

describe("validateTestCases", () => {
  it("accepts a conforming test-cases.json", () => {
    const result = validateTestCases(makePlan());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cases[0].id).toBe("TC-001");
    }
  });

  it("rejects a malformed file with a clear, field-named error", () => {
    const bad = makePlan() as unknown as Record<string, unknown>;
    delete bad.specSlug;
    const result = validateTestCases(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "specSlug: Invalid input: expected string, received undefined",
      );
    }
  });

  it("rejects an out-of-contract file (unknown key) with a field-named error", () => {
    const plan = makePlan() as unknown as Record<string, unknown>;
    plan.unexpected = true;
    const result = validateTestCases(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("unexpected"))).toBe(true);
    }
  });

  it("rejects a wrong-typed nested field with a path-prefixed error", () => {
    const plan = makePlan();
    // @ts-expect-error deliberately wrong type for the test
    plan.cases[0].steps[0].observations = "not-an-array";
    const result = validateTestCases(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("cases.0.steps.0.observations:"))).toBe(true);
    }
  });

  it("accepts a merged case with no priority (priority is optional in v1.1.0)", () => {
    const plan = makePlan();
    delete plan.cases[0].priority;
    expect(plan.cases[0].priority).toBeUndefined();
    expect(validateTestCases(plan).ok).toBe(true);
  });

  it("rejects a level outside the 1-4 range with a field-named error", () => {
    const plan = makePlan();
    plan.cases[0].level = 5;
    const result = validateTestCases(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("cases.0.level:"))).toBe(true);
    }
  });

  it("accepts any non-empty type string (e.g. reliability/structural in real specs)", () => {
    const plan = makePlan();
    plan.cases[0].type = "reliability";
    expect(validateTestCases(plan).ok).toBe(true);
  });

  it("requires at least one linked requirement id", () => {
    const plan = makePlan();
    plan.cases[0].linked_requirement_ids = [];
    const result = validateTestCases(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("cases.0.linked_requirement_ids:"))).toBe(true);
    }
  });

  it("accepts the reserved per-step target and per-observation observe fields when present", () => {
    const plan = makePlan();
    plan.cases[0].steps[0].target = {
      cssSelector: "#submit",
      ariaRole: "button",
      ariaName: "Submit",
      textAnchor: "Submit",
      routeContext: "/checkout",
      region: "main",
    };
    plan.cases[0].steps[0].observations[0].observe = { cssSelector: ".banner" };
    const result = validateTestCases(plan);
    expect(result.ok).toBe(true);
  });

  it("treats the reserved targeting fields as optional (absent still validates)", () => {
    const plan = makePlan();
    expect(plan.cases[0].steps[0].target).toBeUndefined();
    expect(plan.cases[0].steps[0].observations[0].observe).toBeUndefined();
    expect(validateTestCases(plan).ok).toBe(true);
  });
});

describe("validateTestResults", () => {
  it("accepts a conforming test-results.json", () => {
    const result = validateTestResults(makeResults());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.caseResults["TC-001"].derivedStatus).toBe("passed");
    }
  });

  it("carries case results at the top level (no per-bench keying as of v2.0.0)", () => {
    const results = makeResults() as unknown as Record<string, unknown>;
    expect(results.benches).toBeUndefined();
    expect(results.caseResults).toBeDefined();
    expect(typeof results.updatedAt).toBe("string");
  });

  it("references cases by stable id without requiring the plan to be edited", () => {
    // The results fixture keys caseResults by the plan's case id; validating
    // the results never touches or embeds test-cases.json.
    const plan = makePlan();
    const results = makeResults();
    expect(validateTestCases(plan).ok).toBe(true);
    expect(validateTestResults(results).ok).toBe(true);
    expect(Object.keys(results.caseResults)).toEqual([plan.cases[0].id]);
  });

  it("rejects an invalid observation mark result with a field-named error", () => {
    const results = makeResults();
    // @ts-expect-error deliberately out-of-contract enum value
    results.caseResults["TC-001"].observationMarks.O1.result = "maybe";
    const result = validateTestResults(results);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith("caseResults.TC-001.observationMarks.O1.result:")),
      ).toBe(true);
    }
  });

  it("accepts an optional status override and an orphaned flag", () => {
    const results = makeResults();
    const caseResult = results.caseResults["TC-001"];
    caseResult.statusOverride = {
      status: "blocked",
      author: { name: "David", email: "david@poxon.au" },
      timestamp: "2026-06-08T00:00:00.000Z",
    };
    caseResult.notes = [
      {
        id: "N1",
        text: "Blocked on an upstream dependency",
        author: { name: "David", email: "david@poxon.au", isSentinel: true },
        timestamp: "2026-06-08T00:00:00.000Z",
        statusAtWrite: "blocked",
      },
    ];
    caseResult.orphaned = true;
    expect(validateTestResults(results).ok).toBe(true);
  });

  it("accepts an optional per-case caseCanon snapshot (#447)", () => {
    const results = makeResults();
    results.caseResults["TC-001"].caseCanon = "canon-snapshot";
    expect(validateTestResults(results).ok).toBe(true);
  });

  it("accepts an optional machine verification block (tier/confidence/evidence)", () => {
    const results = makeResults();
    results.caseResults["TC-001"].verification = {
      tier: "a",
      confidence: "high",
      evidence: [
        "work_units.py merge --spec-dir ... -> written [TC-001]",
        "verification-report.md#tc-001",
      ],
      author: { name: "David", email: "david@poxon.au" },
      timestamp: "2026-07-04T00:00:00.000Z",
    };
    expect(validateTestResults(results).ok).toBe(true);
  });

  it("rejects an out-of-ladder verification tier with a field-named error", () => {
    const results = makeResults();
    results.caseResults["TC-001"].verification = {
      // @ts-expect-error deliberately out-of-contract tier value
      tier: "e",
      confidence: "high",
      evidence: [],
      author: { name: "David", email: "david@poxon.au" },
      timestamp: "2026-07-04T00:00:00.000Z",
    };
    const result = validateTestResults(results);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("caseResults.TC-001.verification.tier:"))).toBe(
        true,
      );
    }
  });

  it("still rejects an unknown key on a case result with a field-named error", () => {
    const results = makeResults();
    (results.caseResults["TC-001"] as unknown as Record<string, unknown>).bogus = true;
    const result = validateTestResults(results);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith("caseResults.TC-001:") && e.includes("bogus")),
      ).toBe(true);
    }
  });

  it("rejects a results file missing the planHash with a field-named error", () => {
    const results = makeResults() as unknown as Record<string, unknown>;
    delete results.planHash;
    const result = validateTestResults(results);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("planHash:"))).toBe(true);
    }
  });
});

describe("schema metadata", () => {
  it("embeds the schemaVersion semver in each versioned $id (NFR-005)", () => {
    expect(TEST_CASES_SCHEMA_ID).toContain(TEST_CASES_SCHEMA_VERSION);
    expect(TEST_RESULTS_SCHEMA_ID).toContain(TEST_RESULTS_SCHEMA_VERSION);
  });

  it("exposes the fixed CaseStatus set", () => {
    expect(CaseStatusSchema.options).toEqual([
      "not_started",
      "in_progress",
      "passed",
      "failed",
      "blocked",
    ]);
  });

  it("treats every TargetingField key as optional (empty object validates)", () => {
    expect(TargetingFieldSchema.safeParse({}).success).toBe(true);
  });
});
