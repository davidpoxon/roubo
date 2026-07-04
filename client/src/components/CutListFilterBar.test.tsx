// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CutListFilterBar from "./CutListFilterBar";
import { createEmptyFilters, getFacetSelection } from "../lib/cut-list-filters";
import type { FilterState } from "../lib/cut-list-filters";
import type { FilterFacet } from "@roubo/shared";

const fetchFacetOptions = vi.fn();
vi.mock("../hooks/useCutListFacets", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useFilterFacets: vi.fn(() => ({ data: [] })),
    useFacetOptions: (
      _projectId: string | undefined,
      _pluginId: string | null,
      facetId: string,
      opts: { enabled: boolean } = { enabled: false },
    ) =>
      useQuery({
        queryKey: ["test-facet-options", facetId],
        queryFn: () => fetchFacetOptions(facetId),
        enabled: opts.enabled,
      }),
  };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderBar(props: Partial<React.ComponentProps<typeof CutListFilterBar>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onFiltersChange = vi.fn();
  const defaults: React.ComponentProps<typeof CutListFilterBar> = {
    filters: createEmptyFilters(),
    onFiltersChange,
    facets: [
      { id: "type", label: "Type", type: "enum" },
      { id: "label", label: "Label", type: "enum" },
    ],
    projectId: "proj-1",
    pluginId: "github-com",
    derivedOptions: { type: ["Bug", "Feature"], label: ["frontend", "backend"] },
  };
  const merged = { ...defaults, ...props };
  const utils = render(
    <QueryClientProvider client={client}>
      <CutListFilterBar {...merged} />
    </QueryClientProvider>,
  );
  return { ...utils, onFiltersChange: merged.onFiltersChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchFacetOptions.mockResolvedValue([]);
});

