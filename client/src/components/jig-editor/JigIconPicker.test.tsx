// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JigIconPicker from "./JigIconPicker";

describe("JigIconPicker", () => {
  it("renders the trigger button with the current icon aria-label", () => {
    render(<JigIconPicker value="file-text" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Pick icon" })).toBeInTheDocument();
  });

  it("opens popover on click showing all icons", async () => {
    const user = userEvent.setup();
    render(<JigIconPicker value="file-text" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Pick icon" }));
    expect(screen.getByRole("button", { name: "book-open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sparkles" })).toBeInTheDocument();
  });

  it("calls onChange with selected icon", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JigIconPicker value="file-text" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Pick icon" }));
    await user.click(screen.getByRole("button", { name: "rocket" }));
    expect(onChange).toHaveBeenCalledWith("rocket");
  });

  it("marks currently-selected icon as pressed", async () => {
    const user = userEvent.setup();
    render(<JigIconPicker value="sparkles" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Pick icon" }));
    expect(screen.getByRole("button", { name: "sparkles" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
