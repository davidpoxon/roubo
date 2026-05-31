// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionProjectInfo from "./SectionProjectInfo";

describe("SectionProjectInfo", () => {
  it("renders name and display name inputs", () => {
    render(<SectionProjectInfo project={{}} dispatch={vi.fn()} />);
    expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("My Project")).toBeInTheDocument();
  });

  it("renders all project type buttons", () => {
    render(<SectionProjectInfo project={{}} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: "web" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "native" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "api-only" })).toBeInTheDocument();
  });

  it("renders repository structure buttons", () => {
    render(<SectionProjectInfo project={{}} dispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: "meta-repo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "monorepo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "single-repo" })).toBeInTheDocument();
  });

  it("shows name format error for invalid name", () => {
    render(<SectionProjectInfo project={{ name: "My Project" }} dispatch={vi.fn()} />);
    expect(screen.getByText(/lowercase letters/i)).toBeInTheDocument();
  });

  it("dispatches UPDATE_PROJECT when name changes", async () => {
    const dispatch = vi.fn();
    render(<SectionProjectInfo project={{}} dispatch={dispatch} />);
    await userEvent.type(screen.getByPlaceholderText("my-project"), "abc");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_PROJECT" }));
  });

  it("dispatches UPDATE_PROJECT with type when type button clicked", async () => {
    const dispatch = vi.fn();
    render(<SectionProjectInfo project={{}} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "web" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_PROJECT",
      payload: { type: "web" },
    });
  });

  // FR-070 (WU-057): the Identity step no longer hosts these controls; they
  // live in the plugin Configure modal.
  it("does not render Repository, GitHub project, or Submodules controls", () => {
    const { container } = render(
      <SectionProjectInfo
        project={{ repo: "org/repo" }}
        layout={{ type: "meta-repo" }}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText("org/repo-name")).not.toBeInTheDocument();
    expect(screen.queryByText(/github project/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Submodules/);
    expect(screen.queryByRole("button", { name: /add submodule/i })).not.toBeInTheDocument();
  });

  it("shows auto-detected hint for project type when scan result matches", () => {
    const scanResult = {
      detected: {
        suggestedProjectType: "web",
        webFrameworks: ["react"],
        nativeFrameworks: [],
      },
    } as never;
    render(
      <SectionProjectInfo project={{ type: "web" }} scanResult={scanResult} dispatch={vi.fn()} />,
    );
    expect(screen.getByText(/auto-detected/i)).toBeInTheDocument();
  });

  it('shows "Could not auto-detect type" when scan result has null type', () => {
    const scanResult = {
      detected: {
        suggestedProjectType: null,
        webFrameworks: [],
        nativeFrameworks: [],
      },
    } as never;
    render(<SectionProjectInfo project={{}} scanResult={scanResult} dispatch={vi.fn()} />);
    expect(screen.getByText(/could not auto-detect type/i)).toBeInTheDocument();
  });

  it("shows a required error for project type and supersedes the auto-detect hint", () => {
    const scanResult = {
      detected: {
        suggestedProjectType: null,
        webFrameworks: [],
        nativeFrameworks: [],
      },
    } as never;
    render(
      <SectionProjectInfo
        project={{}}
        scanResult={scanResult}
        validationErrors={{ "project.type": "Invalid input" }}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByText(/project type is required/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not auto-detect type/i)).not.toBeInTheDocument();
  });

  it("surfaces required errors for display name and repository structure", () => {
    render(
      <SectionProjectInfo
        project={{}}
        validationErrors={{
          "project.displayName": "Required",
          "layout.type": "Invalid input",
        }}
        dispatch={vi.fn()}
      />,
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("Invalid input")).toBeInTheDocument();
  });
});
