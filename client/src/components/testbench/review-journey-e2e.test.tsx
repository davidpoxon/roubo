// @vitest-environment jsdom
//
// Integration-level E2E test for the review-UI journey: open a plan, mark
// observations, verify derived/override status, append a note, verify the
// progress rollup. It asserts the authoritative e2e_flow case TC-020 end to end
// (#439).
//
// This is the journey's drift guard. It exercises the already-pure, importable
// seams of the slices it spans (the FR-009 derived-status machine, the FR-011
// append-only Note contract, the FR-012/FR-013 rollup), rather than
// re-implementing or DOM-driving any of them. The slices owned by this work unit
// are #409, #412, #415, #416, #419, #420 and #421; a failing step is localised
// back to the owning slice(s) via OWNING_SLICES below (FR-020).
//
// jsdom is required because the note step optionally renders NotesRail to assert
// for real that no edit/delete affordance exists. The append hook is mocked so
// the render stays a pure presentation assertion with no network or act() noise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { deriveStatus } from "@roubo/shared/testbench-domain";
import type {
  BenchResults,
  Case,
  CaseResult,
  CaseStatus,
  Note,
  ObservationMark,
} from "@roubo/shared/testbench-contracts";
import { buildRollup, effectiveCaseStatus } from "./rollup";
import { NotesRail } from "./NotesRail";

vi.mock("../../hooks/useTestbenchNotes");
import { useAppendNote } from "../../hooks/useTestbenchNotes";

const mockUseAppendNote = vi.mocked(useAppendNote);

beforeEach(() => {
  vi.resetAllMocks();
  mockUseAppendNote.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof useAppendNote>);
});

// The slices this journey integrates, from #439's blocked_by / covers set.
// Reported when a step diverges so a failure is attributable (FR-020).
const OWNING_SLICES = "#409, #412, #415, #416, #419, #420, #421";

// Canonical TC-020 step labels, declared once as the single source of truth.
// They are both the labels the journey runs under and the expected sequence the
// terminal drift guard asserts against (AC6): if a step is dropped or reordered,
// the recorded run no longer equals TC020_SEQUENCE and the test fails.
const TC020_STEPS = {
  selectCaseA: "Click case A in the left pane and observe its detail-pane status is not_started",
  markA1Pass: "Mark the first observation of case A pass; the mark is timestamped",
  markA2Pass: "Mark the second observation of case A pass; case A derives to passed",
  markBFail: "Select case B and mark its observation fail; case B derives to failed",
  appendNoteB: "Type a note for case B and submit; it appends stamped, with no edit/delete",
  overallRollup: "Observe the overall progress rollup: 1 passed, 1 failed, 0 open",
} as const;
const TC020_SEQUENCE = [
  TC020_STEPS.selectCaseA,
  TC020_STEPS.markA1Pass,
  TC020_STEPS.markA2Pass,
  TC020_STEPS.markBFail,
  TC020_STEPS.appendNoteB,
  TC020_STEPS.overallRollup,
];

// ── Fixtures ──
//
// A plan with case A (observations O1, O2) and case B (observation O1), all
// initially not_started, plus an empty BenchResults. The journey mutates a local
// results copy as it marks observations, never the plan (FR-007: the plan is the
// source of truth and is never edited by a result write).

const CASE_A_ID = "TC-A";
const CASE_B_ID = "TC-B";

function makeCases(): Case[] {
  return [
    {
      id: CASE_A_ID,
      title: "Case A",
      area: "test-area",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "Do the first thing",
          observations: [
            { id: "O1", expected: "First observation holds" },
            { id: "O2", expected: "Second observation holds" },
          ],
        },
      ],
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
    },
    {
      id: CASE_B_ID,
      title: "Case B",
      area: "test-area",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "Do the only thing",
          observations: [{ id: "O1", expected: "Only observation holds" }],
        },
      ],
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
    },
  ];
}

function emptyResults(): BenchResults {
  return { caseResults: {}, updatedAt: "2026-06-08T00:00:00.000Z" };
}

const AUTHOR = { name: "Reviewer", email: "reviewer@example.com" } as const;

function makeMark(result: "pass" | "fail", timestamp: string): ObservationMark {
  return { result, author: { ...AUTHOR }, timestamp };
}

// Apply a mark to a case's result in a fresh BenchResults, recomputing the
// derived status from the case's full observation-id set (FR-009). This mirrors
// the store-write path's shape: it appends a mark and re-derives, it never edits
// the plan. Returns a new BenchResults so the journey's prior snapshots are kept.
function applyMark(
  results: BenchResults,
  cases: Case[],
  caseId: string,
  observationId: string,
  mark: ObservationMark,
): BenchResults {
  const caseDef = cases.find((c) => c.id === caseId);
  if (!caseDef) throw new Error(`case ${caseId} not in plan`);
  const observationIds = caseDef.steps.flatMap((s) => s.observations.map((o) => o.id));

  const prior = results.caseResults[caseId];
  const observationMarks: Record<string, ObservationMark> = {
    ...(prior?.observationMarks ?? {}),
    [observationId]: mark,
  };
  const next: CaseResult = {
    observationMarks,
    derivedStatus: deriveStatus(observationIds, observationMarks),
    notes: prior?.notes ?? [],
    ...(prior?.statusOverride ? { statusOverride: prior.statusOverride } : {}),
  };
  return {
    caseResults: { ...results.caseResults, [caseId]: next },
    updatedAt: results.updatedAt,
  };
}

