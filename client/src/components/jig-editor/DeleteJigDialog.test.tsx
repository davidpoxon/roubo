// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JigReference } from "@roubo/shared";
import DeleteJigDialog from "./DeleteJigDialog";

const jig = { id: "my-jig", name: "My Jig" };

const refs: JigReference[] = [
  { type: "app-default" },
  { type: "project-default", projectId: "proj-1", projectName: "Project A" },
  {
    type: "issue-type-mapping",
    projectId: "proj-2",
    projectName: "Project B",
    issueType: "feature",
  },
];

describe("DeleteJigDialog", () => {
  it("shows delete confirmation when no references provided", () => {
    render(<DeleteJigDialog isOpen={true} jig={jig} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/permanently delete/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("shows blocked state when references are provided", () => {
    render(
      <DeleteJigDialog
        isOpen={true}
        jig={jig}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        references={refs}
      />,
    );
    expect(screen.getByText(/Jig is in use/i)).toBeInTheDocument();
    expect(screen.getByText(/app-level default/i)).toBeInTheDocument();
    expect(screen.getByText(/Project A/)).toBeInTheDocument();
    expect(screen.getByText(/feature/)).toBeInTheDocument();
  });

  it("formats project-default reference correctly", () => {
    const projectRefs: JigReference[] = [
      { type: "project-default", projectId: "p1", projectName: "My Project" },
    ];
    render(
      <DeleteJigDialog
        isOpen={true}
        jig={jig}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        references={projectRefs}
      />,
    );
    expect(screen.getByText(/My Project/)).toBeInTheDocument();
  });

  it("formats issue-type-mapping reference correctly", () => {
    const mappingRefs: JigReference[] = [
      { type: "issue-type-mapping", projectId: "p1", projectName: "My Project", issueType: "bug" },
    ];
    render(
      <DeleteJigDialog
        isOpen={true}
        jig={jig}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        references={mappingRefs}
      />,
    );
    expect(screen.getByText(/bug/)).toBeInTheDocument();
    expect(screen.getByText(/My Project/)).toBeInTheDocument();
  });

  it("calls onConfirm when Delete button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<DeleteJigDialog isOpen={true} jig={jig} onCancel={vi.fn()} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<DeleteJigDialog isOpen={true} jig={jig} onCancel={onCancel} onConfirm={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables Delete button when isPending is true", () => {
    render(
      <DeleteJigDialog
        isOpen={true}
        jig={jig}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        isPending={true}
      />,
    );
    expect(screen.getByRole("button", { name: /Deleting/ })).toBeDisabled();
  });

  it("disables Cancel button when isPending is true", () => {
    render(
      <DeleteJigDialog
        isOpen={true}
        jig={jig}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        isPending={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("does not render when closed", () => {
    render(<DeleteJigDialog isOpen={false} jig={jig} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
