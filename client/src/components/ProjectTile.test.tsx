// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ProjectTile from "./ProjectTile";
import type { RegisteredProject, Bench } from "@roubo/shared";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "my-app",
    repoPath: "/repos/my-app",
    configValid: true,
    config: {
      project: { name: "my-app", displayName: "My App", repo: "" },
      layout: { type: "single-repo" },
      components: {},
      ports: {},
      benches: { max: 3 },
    },
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "my-app",
    branch: "feat/test",
    workspacePath: "/workspaces/my-app/bench-1",
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

function renderTile(project = makeProject(), benches: Bench[] = []) {
  return render(
    <MemoryRouter>
      <ProjectTile project={project} benches={benches} />
    </MemoryRouter>,
  );
}

describe("ProjectTile", () => {
  it("renders project display name", () => {
    renderTile();
    expect(screen.getByText("My App")).toBeInTheDocument();
  });

  it("renders project id · repo path", () => {
    renderTile();
    expect(screen.getByText(/my-app · \/repos\/my-app/)).toBeInTheDocument();
  });

  it("renders valid badge when configValid is true", () => {
    renderTile();
    expect(screen.getByText("Valid")).toBeInTheDocument();
  });

  it("renders error badge when configValid is false", () => {
    renderTile(makeProject({ configValid: false }));
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("renders bench count as used / max", () => {
    renderTile(makeProject(), [makeBench()]);
    expect(screen.getByText("1 / 3 benches")).toBeInTheDocument();
  });

  it("renders layout type", () => {
    renderTile();
    expect(screen.getByText("single-repo")).toBeInTheDocument();
  });

  it("renders progress bar when max > 0", () => {
    const { container } = renderTile(makeProject(), [makeBench()]);
    expect(container.querySelector('[style*="width"]')).not.toBeNull();
  });

  it("navigates to project page on press", async () => {
    renderTile();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/my-app");
  });

  it("falls back to project id when config is absent", () => {
    renderTile(makeProject({ config: undefined }));
    expect(screen.getByText("my-app")).toBeInTheDocument();
  });
});
