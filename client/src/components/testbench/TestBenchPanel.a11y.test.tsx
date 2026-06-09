// @vitest-environment jsdom
//
// #419 TC-005/TC-029/TC-030/TC-035: the TestBench review panel renders the
// grouped case list + rollup with zero axe violations, never serialises raw
// JSON into the DOM, and handles loading / empty / error states.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { TestCasesPlan, BenchResults, Case } from "@roubo/shared/testbench-contracts";
import type { TestbenchPlanResponse } from "../../lib/api";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}
expect.extend({ toHaveNoViolations });

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useTestbenchPlan: vi.fn(),
  useSetTestbenchFocus: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
// The panel now mounts the staleness/reconcile surface (#440 integration), which
// pulls in the reconcile mutation hooks; mock them so the panel renders without a
// QueryClientProvider.
vi.mock("../../hooks/useReconcile", () => ({
  useReconcilePreview: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
  useReconcileApply: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
  useReconcilePurge: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import TestBenchPanel from "./TestBenchPanel";

const mockUseTestbenchPlan = vi.mocked(useTestbenchPlan);

function makeCase(id: string, level: number, priority: string, title: string): Case {
  return {
    id,
    title,
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

function plan(cases: Case[]): TestCasesPlan {
  return {
    $schema: "https://roubo.dev/schema/testbench/test-cases/v1.0.0.json",
    schemaVersion: "1.0.0",
    specSlug: "demo",
    cases,
  };
}

function results(caseResults: BenchResults["caseResults"]): BenchResults {
  return { caseResults, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function setData(data: Partial<TestbenchPlanResponse> & { plan: TestCasesPlan }): void {
  mockUseTestbenchPlan.mockReturnValue({
    data: { results: null, stale: false, planHash: "h", recovered: false, ...data },
    isLoading: false,
    isError: false,
    error: null,
  } as ReturnType<typeof useTestbenchPlan>);
}

// jsdom reports zero layout; give the virtualiser a real viewport + row height
// so the windowed case rows actually mount.
const VIEWPORT = 400;
beforeEach(() => {
  mockUseTestbenchPlan.mockReset();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "group" ? VIEWPORT : 36;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "group" ? VIEWPORT : 36;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600,
    height: VIEWPORT,
    top: 0,
    left: 0,
    bottom: VIEWPORT,
    right: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TestBenchPanel", () => {
  it("renders grouped cases with status indicators and no axe violations", async () => {
    setData({
      plan: plan([
        makeCase("c1", 1, "P0", "Sign in flow"),
        makeCase("c2", 1, "P1", "Sign out flow"),
        makeCase("c3", 2, "P0", "Token parser"),
      ]),
      results: results({
        c1: { observationMarks: {}, derivedStatus: "passed", notes: [] },
        c2: { observationMarks: {}, derivedStatus: "failed", notes: [] },
      }),
    });

    const { container } = render(<TestBenchPanel projectId="p1" benchId={1} />);

    expect(screen.getByText("Sign in flow")).toBeTruthy();
    expect(screen.getByText("Token parser")).toBeTruthy();
    expect(screen.getAllByText("Passed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);

    const results2 = await axe(container);
    expect(results2).toHaveNoViolations();
  });

  it("never serialises raw plan/result JSON into the DOM", () => {
    setData({
      plan: plan([makeCase("c1", 1, "P0", "Sign in flow")]),
      results: results({
        c1: {
          observationMarks: {
            o1: { result: "pass", author: { name: "a", email: "a@b.c" }, timestamp: "t" },
          },
          derivedStatus: "passed",
          notes: [],
        },
      }),
    });

    const { container } = render(<TestBenchPanel projectId="p1" benchId={1} />);
    const html = container.innerHTML;
    // Hallmarks of a serialised plan/result object must never appear.
    expect(html).not.toContain("observationMarks");
    expect(html).not.toContain("derivedStatus");
    expect(html).not.toContain("$schema");
    expect(html).not.toContain('{"');
  });

  it("shows a loading state", () => {
    mockUseTestbenchPlan.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useTestbenchPlan>);
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(screen.getByText(/loading test cases/i)).toBeTruthy();
  });

  it("shows an empty state when the plan has no cases", () => {
    setData({ plan: plan([]) });
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(screen.getByText(/no test cases yet/i)).toBeTruthy();
  });

  it("shows an error state", () => {
    mockUseTestbenchPlan.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("No test-cases.json for spec"),
    } as ReturnType<typeof useTestbenchPlan>);
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(screen.getByText(/No test-cases.json/i)).toBeTruthy();
  });

  it("shows a preparing placeholder (not an error) while the bench is preparing (#500)", () => {
    // The disabled plan query returns no data and no error on first load; the
    // panel must render the preparing placeholder, never the error branch.
    mockUseTestbenchPlan.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useTestbenchPlan>);
    render(<TestBenchPanel projectId="p1" benchId={1} benchStatus="preparing" />);
    expect(screen.getByText(/preparing test cases/i)).toBeTruthy();
    expect(screen.queryByText(/No test-cases.json/i)).toBeNull();
    expect(screen.queryByText(/could not load the testbench plan/i)).toBeNull();
  });
});
