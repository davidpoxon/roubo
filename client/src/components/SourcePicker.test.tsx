// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceCandidateItem, SourceCandidatesResponse, SourceSelection } from "@roubo/shared";
import SourcePicker from "./SourcePicker";
import { useSourceOptions, type UseSourceOptionsArgs } from "../hooks/useSourceOptions";

// The searchable arm renders AsyncSourceSearch, which fetches through this
// hook. Stub it with per-category fixtures so the picker logic (gating,
// cascade, pruning) can be exercised without the network.
vi.mock("../hooks/useSourceOptions", () => ({
  useSourceOptions: vi.fn(),
}));

const SEARCHABLE: SourceCandidatesResponse = {
  shape: "searchable-categorized",
  searchableCategories: [
    { id: "project", label: "Projects", icon: "project" },
    { id: "board", label: "Boards", icon: "board", scopedBy: "project" },
    { id: "filter", label: "Filters", icon: "filter", scopedBy: "project" },
    { id: "epic", label: "Epics", icon: "epic", scopedBy: "project" },
    {
      id: "mine",
      label: "Assigned to me",
      options: [
        { id: "in-project", label: "In scoped projects" },
        { id: "anywhere", label: "Anywhere" },
      ],
    },
  ],
};

const ITEMS_BY_CATEGORY: Record<string, SourceCandidateItem[]> = {
  project: [
    { externalId: "PLAT", label: "Platform", sublabel: "PLAT" },
    { externalId: "OPS", label: "Operations", sublabel: "OPS" },
  ],
  board: [
    { externalId: "board:482", label: "PLAT Scrum Board", sublabel: "PLAT · board #482" },
    { externalId: "board:99", label: "PLAT Kanban", sublabel: "PLAT · board #99" },
  ],
  // Filter results carry no project key (the plugin's filter search is not
  // project-scoped).
  filter: [{ externalId: "10231", label: "My open bugs", sublabel: "filter #10231" }],
  epic: [],
};

beforeEach(() => {
  vi.mocked(useSourceOptions).mockImplementation(({ category }: UseSourceOptionsArgs) => ({
    items: ITEMS_BY_CATEGORY[category] ?? [],
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    error: null,
  }));
});

const MULTI_LIST: SourceCandidatesResponse = {
  shape: "multi-list",
  items: [
    { externalId: "owner/repo", label: "owner/repo", icon: "repo" },
    { externalId: "PVT_1", label: "Roadmap", icon: "project" },
  ],
};

const CATEGORIZED: SourceCandidatesResponse = {
  shape: "categorized-multi-list",
  categories: [
    { id: "boards", label: "Boards", items: [{ externalId: "999", label: "PROJ Board" }] },
    {
      id: "epics",
      label: "Epics",
      items: [{ externalId: "PROJ-100", label: "Platform Q2", sublabel: "PROJ-100" }],
    },
    { id: "filters", label: "Filters", items: [{ externalId: "456", label: "My issues" }] },
  ],
};

