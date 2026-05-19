// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionProjectInfo from "./SectionProjectInfo";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../hooks/useSetup");
vi.mock("../Select", () => ({
  default: ({
    items,
    value,
    onChange,
    placeholder,
  }: {
    items: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={placeholder ?? "select"}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

import { useGitHubProjects } from "../../hooks/useSetup";

const mockUseGitHubProjects = vi.mocked(useGitHubProjects);

beforeEach(() => {
  vi.resetAllMocks();
  mockUseGitHubProjects.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useGitHubProjects>);
});

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

  it('shows "Set a repository first" when repo is missing', () => {
    render(<SectionProjectInfo project={{}} dispatch={vi.fn()} />);
    expect(screen.getByText(/set a repository first/i)).toBeInTheDocument();
  });

  it("shows loading state for GitHub projects", () => {
    mockUseGitHubProjects.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useGitHubProjects>);
    render(<SectionProjectInfo project={{ repo: "org/repo" }} dispatch={vi.fn()} />);
    expect(screen.getByText(/loading projects/i)).toBeInTheDocument();
  });

  it("shows error state when GitHub projects fail to load", () => {
    mockUseGitHubProjects.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("403"),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useGitHubProjects>);
    renderWithProviders(<SectionProjectInfo project={{ repo: "org/repo" }} dispatch={vi.fn()} />);
    expect(screen.getByText(/could not load from github/i)).toBeInTheDocument();
  });

  it('shows "No projects found" when GitHub returns empty list', () => {
    mockUseGitHubProjects.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useGitHubProjects>);
    render(<SectionProjectInfo project={{ repo: "org/repo" }} dispatch={vi.fn()} />);
    expect(screen.getByText(/no projects found/i)).toBeInTheDocument();
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
});
