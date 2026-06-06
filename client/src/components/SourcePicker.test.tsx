// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceCandidatesResponse, SourceSelection } from "@roubo/shared";
import SourcePicker from "./SourcePicker";

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

  it("renders a neutral notice for the searchable-categorized shape (interim, WU-003 pending)", () => {
    const candidates: SourceCandidatesResponse = {
      shape: "searchable-categorized",
      searchableCategories: [
        { id: "project", label: "Projects" },
        { id: "board", label: "Boards", scopedBy: "project" },
      ],
    };
    render(<SourcePicker candidates={candidates} value={{}} onChange={vi.fn()} />);

    expect(screen.getByTestId("source-picker")).toBeInTheDocument();
    expect(screen.getByText(/not available in this view yet/i)).toBeInTheDocument();
    // No tab strip is rendered for this shape.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
