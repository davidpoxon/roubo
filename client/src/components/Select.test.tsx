// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Select from "./Select";

describe("Select", () => {
  const items = ["alpha", "beta", "gamma"];

  it("renders the trigger button", () => {
    render(<Select items={items} value="" onChange={vi.fn()} placeholder="Pick one" />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("shows placeholder text when no value is selected", () => {
    render(<Select items={items} value="" onChange={vi.fn()} placeholder="Choose…" />);
    expect(screen.getByText("Choose…")).toBeInTheDocument();
  });

  it("renders the placeholder in the text-secondary token for both themes (#887)", () => {
    render(<Select items={items} value="" onChange={vi.fn()} placeholder="Choose…" />);
    const placeholder = screen.getByText("Choose…").closest("[data-placeholder]");
    expect(placeholder).not.toBeNull();
    // stone-500 on light and stone-400 on dark both clear WCAG AA 4.5:1.
    expect(placeholder?.className).toContain("data-[placeholder]:text-stone-500");
    expect(placeholder?.className).toContain("dark:data-[placeholder]:text-stone-400");
    expect(placeholder?.className).not.toContain("dark:data-[placeholder]:text-stone-500");
  });

  it("shows the clear button when allowClear is true and a value is selected", () => {
    render(<Select items={items} value="alpha" onChange={vi.fn()} allowClear />);
    expect(screen.getByRole("button", { name: /clear selection/i })).toBeInTheDocument();
  });

  it("does not show the clear button when no value is selected", () => {
    render(<Select items={items} value="" onChange={vi.fn()} allowClear />);
    expect(screen.queryByRole("button", { name: /clear selection/i })).not.toBeInTheDocument();
  });

  it("calls onChange with empty string when clear button is clicked", async () => {
    const onChange = vi.fn();
    render(<Select items={items} value="beta" onChange={onChange} allowClear />);
    await userEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("calls onChange with empty string when Enter is pressed on the clear button", async () => {
    const onChange = vi.fn();
    render(<Select items={items} value="alpha" onChange={onChange} allowClear />);
    const clearBtn = screen.getByRole("button", { name: /clear selection/i });
    act(() => {
      clearBtn.focus();
    });
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("accepts SelectItem objects with value and label", () => {
    const objectItems = [
      { value: "v1", label: "Label One" },
      { value: "v2", label: "Label Two" },
    ];
    render(<Select items={objectItems} value="" onChange={vi.fn()} placeholder="Select" />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});