// Build an append-only Note exactly as the store-write path does: statusAtWrite
// captures the effective status at the moment of writing (override wins over the
// derived status, FR-010), and there is only a push/append path: no edit/delete
// seam exists. We assert the structural invariant by appending to a copy of the
// existing notes array and never mutating an entry in place.
function buildNote(caseResult: CaseResult, id: string, text: string, timestamp: string): Note {
  const statusAtWrite: CaseStatus = caseResult.statusOverride?.status ?? caseResult.derivedStatus;
  return { id, text, author: { ...AUTHOR }, timestamp, statusAtWrite };
}

// ── FR-020 failure-output wrapper ──
//
// Each TC-020 step runs inside step(): on divergence it reports the diverging
// e2e_flow step label, the expected-vs-actual, and the owning slice issue(s), so
// a failure is attributable to a slice rather than the whole journey.
function step<T>(label: string, expectation: string, body: () => T): T {
  try {
    return body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `TC-020 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${OWNING_SLICES}`,
      { cause },
    );
  }
}

describe("TestBench review-UI E2E (TC-020): open plan -> mark -> status -> note -> progress", () => {
  it("runs the full review journey end to end and matches TC-020", () => {
    // Record each step as it completes, so the terminal assertion can guard the
    // executed sequence against the canonical TC-020 order (AC6), not merely the
    // final state.
    const executed: string[] = [];
    const track = <T,>(label: string, expectation: string, body: () => T): T => {
      const result = step(label, expectation, body);
      executed.push(label);
      return result;
    };

    const cases = makeCases();
    let results = emptyResults();

    // Step 1 (AC1): select case A. Its effective status is not_started, and the
    // overall rollup shows every case open (all not_started).
    track(
      TC020_STEPS.selectCaseA,
      "Case A shows not_started and the progress bar shows all cases open",
      () => {
        expect(effectiveCaseStatus(CASE_A_ID, results)).toBe("not_started");
        const rollup = buildRollup(cases, results);
        expect(rollup.overall.total).toBe(2);
        expect(rollup.overall.not_started).toBe(2);
        expect(rollup.overall.passed).toBe(0);
        expect(rollup.overall.failed).toBe(0);
      },
    );

    // Step 2: mark case A's first observation pass. The mark carries a timestamp
    // and the case derives to in_progress (one of two observations marked).
    results = track(
      TC020_STEPS.markA1Pass,
      "The pass mark is timestamped and case A derives to in_progress",
      () => {
        const mark = makeMark("pass", "2026-06-08T01:00:00.000Z");
        expect(mark.timestamp).toBe("2026-06-08T01:00:00.000Z");
        const next = applyMark(results, cases, CASE_A_ID, "O1", mark);
        expect(next.caseResults[CASE_A_ID].observationMarks.O1.timestamp).toBeTruthy();
        expect(deriveStatus(["O1", "O2"], { O1: mark })).toBe("in_progress");
        expect(next.caseResults[CASE_A_ID].derivedStatus).toBe("in_progress");
        return next;
      },
    );

    // Step 3 (AC2): mark case A's second observation pass. With both observations
    // marked pass the case derives to passed; the rollup shows one passed case.
    results = track(
      TC020_STEPS.markA2Pass,
      "Case A derives to passed and progress shows one passed case",
      () => {
        const mark = makeMark("pass", "2026-06-08T02:00:00.000Z");
        const next = applyMark(results, cases, CASE_A_ID, "O2", mark);
        expect(
          deriveStatus(["O1", "O2"], {
            O1: makeMark("pass", "2026-06-08T01:00:00.000Z"),
            O2: mark,
          }),
        ).toBe("passed");
        expect(effectiveCaseStatus(CASE_A_ID, next)).toBe("passed");
        const rollup = buildRollup(cases, next);
        expect(rollup.overall.passed).toBe(1);
        return next;
      },
    );

    // Step 4 (AC3): select case B and mark its only observation fail. The mark is
    // timestamped, the case derives to failed, and the rollup now shows one
    // passed and one failed.
    results = track(
      TC020_STEPS.markBFail,
      "Case B derives to failed and progress shows one passed and one failed",
      () => {
        const mark = makeMark("fail", "2026-06-08T03:00:00.000Z");
        expect(mark.timestamp).toBeTruthy();
        const next = applyMark(results, cases, CASE_B_ID, "O1", mark);
        expect(deriveStatus(["O1"], { O1: mark })).toBe("failed");
        expect(effectiveCaseStatus(CASE_B_ID, next)).toBe("failed");
        const rollup = buildRollup(cases, next);
        expect(rollup.overall.passed).toBe(1);
        expect(rollup.overall.failed).toBe(1);
        return next;
      },
    );

    // Step 5 (AC4): append a note on case B. statusAtWrite is the effective
    // status (override ?? derived = failed) captured at write time; the entry
    // carries author + timestamp + statusAtWrite. The append is structurally
    // append-only (a new array, no in-place mutation), and rendering NotesRail
    // confirms for real that no edit or delete control is present.
    results = track(
      TC020_STEPS.appendNoteB,
      "The note appends stamped with author, timestamp, and status-at-write (failed), with no edit/delete controls",
      () => {
        const caseBResult = results.caseResults[CASE_B_ID];
        const note = buildNote(
          caseBResult,
          "n1",
          "Saw the failure on case B.",
          "2026-06-08T04:00:00.000Z",
        );
        expect(note.author.name).toBe("Reviewer");
        expect(note.timestamp).toBe("2026-06-08T04:00:00.000Z");
        expect(note.statusAtWrite).toBe("failed");

        // Append-only: build a new notes array (push semantics), never edit or
        // delete an existing entry. The prior array is left untouched.
        const priorNotes = caseBResult.notes;
        const nextNotes = [...priorNotes, note];
        expect(nextNotes).toHaveLength(priorNotes.length + 1);
        expect(priorNotes).toHaveLength(0);
        const next: BenchResults = {
          caseResults: {
            ...results.caseResults,
            [CASE_B_ID]: { ...caseBResult, notes: nextNotes },
          },
          updatedAt: results.updatedAt,
        };

        // Render the rail for real: the note shows author + status-at-write, and
        // there is exactly one button (the add-note submit), no edit/delete.
        render(<NotesRail projectId="p1" benchId={1} caseId={CASE_B_ID} notes={nextNotes} />);
        expect(screen.getByText("Reviewer")).toBeInTheDocument();
        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
        expect(screen.getAllByRole("button")).toHaveLength(1);

        return next;
      },
    );

    // Step 6 (AC5): the overall rollup. Inject an orphaned result (a result whose
    // case was removed from the plan) and confirm it is excluded from every
    // count: the overall is 1 passed / 1 failed / 0 open, per-level counts are
    // correct, and the orphan never contributes.
    track(
      TC020_STEPS.overallRollup,
      "Overall rollup is 1 passed, 1 failed, 0 open; per-level counts correct; orphan excluded",
      () => {
        const withOrphan: BenchResults = {
          caseResults: {
            ...results.caseResults,
            "TC-GONE": {
              observationMarks: { O1: makeMark("pass", "2026-06-08T05:00:00.000Z") },
              derivedStatus: "passed",
              notes: [],
              orphaned: true,
            },
          },
          updatedAt: results.updatedAt,
        };
        const rollup = buildRollup(cases, withOrphan);
        expect(rollup.overall.total).toBe(2);
        expect(rollup.overall.passed).toBe(1);
        expect(rollup.overall.failed).toBe(1);
        expect(rollup.overall.not_started).toBe(0);
        expect(rollup.overall.in_progress).toBe(0);
        expect(rollup.overall.blocked).toBe(0);

        // Per-level counts: a single level (both cases are L1) holding both cases.
        expect(rollup.levels).toHaveLength(1);
        const level = rollup.levels[0];
        expect(level.level).toBe("1");
        expect(level.counts.total).toBe(2);
        expect(level.counts.passed).toBe(1);
        expect(level.counts.failed).toBe(1);

        // The orphan attaches to no plan case, so it appears in no row.
        const allCaseIds = rollup.levels.flatMap((l) =>
          l.priorities.flatMap((p) => p.rows.map((r) => r.case.id)),
        );
        expect(allCaseIds).not.toContain("TC-GONE");
        expect(effectiveCaseStatus("TC-GONE", withOrphan)).toBe("not_started");
      },
    );

    // Terminal drift guard (AC6): the integrated run matches TC-020's step
    // sequence end to end. A dropped or reordered step makes executed diverge
    // from TC020_SEQUENCE and fails here.
    expect(executed).toEqual(TC020_SEQUENCE);
  });

  // AC7 / FR-020: prove the failure-output wrapper localises a diverging step,
  // reporting the diverging label, expected-vs-actual, and the owning slices.
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", () => {
    const diverge = () =>
      step(TC020_STEPS.markA2Pass, "Case A derives to passed", () => {
        // Force a real divergence: only one of case A's two observations is
        // marked, so the case derives to in_progress, not passed.
        const status = deriveStatus(["O1", "O2"], {
          O1: makeMark("pass", "2026-06-08T01:00:00.000Z"),
        });
        expect(status).toBe("passed");
      });

    expect(diverge).toThrow(/TC-020 step diverged: "Mark the second observation of case A pass/);

    let captured = "";
    try {
      diverge();
    } catch (e) {
      captured = (e as Error).message;
    }
    expect(captured).toContain("expected: Case A derives to passed");
    expect(captured).toContain("actual:");
    expect(captured).toContain("in_progress");
    expect(captured).toContain(`owning slice(s): ${OWNING_SLICES}`);
  });
});
