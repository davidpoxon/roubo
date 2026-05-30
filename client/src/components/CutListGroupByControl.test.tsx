// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FilterFacet } from "@roubo/shared";
import CutListGroupByControl from "./CutListGroupByControl";
import { createEmptyGrouping } from "../lib/cut-list-groups";
import type { GroupingState } from "../lib/cut-list-groups";

const FACETS: FilterFacet[] = [
  { id: "type", label: "Type", type: "enum-async" },
  { id: "label", label: "Label", type: "enum-async" },
  { id: "status", label: "Status", type: "enum" },
  { id: "milestone", label: "Milestone", type: "enum-async" },
];

function renderControl(grouping: GroupingState, onChange = vi.fn(), facets = FACETS) {
  return render(
    <CutListGroupByControl grouping={grouping} onGroupingChange={onChange} facets={facets} />,
  );
}

describe("CutListGroupByControl", () => {
  it('renders trigger button with "Group cut list" aria-label when inactive', () => {
    renderControl(createEmptyGrouping());
    expect(screen.getByRole("button", { name: "Group cut list" })).toBeInTheDocument();
  });

  it("renders trigger with dimension label when active", () => {
    renderControl({ groupBy: "type" });
    expect(screen.getByRole("button", { name: "Group cut list by Type" })).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("treats a groupBy that is not an exposed facet as inactive", () => {
    renderControl({ groupBy: "gone" });
    expect(screen.getByRole("button", { name: "Group cut list" })).toBeInTheDocument();
  });

  it("lists None plus a dimension per facet, including Milestone", async () => {
    const user = userEvent.setup();
    renderControl(createEmptyGrouping());
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Label" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Milestone" })).toBeInTheDocument();
  });

  it("calls onGroupingChange with type when Type is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl(createEmptyGrouping(), onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    await user.click(screen.getByRole("option", { name: "Type" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "type" });
  });

  it("calls onGroupingChange with milestone when Milestone is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl(createEmptyGrouping(), onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    await user.click(screen.getByRole("option", { name: "Milestone" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "milestone" });
  });

  it("toggles the active dimension off when selected again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ groupBy: "type" }, onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list by Type" }));
    await user.click(screen.getByRole("option", { name: "Type" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "none" });
  });

  it("shows a Clear button in the popover header when grouping is active", async () => {
    const user = userEvent.setup();
    renderControl({ groupBy: "milestone" });
    await user.click(screen.getByRole("button", { name: "Group cut list by Milestone" }));
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("calls onGroupingChange with empty grouping when Clear is pressed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ groupBy: "type" }, onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list by Type" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(createEmptyGrouping());
  });
});
