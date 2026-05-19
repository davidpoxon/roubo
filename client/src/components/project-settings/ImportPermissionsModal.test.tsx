// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ImportPermissionsModal } from "./ImportPermissionsModal";
import { useProjects } from "../../hooks/useProjects";
import * as api from "../../lib/api";
import type { PermissionRule } from "./permissionTypes";
import type { ProjectPermissions } from "@roubo/shared";

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  fetchProjectPermissions: vi.fn(),
}));

const mockedUseProjects = vi.mocked(useProjects);
const mockedFetchProjectPermissions = vi.mocked(api.fetchProjectPermissions);

const PROJECT_A = {
  id: "proj-a",
  repoPath: "/home/user/project-a",
  name: "project-a",
};
const PROJECT_B = {
  id: "proj-b",
  repoPath: "/home/user/project-b",
  name: "project-b",
};

function renderModal(
  props: Partial<{
    isOpen: boolean;
    currentProjectId: string;
    currentPermissions: ProjectPermissions;
    onImport: (rules: PermissionRule[]) => void;
    onClose: () => void;
  }> = {},
) {
  const defaults = {
    isOpen: true,
    currentProjectId: PROJECT_A.id,
    currentPermissions: { allow: [], deny: [], ask: [] },
    onImport: vi.fn(),
    onClose: vi.fn(),
  };
  return renderWithProviders(<ImportPermissionsModal {...defaults} {...props} />);
}

async function selectSourceProject(user: ReturnType<typeof userEvent.setup>, projectName: string) {
  await user.click(screen.getByRole("button", { name: /choose a project/i }));
  await user.click(await screen.findByRole("option", { name: projectName }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // React Aria Dialog warns when Heading lacks slot="title"; suppress library noise in tests.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockedUseProjects.mockReturnValue({
    data: [PROJECT_A, PROJECT_B],
  } as unknown as ReturnType<typeof useProjects>);
});

describe("ImportPermissionsModal", () => {
  it("renders the project source selector", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /choose a project/i })).toBeInTheDocument();
  });

  it("shows no-other-projects empty state when all projects are filtered out", () => {
    mockedUseProjects.mockReturnValue({
      data: [PROJECT_A],
    } as unknown as ReturnType<typeof useProjects>);
    renderModal();
    expect(screen.getByText(/No other registered projects found/)).toBeInTheDocument();
  });

  it("shows 'choose a source project' prompt when no project is selected", () => {
    renderModal();
    expect(screen.getByText(/Choose a source project to see importable rules/)).toBeInTheDocument();
  });

  it("fetches permissions and shows new rules after selecting a project", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(mockedFetchProjectPermissions).toHaveBeenCalledWith(PROJECT_B.id);
    });
    await waitFor(() => {
      expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    });
  });

  it("excludes rules already present in currentPermissions by same type+pattern", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)", "Read(**/*.ts)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal({
      currentPermissions: { allow: ["Bash(npm test:*)"], deny: [], ask: [] },
    });

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText("Read(**/*.ts)")).toBeInTheDocument();
    });

    // Left panel (new rules) should have one checkbox (one new rule)
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
  });

  it("does NOT exclude a rule that exists under a different type", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(*)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal({
      currentPermissions: { allow: [], deny: ["Bash(*)"], ask: [] },
    });

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });
  });

  it("shows 'All rules from this project are already present' when there are no new rules", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal({
      currentPermissions: { allow: ["Bash(npm test:*)"], deny: [], ask: [] },
    });

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(
        screen.getByText(/All rules from this project are already present/),
      ).toBeInTheDocument();
    });
  });

  it("Import button is disabled when nothing is selected", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
  });

  it("selecting a rule enables the Import button with count", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });

    await user.click(screen.getAllByRole("checkbox")[0]);

    expect(screen.getByRole("button", { name: /import 1 rule/i })).not.toBeDisabled();
  });

  it("Import button calls onImport with only the selected rules", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)", "Read(**/*.ts)"],
      deny: [],
      ask: [],
    });
    const onImport = vi.fn();
    const user = userEvent.setup();
    renderModal({ onImport });

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    await user.click(screen.getByRole("button", { name: /import 1 rule/i }));

    expect(onImport).toHaveBeenCalledWith([{ type: "allow", pattern: "Bash(npm test:*)" }]);
  });

  it("Select all toggles all checkboxes on", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)", "Read(**/*.ts)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /select all/i }));

    expect(screen.getByRole("button", { name: /import 2 rules/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deselect all/i })).toBeInTheDocument();
  });

  it("Deselect all clears all selections", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)", "Read(**/*.ts)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /select all/i }));
    await user.click(screen.getByRole("button", { name: /deselect all/i }));

    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /select all/i })).toBeInTheDocument();
  });

  it("resets selection when switching source project", async () => {
    const PROJECT_C = {
      id: "proj-c",
      repoPath: "/home/user/project-c",
      name: "project-c",
    };
    mockedUseProjects.mockReturnValue({
      data: [PROJECT_A, PROJECT_B, PROJECT_C],
    } as unknown as ReturnType<typeof useProjects>);

    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });

    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });

    // Select a rule
    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: /import 1 rule/i })).toBeInTheDocument();

    // Switch to another project — selection should reset
    await user.click(screen.getByRole("button", { name: /project-b/i }));
    await user.click(await screen.findByRole("option", { name: "project-c" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
    });
  });

  it("shows 'New rules (N)' header with count when there are importable rules", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)", "Read(**/*.ts)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText("New rules (2)")).toBeInTheDocument();
    });
  });

  it("shows 'Preview (N)' header counting current rules when nothing is selected", async () => {
    mockedFetchProjectPermissions.mockResolvedValue({
      allow: ["Bash(npm test:*)"],
      deny: [],
      ask: [],
    });
    const user = userEvent.setup();
    renderModal({
      currentPermissions: { allow: ["Read(**)"], deny: [], ask: [] },
    });

    await selectSourceProject(user, "project-b");

    // Preview should show the current rules count (1) since nothing is selected
    await waitFor(() => {
      expect(screen.getByText("Preview (1)")).toBeInTheDocument();
    });
  });

  it("shows error message when fetching source permissions fails", async () => {
    mockedFetchProjectPermissions.mockRejectedValue(new Error("Network error"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    renderModal();

    await selectSourceProject(user, "project-b");

    await waitFor(() => {
      expect(screen.getByText(/Failed to load permissions/)).toBeInTheDocument();
    });
  });
});
