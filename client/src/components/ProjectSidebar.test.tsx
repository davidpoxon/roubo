// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProjectSidebar from "./ProjectSidebar";
import { RegisterProjectModalProvider } from "./RegisterProjectModalProvider";
import type { UseQueryResult } from "@tanstack/react-query";
import type { RegisteredProject, Bench } from "@roubo/shared";

vi.mock("../hooks/useProjects");
vi.mock("../hooks/useBenches");
vi.mock("./RegisterProjectModal", () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="register-modal">Register modal</div> : null,
}));

import { useProjects } from "../hooks/useProjects";
import { useAllBenches } from "../hooks/useBenches";

const mockedUseProjects = vi.mocked(useProjects);
const mockedUseAllBenches = vi.mocked(useAllBenches);

function renderSidebar(initialPath = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <RegisterProjectModalProvider>
          <ProjectSidebar />
        </RegisterProjectModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "proj-1",
    repoPath: "/repos/proj-1",
    configValid: true,
    config: {
      project: { displayName: "My Project", name: "my-project", type: "web", repo: "" },
    } as RegisteredProject["config"],
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-1",
    branch: "feat/my-feature",
    workspacePath: "/workspaces/proj-1/bench-1",
    status: "idle",
    ports: {},
    components: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    ...overrides,
  };
}

function stubNoData() {
  mockedUseProjects.mockReturnValue({ data: undefined } as unknown as UseQueryResult<
    RegisteredProject[]
  >);
  mockedUseAllBenches.mockReturnValue({ data: undefined } as unknown as UseQueryResult<Bench[]>);
}

