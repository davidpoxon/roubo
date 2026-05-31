// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RegisteredProject, RouboConfig } from "@roubo/shared";
import PortAssignmentTile from "./PortAssignmentTile";

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

import { useProjects } from "../../hooks/useProjects";

function makeConfig(ports: RouboConfig["ports"]): RouboConfig {
  return {
    project: {
      name: "app",
      displayName: "App",
      repo: "git@github.com:org/app.git",
    },
    layout: { type: "single-repo" },
    components: { api: { type: "process" } },
    ports,
    benches: { max: 5 },
  };
}

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "proj-1",
    repoPath: "/repos/app",
    configValid: true,
    config: makeConfig({ api: { base: 3333 }, web: { base: 3334 } }),
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

describe("PortAssignmentTile", () => {
  beforeEach(() => {
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject()],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
  });

  it("lists all port names and their base values", () => {
    render(<PortAssignmentTile projectId="proj-1" />);
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("3333")).toBeInTheDocument();
    expect(screen.getByText("3334")).toBeInTheDocument();
  });

  it("shows per-bench increment footnote", () => {
    render(<PortAssignmentTile projectId="proj-1" />);
    expect(screen.getByText("Each port increments by 1 per bench")).toBeInTheDocument();
  });

  it("lists all ports regardless of order in config", () => {
    const config = makeConfig({ web: { base: 3400 }, api: { base: 3333 } });
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ config })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<PortAssignmentTile projectId="proj-1" />);
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("3333")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("3400")).toBeInTheDocument();
  });

  it("shows Not configured when ports is empty", () => {
    const config = makeConfig({});
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ config })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<PortAssignmentTile projectId="proj-1" />);
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("shows Not configured when configValid is false", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [makeProject({ configValid: false })],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    render(<PortAssignmentTile projectId="proj-1" />);
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("renders loading skeleton while loading", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjects>);
    render(<PortAssignmentTile projectId="proj-1" />);
    // Loading skeleton renders placeholder divs
    expect(screen.queryByText("Not configured")).not.toBeInTheDocument();
    expect(screen.queryByText("Each port increments by 1 per bench")).not.toBeInTheDocument();
  });
});
