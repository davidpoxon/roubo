// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MultiSelect from "./MultiSelect";

const items = [
  { value: "frontend", label: "frontend" },
  { value: "backend", label: "backend" },
  { value: "api", label: "api" },
];

describe("MultiSelect", () => {
  it("renders the trigger button", () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set()}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.getByRole("button", { name: "Labels" })).toBeInTheDocument();
  });

  it("shows placeholder when nothing selected", () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set()}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.getByText("Labels")).toBeInTheDocument();
  });

  it("shows single selected label as trigger text", () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set(["frontend"])}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.getByText("frontend")).toBeInTheDocument();
  });

  it("shows comma-joined labels when 2 are selected", () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set(["frontend", "backend"])}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.getByText("frontend, backend")).toBeInTheDocument();
  });

  it('shows "N selected" when more than 2 are selected', () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set(["frontend", "backend", "api"])}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("shows clear button when selections exist", () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set(["frontend"])}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeInTheDocument();
  });

  it("does not show clear button when nothing is selected", () => {
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set()}
        onChange={vi.fn()}
        placeholder="Labels"
      />,
    );
    expect(screen.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();
  });

  it("calls onChange with empty set when clear button is clicked", async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        items={items}
        selectedKeys={new Set(["frontend"])}
        onChange={onChange}
        placeholder="Labels"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onChange).toHaveBeenCalledWith(new Set());
  });
});
