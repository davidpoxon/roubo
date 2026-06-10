import { describe, it, expect } from "vitest";
import type { Case, BenchResults, CaseResult } from "@roubo/shared/testbench-contracts";
import {
  buildRollup,
  flattenRollup,
  effectiveCaseStatus,
  caseObservationProgress,
  type RollupModel,
} from "./rollup";

function makeCase(id: string, level: number, priority?: string): Case {
  return {
    id,
    title: `Case ${id}`,
    area: "test-area",
    level,
    type: "functional",
    priority,
    steps: [],
    tags: [],
    linked_requirement_ids: ["FR-001"],
    linked_user_story_ids: [],
  };
}

function result(partial: Partial<CaseResult>): CaseResult {
  return {
    observationMarks: {},
    derivedStatus: "not_started",
    notes: [],
    ...partial,
  };
}

function results(caseResults: Record<string, CaseResult>): BenchResults {
  return { caseResults, updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("effectiveCaseStatus", () => {
  it("returns not_started when there is no result for the case", () => {
    expect(effectiveCaseStatus("c1", null)).toBe("not_started");
    expect(effectiveCaseStatus("c1", results({}))).toBe("not_started");
  });

  it("returns the derived status when no override is set", () => {
    expect(effectiveCaseStatus("c1", results({ c1: result({ derivedStatus: "passed" }) }))).toBe(
      "passed",
    );
  });

  it("prefers a status override over the derived status", () => {
    const r = results({
      c1: result({
        derivedStatus: "passed",
        statusOverride: {
          status: "blocked",
          author: { name: "a", email: "a@b.c" },
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(effectiveCaseStatus("c1", r)).toBe("blocked");
  });

  it("treats an orphaned result as not_started", () => {
    const r = results({ c1: result({ derivedStatus: "failed", orphaned: true }) });
    expect(effectiveCaseStatus("c1", r)).toBe("not_started");
  });
});

describe("buildRollup grouping", () => {
  it("groups cases by level then priority", () => {
    const cases = [makeCase("a", 1, "P1"), makeCase("b", 1, "P0"), makeCase("c", 2, "P1")];
    const model = buildRollup(cases, null);
    expect(model.levels.map((l) => l.level)).toEqual(["1", "2"]);
    const e2e = model.levels[0];
    // priorities sorted: P0 before P1
    expect(e2e.priorities.map((p) => p.priority)).toEqual(["P0", "P1"]);
    expect(e2e.priorities[0].rows.map((r) => r.case.id)).toEqual(["b"]);
    expect(e2e.priorities[1].rows.map((r) => r.case.id)).toEqual(["a"]);
    expect(model.levels[1].priorities[0].rows.map((r) => r.case.id)).toEqual(["c"]);
  });

  it("buckets cases with no priority under the Unprioritized group", () => {
    const cases = [makeCase("a", 1), makeCase("b", 1, "P0")];
    const model = buildRollup(cases, null);
    const level1 = model.levels.find((l) => l.level === "1");
    expect(level1?.priorities.map((p) => p.priority)).toEqual(["P0", "Unprioritized"]);
    const unprioritized = level1?.priorities.find((p) => p.priority === "Unprioritized");
    expect(unprioritized?.rows.map((r) => r.case.id)).toEqual(["a"]);
  });

  it("rolls per-priority, per-level and overall counts that sum to total", () => {
    const cases = [
      makeCase("a", 1, "P0"),
      makeCase("b", 1, "P0"),
      makeCase("c", 1, "P1"),
      makeCase("d", 2, "P0"),
    ];
    const r = results({
      a: result({ derivedStatus: "passed" }),
      b: result({ derivedStatus: "failed" }),
      c: result({ derivedStatus: "in_progress" }),
      // d has no result -> not_started
    });
    const model = buildRollup(cases, r);

    expect(model.overall.total).toBe(4);
    expect(model.overall.passed).toBe(1);
    expect(model.overall.failed).toBe(1);
    expect(model.overall.in_progress).toBe(1);
    expect(model.overall.not_started).toBe(1);

    const e2e = model.levels.find((l) => l.level === "1");
    expect(e2e).toBeDefined();
    expect(e2e?.counts.total).toBe(3);
    const p0 = e2e?.priorities.find((p) => p.priority === "P0");
    expect(p0).toBeDefined();
    expect(p0?.counts.total).toBe(2);
    expect(p0?.counts.passed).toBe(1);
    expect(p0?.counts.failed).toBe(1);

    // Every counts object's buckets sum to its total.
    for (const level of model.levels) {
      expectBucketsSumToTotal(level.counts);
      for (const priority of level.priorities) expectBucketsSumToTotal(priority.counts);
    }
    expectBucketsSumToTotal(model.overall);
  });

  it("excludes orphaned results from the rollup (FR-013)", () => {
    const cases = [makeCase("a", 1, "P0")];
    const r = results({
      a: result({ derivedStatus: "passed" }),
      // "ghost" is an orphaned result whose case was removed from the plan.
      ghost: result({ derivedStatus: "failed", orphaned: true }),
    });
    const model = buildRollup(cases, r);
    // Only the surviving case is counted; the orphaned result never appears.
    expect(model.overall.total).toBe(1);
    expect(model.overall.passed).toBe(1);
    expect(model.overall.failed).toBe(0);
    const ids = model.levels.flatMap((l) =>
      l.priorities.flatMap((p) => p.rows.map((x) => x.case.id)),
    );
    expect(ids).toEqual(["a"]);
  });

  it("returns an empty model for an empty plan", () => {
    const model = buildRollup([], null);
    expect(model.levels).toEqual([]);
    expect(model.overall.total).toBe(0);
  });
});

describe("flattenRollup", () => {
  it("emits a level header, priority subheader, then case rows in order", () => {
    const cases = [makeCase("a", 1, "P0"), makeCase("b", 1, "P0")];
    const flat = flattenRollup(buildRollup(cases, null));
    expect(flat.map((f) => f.kind)).toEqual(["level", "priority", "case", "case"]);
    expect(flat.map((f) => f.key)).toEqual(["level:1", "priority:1:P0", "case:a", "case:b"]);
  });

  it("produces unique keys across all rows for a 500-case plan", () => {
    const cases: Case[] = [];
    for (let i = 0; i < 500; i++) {
      cases.push(makeCase(`c${i}`, (i % 3) + 1, `P${i % 4}`));
    }
    const model: RollupModel = buildRollup(cases, null);
    const flat = flattenRollup(model);
    const keys = new Set(flat.map((f) => f.key));
    expect(keys.size).toBe(flat.length);
    // 500 case rows are present regardless of header rows.
    expect(flat.filter((f) => f.kind === "case").length).toBe(500);
  });

  it("#508: carries the owning level on each case row (for collapse filtering)", () => {
    const cases = [makeCase("a", 1, "P0"), makeCase("b", 2, "P0")];
    const flat = flattenRollup(buildRollup(cases, null));
    const caseRows = flat.filter((f) => f.kind === "case");
    expect(caseRows.map((r) => (r.kind === "case" ? r.level : null))).toEqual(["1", "2"]);
  });
});

describe("caseObservationProgress (#508)", () => {
  function caseWithObservations(observationCount: number): Case {
    return {
      ...makeCase("TC", 1, "P0"),
      steps: [
        {
          id: "S1",
          instruction: "do",
          observations: Array.from({ length: observationCount }, (_, i) => ({
            id: `O${i + 1}`,
            expected: `expected ${i + 1}`,
          })),
        },
      ],
    };
  }

  it("counts marked observations against the total defined", () => {
    const testCase = caseWithObservations(3);
    const r = result({
      observationMarks: {
        O1: { result: "pass", author: { name: "a", email: "a@b" }, timestamp: "t" },
        O3: { result: "fail", author: { name: "a", email: "a@b" }, timestamp: "t" },
      },
    });
    expect(caseObservationProgress(testCase, r)).toEqual({ marked: 2, total: 3 });
  });

  it("is 0/total when no result exists yet", () => {
    expect(caseObservationProgress(caseWithObservations(2), undefined)).toEqual({
      marked: 0,
      total: 2,
    });
  });

  it("is 0/0 for a case with no observations", () => {
    expect(caseObservationProgress(caseWithObservations(0), undefined)).toEqual({
      marked: 0,
      total: 0,
    });
  });
});

function expectBucketsSumToTotal(counts: {
  total: number;
  not_started: number;
  in_progress: number;
  passed: number;
  failed: number;
  blocked: number;
}): void {
  const sum =
    counts.not_started + counts.in_progress + counts.passed + counts.failed + counts.blocked;
  expect(sum).toBe(counts.total);
}
