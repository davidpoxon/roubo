// @vitest-environment jsdom
//
// #440: the archived-cases section surfaces orphaned case results (a case removed
// from the source plan whose results were retained, not deleted) so an authored
// mark or note is never lost from the reviewer's view (NFR-003). It renders only
// when at least one orphaned result exists, and shows each orphan's id, status,
// observation marks, and notes.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { BenchResults } from "@roubo/shared/testbench-contracts";
import ArchivedCases from "./ArchivedCases";

const AUTHOR = { name: "Reviewer", email: "r@example.com" };

function results(caseResults: BenchResults["caseResults"]): BenchResults {
  return { caseResults, updatedAt: "2026-06-08T09:00:00.000Z" };
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
