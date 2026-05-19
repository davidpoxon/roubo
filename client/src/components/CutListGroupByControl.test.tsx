// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CutListGroupByControl from "./CutListGroupByControl";
import { createEmptyGrouping } from "../lib/cut-list-groups";
import type { GroupingState } from "../lib/cut-list-groups";

function renderControl(grouping: GroupingState, onChange = vi.fn()) {
  return render(<CutListGroupByControl grouping={grouping} onGroupingChange={onChange} />);
}

describe("CutListGroupByControl", () => {
  it('renders trigger button with "Group cut list" aria-label when inactive', () => {
    renderControl(createEmptyGrouping());
    expect(screen.getByRole("button", { name: "Group cut list" })).toBeInTheDocument();
  });

  it("does not show dimension label text when groupBy is none", () => {
    renderControl(createEmptyGrouping());
    const btn = screen.getByRole("button", { name: "Group cut list" });
    expect(btn.textContent).toBe("");
  });

  it("renders trigger with dimension label when active", () => {
    renderControl({ groupBy: "milestone" });
    expect(screen.getByRole("button", { name: "Group cut list by Milestone" })).toBeInTheDocument();
    expect(screen.getByText("Milestone")).toBeInTheDocument();
  });

  it("renders dimension labels for all active states", () => {
    const cases: Array<[GroupingState["groupBy"], string]> = [
      ["status", "Status"],
      ["type", "Type"],
      ["labels", "Labels"],
    ];
    for (const [groupBy, label] of cases) {
      const { unmount } = renderControl({ groupBy });
      expect(
        screen.getByRole("button", { name: `Group cut list by ${label}` }),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("opens popover with all five dimension options when clicked", async () => {
    const user = userEvent.setup();
    renderControl(createEmptyGrouping());
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Milestone" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Labels" })).toBeInTheDocument();
  });

  it("calls onGroupingChange with milestone when Milestone is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl(createEmptyGrouping(), onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    await user.click(screen.getByRole("option", { name: "Milestone" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "milestone" });
  });

  it("calls onGroupingChange with none when same active dimension is selected again (toggle)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ groupBy: "milestone" }, onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list by Milestone" }));
    await user.click(screen.getByRole("option", { name: "Milestone" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "none" });
  });

  it("shows Clear button in popover header when grouping is active", async () => {
    const user = userEvent.setup();
    renderControl({ groupBy: "status" });
    await user.click(screen.getByRole("button", { name: "Group cut list by Status" }));
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("does not show Clear button in popover when grouping is none", async () => {
    const user = userEvent.setup();
    renderControl(createEmptyGrouping());
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
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
