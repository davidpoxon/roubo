import { describe, it, expect } from "vitest";
import {
  currentResultCaseIds,
  deriveStatus,
  purgeOrphans,
  reconcile,
  noncurrentLiveCaseIds,
  staleResultCaseIds,
} from "./testbench-domain.js";
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

  it("#510: one fail with other observations still unmarked => failed", () => {
    // A single failed observation moves the case to failed immediately, even
    // though O2 and O3 are unmarked (would otherwise be in_progress).
    expect(deriveStatus(["O1", "O2", "O3"], { O1: mark("fail") })).toBe("failed");
  });

  it("#510: fail wins over a pending pass mark too", () => {
    expect(deriveStatus(["O1", "O2", "O3"], { O1: mark("pass"), O2: mark("fail") })).toBe("failed");
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

    const { classification } = reconcile(plan, results, { fresh: true });
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
    const { classification } = reconcile(plan, results, { fresh: true });
    expect(classification.changed).toEqual(["TC-001"]);
    expect(classification.unchanged).toEqual([]);
  });

  // #1160 (SATCA-FR-022, SATCA-TC-055): reconcile compares the stored caseCanon
  // against canonicalizeCase(planCase), and the canonical projection excludes the
  // v1.2.0 lifecycle block (#1158), so retiring or superseding a case must NOT
  // re-classify it as changed. TC-003 is the negative control: an edit to the
  // case body still reads as changed.
  it("does not classify a case as changed solely because its lifecycle block changed", () => {
    const liveOne = buildCase("TC-001", "obs one");
    const liveTwo = buildCase("TC-002", "obs two");
    const liveThree = buildCase("TC-003", "obs three");

    const plan = buildPlan([
      { ...liveOne, lifecycle: { state: "retired", reason: "Behaviour was removed" } },
      { ...liveTwo, lifecycle: { state: "superseded", replacement: "TC-009" } },
      buildCase("TC-003", "reworded obs three"),
    ]);

    const results: BenchResults = {
      caseResults: {
        "TC-001": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(liveOne),
        },
        "TC-002": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(liveTwo),
        },
        "TC-003": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(liveThree),
        },
      },
      updatedAt: "T0",
    };

    const { classification, nextResults } = reconcile(plan, results, { fresh: true });
    expect(classification.unchanged).toEqual(["TC-001", "TC-002"]);
    expect(classification.changed).toEqual(["TC-003"]);
    // An unchanged case's stored snapshot is left exactly as authored: the
    // lifecycle block never reaches it.
    expect(nextResults.caseResults["TC-001"].caseCanon).toBe(canonicalizeCase(liveOne));
    expect(nextResults.caseResults["TC-001"].caseCanon).not.toContain("lifecycle");
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
    reconcile(plan, results, { fresh: true });
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

    const { classification, nextResults } = reconcile(newPlan, results, { fresh: true });

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

    // TC-002 (changed, fresh results): every mark, note, override kept, and
    // derivedStatus recomputed from the kept (fail) mark. Its recorded snapshot
    // names the old body, so it is kept and the case stays stale (#1696).
    expect(next["TC-002"].observationMarks.O1).toEqual(mark("fail"));
    expect(next["TC-002"].statusOverride).toEqual({
      status: "blocked",
      author,
      timestamp: "T2",
    });
    expect(next["TC-002"].notes.map((n) => n.id)).toEqual(["N2"]);
    expect(next["TC-002"].caseCanon).toBe(canonicalizeCase(tc002Old));
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
    const { nextResults } = reconcile(plan, results, { fresh: true });
    expect(nextResults.caseResults["TC-001"].orphaned).toBe(true);

    // only the explicit purge removes it.
    const purged = purgeOrphans(nextResults);
    expect(purged.caseResults["TC-001"]).toBeUndefined();
  });
});

// #1407: under stale results a changed case keeps the snapshot of the body its
// marks were judged against, so a confirmed reconcile cannot make them current.
describe("reconcile under stale results (#1407)", () => {
  it("keeps a changed case's old snapshot when the results are not fresh", () => {
    const oldBody = buildCase("TC-001", "original wording");
    const newBody = buildCase("TC-001", "reworded wording");
    const results: BenchResults = {
      caseResults: {
        "TC-001": {
          observationMarks: { O1: mark("pass") },
          derivedStatus: "passed",
          notes: [],
          caseCanon: canonicalizeCase(oldBody),
        },
      },
      updatedAt: "T0",
    };

    const { classification, nextResults } = reconcile(buildPlan([newBody]), results, {
      fresh: false,
    });

    expect(classification.changed).toEqual(["TC-001"]);
    expect(nextResults.caseResults["TC-001"].caseCanon).toBe(canonicalizeCase(oldBody));
    expect(nextResults.caseResults["TC-001"].observationMarks.O1).toEqual(mark("pass"));
    expect(nextResults.caseResults["TC-001"].derivedStatus).toBe("passed");
  });

  it("leaves a changed case with no snapshot without one when the results are not fresh", () => {
    const body = buildCase("TC-001", "obs one");
    const results: BenchResults = {
      caseResults: {
        "TC-001": { observationMarks: {}, derivedStatus: "not_started", notes: [] },
      },
      updatedAt: "T0",
    };

    const { nextResults } = reconcile(buildPlan([body]), results, { fresh: false });

    expect(nextResults.caseResults["TC-001"].caseCanon).toBeUndefined();
  });

  it("gives a legacy changed case with no snapshot the current body when the results are fresh", () => {
    const body = buildCase("TC-001", "obs one");
    const results: BenchResults = {
      caseResults: {
        "TC-001": { observationMarks: {}, derivedStatus: "not_started", notes: [] },
      },
      updatedAt: "T0",
    };

    const { nextResults } = reconcile(buildPlan([body]), results, { fresh: true });

    expect(nextResults.caseResults["TC-001"].caseCanon).toBe(canonicalizeCase(body));
  });
});

