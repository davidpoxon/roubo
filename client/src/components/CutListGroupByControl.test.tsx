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

  it("renders trigger with dimension label when active", () => {
    renderControl({ groupBy: "type" });
    expect(screen.getByRole("button", { name: "Group cut list by Type" })).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("renders dimension labels for all active states", () => {
    const cases: Array<[GroupingState["groupBy"], string]> = [
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

  it("opens popover with the supported dimension options when clicked", async () => {
    const user = userEvent.setup();
    renderControl(createEmptyGrouping());
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Labels" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Milestone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Status" })).not.toBeInTheDocument();
  });

  it("calls onGroupingChange with type when Type is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl(createEmptyGrouping(), onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list" }));
    await user.click(screen.getByRole("option", { name: "Type" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "type" });
  });

  it("calls onGroupingChange with none when same active dimension is selected again (toggle)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ groupBy: "type" }, onChange);
    await user.click(screen.getByRole("button", { name: "Group cut list by Type" }));
    await user.click(screen.getByRole("option", { name: "Type" }));
    expect(onChange).toHaveBeenCalledWith({ groupBy: "none" });
  });

  it("shows Clear button in popover header when grouping is active", async () => {
    const user = userEvent.setup();
    renderControl({ groupBy: "labels" });
    await user.click(screen.getByRole("button", { name: "Group cut list by Labels" }));
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
