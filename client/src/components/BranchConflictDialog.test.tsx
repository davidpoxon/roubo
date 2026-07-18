// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BranchConflictDialog from "./BranchConflictDialog";
import type { BranchConflictInfo } from "@roubo/shared";

const conflict: BranchConflictInfo = {
  branchName: "feature/my-branch",
  branchExists: true,
  workspaceExists: false,
};

describe("BranchConflictDialog", () => {
  it("renders dialog content when open", () => {
    render(
      <BranchConflictDialog
        isOpen
        onClose={vi.fn()}
        conflict={conflict}
        onResume={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: /branch already exists/i })).toBeInTheDocument();
    expect(screen.getByText("feature/my-branch")).toBeInTheDocument();
  });

  it("does not render when not open", () => {
    render(
      <BranchConflictDialog
        isOpen={false}
        onClose={vi.fn()}
        conflict={conflict}
        onResume={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    );
    expect(screen.queryByText(/branch already exists/i)).not.toBeInTheDocument();
  });

  it("shows orphaned worktree warning when workspaceExists is true", () => {
    render(
      <BranchConflictDialog
        isOpen
        onClose={vi.fn()}
        conflict={{ ...conflict, workspaceExists: true }}
        onResume={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    );
    expect(screen.getByText(/orphaned worktree/i)).toBeInTheDocument();
  });

  it("does not show orphaned worktree warning when workspaceExists is false", () => {
    render(
      <BranchConflictDialog
        isOpen
        onClose={vi.fn()}
        conflict={{ ...conflict, workspaceExists: false }}
        onResume={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    );
    expect(screen.queryByText(/orphaned worktree/i)).not.toBeInTheDocument();
  });

  it('calls onResume when "Resume existing" is pressed', async () => {
    const onResume = vi.fn();
    render(
      <BranchConflictDialog
        isOpen
        onClose={vi.fn()}
        conflict={conflict}
        onResume={onResume}
        onCreateNew={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /resume existing/i }));
    expect(onResume).toHaveBeenCalled();
  });

  it('calls onCreateNew when "Create new branch" is pressed', async () => {
    const onCreateNew = vi.fn();
    render(
      <BranchConflictDialog
        isOpen
        onClose={vi.fn()}
        conflict={conflict}
        onResume={vi.fn()}
        onCreateNew={onCreateNew}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /create new branch/i }));
    expect(onCreateNew).toHaveBeenCalled();
  });

  it("calls onClose when Cancel is pressed", async () => {
    const onClose = vi.fn();
    render(
      <BranchConflictDialog
        isOpen
        onClose={onClose}
        conflict={conflict}
        onResume={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    render(
      <BranchConflictDialog
        isOpen
        onClose={vi.fn()}
        conflict={conflict}
        onResume={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
