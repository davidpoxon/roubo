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
import type { GitHubProjectItem } from "@roubo/shared";

const noopFiltersChange = vi.fn();

const defaultProps = {
  filters: createEmptyFilters(),
  onFiltersChange: noopFiltersChange,
  availableMilestones: ["Sprint 1", "Sprint 2"],
  availableTypes: ["Bug", "Feature"],
  availableLabels: ["frontend", "backend"],
};

function makeItemWithTitle(
  number: number,
  title: string,
  overrides: Partial<{
    milestone: string;
    type: string;
    labels: string[];
  }> = {},
): GitHubProjectItem {
  return {
    issue: {
      number,
      title,
      body: null,
      state: "open",
      labels: overrides.labels ?? [],
      milestone: overrides.milestone,
      type: overrides.type,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      commentsCount: 0,
      htmlUrl: `https://github.com/org/repo/issues/${number}`,
    },
  };
}

function makeItem(
  number: number,
  overrides: Partial<{
    milestone: string;
    type: string;
    labels: string[];
  }> = {},
): GitHubProjectItem {
  return {
    issue: {
      number,
      title: `Issue ${number}`,
      body: null,
      state: "open",
      labels: overrides.labels ?? [],
      milestone: overrides.milestone,
      type: overrides.type,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      commentsCount: 0,
      htmlUrl: `https://github.com/org/repo/issues/${number}`,
    },
  };
}

describe("CutListFilterBar", () => {
  it("renders filter trigger button", () => {
    render(<CutListFilterBar {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Filter cut list" })).toBeInTheDocument();
  });

  it("renders search input even when no structured filter options are available", () => {
    render(
      <CutListFilterBar
        {...defaultProps}
        availableMilestones={[]}
        availableTypes={[]}
        availableLabels={[]}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Search cuts by title or number" }),
    ).toBeInTheDocument();
  });

  it("hides filter trigger button when no structured filter options are available", () => {
    render(
      <CutListFilterBar
        {...defaultProps}
        availableMilestones={[]}
        availableTypes={[]}
        availableLabels={[]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Filter cut list" })).not.toBeInTheDocument();
  });

  it("renders search input", () => {
    render(<CutListFilterBar {...defaultProps} />);
    expect(
      screen.getByRole("textbox", { name: "Search cuts by title or number" }),
    ).toBeInTheDocument();
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

  it("shows clear search button when search has content", () => {
    render(
      <CutListFilterBar {...defaultProps} filters={{ ...createEmptyFilters(), search: "fix" }} />,
    );
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("does not show clear search button when search is empty", () => {
    render(<CutListFilterBar {...defaultProps} />);
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("pressing clear search button clears the search field", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), search: "fix" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ search: "" }));
  });

  it("shows count badge on trigger when filters are active", () => {
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ milestone: "Sprint 1", type: "Bug", labels: new Set(), search: "" }}
      />,
    );
    const badge = screen.getByText("2");
    expect(badge).toBeInTheDocument();
  });

  it("shows count of 1 when only one filter is active", () => {
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), milestone: "Sprint 1" }}
      />,
    );
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("does not show badge when no filters are active", () => {
    render(<CutListFilterBar {...defaultProps} />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("opens popover with Filters heading on trigger click", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });

  it("shows Milestone section when milestones are available", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByText("Milestone")).toBeInTheDocument();
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

  it("omits Milestone section when no milestones available", async () => {
    render(<CutListFilterBar {...defaultProps} availableMilestones={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.queryByText("Milestone")).not.toBeInTheDocument();
  });

  it("omits Type section when no types available", async () => {
    render(<CutListFilterBar {...defaultProps} availableTypes={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.queryByText("Type")).not.toBeInTheDocument();
  });

  it("omits Labels section when no labels available", async () => {
    render(<CutListFilterBar {...defaultProps} availableLabels={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.queryByText("Labels")).not.toBeInTheDocument();
  });

  it("shows milestone items in the popover", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByRole("option", { name: "Sprint 1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sprint 2" })).toBeInTheDocument();
  });

  it("calls onFiltersChange with milestone when milestone item is selected", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={createEmptyFilters()}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    await userEvent.click(screen.getByRole("option", { name: "Sprint 1" }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: "Sprint 1" }),
    );
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

  it('shows "Clear all" button only when filters are active', async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), milestone: "Sprint 1" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
  });

  it('does not show "Clear all" when no filters active', async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it('"Clear all" calls onFiltersChange with empty filters', async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ milestone: "Sprint 1", type: "Bug", labels: new Set(["frontend"]), search: "" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onFiltersChange).toHaveBeenCalledWith(createEmptyFilters());
  });

  it("shows clear button for milestone section when milestone is set", async () => {
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), milestone: "Sprint 1" }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    expect(screen.getByRole("button", { name: "Clear milestone filter" })).toBeInTheDocument();
  });

  it("does not show clear button for milestone section when milestone is not set", async () => {
    render(<CutListFilterBar {...defaultProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(
      screen.queryByRole("button", { name: "Clear milestone filter" }),
    ).not.toBeInTheDocument();
  });

  it("clearing milestone section calls onFiltersChange with empty milestone", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), milestone: "Sprint 1" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear milestone filter" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ milestone: "" }));
  });

  it("deselecting a selected milestone calls onFiltersChange with empty milestone", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), milestone: "Sprint 1" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    await userEvent.click(screen.getByRole("option", { name: "Sprint 1" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ milestone: "" }));
  });

  it("deselecting a selected type calls onFiltersChange with empty type", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), type: "Bug" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    await userEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ type: "" }));
  });

  it("clearing labels section calls onFiltersChange with empty labels", async () => {
    const onFiltersChange = vi.fn();
    render(
      <CutListFilterBar
        {...defaultProps}
        filters={{ ...createEmptyFilters(), labels: new Set(["frontend"]) }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear labels filter" }));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ labels: new Set() }));
  });
});