describe("SourcePicker", () => {
  it("renders the multi-list shape and reports selections under the `items` key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(next: SourceSelection) => void>();
    render(<SourcePicker candidates={MULTI_LIST} value={{}} onChange={onChange} />);

    expect(screen.getByTestId("source-picker")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select sources" }));
    await user.click(screen.getByRole("option", { name: "Roadmap" }));

    expect(onChange).toHaveBeenCalledWith({ items: ["PVT_1"] });
  });

  it("renders a tab per category for the categorized-multi-list shape", () => {
    render(<SourcePicker candidates={CATEGORIZED} value={{}} onChange={vi.fn()} />);
    const tablist = screen.getByRole("tablist", { name: "Source categories" });
    expect(within(tablist).getByRole("tab", { name: /Boards/ })).toBeInTheDocument();
    expect(within(tablist).getByRole("tab", { name: /Epics/ })).toBeInTheDocument();
    expect(within(tablist).getByRole("tab", { name: /Filters/ })).toBeInTheDocument();
  });

  it("shows a selected count on the tab when the category has selections", () => {
    render(
      <SourcePicker candidates={CATEGORIZED} value={{ epics: ["PROJ-100"] }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("tab", { name: /Epics\s*1/ })).toBeInTheDocument();
  });

  it("seeds the selection from object-form entries", async () => {
    const user = userEvent.setup();
    render(
      <SourcePicker
        candidates={MULTI_LIST}
        value={{ items: [{ externalId: "owner/repo" }] }}
        onChange={vi.fn()}
      />,
    );
    // The trigger summarizes the seeded selection by label (visible text; the
    // button's accessible name is its aria-label placeholder).
    expect(screen.getByText("owner/repo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select sources" }));
    expect(screen.getByRole("option", { name: "owner/repo" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("selects an epic under the categorized `epics` key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(next: SourceSelection) => void>();
    render(<SourcePicker candidates={CATEGORIZED} value={{}} onChange={onChange} />);

    // Boards is the default tab; switch to Epics first.
    await user.click(screen.getByRole("tab", { name: /Epics/ }));
    await user.click(screen.getByRole("button", { name: "Select epics" }));
    await user.click(screen.getByRole("option", { name: /Platform Q2/ }));

    expect(onChange).toHaveBeenCalledWith({ epics: ["PROJ-100"] });
  });

  describe("searchable-categorized shape (WU-003)", () => {
    it("gates board/filter/epic until a project is in scope, then enables them (TC-001)", () => {
      const { rerender } = render(
        <SourcePicker candidates={SEARCHABLE} value={{}} onChange={vi.fn()} projectId="p1" />,
      );

      // Project search is always available; the scoped categories are disabled
      // with a hint until a project is picked.
      expect(screen.getByRole("button", { name: "Add projects" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Add boards" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add filters" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add epics" })).toBeDisabled();
      expect(screen.getAllByText("Pick a project first.").length).toBeGreaterThan(0);

      rerender(
        <SourcePicker
          candidates={SEARCHABLE}
          value={{ project: ["PLAT"] }}
          onChange={vi.fn()}
          projectId="p1"
        />,
      );

      expect(screen.getByRole("button", { name: "Add boards" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Add filters" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Add epics" })).toBeEnabled();
      expect(screen.queryByText("Pick a project first.")).not.toBeInTheDocument();
    });

    it("does not render the synthetic 'mine' category (deferred to WU-004)", () => {
      render(<SourcePicker candidates={SEARCHABLE} value={{}} onChange={vi.fn()} projectId="p1" />);
      expect(screen.queryByRole("button", { name: /assigned to me/i })).not.toBeInTheDocument();
    });

    it("stamps the scoped project onto a picked board entry", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: SourceSelection) => void>();
      render(
        <SourcePicker
          candidates={SEARCHABLE}
          value={{ project: ["PLAT"] }}
          onChange={onChange}
          projectId="p1"
        />,
      );

      await user.click(screen.getByRole("button", { name: "Add boards" }));
      await user.click(screen.getByRole("option", { name: /PLAT Scrum Board/ }));

      expect(onChange).toHaveBeenCalledWith({
        project: ["PLAT"],
        board: [{ externalId: "board:482", project: "PLAT" }],
      });
    });

    it("drops a project's scoped sources when the project leaves scope (TC-039)", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: SourceSelection) => void>();
      render(
        <SourcePicker
          candidates={SEARCHABLE}
          value={{ project: ["PLAT"], board: [{ externalId: "board:482", project: "PLAT" }] }}
          onChange={onChange}
          projectId="p1"
        />,
      );

      // The project chip carries the friendly label resolved from results.
      await user.click(screen.getByRole("button", { name: "Remove Platform" }));

      // Removing PLAT removes it from scope and prunes the board scoped to it,
      // leaving an empty selection (no lingering empty category keys).
      expect(onChange).toHaveBeenCalledWith({});
    });

    it("accumulates multiple picks in the same category without dropping prior ones", async () => {
      const user = userEvent.setup();
      function Harness() {
        const [value, setValue] = useState<SourceSelection>({ project: ["PLAT"] });
        return (
          <SourcePicker candidates={SEARCHABLE} value={value} onChange={setValue} projectId="p1" />
        );
      }
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Add boards" }));
      await user.click(screen.getByRole("option", { name: /PLAT Scrum Board/ }));
      await user.click(screen.getByRole("option", { name: /PLAT Kanban/ }));

      // Both picks survive: each result stays selected (a regression that dropped
      // the first pick would leave only the second selected).
      const listbox = screen.getByRole("listbox", { name: "Boards results" });
      expect(within(listbox).getByRole("option", { name: /PLAT Scrum Board/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(within(listbox).getByRole("option", { name: /PLAT Kanban/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("leaves a filter's project unset under multi-project scope (no wrong-project pruning)", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn<(next: SourceSelection) => void>();
      render(
        <SourcePicker
          candidates={SEARCHABLE}
          value={{ project: ["PLAT", "OPS"] }}
          onChange={onChange}
          projectId="p1"
        />,
      );

      await user.click(screen.getByRole("button", { name: "Add filters" }));
      await user.click(screen.getByRole("option", { name: /My open bugs/ }));

      // The filter carries no project key, so with several projects in scope it
      // is stamped with none rather than guessing the first.
      expect(onChange).toHaveBeenCalledWith({
        project: ["PLAT", "OPS"],
        filter: [{ externalId: "10231" }],
      });
    });
  });
});
