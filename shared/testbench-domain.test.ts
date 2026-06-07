import { describe, it, expect } from "vitest";
import { deriveStatus, purgeOrphans, reconcile } from "./testbench-domain.js";
import { canonicalizeCase } from "./testbench-canonicalize.js";
import type {
  Author,
  BenchResults,
  Case,
  ObservationMark,
  TestCasesPlan,
} from "./testbench-domain-types.js";

const author: Author = { name: "Dev", email: "dev@example.com" };

function mark(result: "pass" | "fail"): ObservationMark {
  return { result, author, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("deriveStatus (FR-009 truth table)", () => {
  it("TC-023: no observations marked => not_started", () => {
    expect(deriveStatus(["O1", "O2"], {})).toBe("not_started");
  });

  it("some but not all observations marked => in_progress", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("pass") })).toBe("in_progress");
  });

  it("all observations marked AND all pass => passed", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("pass"), O2: mark("pass") })).toBe("passed");
  });

  it("TC-026: all observations marked AND at least one fail => failed", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("pass"), O2: mark("fail") })).toBe("failed");
  });

  it("all observations marked AND all fail => failed", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("fail"), O2: mark("fail") })).toBe("failed");
  });

  it("single observation marked pass => passed", () => {
    expect(deriveStatus(["O1"], { O1: mark("pass") })).toBe("passed");
  });

  it("zero observations defined => not_started (edge)", () => {
    expect(deriveStatus([], {})).toBe("not_started");
  });

  it("ignores marks for observation ids not in the defined set", () => {
    // A stray mark keyed to an unknown id must not count toward the denominator.
    expect(deriveStatus(["O1"], { O1: mark("pass"), OBSOLETE: mark("fail") })).toBe("passed");
  });

  it("never derives blocked (marks are pass|fail only)", () => {
    const results = new Set<string>();
    results.add(deriveStatus([], {}));
    results.add(deriveStatus(["O1"], {}));
    results.add(deriveStatus(["O1", "O2"], { O1: mark("pass") }));
    results.add(deriveStatus(["O1"], { O1: mark("pass") }));
    results.add(deriveStatus(["O1"], { O1: mark("fail") }));
    expect(results.has("blocked")).toBe(false);
  });
});

// ── reconcile + purgeOrphans (FR-017, spike-407 AC3/AC4/AC5) ──

// Build a one-step, one-observation case with a given id and expected wording.
function buildCase(id: string, expected: string): Case {
  return {
    id,
    title: `${id} title`,
    level: "1",
    priority: "P0",
    steps: [{ id: "S1", instruction: "do the thing", observations: [{ id: "O1", expected }] }],
  };
}

function buildPlan(cases: Case[]): TestCasesPlan {
  return { $schema: "x", schemaVersion: "1.0.0", specSlug: "testbench", cases };
}

