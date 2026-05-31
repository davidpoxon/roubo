// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RegisteredProject, RouboConfig } from "@roubo/shared";
import SetupTile from "./SetupTile";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

import { useProjects } from "../../hooks/useProjects";

function makeConfig(overrides: Partial<RouboConfig> = {}): RouboConfig {
  return {
    project: {
      name: "test-app",
      displayName: "Test App",
      repo: "git@github.com:org/test.git",
    },
    layout: { type: "single-repo" },
    components: {
      backend: { type: "process" },
      frontend: { type: "process" },
    },
    ports: {
      backend: { base: 3333 },
      frontend: { base: 3334 },
    },
    benches: { max: 5 },
    ...overrides,
  };
}

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "proj-1",
    repoPath: "/repos/test-app",
    configValid: true,
    config: makeConfig(),
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

describe("SetupTile", () => {
  beforeEach(() => {
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject()],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    mockNavigate.mockReset();
  });

  it("renders project name in the yaml preview", () => {
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByText(/test-app/)).toBeInTheDocument();
  });

  it("renders component names in the yaml preview", () => {
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByText(/backend/)).toBeInTheDocument();
    expect(screen.getByText(/frontend/)).toBeInTheDocument();
  });

  it("renders the lowest port base", () => {
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByText(/3333/)).toBeInTheDocument();
  });

  it("renders … when more than 3 components exist", () => {
    const config = makeConfig({
      components: {
        a: { type: "process" },
        b: { type: "process" },
        c: { type: "process" },
        d: { type: "process" },
      },
    });
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ config })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByText(/…/)).toBeInTheDocument();
  });

  it("navigates to config edit when Edit button is pressed", async () => {
    const user = userEvent.setup();
    render(<SetupTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Edit project configuration" }));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-1/settings/setup");
  });

  it("shows alert when project config is undefined", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ config: undefined, configValid: false })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Config missing or invalid")).toBeInTheDocument();
  });

  it("shows configError text when present", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [
        makeProject({
          config: undefined,
          configValid: false,
          configError: "missing field: project.name",
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByText("missing field: project.name")).toBeInTheDocument();
  });

  it("shows alert when configValid is false even if config exists", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ configValid: false })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("still renders Edit button when config is invalid", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ config: undefined, configValid: false })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-1" />);
    expect(screen.getByRole("button", { name: "Edit project configuration" })).toBeInTheDocument();
  });

  it("renders loading skeleton when data is loading", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-1" />);
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows Project not found when projectId is absent from the project list", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<SetupTile projectId="proj-unknown" />);
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
