// @vitest-environment jsdom
//
// #775 (SATCA-TC-019, SATCA-NFR-005): the accessibility contract of the archived
// cases section. Its controls (Restore, and the "Replaced by" reveal) are
// reachable and operable by keyboard alone, the section is a named landmark, the
// lifecycle state of every entry is carried as text rather than by colour, and
// the rendered section reports zero axe findings in each of its shapes.
//
// It also holds the AC4 focus contract: after a case is retired or superseded it
// leaves the live list, and the panel hands this section the id of the case that
// just arrived so the matching entry takes focus rather than dropping it to the
// document body.
//
// Coverage gap: jsdom has no layout/paint engine, so axe cannot execute the
// color-contrast rule here (it silently reports zero contrast violations even
// when text fails AA in a real browser). The archival surfaces are scanned for
// real contrast in e2e/e2e-flow/archival-contrast.spec.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { BenchResults, Case, CaseLifecycle } from "@roubo/shared/testbench-contracts";
import ArchivedCases from "./ArchivedCases";
import { buildRollup, type ArchivedCaseModel } from "./rollup";
import { expectNoAxeFindings } from "../../test/axe";

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useSetCaseLifecycle: vi.fn(),
  caseLifecycleErrorMessage: (error: unknown) => (error ? (error as Error).message : null),
}));
import { useSetCaseLifecycle } from "../../hooks/useTestbenchPlan";

const mockSetLifecycle = vi.mocked(useSetCaseLifecycle);
const restoreMutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockSetLifecycle.mockReturnValue({
    mutate: restoreMutate,
    isPending: false,
    error: null,
  } as never);
});

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
    linked_requirement_ids: ["SATCA-NFR-005"],
    linked_user_story_ids: [],
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}

// The archived entries the panel passes down are the rollup's own output, so the
// component tests build them the same way the panel does rather than by hand.
function archivedFor(cases: Case[], benchResults: BenchResults | null = null): ArchivedCaseModel[] {
  return buildRollup(cases, benchResults, "spec-and-test-case-archival").archived;
}

const RETIRED = lifecycleCase("TC-A", { state: "retired", reason: "covered by TC-B" });
const SUPERSEDED = lifecycleCase("TC-C", { state: "superseded", replacement: "TC-B" });
const LIVE_TARGET = lifecycleCase("TC-B");

function renderSection(props: Partial<React.ComponentProps<typeof ArchivedCases>> = {}) {
  return render(
    <ArchivedCases
      results={null}
      archived={archivedFor([RETIRED, SUPERSEDED, LIVE_TARGET])}
      projectId="p1"
      benchId={7}
      {...props}
    />,
  );
}

describe("ArchivedCases a11y: name and state as text (SATCA-TC-019 S001)", () => {
  it("names the section so it is reachable as a labelled region", () => {
    renderSection();
    expect(screen.getByRole("region", { name: "Archived cases" })).toBeInTheDocument();
  });

  it("states each entry's lifecycle state in words, not by colour alone", () => {
    renderSection({
      results: results({
        "TC-GONE": { observationMarks: {}, derivedStatus: "passed", notes: [], orphaned: true },
      }),
    });

    expect(
      within(screen.getByTestId("archived-case-TC-A")).getByText("Retired"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("archived-case-TC-C")).getByText("Superseded"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("archived-case-TC-GONE")).getByText("Removed from plan"),
    ).toBeInTheDocument();
  });
});