describe("reconcile (spike-407 AC3 classification)", () => {
  it("buckets added (plan-only), removed (result-only), unchanged, changed", () => {
    const unchangedCase = buildCase("TC-001", "obs one");
    const changedCase = buildCase("TC-002", "reworded obs");
    const plan = buildPlan([unchangedCase, changedCase, buildCase("TC-004", "new obs")]);

    const results: BenchResults = {
      caseResults: {
        // matches its plan snapshot => unchanged
        "TC-001": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(unchangedCase),
        },
        // stored snapshot differs from the reworded plan case => changed
        "TC-002": {
          observationMarks: { O1: mark("fail") },
          derivedStatus: "failed",
          notes: [],
          caseCanon: canonicalizeCase(buildCase("TC-002", "old wording")),
        },
        // no matching plan case => removed (orphan candidate)
        "TC-003": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(buildCase("TC-003", "obs three")),
        },
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const { classification } = reconcile(plan, results);
    expect(classification.added).toEqual(["TC-004"]);
    expect(classification.unchanged).toEqual(["TC-001"]);
    expect(classification.changed).toEqual(["TC-002"]);
    expect(classification.removed).toEqual(["TC-003"]);
  });

  it("a result with no stored snapshot is conservatively classified changed", () => {
    const planCase = buildCase("TC-001", "obs one");
    const plan = buildPlan([planCase]);
    const results: BenchResults = {
      caseResults: {
        "TC-001": { observationMarks: { O1: mark("pass") }, derivedStatus: "passed", notes: [] },
      },
      updatedAt: "T0",
    };
    const { classification } = reconcile(plan, results);
    expect(classification.changed).toEqual(["TC-001"]);
    expect(classification.unchanged).toEqual([]);
  });

  it("does not mutate the input results", () => {
    const planCase = buildCase("TC-001", "obs one");
    const plan = buildPlan([]); // TC-001 removed from plan
    const results: BenchResults = {
      caseResults: {
        "TC-001": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(planCase),
        },
      },
      updatedAt: "T0",
    };
    reconcile(plan, results);
    expect(results.caseResults["TC-001"].orphaned).toBeUndefined();
  });

  it("TC-042: AC4 worked example, no authored mark/note/override is lost across add + remove + change", () => {
    // Starting plan: TC-001, TC-002, TC-003. New plan: TC-001 untouched,
    // TC-002 reworded (change), TC-003 removed, TC-004 added.
    const tc001 = buildCase("TC-001", "obs one");
    const tc002Old = buildCase("TC-002", "original wording");
    const tc002New = buildCase("TC-002", "reworded wording");
    const tc003 = buildCase("TC-003", "obs three");
    const tc004 = buildCase("TC-004", "obs four");

    const newPlan = buildPlan([tc001, tc002New, tc004]);

    const results: BenchResults = {
      caseResults: {
        "TC-001": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [
            {
              id: "N1",
              text: "verified on chrome",
              author,
              timestamp: "T1",
              statusAtWrite: "passed",
            },
          ],
          caseCanon: canonicalizeCase(tc001),
        },
        "TC-002": {
          observationMarks: { O1: mark("fail") },
          derivedStatus: "failed",
          statusOverride: { status: "blocked", author, timestamp: "T2" },
          notes: [
            {
              id: "N2",
              text: "blocked by missing fixture",
              author,
              timestamp: "T2",
              statusAtWrite: "failed",
            },
          ],
          caseCanon: canonicalizeCase(tc002Old),
        },
        "TC-003": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(tc003),
        },
      },
      updatedAt: "T3",
    };

    const { classification, nextResults } = reconcile(newPlan, results);

    expect(classification).toEqual({
      added: ["TC-004"],
      unchanged: ["TC-001"],
      changed: ["TC-002"],
      removed: ["TC-003"],
    });

    const next = nextResults.caseResults;

    // TC-001 (unchanged): mark + note kept verbatim, not orphaned.
    expect(next["TC-001"].observationMarks.O1).toEqual(mark("pass"));
    expect(next["TC-001"].notes.map((n) => n.id)).toEqual(["N1"]);
    expect(next["TC-001"].orphaned).toBeUndefined();

    // TC-002 (changed): every mark, note, override kept; only caseCanon refreshed
    // and derivedStatus recomputed from the kept (fail) mark.
    expect(next["TC-002"].observationMarks.O1).toEqual(mark("fail"));
    expect(next["TC-002"].statusOverride).toEqual({
      status: "blocked",
      author,
      timestamp: "T2",
    });
    expect(next["TC-002"].notes.map((n) => n.id)).toEqual(["N2"]);
    expect(next["TC-002"].caseCanon).toBe(canonicalizeCase(tc002New));
    expect(next["TC-002"].derivedStatus).toBe("failed");
    expect(next["TC-002"].orphaned).toBeUndefined();

    // TC-003 (removed): retained, flagged orphaned, mark and empty note set kept.
    expect(next["TC-003"]).toBeDefined();
    expect(next["TC-003"].orphaned).toBe(true);
    expect(next["TC-003"].observationMarks.O1).toEqual(mark("pass"));
    expect(next["TC-003"].notes).toEqual([]);

    // TC-004 (added): no result yet.
    expect(next["TC-004"]).toBeUndefined();
  });
});

describe("purgeOrphans (spike-407 AC5, separate explicit operation)", () => {
  it("TC-049: drops only orphaned entries, retains the rest, leaves input untouched", () => {
    const results: BenchResults = {
      caseResults: {
        "TC-001": { observationMarks: { O1: mark("pass") }, derivedStatus: "passed", notes: [] },
        "TC-003": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          orphaned: true,
        },
      },
      updatedAt: "T0",
    };

    const purged = purgeOrphans(results);
    expect(Object.keys(purged.caseResults)).toEqual(["TC-001"]);
    expect(purged.caseResults["TC-003"]).toBeUndefined();
    // Input not mutated.
    expect(results.caseResults["TC-003"]).toBeDefined();
  });

  it("purge is decoupled from reconcile: reconcile orphans, purge deletes", () => {
    const tc001 = buildCase("TC-001", "obs one");
    const plan = buildPlan([]); // TC-001 removed from plan
    const results: BenchResults = {
      caseResults: {
        "TC-001": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(tc001),
        },
      },
      updatedAt: "T0",
    };

    // reconcile alone never deletes: the orphaned result is still present.
    const { nextResults } = reconcile(plan, results);
    expect(nextResults.caseResults["TC-001"].orphaned).toBe(true);

    // only the explicit purge removes it.
    const purged = purgeOrphans(nextResults);
    expect(purged.caseResults["TC-001"]).toBeUndefined();
  });
});
