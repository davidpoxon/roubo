// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
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
      project: { displayName: "My Project", name: "my-project", repo: "" },
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

beforeEach(() => {
  localStorage.clear();
});

describe("ProjectSidebar", () => {
  it("renders All Benches, Projects and Settings nav items", () => {
    stubNoData();
    renderSidebar();
    expect(screen.getByText("All Benches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("marks All Benches as the current page on the root path", () => {
    stubNoData();
    renderSidebar("/");
    expect(screen.getByText("All Benches").closest("button")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Projects" })).not.toHaveAttribute("aria-current");
  });

  it("navigates to the All Benches view when All Benches is pressed", async () => {
    stubNoData();
    renderSidebar("/settings");
    await userEvent.click(screen.getByText("All Benches"));
    expect(screen.getByText("All Benches").closest("button")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  describe("Projects header", () => {
    it("navigates to the projects overview when pressed", async () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      renderSidebar("/");
      const header = screen.getByRole("button", { name: "Projects" });
      expect(header).not.toHaveAttribute("aria-current");
      await userEvent.click(header);
      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByText("All Benches").closest("button")).not.toHaveAttribute("aria-current");
    });

    it("is selected on the projects overview but not on a single project", () => {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      const { unmount } = renderSidebar("/projects");
      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      unmount();
      renderSidebar("/projects/proj-1");
      expect(screen.getByRole("button", { name: "Projects" })).not.toHaveAttribute("aria-current");
    });

    it("keeps the section-header type role", () => {
      stubNoData();
      renderSidebar();
      const label = screen.getByText("Projects");
      expect(label.className).toContain("text-11");
      expect(label.className).toContain("uppercase");
      expect(label.className).toContain("tracking-label");
    });

    it("renders even when no projects are registered", () => {
      mockedUseProjects.mockReturnValue({ data: [] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
      renderSidebar();
      expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Register project")).not.toBeInTheDocument();
    });
  });

  it("renders an inactive All Benches link in the text-body token for both themes (#1275)", () => {
    stubNoData();
    renderSidebar("/settings");
    const link = screen.getByText("All Benches").closest("button");
    // DESIGN.md Nav item: an unselected label is text-body, one utility for both themes.
    expect(link?.className).toContain("text-text-body");
    expect(link?.className).not.toMatch(/dark:/);
  });

  it("renders the active Settings item in medium-weight accent-text on accent-muted (#1276)", () => {
    stubNoData();
    renderSidebar("/settings");
    const settings = screen.getByText("Settings").closest("button");
    // The old amber text on the amber wash was 2.83:1 in light; accent-text clears 4.5:1 in both themes.
    expect(settings?.className).toContain("bg-accent-muted");
    expect(settings?.className).toContain("text-accent-text");
    expect(settings?.className).toContain("font-medium");
    expect(settings?.className).not.toMatch(/\bamber\b|-amber-/);
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

  it("renders status dot with the status-active token for active bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "active" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-status-active")).not.toBeNull();
  });

  it("renders status dot with the status-error token for error bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "error" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-status-error")).not.toBeNull();
  });

  it("renders status dot with the status-idle token for idle bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "idle" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-status-idle")).not.toBeNull();
  });

  it("renders status dot with the status-preparing token for preparing bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "preparing" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-status-preparing")).not.toBeNull();
  });

  it("renders status dot with the status-preparing token for clearing bench", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({
      data: [makeBench({ status: "clearing" })],
    } as unknown as UseQueryResult<Bench[]>);
    const { container } = renderSidebar();
    expect(container.querySelector(".bg-status-preparing")).not.toBeNull();
  });

  it("marks project active on exact path match", () => {
    mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
      RegisteredProject[]
    >);
    mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
    renderSidebar("/projects/proj-1");
    const projectButton = screen.getByText("My Project").closest("button");
    expect(projectButton?.className).toContain("text-accent-text");
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
    expect(projectButton?.className).not.toContain("text-accent-text");
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
    expect(benchButton?.className).toContain("text-accent-text");
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
    expect(benchButton?.className).not.toContain("text-accent-text");
  });

  it("does not render benches from one project under another project", () => {
    const projectA = makeProject({
      id: "proj-a",
      config: {
        project: { displayName: "Project A", name: "proj-a", repo: "" },
      } as RegisteredProject["config"],
    });
    const projectB = makeProject({
      id: "proj-b",
      config: {
        project: { displayName: "Project B", name: "proj-b", repo: "" },
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
                type: "agent-waiting",
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
                type: "agent-waiting",
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
      // The active bench is NOT excluded from the project rollup: all action-needed notifications
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
                type: "agent-waiting",
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

  describe("collapse (#525)", () => {
    function stubWithProject() {
      mockedUseProjects.mockReturnValue({ data: [makeProject()] } as unknown as UseQueryResult<
        RegisteredProject[]
      >);
      mockedUseAllBenches.mockReturnValue({ data: [] } as unknown as UseQueryResult<Bench[]>);
    }

    it("collapses to an icon rail that hides the project list and keeps the nav icons", async () => {
      stubWithProject();
      renderSidebar();
      // Expanded: the project list and a collapse control are present.
      expect(screen.getByText("My Project")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      // Collapsed: the project list is gone; icon-only All Benches, Projects and
      // Settings remain.
      expect(screen.queryByText("My Project")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "All Benches" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    });

    it("navigates to the projects overview from the collapsed Projects icon", async () => {
      stubWithProject();
      renderSidebar("/");
      await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      await userEvent.click(screen.getByRole("button", { name: "Projects" }));
      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByRole("button", { name: "All Benches" })).not.toHaveAttribute(
        "aria-current",
      );
    });

    it("restores the full sidebar when expanded", async () => {
      stubWithProject();
      renderSidebar();
      await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(screen.queryByText("My Project")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    it("persists the collapsed state across remounts", async () => {
      stubWithProject();
      const { unmount } = renderSidebar();
      await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      unmount();
      renderSidebar();
      // Remounts collapsed: the project list stays hidden until expanded again.
      expect(screen.queryByText("My Project")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    });
  });
});
