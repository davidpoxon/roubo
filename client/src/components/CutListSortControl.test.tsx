// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SortField } from "@roubo/shared";
import CutListSortControl from "./CutListSortControl";
import type { SortSelection } from "./CutListSortControl";

const FIELDS: SortField[] = [
  { id: "created", label: "Created", defaultDir: "desc" },
  { id: "updated", label: "Updated", defaultDir: "desc" },
  { id: "comments", label: "Comments", defaultDir: "desc" },
];

function renderControl(
  selection: SortSelection | null = null,
  onChange = vi.fn(),
  fields = FIELDS,
) {
  return render(
    <CutListSortControl fields={fields} selection={selection} onSelectionChange={onChange} />,
  );
}

describe("CutListSortControl", () => {
  it("renders nothing when the plugin declares no sort fields (CLI-FR-011)", () => {
    const { container } = renderControl(null, vi.fn(), []);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a "Sort cut list" trigger when inactive', () => {
    renderControl();
    expect(screen.getByRole("button", { name: "Sort cut list" })).toBeInTheDocument();
  });

  it("shows the active field and direction in the trigger aria-label when active", () => {
    renderControl({ sortBy: "created", sortDir: "desc" });
    expect(
      screen.getByRole("button", { name: "Sort cut list by Created, descending" }),
    ).toBeInTheDocument();
  });

  it("lists one option per declared field (CLI-FR-009)", async () => {
    const user = userEvent.setup();
    renderControl();
    await user.click(screen.getByRole("button", { name: "Sort cut list" }));
    expect(screen.getByRole("option", { name: "Created" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Updated" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Comments" })).toBeInTheDocument();
  });

  it("applies the field's defaultDir on first selection (CLI-FR-010)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl(null, onChange);
    await user.click(screen.getByRole("button", { name: "Sort cut list" }));
    await user.click(screen.getByRole("option", { name: "Updated" }));
    expect(onChange).toHaveBeenCalledWith({ sortBy: "updated", sortDir: "desc" });
  });

  it("toggles the direction when the active field is re-selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ sortBy: "created", sortDir: "desc" }, onChange);
    await user.click(screen.getByRole("button", { name: "Sort cut list by Created, descending" }));
    await user.click(screen.getByRole("option", { name: "Created" }));
    expect(onChange).toHaveBeenCalledWith({ sortBy: "created", sortDir: "asc" });
  });

  it("clears the selection via the Clear button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ sortBy: "created", sortDir: "desc" }, onChange);
    await user.click(screen.getByRole("button", { name: "Sort cut list by Created, descending" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
