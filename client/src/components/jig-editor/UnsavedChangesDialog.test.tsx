// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UnsavedChangesDialog from "./UnsavedChangesDialog";

describe("UnsavedChangesDialog", () => {
  it("renders heading when open", () => {
    render(<UnsavedChangesDialog isOpen={true} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Discard changes/i })).toBeInTheDocument();
  });

  it("does not render content when closed", () => {
    render(<UnsavedChangesDialog isOpen={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: /Discard changes/i })).not.toBeInTheDocument();
  });

  it("calls onConfirm when Discard is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<UnsavedChangesDialog isOpen={true} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Keep editing is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<UnsavedChangesDialog isOpen={true} onConfirm={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows warning message about unsaved changes", () => {
    render(<UnsavedChangesDialog isOpen={true} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });
});
