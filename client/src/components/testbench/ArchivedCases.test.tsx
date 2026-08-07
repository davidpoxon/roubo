// @vitest-environment jsdom
//
// #440: the archived-cases section surfaces orphaned case results (a case removed
// from the source plan whose results were retained, not deleted) so an authored
// mark or note is never lost from the reviewer's view (NFR-003). It renders only
// when at least one orphaned result exists, and shows each orphan's id, status,
// observation marks, and notes.
//
// #769: the same section now also carries lifecycle-archived cases (retired or
// superseded in the source plan, and therefore excluded from the rollup and the
// live list). Both kinds coexist, each stating in text which situation it is.

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BenchResults, Case, CaseLifecycle } from "@roubo/shared/testbench-contracts";
import ArchivedCases from "./ArchivedCases";
import { buildRollup, type ArchivedCaseModel } from "./rollup";

const AUTHOR = { name: "Reviewer", email: "r@example.com" };

function results(caseResults: BenchResults["caseResults"]): BenchResults {
  return { caseResults, updatedAt: "2026-06-08T09:00:00.000Z" };
}

// Omitting the lifecycle block yields a live case, which is what a revealable
// replacement pointer has to name (#789).
function lifecycleCase(id: string, lifecycle?: CaseLifecycle): Case {
  return {
    id,
    title: `Case ${id}`,
    area: "rollup-and-panel",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["SATCA-FR-006"],
    linked_user_story_ids: [],
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}

// The archived entries the panel passes down are the rollup's own output, so the
// component tests build them the same way the panel does rather than by hand.
function archivedFor(cases: Case[], benchResults: BenchResults | null): ArchivedCaseModel[] {
  return buildRollup(cases, benchResults, "spec-and-test-case-archival").archived;
}

describe("ArchivedCases", () => {
  it("renders nothing when there are no results", () => {
    const { container } = render(<ArchivedCases results={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no result is orphaned", () => {
    const { container } = render(
      <ArchivedCases
        results={results({
          "TC-A": { observationMarks: {}, derivedStatus: "passed", notes: [] },
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces an orphaned case with its fail mark and note retained", () => {
    render(
      <ArchivedCases
        results={results({
          "TC-A": { observationMarks: {}, derivedStatus: "passed", notes: [] },
          "TC-B": {
            observationMarks: {
              "TC-B-S1-O1": { result: "fail", author: AUTHOR, timestamp: "2026-06-08T09:00:00Z" },
            },
            derivedStatus: "failed",
            notes: [
              {
                id: "n1",
                text: "broken redirect",
                author: AUTHOR,
                timestamp: "2026-06-08T09:00:00Z",
                statusAtWrite: "failed",
              },
            ],
            orphaned: true,
          },
        })}
      />,
    );

    const section = screen.getByTestId("archived-cases");
    expect(within(section).getByText("Archived")).toBeInTheDocument();
    // Only the orphaned case appears; the active TC-A is excluded.
    expect(screen.getByTestId("archived-case-TC-B")).toBeInTheDocument();
    expect(screen.queryByTestId("archived-case-TC-A")).not.toBeInTheDocument();

    const archivedB = screen.getByTestId("archived-case-TC-B");
    expect(within(archivedB).getByText("fail")).toBeInTheDocument();
    expect(within(archivedB).getByText("broken redirect")).toBeInTheDocument();
    expect(within(archivedB).getByText("Failed")).toBeInTheDocument();
  });

  it("shows an override status in preference to the derived status", () => {
    render(
      <ArchivedCases
        results={results({
          "TC-B": {
            observationMarks: {},
            derivedStatus: "failed",
            statusOverride: {
              status: "blocked",
              author: AUTHOR,
              timestamp: "2026-06-08T09:00:00Z",
            },
            notes: [],
            orphaned: true,
          },
        })}
      />,
    );
    const archivedB = screen.getByTestId("archived-case-TC-B");
    expect(within(archivedB).getByText("Blocked")).toBeInTheDocument();
  });
});

// #769 (SATCA-FR-006/FR-007). A case retired or superseded in the source plan is
// still IN the plan, so it is never orphaned: without this section it would
// simply vanish from the panel once the rollup excluded it.
describe("ArchivedCases lifecycle entries (#769)", () => {
  it("SATCA-TC-015: lists a retired case with its id, its state as text, and its reason", () => {
    const reason = "Superseded by the batch-level smoke check; kept for audit only.";
    render(
      <ArchivedCases
        results={null}
        archived={archivedFor([lifecycleCase("TC-A", { state: "retired", reason })], null)}
      />,
    );

    const entry = screen.getByTestId("archived-case-TC-A");
    expect(within(entry).getByText("TC-A")).toBeInTheDocument();
    // State as words, not colour alone.
    expect(within(entry).getByText("Retired")).toBeInTheDocument();
    // The reason is shown verbatim.
    expect(screen.getByTestId("archived-reason-TC-A")).toHaveTextContent(reason);
  });

  it("SATCA-TC-016: names a same-spec replacement and reveals it when activated", async () => {
    const onSelectCase = vi.fn();
    render(
      <ArchivedCases
        results={null}
        archived={archivedFor(
          [
            lifecycleCase("TC-A", { state: "superseded", replacement: "TC-B" }),
            // The target has to be in the plan and live to be revealable (#789).
            lifecycleCase("TC-B"),
          ],
          null,
        )}
        onSelectCase={onSelectCase}
      />,
    );

    const entry = screen.getByTestId("archived-case-TC-A");
    expect(within(entry).getByText("Superseded")).toBeInTheDocument();
    const replacement = screen.getByTestId("archived-replacement-TC-A");
    expect(replacement).toHaveTextContent("Replaced by TC-B");

    await userEvent.click(replacement);
    expect(onSelectCase).toHaveBeenCalledWith("TC-B");
  });

  // #789. A same-spec pointer is not proof the target can be revealed: the id may
  // be in no plan at all, or name a case that is itself archived and so absent
  // from the live list. Either way the panel could not resolve the selection, so
  // the pointer is named as text rather than rendered as a dead control.
  it("#789: does not make a same-spec replacement activatable when the target is missing", async () => {
    const onSelectCase = vi.fn();
    render(
      <ArchivedCases
        results={null}
        archived={archivedFor(
          [lifecycleCase("TC-A", { state: "superseded", replacement: "TC-GONE" })],
          null,
        )}
        onSelectCase={onSelectCase}
      />,
    );

    const replacement = screen.getByTestId("archived-replacement-TC-A");
    // The verbatim pointer is still named, so the reviewer can see where the
    // author pointed even though nothing can be revealed.
    expect(replacement).toHaveTextContent("Replaced by TC-GONE");
    expect(replacement.tagName).toBe("P");
    expect(screen.queryByRole("button", { name: /Replaced by/ })).not.toBeInTheDocument();
    await userEvent.click(replacement);
    expect(onSelectCase).not.toHaveBeenCalled();
  });

  it("#789: does not make a same-spec replacement activatable when the target is retired", async () => {
    const onSelectCase = vi.fn();
    render(
      <ArchivedCases
        results={null}
        archived={archivedFor(
          [
            lifecycleCase("TC-A", { state: "superseded", replacement: "TC-B" }),
            lifecycleCase("TC-B", { state: "retired", reason: "obsolete too" }),
          ],
          null,
        )}
        onSelectCase={onSelectCase}
      />,
    );

    const replacement = screen.getByTestId("archived-replacement-TC-A");
    expect(replacement).toHaveTextContent("Replaced by TC-B");
    expect(replacement.tagName).toBe("P");
    expect(screen.queryByRole("button", { name: /Replaced by/ })).not.toBeInTheDocument();
    await userEvent.click(replacement);
    expect(onSelectCase).not.toHaveBeenCalled();
  });

  it("names a cross-spec replacement without making it activatable", async () => {
    const onSelectCase = vi.fn();
    render(
      <ArchivedCases
        results={null}
        archived={archivedFor(
          [lifecycleCase("TC-A", { state: "superseded", replacement: "other-spec:TC-B" })],
          null,
        )}
        onSelectCase={onSelectCase}
      />,
    );

    const replacement = screen.getByTestId("archived-replacement-TC-A");
    expect(replacement).toHaveTextContent("Replaced by other-spec:TC-B");
    // No control to activate: the panel holds only this spec's plan.
    expect(screen.queryByRole("button", { name: /Replaced by/ })).not.toBeInTheDocument();
    await userEvent.click(replacement);
    expect(onSelectCase).not.toHaveBeenCalled();
  });

  it("SATCA-TC-017: retains marks, notes, and the status override on a retired case", () => {
    const benchResults = results({
      "TC-A": {
        observationMarks: {
          "S001-O01": { result: "pass", author: AUTHOR, timestamp: "2026-06-08T09:00:00Z" },
          "S001-O02": { result: "fail", author: AUTHOR, timestamp: "2026-06-08T09:01:00Z" },
        },
        derivedStatus: "failed",
        statusOverride: { status: "blocked", author: AUTHOR, timestamp: "2026-06-08T09:02:00Z" },
        notes: [
          {
            id: "n1",
            text: "flaky on CI",
            author: AUTHOR,
            timestamp: "2026-06-08T09:00:00Z",
            statusAtWrite: "failed",
          },
          {
            id: "n2",
            text: "raised upstream",
            author: AUTHOR,
            timestamp: "2026-06-08T09:01:00Z",
            statusAtWrite: "failed",
          },
        ],
      },
    });
    const cases = [lifecycleCase("TC-A", { state: "retired", reason: "obsolete" })];

    render(<ArchivedCases results={benchResults} archived={archivedFor(cases, benchResults)} />);

    const entry = screen.getByTestId("archived-case-TC-A");
    expect(within(entry).getByText("S001-O01")).toBeInTheDocument();
    expect(within(entry).getByText("S001-O02")).toBeInTheDocument();
    expect(within(entry).getByText("flaky on CI")).toBeInTheDocument();
    expect(within(entry).getByText("raised upstream")).toBeInTheDocument();
    // The override wins over the derived status, exactly as it did before.
    expect(within(entry).getByText("Blocked")).toBeInTheDocument();
    // The result is not orphaned, so it is not listed twice.
    expect(screen.getAllByTestId("archived-case-TC-A")).toHaveLength(1);
  });

  it("SATCA-TC-021: lifecycle-archived cases and orphaned results coexist, each saying which", () => {
    const benchResults = results({
      "TC-GONE": { observationMarks: {}, derivedStatus: "passed", notes: [], orphaned: true },
    });
    const cases = [lifecycleCase("TC-A", { state: "retired", reason: "obsolete" })];

    render(<ArchivedCases results={benchResults} archived={archivedFor(cases, benchResults)} />);

    const lifecycleEntry = screen.getByTestId("archived-case-TC-A");
    const orphanEntry = screen.getByTestId("archived-case-TC-GONE");
    expect(lifecycleEntry).toBeInTheDocument();
    expect(orphanEntry).toBeInTheDocument();

    // Each entry states which of the two situations it is, in distinct wording.
    expect(lifecycleEntry).toHaveTextContent("Still in the source plan");
    expect(within(lifecycleEntry).getByText("Retired")).toBeInTheDocument();
    expect(orphanEntry).toHaveTextContent("Removed from the source plan");
    expect(within(orphanEntry).getByText("Removed from plan")).toBeInTheDocument();

    // Both are counted in the section header, and neither is in the rollup.
    const section = screen.getByTestId("archived-cases");
    expect(within(section).getByText("2")).toBeInTheDocument();
    expect(buildRollup(cases, benchResults, "spec").overall.total).toBe(0);
  });

  it("renders the section for a lifecycle entry even with no orphaned results", () => {
    const { container } = render(
      <ArchivedCases
        results={null}
        archived={archivedFor([lifecycleCase("TC-A", { state: "retired", reason: "x" })], null)}
      />,
    );
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByTestId("archived-cases")).toBeInTheDocument();
  });
});