describe("ProjectSidebar", () => {
  it("renders All Projects and Settings nav items", () => {
    stubNoData();
    renderSidebar();
    expect(screen.getByText("All Projects")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders project displayName when available", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
    renderSidebar();
    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("falls back to project id when displayName is absent", () => {
    mockedUseProjects.mockReturnValue({
      data: [makeProject({ config: undefined })],
    } as unknown as UseQueryResult<RegisteredProject[]>);
    mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
    renderSidebar();
    expect(screen.getByText("proj-1")).toBeInTheDocument();
  });

  it("shows bench count badge when project has benches", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench(), makeBench({ id: 2, branch: "feat/other" })],
    } as unknown as UseQueryResult<Bench[]>);
    renderSidebar();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("does not show bench count badge when project has no benches", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
    renderSidebar();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("renders bench branch name nested under project", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ branch: "feat/my-feature" })],
    } as unknown as UseQueryResult<Bench[]>);
    renderSidebar();
    expect(screen.getByText("feat/my-feature")).toBeInTheDocument();
  });

  it("renders status dot with green class for active bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "active" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-green-500")).not.toBeNull();
  });

  it("renders status dot with red class for error bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "error" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-red-500")).not.toBeNull();
  });

  it("renders status dot with stone class for idle bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "idle" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-stone-300")).not.toBeNull();
  });

  it("renders status dot with amber class for preparing bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "preparing" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });

  it("renders status dot with amber class for clearing bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "clearing" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });

  it("marks project active on exact path match", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
    renderSidebar("/projects/proj-1");
    const projectButton = screen.getByText("My Project").closest("button");
    expect(projectButton?.className).toContain("text-amber-600");
  });

  it("does not mark project active when on a bench sub-path", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ id: 1 })],
    } as unknown as UseQueryResult<Bench[]>);
    renderSidebar("/projects/proj-1/benches/1");
    const projectButton = screen.getByText("My Project").closest("button");
    expect(projectButton?.className).not.toContain("text-amber-600");
  });

  it("marks bench active when on bench path", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ id: 1, branch: "feat/my-feature" })],
    } as unknown as UseQueryResult<Bench[]>);
    renderSidebar("/projects/proj-1/benches/1");
    const benchButton = screen.getByText("feat/my-feature").closest("button");
    expect(benchButton?.className).toContain("text-amber-600");
  });

  it("does not mark bench active when on a different bench path", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [
        makeBench({ id: 1, branch: "feat/my-feature" }),
        makeBench({ id: 2, branch: "feat/other" }),
      ],
    } as unknown as UseQueryResult<Bench[]>);
    renderSidebar("/projects/proj-1/benches/2");
    const benchButton = screen.getByText("feat/my-feature").closest("button");
    expect(benchButton?.className).not.toContain("text-amber-600");
  });

  it("does not render benches from one project under another project", () => {
    const projectA = makeProject({
      id: "proj-a",
      config: {
        project: { displayName: "Project A", name: "proj-a", type: "web", repo: "" },
      } as RegisteredProject["config"],
    });
    const projectB = makeProject({
      id: "proj-b",
      config: {
        project: { displayName: "Project B", name: "proj-b", type: "web", repo: "" },
      } as RegisteredProject["config"],
    });
    mockedUseProjects.mockReturnValue({ data: [projectA, projectB] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [
        makeBench({ id: 1, projectId: "proj-a", branch: "feat/alpha" }),
        makeBench({ id: 2, projectId: "proj-b", branch: "feat/beta" }),
      ],
    } as unknown as UseQueryResult<Bench[]>);
    renderSidebar();

    const projectASection = screen.getByText("Project A").closest("div");
    if (!projectASection) throw new Error("expected project A section");
    const projectBSection = screen.getByText("Project B").closest("div");
    if (!projectBSection) throw new Error("expected project B section");

    expect(projectASection.querySelector('button[class*="pl-7"]')?.textContent).toContain(
      "feat/alpha",
    );
    expect(projectASection).not.toHaveTextContent("feat/beta");
    expect(projectBSection.querySelector('button[class*="pl-7"]')?.textContent).toContain(
      "feat/beta",
    );
    expect(projectBSection).not.toHaveTextContent("feat/alpha");
  });

  describe("register project entry points", () => {
    it('shows "+" icon button next to Projects heading when projects exist', () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      expect(screen.getByLabelText("Register project")).toBeInTheDocument();
    });

    it('opens register modal when "+" icon button is pressed', async () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      await userEvent.click(screen.getByLabelText("Register project"));
      expect(screen.getByTestId("register-modal")).toBeInTheDocument();
    });

    it('shows "+ Register project" row button when projects exist', () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      expect(screen.getByText("Register project")).toBeInTheDocument();
    });

    it('opens register modal when "+ Register project" row is pressed', async () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      await userEvent.click(screen.getByText("Register project"));
      expect(screen.getByTestId("register-modal")).toBeInTheDocument();
    });
  });

  describe("notification indicators", () => {
    it("shows notification indicator on bench row when bench has notifications", () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({
        data: [
          makeBench({
            notifications: [
              {
                id: "n1",
                type: "claude-waiting",
                priority: "action-needed",
                createdAt: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        ],
      } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      const benchButton = screen.getByText("feat/my-feature").closest("button");
      expect(benchButton?.querySelector('[aria-label="Action needed"]')).not.toBeNull();
    });

    it("does not show notification indicator on bench row when bench has no notifications", () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({
        data: [makeBench({ notifications: [] })],
      } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      const benchButton = screen.getByText("feat/my-feature").closest("button");
      expect(benchButton?.querySelector('[aria-label="Action needed"]')).toBeNull();
      expect(benchButton?.querySelector('[aria-label="Notification"]')).toBeNull();
    });

    it("does not show notification indicator on bench row for the active bench", () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({
        data: [
          makeBench({
            id: 1,
            notifications: [
              {
                id: "n1",
                type: "claude-waiting",
                priority: "action-needed",
                createdAt: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        ],
      } as unknown as UseQueryResult<Bench[]>);
      renderSidebar("/projects/proj-1/benches/1");
      const benchButton = screen.getByText("feat/my-feature").closest("button");
      expect(benchButton?.querySelector('[aria-label="Action needed"]')).toBeNull();
    });

    it("shows notification indicator on project row when non-active bench has notifications", () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({
        data: [
          makeBench({ id: 1, notifications: [] }),
          makeBench({
            id: 2,
            branch: "feat/other",
            notifications: [
              {
                id: "n1",
                type: "bench-error",
                priority: "action-needed",
                createdAt: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        ],
      } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      const projectButton = screen.getByText("My Project").closest("button");
      expect(projectButton?.querySelector('[aria-label="Action needed"]')).not.toBeNull();
    });

    it("still shows notification on project row when only the active bench has notifications", () => {
      // The active bench is NOT excluded from the project rollup — all action-needed notifications
      // bubble up to project level regardless of which bench the user is currently viewing.
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({
        data: [
          makeBench({
            id: 1,
            notifications: [
              {
                id: "n1",
                type: "claude-waiting",
                priority: "action-needed",
                createdAt: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        ],
      } as unknown as UseQueryResult<Bench[]>);
      renderSidebar("/projects/proj-1/benches/1");
      const projectButton = screen.getByText("My Project").closest("button");
      expect(projectButton?.querySelector('[aria-label="Action needed"]')).not.toBeNull();
    });
  });
});
