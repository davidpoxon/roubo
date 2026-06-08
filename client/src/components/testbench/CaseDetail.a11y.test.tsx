// @vitest-environment jsdom
//
// #420 TC-019/TC-021/TC-022/TC-023/TC-024/TC-031/TC-036: the case detail pane
// renders the case in full (metadata, preconditions, ordered steps, expected
// observations), each observation carries a keyboard-operable segmented pass/fail
// mark control, the per-case status reflects the marks and an override is shown
// distinctly from the derived value, and the pane has zero axe violations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";
import CaseDetail from "./CaseDetail";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}
expect.extend({ toHaveNoViolations });

vi.mock("../../hooks/useTestbenchMarks");
import { useMarkObservation, useSetStatusOverride } from "../../hooks/useTestbenchMarks";

const mockMark = vi.mocked(useMarkObservation);
const mockOverride = vi.mocked(useSetStatusOverride);

function makeMutationMock(mutate = vi.fn()) {
  return { mutate, isPending: false } as never;
}

const CASE: Case = {
  id: "TC-001",
  title: "Mark each observation pass or fail",
  level: "Integration",
  priority: "P0",
  preconditions: ["A bench is open", "TestBench is enabled"],
  steps: [
    {
      id: "s1",
      instruction: "Open the case detail",
      observations: [
        { id: "o1", expected: "The detail shows steps and observations" },
        { id: "o2", expected: "Each mark is timestamped" },
      ],
    },
    {
      id: "s2",
      instruction: "Mark an observation",
      observations: [{ id: "o3", expected: "The status updates from the marks" }],
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mockMark.mockReturnValue(makeMutationMock());
  mockOverride.mockReturnValue(makeMutationMock());
});

describe("CaseDetail full render (TC-019)", () => {
  it("shows title, id/level/priority, preconditions, ordered steps, and every observation", () => {
    render(<CaseDetail projectId="p1" benchId={1} testCase={CASE} result={undefined} />);

    expect(screen.getByRole("heading", { name: CASE.title })).toBeInTheDocument();
    expect(screen.getByText("TC-001")).toBeInTheDocument();
    expect(screen.getByText("Integration")).toBeInTheDocument();
    expect(screen.getByText("P0")).toBeInTheDocument();
    expect(screen.getByText("A bench is open")).toBeInTheDocument();
    expect(screen.getByText("Open the case detail")).toBeInTheDocument();
    expect(screen.getByText("Mark an observation")).toBeInTheDocument();
    expect(screen.getByText("The detail shows steps and observations")).toBeInTheDocument();
    expect(screen.getByText("Each mark is timestamped")).toBeInTheDocument();
    expect(screen.getByText("The status updates from the marks")).toBeInTheDocument();
    // One mark control (radiogroup) per observation.
    expect(screen.getAllByRole("radiogroup")).toHaveLength(3);
  });
});

describe("CaseDetail observation mark control (TC-021/TC-031)", () => {
  it("marks an observation pass via the mutation hook", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockMark.mockReturnValue(makeMutationMock(mutate));

    render(<CaseDetail projectId="p1" benchId={3} testCase={CASE} result={undefined} />);

    const firstGroup = screen.getAllByRole("radiogroup")[0];
    await user.click(within(firstGroup).getByRole("radio", { name: "Pass" }));

    expect(mutate).toHaveBeenCalledWith({
      projectId: "p1",
      benchId: 3,
      caseId: "TC-001",
      observationId: "o1",
      result: "pass",
    });
  });

  it("reflects a recorded mark as the selected segment", () => {
    const result: CaseResult = {
      observationMarks: {
        o1: {
          result: "fail",
          author: { name: "Ada", email: "a@e.com" },
          timestamp: "2026-06-08T10:00:00.000Z",
        },
      },
      derivedStatus: "in_progress",
      notes: [],
    };
    render(<CaseDetail projectId="p1" benchId={1} testCase={CASE} result={result} />);

    const firstGroup = screen.getAllByRole("radiogroup")[0];
    expect(within(firstGroup).getByRole("radio", { name: "Fail" })).toBeChecked();
  });

  it("is keyboard operable: the mark control radios are focusable and selectable by keyboard", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockMark.mockReturnValue(makeMutationMock(mutate));
    render(<CaseDetail projectId="p1" benchId={1} testCase={CASE} result={undefined} />);

    // Tab through the header status control to the first mark control's Pass
    // radio, then select it by keyboard (space activates a focused radio); a
    // selection fires the mutation. This exercises real keyboard reachability.
    const firstGroup = screen.getAllByRole("radiogroup")[0];
    const passRadio = within(firstGroup).getByRole("radio", { name: "Pass" });
    await user.tab(); // status override Select trigger
    await user.tab(); // first observation's Pass radio
    expect(passRadio).toHaveFocus();
    await user.keyboard("{ }");
    expect(mutate).toHaveBeenCalled();
  });
});

describe("CaseDetail status override (TC-022/TC-024)", () => {
  it("shows the effective (override) status and a distinct Override marker", () => {
    const result: CaseResult = {
      observationMarks: {},
      derivedStatus: "not_started",
      statusOverride: {
        status: "blocked",
        author: { name: "Ada", email: "a@e.com" },
        timestamp: "2026-06-08T10:00:00.000Z",
      },
      notes: [],
    };
    render(<CaseDetail projectId="p1" benchId={1} testCase={CASE} result={result} />);

    // The override marker is present and distinct from the derived value.
    expect(screen.getByTestId("override-marker")).toBeInTheDocument();
    expect(screen.getByText("Override")).toBeInTheDocument();
    // The effective (overridden) status is surfaced (status indicator + the
    // override control's selected value both read "Blocked").
    expect(screen.getAllByText("Blocked").length).toBeGreaterThanOrEqual(1);
  });

  it("does not show an override marker when the status is purely derived", () => {
    const result: CaseResult = {
      observationMarks: {},
      derivedStatus: "in_progress",
      notes: [],
    };
    render(<CaseDetail projectId="p1" benchId={1} testCase={CASE} result={result} />);
    expect(screen.queryByTestId("override-marker")).not.toBeInTheDocument();
  });
});

describe("CaseDetail a11y (TC-036)", () => {
  it("has no axe violations", async () => {
    const result: CaseResult = {
      observationMarks: {
        o1: {
          result: "pass",
          author: { name: "Ada", email: "a@e.com" },
          timestamp: "2026-06-08T10:00:00.000Z",
        },
      },
      derivedStatus: "in_progress",
      statusOverride: {
        status: "blocked",
        author: { name: "Ada", email: "a@e.com" },
        timestamp: "2026-06-08T10:00:00.000Z",
      },
      notes: [],
    };
    const { container } = render(
      <CaseDetail projectId="p1" benchId={1} testCase={CASE} result={result} onBack={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
