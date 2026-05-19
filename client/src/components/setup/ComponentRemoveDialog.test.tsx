// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComponentRemoveDialog from "./ComponentRemoveDialog";

describe("ComponentRemoveDialog", () => {
  it("renders nothing when not open", () => {
    render(
      <ComponentRemoveDialog
        isOpen={false}
        componentName="api"
        references={[]}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders plain confirm wording when no bench references", () => {
    render(
      <ComponentRemoveDialog
        isOpen
        componentName="api"
        references={[]}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/Remove "api"\?/);
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
  });

  it("lists referencing benches and uses 'Remove anyway' when in use", () => {
    render(
      <ComponentRemoveDialog
        isOpen
        componentName="postgres"
        references={[
          { benchId: 1, branch: "feat/auth" },
          { benchId: 3, branch: "main" },
        ]}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/"postgres" is in use/);
    expect(screen.getByText(/bench #1/)).toBeInTheDocument();
    expect(screen.getByText(/feat\/auth/)).toBeInTheDocument();
    expect(screen.getByText(/bench #3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove anyway/i })).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is pressed", async () => {
    const onCancel = vi.fn();
    render(
      <ComponentRemoveDialog
        isOpen
        componentName="api"
        references={[]}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm when confirm button is pressed", async () => {
    const onConfirm = vi.fn();
    render(
      <ComponentRemoveDialog
        isOpen
        componentName="api"
        references={[]}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
