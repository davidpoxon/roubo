// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionLayout from "./SectionLayout";

describe("SectionLayout", () => {
  it("renders all structure type buttons", () => {
    render(<SectionLayout structure={{}} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: "meta-repo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "monorepo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "single-repo" })).toBeInTheDocument();
  });

  it("dispatches UPDATE_STRUCTURE when a structure type is selected", async () => {
    const dispatch = vi.fn();
    render(<SectionLayout structure={{}} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "monorepo" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_STRUCTURE",
      payload: { type: "monorepo" },
    });
  });

  it("shows auto-detected hint when scanResult matches structure", () => {
    const scanResult = { detected: { structureType: "monorepo" } } as never;
    render(
      <SectionLayout structure={{ type: "monorepo" }} scanResult={scanResult} dispatch={vi.fn()} />,
    );
    expect(screen.getByText(/auto-detected/i)).toBeInTheDocument();
  });

  it("shows submodule inputs when meta-repo is selected", () => {
    render(
      <SectionLayout
        structure={{ type: "meta-repo", submodules: { frontend: "frontend/" } }}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /add submodule/i })).toBeInTheDocument();
  });

  it("dispatches SET_TOOLS for meta-repo add submodule", async () => {
    const dispatch = vi.fn();
    render(<SectionLayout structure={{ type: "meta-repo" }} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /add submodule/i }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_STRUCTURE" }));
  });

  it("dispatches UPDATE_STRUCTURE when submodule alias is changed", async () => {
    const dispatch = vi.fn();
    render(
      <SectionLayout
        structure={{ type: "meta-repo", submodules: { backend: "backend/" } }}
        dispatch={dispatch}
      />,
    );
    const aliasInput = screen.getByLabelText("Submodule alias");
    await userEvent.clear(aliasInput);
    await userEvent.type(aliasInput, "api");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_STRUCTURE" }));
  });

  it("dispatches UPDATE_STRUCTURE when submodule directory is changed", async () => {
    const dispatch = vi.fn();
    render(
      <SectionLayout
        structure={{ type: "meta-repo", submodules: { backend: "backend/" } }}
        dispatch={dispatch}
      />,
    );
    const dirInput = screen.getByLabelText("Submodule directory");
    await userEvent.clear(dirInput);
    await userEvent.type(dirInput, "server/");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_STRUCTURE" }));
  });

  it("dispatches UPDATE_STRUCTURE when submodule is removed", async () => {
    const dispatch = vi.fn();
    render(
      <SectionLayout
        structure={{ type: "meta-repo", submodules: { backend: "backend/" } }}
        dispatch={dispatch}
      />,
    );
    // The icon-only buttons (no text) are [Info, X remove]; the last one is the X remove button
    const iconButtons = screen.getAllByRole("button").filter((b) => !b.textContent?.trim());
    await userEvent.click(iconButtons[iconButtons.length - 1]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_STRUCTURE",
      payload: { submodules: {} },
    });
  });
});