describe("per-case result currency (#1407)", () => {
  const live = buildCase("TC-001", "obs one");
  const edited = buildCase("TC-002", "reworded");
  const editedOld = buildCase("TC-002", "original");
  const noSnapshot = buildCase("TC-003", "obs three");
  const retired: Case = {
    ...buildCase("TC-004", "reworded"),
    lifecycle: { state: "retired", reason: "gone" },
  };
  const superseded: Case = {
    ...buildCase("TC-005", "reworded"),
    lifecycle: { state: "superseded", replacement: "TC-001" },
  };
  const plan = buildPlan([live, edited, noSnapshot, retired, superseded]);

  function result(caseCanon?: string) {
    return {
      observationMarks: { O1: mark("pass") },
      derivedStatus: "passed" as const,
      notes: [],
      ...(caseCanon !== undefined && { caseCanon }),
    };
  }

  const caseResults = {
    "TC-ORPHAN": result("whatever"),
    "TC-001": result(canonicalizeCase(live)),
    "TC-002": result(canonicalizeCase(editedOld)),
    "TC-003": result(),
    "TC-004": result(canonicalizeCase(buildCase("TC-004", "original"))),
    "TC-005": result(canonicalizeCase(buildCase("TC-005", "original"))),
  };

  it("reads every recorded result as current when the results are fresh, except a recorded older body", () => {
    // A fresh file claims every result, but a recorded caseCanon that names
    // another body is never current (#1696): TC-002 and the retired and
    // superseded cases were judged against an older body. TC-003 records no
    // body, so a fresh file claims it, and so is the orphan.
    expect(currentResultCaseIds(plan, caseResults, true)).toEqual([
      "TC-001",
      "TC-003",
      "TC-ORPHAN",
    ]);
    expect(staleResultCaseIds(plan, caseResults, true)).toEqual([]);
  });

  it("names the live recorded cases with a recorded older body as non-current (#1696)", () => {
    // The retired and superseded cases end their own obligation; TC-003 has no
    // snapshot, which only a stale file holds against it.
    expect(noncurrentLiveCaseIds(plan, caseResults, true)).toEqual(["TC-002"]);
    expect(noncurrentLiveCaseIds(plan, caseResults, false)).toEqual(["TC-002", "TC-003"]);
  });

  it("reads only a result whose snapshot matches the current body as current when stale", () => {
    expect(currentResultCaseIds(plan, caseResults, false)).toEqual(["TC-001"]);
  });

  it("names only the live recorded cases without a current result as stale", () => {
    // TC-002 (older body) and TC-003 (no snapshot) hold the stamp. The retired
    // and superseded cases end their own obligation, and the orphan left the plan.
    expect(staleResultCaseIds(plan, caseResults, false)).toEqual(["TC-002", "TC-003"]);
  });

  it("names no stale case when every live recorded case is current", () => {
    expect(staleResultCaseIds(plan, { "TC-001": result(canonicalizeCase(live)) }, false)).toEqual(
      [],
    );
  });

  it("names a current case whose override stands over a verdict judged against another body", () => {
    const overridden = (verdictCanon: string | null | undefined) => ({
      "TC-001": {
        ...result(canonicalizeCase(live)),
        statusOverride: {
          status: "passed" as const,
          author: { name: "A", email: "a@example.com" },
          timestamp: "2026-01-01T00:00:00.000Z",
          ...(verdictCanon !== undefined && { verdictCanon }),
        },
      },
    });
    // The override is current, so the result reads current either way.
    expect(currentResultCaseIds(plan, overridden("older body"), false)).toEqual(["TC-001"]);
    expect(staleResultCaseIds(plan, overridden("older body"), false)).toEqual(["TC-001"]);
    expect(staleResultCaseIds(plan, overridden(null), false)).toEqual(["TC-001"]);
    expect(staleResultCaseIds(plan, overridden(canonicalizeCase(live)), false)).toEqual([]);
    expect(staleResultCaseIds(plan, overridden(undefined), false)).toEqual([]);
  });
});
