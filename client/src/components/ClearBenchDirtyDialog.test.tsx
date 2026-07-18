// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DirtyReason, DirtyReasonKind } from "@roubo/shared";
import ClearBenchDirtyDialog from "./ClearBenchDirtyDialog";

const mixedReasons: DirtyReason[] = [
  { kind: "dirty-worktree", location: "workspace", detail: "2 modified, 1 untracked" },
  { kind: "stash", location: "workspace", detail: "1 stash" },
  { kind: "unpushed-commits", location: "vendor/lib", detail: "3 commits ahead" },
  { kind: "no-upstream", location: "vendor/lib", detail: "feature-x" },
];

function renderDialog(props: Partial<Parameters<typeof ClearBenchDirtyDialog>[0]> = {}) {
  const defaults = {
    isOpen: true,
    onClose: vi.fn(),
    benchId: 7,
    reasons: mixedReasons,
    onConfirmForce: vi.fn(),
    isPending: false,
  };
  render(<ClearBenchDirtyDialog {...defaults} {...props} />);
  return {
    onClose: props.onClose ?? defaults.onClose,
    onConfirmForce: props.onConfirmForce ?? defaults.onConfirmForce,
  };
}

describe("ClearBenchDirtyDialog", () => {
  it("shows a heading that includes the bench id", () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: /Clear Bench 7/i })).toBeInTheDocument();
  });

  it('mentions "uncommitted work detected" in the heading', () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: /uncommitted work detected/i })).toBeInTheDocument();
  });

  it('renders workspace reasons under a "Workspace" subhead', () => {
    renderDialog();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("2 modified, 1 untracked")).toBeInTheDocument();
    expect(screen.getByText("1 stash")).toBeInTheDocument();
  });

  it("renders submodule reasons grouped under the submodule path", () => {
    renderDialog();
    expect(screen.getByText("vendor/lib")).toBeInTheDocument();
    expect(screen.getByText("3 commits ahead")).toBeInTheDocument();
    expect(screen.getByText("feature-x")).toBeInTheDocument();
  });

  it.each<[DirtyReasonKind, string]>([
    ["dirty-worktree", "Uncommitted changes"],
    ["stash", "Stashed changes"],
    ["unpushed-commits", "Unpushed commits"],
    ["no-upstream", "No upstream branch (cannot check for unpushed commits)"],
    ["local-only-after-merge", "Local-only commits (upstream deleted)"],
  ])("renders correct label for kind %s", (kind, expectedLabel) => {
    render(
      <ClearBenchDirtyDialog
        isOpen={true}
        onClose={vi.fn()}
        benchId={1}
        reasons={[{ kind, location: "workspace", detail: "some detail" }]}
        onConfirmForce={vi.fn()}
      />,
    );
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it("does not use em dashes in any rendered label or heading", () => {
    render(
      <ClearBenchDirtyDialog
        isOpen={true}
        onClose={vi.fn()}
        benchId={1}
        reasons={[
          { kind: "no-upstream", location: "workspace", detail: "x" },
          { kind: "local-only-after-merge", location: "workspace", detail: "y" },
        ]}
        onConfirmForce={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog").textContent ?? "").not.toContain("—");
  });

  it("clicking Cancel calls onClose and does not call onConfirmForce", async () => {
    const onClose = vi.fn();
    const onConfirmForce = vi.fn();
    renderDialog({ onClose, onConfirmForce });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirmForce).not.toHaveBeenCalled();
  });

  it('clicking "Clear anyway" calls onConfirmForce exactly once', async () => {
    const onConfirmForce = vi.fn();
    renderDialog({ onConfirmForce });
    await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));
    expect(onConfirmForce).toHaveBeenCalledTimes(1);
  });

  it("disables the confirm button when isPending is true", () => {
    renderDialog({ isPending: true });
    expect(screen.getByRole("button", { name: "Clear anyway" })).toBeDisabled();
  });

  it("disables the Cancel button when isPending is true", () => {
    renderDialog({ isPending: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("does not dismiss on Escape when isPending is true", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose, isPending: true });
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not render workspace section when no workspace reasons exist", () => {
    renderDialog({
      reasons: [{ kind: "unpushed-commits", location: "vendor/lib", detail: "1 commit" }],
    });
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("shows forceError message when provided", () => {
    renderDialog({ forceError: "Clear failed: please try again." });
    expect(screen.getByText("Clear failed: please try again.")).toBeInTheDocument();
  });

  it("does not show error message when forceError is null", () => {
    renderDialog({ forceError: null });
    expect(screen.queryByText(/clear failed/i)).not.toBeInTheDocument();
  });

  it('clicking "Clear anyway" does not close the dialog: parent controls lifecycle', async () => {
    const onClose = vi.fn();
    const onConfirmForce = vi.fn();
    renderDialog({ onClose, onConfirmForce });
    await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));
    // onConfirmForce fires but onClose must NOT be called: dialog stays open until parent sets isOpen=false
    expect(onConfirmForce).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