describe("applyFilters", () => {
  const items = [
    makeItem(1, { milestone: "Sprint 1", type: "Bug", labels: ["frontend", "api"] }),
    makeItem(2, { milestone: "Sprint 1", type: "Feature", labels: ["backend"] }),
    makeItem(3, { milestone: "Sprint 2", type: "Bug", labels: ["frontend"] }),
    makeItem(4, { labels: [] }),
  ];

  it("returns all items when filters are empty", () => {
    expect(applyFilters(items, createEmptyFilters())).toHaveLength(4);
  });

  it("filters by milestone", () => {
    const result = applyFilters(items, { ...createEmptyFilters(), milestone: "Sprint 1" });
    expect(result.map((i) => i.issue.number)).toEqual([1, 2]);
  });

  it("excludes items with no milestone when milestone filter is active", () => {
    const result = applyFilters(items, { ...createEmptyFilters(), milestone: "Sprint 1" });
    expect(result.every((i) => i.issue.milestone)).toBe(true);
  });

  it("filters by type", () => {
    const result = applyFilters(items, { ...createEmptyFilters(), type: "Bug" });
    expect(result.map((i) => i.issue.number)).toEqual([1, 3]);
  });

  it("filters by single label (OR within)", () => {
    const result = applyFilters(items, { ...createEmptyFilters(), labels: new Set(["frontend"]) });
    expect(result.map((i) => i.issue.number)).toEqual([1, 3]);
  });

  it("filters by multiple labels (OR within — item needs any one)", () => {
    const result = applyFilters(items, {
      ...createEmptyFilters(),
      labels: new Set(["frontend", "api"]),
    });
    // items 1 (has both), 3 (has frontend) qualify
    expect(result.map((i) => i.issue.number)).toEqual([1, 3]);
  });

  it("excludes items with no labels when label filter is active", () => {
    const result = applyFilters(items, { ...createEmptyFilters(), labels: new Set(["frontend"]) });
    expect(result.every((i) => i.issue.labels.length > 0)).toBe(true);
  });

  it("applies AND logic across dimensions", () => {
    const result = applyFilters(items, {
      milestone: "Sprint 1",
      type: "Bug",
      labels: new Set(["frontend"]),
      search: "",
    });
    // Only item 1 matches all three
    expect(result.map((i) => i.issue.number)).toEqual([1]);
  });

  it("combining milestone + label shows items matching both", () => {
    const result = applyFilters(items, {
      ...createEmptyFilters(),
      milestone: "Sprint 1",
      labels: new Set(["backend"]),
    });
    expect(result.map((i) => i.issue.number)).toEqual([2]);
  });

  describe("search", () => {
    const searchItems = [
      makeItemWithTitle(10, "Add dark mode support"),
      makeItemWithTitle(123, "Fix login bug"),
      makeItemWithTitle(412, "Refactor database layer"),
    ];

    it("returns all items when search is empty", () => {
      expect(applyFilters(searchItems, createEmptyFilters())).toHaveLength(3);
    });

    it("filters by title substring (case-insensitive)", () => {
      const result = applyFilters(searchItems, { ...createEmptyFilters(), search: "dark" });
      expect(result.map((i) => i.issue.number)).toEqual([10]);
    });

    it("filters by title substring case-insensitively", () => {
      const result = applyFilters(searchItems, { ...createEmptyFilters(), search: "LOGIN" });
      expect(result.map((i) => i.issue.number)).toEqual([123]);
    });

    it("filters by issue number substring", () => {
      const result = applyFilters(searchItems, { ...createEmptyFilters(), search: "12" });
      // issue 123 and 412 both contain "12"
      expect(result.map((i) => i.issue.number)).toEqual([123, 412]);
    });

    it("matches by title OR number", () => {
      // "10" matches issue #10 (number) and no titles
      const result = applyFilters(searchItems, { ...createEmptyFilters(), search: "10" });
      expect(result.map((i) => i.issue.number)).toEqual([10]);
    });

    it("whitespace-only search returns all items", () => {
      const result = applyFilters(searchItems, { ...createEmptyFilters(), search: "   " });
      expect(result).toHaveLength(3);
    });

    it("combines with milestone filter using AND logic", () => {
      const combined = [
        makeItemWithTitle(1, "Add feature", { milestone: "Sprint 1" }),
        makeItemWithTitle(2, "Fix bug", { milestone: "Sprint 1" }),
        makeItemWithTitle(3, "Add other", { milestone: "Sprint 2" }),
      ];
      const result = applyFilters(combined, {
        ...createEmptyFilters(),
        milestone: "Sprint 1",
        search: "add",
      });
      expect(result.map((i) => i.issue.number)).toEqual([1]);
    });
  });
});

describe("isFiltersEmpty", () => {
  it("returns true when all filters are empty", () => {
    expect(isFiltersEmpty(createEmptyFilters())).toBe(true);
  });

  it("returns false when milestone is set", () => {
    expect(isFiltersEmpty({ ...createEmptyFilters(), milestone: "Sprint 1" })).toBe(false);
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

  it("returns 1 for milestone only", () => {
    expect(activeFilterCount({ ...createEmptyFilters(), milestone: "Sprint 1" })).toBe(1);
  });

  it("returns 3 for all filters active", () => {
    expect(
      activeFilterCount({
        milestone: "Sprint 1",
        type: "Bug",
        labels: new Set(["frontend"]),
        search: "",
      }),
    ).toBe(3);
  });

  it("does not count search as a structured filter (badge count)", () => {
    expect(activeFilterCount({ ...createEmptyFilters(), search: "fix" })).toBe(0);
  });
});