describe("CutListFilterBar", () => {
  it("renders the search input even when no facets are available", () => {
    renderBar({ facets: [], derivedOptions: {} });
    expect(
      screen.getByRole("textbox", { name: "Search cuts by title or number" }),
    ).toBeInTheDocument();
  });

  it("hides the filter trigger when no facets are available", () => {
    renderBar({ facets: [], derivedOptions: {} });
    expect(screen.queryByRole("button", { name: /Filter cut list/i })).not.toBeInTheDocument();
  });

  it("renders the filter trigger when facets are provided", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Filter cut list" })).toBeInTheDocument();
  });

  it("typing in search calls onFiltersChange with updated search", async () => {
    const { onFiltersChange } = renderBar();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search cuts by title or number" }),
      "a",
    );
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ search: "a" }));
  });

  it("shows the count badge when a facet selection is active", () => {
    const filters: FilterState = {
      ...createEmptyFilters(),
      facetValues: { type: new Set(["Bug"]), label: new Set(["frontend"]) },
    };
    renderBar({ filters });
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders a section per facet inside the popover", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Label")).toBeInTheDocument();
  });

  it("selecting an enum option calls onFiltersChange with a single-key set", async () => {
    const { onFiltersChange } = renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
    await userEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ facetValues: { type: new Set(["Bug"]) } }),
    );
  });

  it("multi-enum selection accumulates values", async () => {
    const facets: FilterFacet[] = [{ id: "label", label: "Label", type: "multi-enum" }];
    const filters: FilterState = {
      ...createEmptyFilters(),
      facetValues: { label: new Set(["frontend"]) },
    };
    const { onFiltersChange } = renderBar({
      facets,
      filters,
      derivedOptions: { label: ["frontend", "backend"] },
    });
    await userEvent.click(screen.getByRole("button", { name: /Filter cut list/i }));
    await userEvent.click(screen.getByRole("option", { name: "backend" }));
    expect(onFiltersChange).toHaveBeenCalled();
    const next = (onFiltersChange as unknown as MockInstance).mock.calls[0]?.[0] as FilterState;
    const selection = getFacetSelection(next, "label");
    expect(selection.has("frontend")).toBe(true);
    expect(selection.has("backend")).toBe(true);
  });

  describe("enum-async facets", () => {
    it("fetches options as soon as the popover opens, with no 'Load options' button", async () => {
      fetchFacetOptions.mockResolvedValueOnce([
        { value: "v1", label: "v1.0" },
        { value: "v2", label: "v2.0" },
      ]);
      const facets: FilterFacet[] = [{ id: "milestone", label: "Milestone", type: "enum-async" }];
      renderBar({ facets, derivedOptions: {} });
      await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
      expect(screen.queryByRole("button", { name: "Load options" })).not.toBeInTheDocument();
      expect(fetchFacetOptions).toHaveBeenCalledWith("milestone");
      expect(await screen.findByRole("option", { name: "v1.0" })).toBeInTheDocument();
      expect(await screen.findByRole("option", { name: "v2.0" })).toBeInTheDocument();
    });
  });

  describe("status exclusion is no longer a client concern (FR-009)", () => {
    const statusFacets: FilterFacet[] = [{ id: "status", label: "Status", type: "enum" }];

    it("renders status options without a 'Hidden by default' pill or include-hidden toggle", async () => {
      // Exclusion moved into the query; the client neither folds excluded
      // statuses into the facet nor offers a toggle to reveal them.
      renderBar({
        facets: statusFacets,
        derivedOptions: { status: ["Open", "In progress"] },
      });
      await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
      expect(screen.queryByText("Hidden by default")).not.toBeInTheDocument();
      expect(screen.queryByText(/Include hidden statuses/i)).not.toBeInTheDocument();
    });
  });

  describe("source-side exclusion note (issue #423, TC-057/058/067)", () => {
    it("renders the exact milestone note for a milestone facet", async () => {
      const facets: FilterFacet[] = [{ id: "milestone", label: "Milestone", type: "enum-async" }];
      renderBar({ facets, derivedOptions: {} });
      await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
      const note = await screen.findByTestId("source-exclusion-note");
      // TC-057-S001-O04 asserts this string verbatim.
      expect(note.textContent).toBe("Closed / archived milestones are excluded at the source.");
    });

    it("renders the epic note for an epic facet", async () => {
      const facets: FilterFacet[] = [{ id: "epic", label: "Epic", type: "enum-async" }];
      renderBar({ facets, derivedOptions: {} });
      await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
      const note = await screen.findByTestId("source-exclusion-note");
      expect(note.textContent).toBe("Closed / resolved epics are excluded at the source.");
    });

    it("renders no source-exclusion note for a non-excluding facet", async () => {
      renderBar({
        facets: [{ id: "status", label: "Status", type: "enum" }],
        derivedOptions: { status: ["Open", "In progress"] },
      });
      await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
      // The section renders, but carries no source-exclusion footer note.
      expect(screen.getByRole("option", { name: "Open" })).toBeInTheDocument();
      expect(screen.queryByTestId("source-exclusion-note")).not.toBeInTheDocument();
    });
  });

  describe("COMMON_FACET_FALLBACK (TC-126)", () => {
    it("renders Status, Label, Assignee, Type sections when given the fallback set", async () => {
      const fallback: FilterFacet[] = [
        { id: "status", label: "Status", type: "enum" },
        { id: "label", label: "Label", type: "enum" },
        { id: "assignee", label: "Assignee", type: "enum" },
        { id: "type", label: "Type", type: "enum" },
      ];
      renderBar({
        facets: fallback,
        derivedOptions: {
          status: ["Open"],
          label: ["frontend"],
          assignee: ["alice"],
          type: ["Bug"],
        },
      });
      await userEvent.click(screen.getByRole("button", { name: "Filter cut list" }));
      expect(screen.getByText("Status")).toBeInTheDocument();
      expect(screen.getByText("Label")).toBeInTheDocument();
      expect(screen.getByText("Assignee")).toBeInTheDocument();
      expect(screen.getByText("Type")).toBeInTheDocument();
    });
  });
});
