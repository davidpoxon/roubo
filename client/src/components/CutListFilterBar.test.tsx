// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CutListFilterBar from "./CutListFilterBar";
import {
  applyFilters,
  isFiltersEmpty,
  activeFilterCount,
  createEmptyFilters,
} from "../lib/cut-list-filters";
import type { NormalizedIssue } from "@roubo/shared";

const noopFiltersChange = vi.fn();

const defaultProps = {
  filters: createEmptyFilters(),
  onFiltersChange: noopFiltersChange,
  availableTypes: ["Bug", "Feature"],
  availableLabels: ["frontend", "backend"],
};

function makeIssue(
  externalId: string,
  overrides: Partial<{ title: string; issueType: string; labels: string[] }> = {},
): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/org/repo/issues/${externalId}`,
    title: overrides.title ?? `Issue ${externalId}`,
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: overrides.labels ?? [],
    issueType: overrides.issueType ?? null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: null,
  };
}

describe("CutListFilterBar", () => {
  it("renders filter trigger button", () => {
    render(<CutListFilterBar {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Filter cut list" })).toBeInTheDocument();
  });

  it("renders search input even when no structured filter options are available", () => {
    render(<CutListFilterBar {...defaultProps} availableTypes={[]} availableLabels={[]} />);
    expect(
      screen.getByRole("textbox", { name: "Search cuts by title or number" }),
    ).toBeInTheDocument();
  });

  it("hides filter trigger button when no structured filter options are available", () => {
    render(<CutListFilterBar {...defaultProps} availableTypes={[]} availableLabels={[]} />);
    expect(screen.queryByRole("button", { name: "Filter cut list" })).not.toBeInTheDocument();
  });

  it("typing in search input calls onFiltersChange with updated search", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={createEmptyFilters()}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search cuts by title or number" }),
      "f",
    );
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ search: "f" }));
  });

  it("shows count badge on trigger when filters are active", () => {
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ type: "Bug", labels: new Set(["frontend"]), search: "" }}
      />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("opens popover with Filters heading on trigger click", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });

  it("shows Type section when types are available", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("shows Labels section when labels are available", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByText("Labels")).toBeInTheDocument();
  });

  it("calls onFiltersChange with type when type item is selected", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={createEmptyFilters()}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    await userEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ type: "Bug" }));
  });

  it("calls onFiltersChange with labels when a label item is selected", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={createEmptyFilters()}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    await userEvent.click(screen.getByRole("option", { name: "frontend" }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ labels: new Set(["frontend"]) }),
    );
  });
});

describe("applyFilters", () => {
  const issues = [
    makeIssue("1", { issueType: "Bug", labels: ["frontend", "api"] }),
    makeIssue("2", { issueType: "Feature", labels: ["backend"] }),
    makeIssue("3", { issueType: "Bug", labels: ["frontend"] }),
    makeIssue("4", { labels: [] }),
  ];

  it("returns all issues when filters are empty", () => {
    expect(applyFilters(issues, createEmptyFilters())).toHaveLength(4);
  });

  it("filters by type", () => {
    const result = applyFilters(issues, { ...createEmptyFilters(), type: "Bug" });
    expect(result.map((i) => i.externalId)).toEqual(["1", "3"]);
  });

  it("filters by single label", () => {
    const result = applyFilters(issues, {
      ...createEmptyFilters(),
      labels: new Set(["frontend"]),
    });
    expect(result.map((i) => i.externalId)).toEqual(["1", "3"]);
  });

  it("filters by multiple labels (OR within)", () => {
    const result = applyFilters(issues, {
      ...createEmptyFilters(),
      labels: new Set(["frontend", "api"]),
    });
    expect(result.map((i) => i.externalId)).toEqual(["1", "3"]);
  });

  it("applies AND logic across type + labels", () => {
    const result = applyFilters(issues, {
      type: "Bug",
      labels: new Set(["frontend"]),
      search: "",
    });
    expect(result.map((i) => i.externalId)).toEqual(["1", "3"]);
  });

  describe("search", () => {
    const searchIssues = [
      makeIssue("10", { title: "Add dark mode support" }),
      makeIssue("123", { title: "Fix login bug" }),
      makeIssue("412", { title: "Refactor database layer" }),
    ];

    it("filters by title substring case-insensitively", () => {
      const result = applyFilters(searchIssues, { ...createEmptyFilters(), search: "LOGIN" });
      expect(result.map((i) => i.externalId)).toEqual(["123"]);
    });

    it("filters by externalId substring", () => {
      const result = applyFilters(searchIssues, { ...createEmptyFilters(), search: "12" });
      // "12" matches externalIds "123" and "412"
      expect(result.map((i) => i.externalId)).toEqual(["123", "412"]);
    });

    it("whitespace-only search returns all issues", () => {
      const result = applyFilters(searchIssues, { ...createEmptyFilters(), search: "   " });
      expect(result).toHaveLength(3);
    });
  });
});

describe("isFiltersEmpty", () => {
  it("returns true when all filters are empty", () => {
    expect(isFiltersEmpty(createEmptyFilters())).toBe(true);
  });

  it("returns false when type is set", () => {
    expect(isFiltersEmpty({ ...createEmptyFilters(), type: "Bug" })).toBe(false);
  });

  it("returns false when labels are set", () => {
    expect(isFiltersEmpty({ ...createEmptyFilters(), labels: new Set(["frontend"]) })).toBe(false);
  });

  it("returns false when search is set", () => {
    expect(isFiltersEmpty({ ...createEmptyFilters(), search: "fix" })).toBe(false);
  });
});

describe("activeFilterCount", () => {
  it("returns 0 for empty filters", () => {
    expect(activeFilterCount(createEmptyFilters())).toBe(0);
  });

  it("returns 1 for type only", () => {
    expect(activeFilterCount({ ...createEmptyFilters(), type: "Bug" })).toBe(1);
  });

  it("returns 2 for type + labels", () => {
    expect(activeFilterCount({ type: "Bug", labels: new Set(["frontend"]), search: "" })).toBe(2);
  });

  it("does not count search as a structured filter (badge count)", () => {
    expect(activeFilterCount({ ...createEmptyFilters(), search: "fix" })).toBe(0);
  });
});
