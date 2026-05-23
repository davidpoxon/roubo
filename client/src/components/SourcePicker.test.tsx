// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceCandidatesResponse, SourceSelection } from "@roubo/shared";
import SourcePicker from "./SourcePicker";

function ControlledPicker({
  response,
  initial = {},
  onChangeSpy,
}: {
  response: SourceCandidatesResponse;
  initial?: SourceSelection;
  onChangeSpy?: (next: SourceSelection) => void;
}) {
  // Inline tiny wrapper so tests exercise the real controlled flow.
  const [value, setValue] = useStateValue(initial);
  return (
    <SourcePicker
      response={response}
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
    />
  );
}

// Mini state helper — avoids pulling React import in the test wrapper boilerplate.
import { useState } from "react";
function useStateValue(
  initial: SourceSelection,
): [SourceSelection, (next: SourceSelection) => void] {
  const [value, setValue] = useState<SourceSelection>(initial);
  return [value, setValue];
}

const multiListFixture: SourceCandidatesResponse = {
  shape: "multi-list",
  items: [
    { externalId: "org/api", label: "org/api", sublabel: "Backend service", icon: "repo" },
    { externalId: "org/web", label: "org/web", sublabel: "Frontend", icon: "repo" },
    { externalId: "proj-42", label: "Roadmap", sublabel: "Project board", icon: "project" },
  ],
};

const categorizedFixture: SourceCandidatesResponse = {
  shape: "categorized-multi-list",
  categories: [
    {
      id: "boards",
      label: "Boards",
      items: [
        { externalId: "b1", label: "Engineering", icon: "board" },
        { externalId: "b2", label: "Design", icon: "board" },
      ],
    },
    {
      id: "epics",
      label: "Epics",
      items: [{ externalId: "e1", label: "Q1 launch", icon: "epic" }],
    },
    {
      id: "filters",
      label: "Filters",
      items: [{ externalId: "f1", label: "Open bugs", icon: "filter" }],
    },
  ],
};

describe("SourcePicker — multi-list (TC-021)", () => {
  it("renders combined items with type-aware affordances and selection chips", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker response={multiListFixture} onChangeSpy={onChange} />);

    // Items are listed with labels and sublabels in a single combined list.
    const list = screen.getByRole("listbox", { name: /source candidates/i });
    expect(within(list).getByText("org/api")).toBeInTheDocument();
    expect(within(list).getByText("Backend service")).toBeInTheDocument();
    expect(within(list).getByText("Roadmap")).toBeInTheDocument();

    // Select two items.
    await user.click(within(list).getByText("org/api"));
    await user.click(within(list).getByText("Roadmap"));

    // Both appear in the chip strip; counter reflects selection.
    expect(screen.getByText(/Selected \(2\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove org/api" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Roadmap" })).toBeInTheDocument();

    // Removing a chip propagates back to onChange.
    await user.click(screen.getByRole("button", { name: "Remove org/api" }));
    expect(screen.queryByRole("button", { name: "Remove org/api" })).not.toBeInTheDocument();

    // onChange was called with the persisted SourceSelection shape (key "items").
    expect(onChange).toHaveBeenLastCalledWith({ items: ["proj-42"] });
  });

  it("filters the list via the search field", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={multiListFixture} />);

    const list = screen.getByRole("listbox", { name: /source candidates/i });
    expect(within(list).getByText("org/api")).toBeInTheDocument();
    expect(within(list).getByText("Roadmap")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: /search source candidates/i }), "road");

    expect(within(list).queryByText("org/api")).not.toBeInTheDocument();
    expect(within(list).getByText("Roadmap")).toBeInTheDocument();
  });
});

describe("SourcePicker — categorized-multi-list (TC-022)", () => {
  it("renders one tab per category and shows per-tab count badges", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={categorizedFixture} />);

    const tabList = screen.getByRole("tablist", { name: /source categories/i });
    expect(within(tabList).getByRole("tab", { name: /Boards/ })).toBeInTheDocument();
    expect(within(tabList).getByRole("tab", { name: /Epics/ })).toBeInTheDocument();
    expect(within(tabList).getByRole("tab", { name: /Filters/ })).toBeInTheDocument();

    // The first tab is selected by default; select an item.
    const boardsList = screen.getByRole("listbox", { name: /boards candidates/i });
    await user.click(within(boardsList).getByText("Engineering"));

    // Boards tab now shows a count badge of 1; Epics shows none.
    const boardsTab = within(tabList).getByRole("tab", { name: /Boards/ });
    expect(within(boardsTab).getByLabelText(/1 selected/)).toBeInTheDocument();
    expect(
      within(within(tabList).getByRole("tab", { name: /Epics/ })).queryByLabelText(/selected/),
    ).not.toBeInTheDocument();
  });

  it("scopes search and selection per tab and groups chips by category", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={categorizedFixture} />);

    // Select a Board.
    const boardsList = screen.getByRole("listbox", { name: /boards candidates/i });
    await user.click(within(boardsList).getByText("Engineering"));

    // Switch to Epics tab and select.
    await user.click(screen.getByRole("tab", { name: /Epics/ }));
    const epicsList = screen.getByRole("listbox", { name: /epics candidates/i });
    await user.click(within(epicsList).getByText("Q1 launch"));

    // Chip strip is grouped: "Boards" group + "Epics" group, each with the right chip.
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Engineering" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Q1 launch" })).toBeInTheDocument();
  });
});

describe("SourcePicker — accessibility & keyboard nav (TC-076)", () => {
  it("makes search focusable and selects with Space inside the list", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker response={multiListFixture} onChangeSpy={onChange} />);

    const search = screen.getByRole("searchbox", { name: /search source candidates/i });

    // React Aria's focus hooks update state when focus moves into a managed
    // node, so direct .focus() calls must run inside act() to keep the renders
    // tracked (CLAUDE.md: tests must produce zero stderr).
    act(() => {
      search.focus();
    });
    expect(search).toHaveFocus();

    const list = screen.getByRole("listbox", { name: /source candidates/i });
    const firstOption = within(list).getByRole("option", { name: /org\/api/ });
    act(() => {
      firstOption.focus();
    });
    await user.keyboard(" ");

    expect(onChange).toHaveBeenLastCalledWith({ items: ["org/api"] });
  });

  it("announces selection changes via an aria-live region (TC-076)", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={multiListFixture} />);

    // The chip strip carries the selected count and chip list and is wrapped
    // in aria-live="polite" so screen readers announce each selection change
    // (TC-076 expects "Selection state updates and is announced").
    const list = screen.getByRole("listbox", { name: /source candidates/i });
    await user.click(within(list).getByText("org/api"));

    const count = screen.getByText(/Selected \(1\)/);
    const region = count.parentElement;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("categorized tabs expose tablist role and per-tab selection counts (TC-076)", async () => {
    const user = userEvent.setup();
    render(<ControlledPicker response={categorizedFixture} />);

    // TabList is named so screen readers announce the category list when focus enters.
    const tabList = screen.getByRole("tablist", { name: /source categories/i });
    expect(tabList).toBeInTheDocument();

    // Selecting an item populates the tab's count badge with an aria-label so
    // screen readers announce "N selected" alongside the tab label.
    const boardsList = screen.getByRole("listbox", { name: /boards candidates/i });
    await user.click(within(boardsList).getByText("Engineering"));

    const boardsTab = within(tabList).getByRole("tab", { name: /Boards/ });
    expect(within(boardsTab).getByLabelText(/1 selected/i)).toBeInTheDocument();
  });
});
