// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { RegisteredProject, Bench } from "@roubo/shared";
import AllBenchesView from "./AllBenchesView";

vi.mock("../hooks/useProjects");
vi.mock("../hooks/useBenches");
vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(() => ({ data: undefined })),
}));
vi.mock("./GlobalBenchMeter", () => ({
  default: () => <div data-testid="global-bench-meter" />,
}));
vi.mock("./BenchCard", () => ({
  default: ({
    bench,
    activeIntegrationId,
  }: {
    bench: Bench;
    activeIntegrationId?: string | null;
  }) => (
    <div data-testid="bench-card" data-integration-id={activeIntegrationId ?? ""}>
      {bench.branch}
    </div>
  ),
}));

import { useProjects } from "../hooks/useProjects";
import { useAllBenches } from "../hooks/useBenches";
import { useProjectIntegration } from "../hooks/useProjectIntegration";

const mockedUseProjects = vi.mocked(useProjects);
const mockedUseAllBenches = vi.mocked(useAllBenches);
const mockedUseProjectIntegration = vi.mocked(useProjectIntegration);

function makeProject(id: string, displayName?: string): RegisteredProject {
  return {
    id,
    repoPath: `/repos/${id}`,
    configValid: true,
    config: displayName
      ? ({ project: { displayName, name: id, repo: "" } } as RegisteredProject["config"])
      : undefined,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  };
}

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-a",
    branch: "feat/a",
    workspacePath: "/workspaces/proj-a/bench-1",
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

function stub({
  projects,
  benches,
  projectsLoading = false,
  benchesLoading = false,
  projectsError = false,
  benchesError = false,
}: {
  projects?: RegisteredProject[];
  benches?: Bench[];
  projectsLoading?: boolean;
  benchesLoading?: boolean;
  projectsError?: boolean;
  benchesError?: boolean;
}) {
  mockedUseProjects.mockReturnValue({
    data: projects,
    isLoading: projectsLoading,
    isError: projectsError,
  } as unknown as UseQueryResult<RegisteredProject[]>);
  mockedUseAllBenches.mockReturnValue({
    data: benches,
    isLoading: benchesLoading,
    isError: benchesError,
  } as unknown as UseQueryResult<Bench[]>);
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AllBenchesView />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseProjectIntegration.mockReturnValue({ data: undefined } as unknown as ReturnType<
    typeof useProjectIntegration
  >);
});

describe("AllBenchesView", () => {
  it("renders the All Benches title and the global bench meter", () => {
    stub({ projects: [], benches: [] });
    renderView();
    expect(screen.getByRole("heading", { name: "All Benches" })).toBeInTheDocument();
    expect(screen.getByTestId("global-bench-meter")).toBeInTheDocument();
  });

  it("shows a loading indicator while benches or projects load", () => {
    stub({ projects: undefined, benches: undefined, benchesLoading: true });
    renderView();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByTestId("bench-card")).toBeNull();
  });

  it("shows an empty state linking to the projects overview when there are no benches", () => {
    stub({ projects: [makeProject("proj-a", "Alpha")], benches: [] });
    renderView();
    expect(screen.getByText(/No benches yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
  });

  it("groups benches from every project under one section per project, in project order", () => {
    stub({
      projects: [makeProject("proj-a", "Alpha"), makeProject("proj-b", "Beta")],
      benches: [
        makeBench({ id: 1, projectId: "proj-b", branch: "feat/b1" }),
        makeBench({ id: 1, projectId: "proj-a", branch: "feat/a1" }),
        makeBench({ id: 2, projectId: "proj-a", branch: "feat/a2" }),
      ],
    });
    renderView();

    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => within(s).getByRole("link").textContent)).toEqual(["Alpha", "Beta"]);

    const alpha = screen.getByRole("region", { name: /Alpha/ });
    expect(
      within(alpha)
        .getAllByTestId("bench-card")
        .map((c) => c.textContent),
    ).toEqual(["feat/a1", "feat/a2"]);
    const beta = screen.getByRole("region", { name: /Beta/ });
    expect(
      within(beta)
        .getAllByTestId("bench-card")
        .map((c) => c.textContent),
    ).toEqual(["feat/b1"]);
  });

  it("links each section heading to its project", () => {
    stub({
      projects: [makeProject("proj-a", "Alpha")],
      benches: [makeBench({ projectId: "proj-a" })],
    });
    renderView();
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/projects/proj-a");
  });

  it("leaves out projects that have no benches", () => {
    stub({
      projects: [makeProject("proj-a", "Alpha"), makeProject("proj-b", "Beta")],
      benches: [makeBench({ projectId: "proj-a" })],
    });
    renderView();
    expect(screen.getByRole("link", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Beta" })).toBeNull();
  });

  it("falls back to the project id when the project has no display name", () => {
    stub({
      projects: [makeProject("proj-a")],
      benches: [makeBench({ projectId: "proj-a" })],
    });
    renderView();
    expect(screen.getByRole("link", { name: "proj-a" })).toBeInTheDocument();
  });

  it("still shows a bench whose project is not registered, under its project id", () => {
    stub({
      projects: [makeProject("proj-a", "Alpha")],
      benches: [makeBench({ projectId: "gone", branch: "feat/orphan" })],
    });
    renderView();
    const section = screen.getByRole("region", { name: /gone/ });
    expect(within(section).getByText("feat/orphan")).toBeInTheDocument();
    // There is no project page for it, so the heading is not a link and no
    // integration is requested for the unknown id.
    expect(within(section).queryByRole("link")).toBeNull();
    expect(mockedUseProjectIntegration).not.toHaveBeenCalledWith("gone");
    expect(mockedUseProjectIntegration).toHaveBeenCalledWith(undefined);
  });

  it("shows an error, not the empty state, when benches fail to load", () => {
    stub({ projects: [makeProject("proj-a", "Alpha")], benches: undefined, benchesError: true });
    renderView();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load benches");
    expect(screen.queryByText(/No benches yet/)).toBeNull();
  });

  it("shows an error, not unregistered sections, when projects fail to load", () => {
    stub({
      projects: undefined,
      benches: [makeBench({ projectId: "proj-a" })],
      projectsError: true,
    });
    renderView();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("bench-card")).toBeNull();
  });

  it("keeps showing benches when a refetch fails after a good load", () => {
    stub({
      projects: [makeProject("proj-a", "Alpha")],
      benches: [makeBench({ projectId: "proj-a", branch: "feat/a" })],
      benchesError: true,
    });
    renderView();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("feat/a")).toBeInTheDocument();
  });

  it("passes each project's active integration to its bench cards", () => {
    mockedUseProjectIntegration.mockImplementation(
      (projectId) =>
        ({
          data: { plugin: { id: projectId === "proj-a" ? "github-com" : "jira" } },
        }) as unknown as ReturnType<typeof useProjectIntegration>,
    );
    stub({
      projects: [makeProject("proj-a", "Alpha"), makeProject("proj-b", "Beta")],
      benches: [
        makeBench({ projectId: "proj-a", branch: "feat/a" }),
        makeBench({ projectId: "proj-b", branch: "feat/b" }),
      ],
    });
    renderView();
    expect(screen.getByText("feat/a")).toHaveAttribute("data-integration-id", "github-com");
    expect(screen.getByText("feat/b")).toHaveAttribute("data-integration-id", "jira");
  });
});