describe("ArchivedCases a11y: keyboard operation (SATCA-TC-019 S002-O01)", () => {
  it("reaches and operates Restore by keyboard alone", async () => {
    const user = userEvent.setup();
    renderSection({ archived: archivedFor([RETIRED]) });

    // Reached by tabbing, never by a mouse click: a retired entry offers Restore
    // as its only control, so one Tab from the document lands on it.
    await user.tab();
    expect(screen.getByRole("button", { name: /Restore/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(restoreMutate).toHaveBeenCalledWith({
      projectId: "p1",
      benchId: 7,
      caseId: "TC-A",
      lifecycle: null,
    });

    restoreMutate.mockClear();
    await user.keyboard("[Space]");
    expect(restoreMutate).toHaveBeenCalledTimes(1);
  });

  it("reaches and operates the replacement reveal by keyboard alone", async () => {
    const user = userEvent.setup();
    const onSelectCase = vi.fn();
    renderSection({ archived: archivedFor([SUPERSEDED, LIVE_TARGET]), onSelectCase });

    await user.tab();
    expect(screen.getByRole("button", { name: "Replaced by TC-B" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelectCase).toHaveBeenCalledWith("TC-B");
  });

  it("keeps every control in the tab order, with the entries themselves skipped", async () => {
    const user = userEvent.setup();
    renderSection({ archived: archivedFor([SUPERSEDED, LIVE_TARGET]), onSelectCase: vi.fn() });

    await user.tab();
    expect(screen.getByRole("button", { name: "Replaced by TC-B" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /Restore/ })).toHaveFocus();
  });
});

// #775 AC4. Retiring a case removes it from the live list, unmounting the
// control that applied the action; the panel names the arriving case so this
// section can land focus on it rather than letting it fall to the body.
describe("ArchivedCases a11y: focus lands on the arriving case (SATCA-TC-057)", () => {
  it("focuses the entry named by focusCaseId once it mounts", () => {
    const { rerender } = render(
      <ArchivedCases results={null} archived={[]} projectId="p1" benchId={7} />,
    );
    expect(document.body).toHaveFocus();

    rerender(
      <ArchivedCases
        results={null}
        archived={archivedFor([RETIRED])}
        projectId="p1"
        benchId={7}
        focusCaseId="TC-A"
      />,
    );
    expect(screen.getByTestId("archived-case-TC-A")).toHaveFocus();
  });

  it("leaves focus alone on an ordinary render", () => {
    renderSection();
    expect(document.body).toHaveFocus();
  });

  it("does not put the focused entry into the tab order", () => {
    renderSection({ archived: archivedFor([RETIRED]), focusCaseId: "TC-A" });
    expect(screen.getByTestId("archived-case-TC-A")).toHaveAttribute("tabindex", "-1");
  });
});

describe("ArchivedCases a11y: axe (SATCA-TC-019 S002-O02)", () => {
  it("has no axe violations for lifecycle entries with marks, notes, and Restore", async () => {
    const benchResults = results({
      "TC-A": {
        observationMarks: {
          "S001-O01": { result: "pass", author: AUTHOR, timestamp: "2026-06-08T09:00:00Z" },
          "S001-O02": { result: "fail", author: AUTHOR, timestamp: "2026-06-08T09:01:00Z" },
        },
        derivedStatus: "failed",
        notes: [
          {
            id: "n1",
            text: "flaky on CI",
            author: AUTHOR,
            timestamp: "2026-06-08T09:00:00Z",
            statusAtWrite: "failed",
          },
        ],
      },
    });
    const { container } = render(
      <ArchivedCases
        results={benchResults}
        archived={archivedFor([RETIRED, SUPERSEDED, LIVE_TARGET], benchResults)}
        onSelectCase={vi.fn()}
        projectId="p1"
        benchId={7}
      />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations when a lifecycle entry and an orphaned result coexist", async () => {
    const benchResults = results({
      "TC-GONE": { observationMarks: {}, derivedStatus: "passed", notes: [], orphaned: true },
    });
    const { container } = render(
      <ArchivedCases
        results={benchResults}
        archived={archivedFor([RETIRED], benchResults)}
        projectId="p1"
        benchId={7}
      />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations with a refused restore showing", async () => {
    mockSetLifecycle.mockReturnValue({
      mutate: restoreMutate,
      isPending: false,
      error: new Error("The case file changed on disk. Reload the spec, then try again."),
    } as never);
    const { container } = renderSection({ archived: archivedFor([RETIRED]) });
    expectNoAxeFindings(await axe(container));
  });
});
