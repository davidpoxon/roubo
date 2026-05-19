// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSourceTile } from "./WorkspaceSourceTile";
import type { ProjectSettings } from "@roubo/shared";

vi.mock("../../hooks/useProjectSettings");
import { useProjectSettings } from "../../hooks/useProjectSettings";

const mockedUseProjectSettings = vi.mocked(useProjectSettings);

const defaultWorktreeSource: ProjectSettings["worktreeSource"] = {
  branchFromDefault: true,
  pullLatest: true,
};

function makeSettings(overrides: Partial<ReturnType<typeof useProjectSettings>> = {}) {
  return {
    settings: {
      worktreeSource: defaultWorktreeSource,
      defaultBranch: undefined,
      defaultBranchError: undefined,
    },
    isLoading: false,
    updateSettings: vi.fn(),
    updateSettingsAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    isFetchError: false,
    fetchError: null,
    ...overrides,
  };
}

function renderTile(
  draft: ProjectSettings["worktreeSource"] = defaultWorktreeSource,
  original: ProjectSettings["worktreeSource"] = defaultWorktreeSource,
  onChange = vi.fn(),
) {
  return render(
    <WorkspaceSourceTile
      projectId="my-app"
      draft={draft}
      onChange={onChange}
      original={original}
    />,
  );
}

describe("WorkspaceSourceTile", () => {
  beforeEach(() => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings() as unknown as ReturnType<typeof useProjectSettings>,
    );
  });

  it("shows loading state while fetching settings", () => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings({
        isLoading: true,
        settings: undefined,
      }) as unknown as ReturnType<typeof useProjectSettings>,
    );
    renderTile();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders fetch error banner when isFetchError is true", () => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings({ isFetchError: true }) as unknown as ReturnType<typeof useProjectSettings>,
    );
    renderTile();
    expect(
      screen.getByText("Failed to load workspace source settings. Please try again."),
    ).toBeInTheDocument();
  });

  it("shows the tile heading", () => {
    renderTile();
    expect(screen.getByText("Workspace source")).toBeInTheDocument();
  });

  it("always renders both toggles", () => {
    renderTile();
    expect(
      screen.getByRole("switch", {
        name: /branch new benches from the default branch/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: /pull latest before workspace setup/i,
      }),
    ).toBeInTheDocument();
  });

  it("does not render Edit, Save, or Cancel buttons", () => {
    renderTile();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("reflects draft values in toggle state", () => {
    renderTile({ branchFromDefault: false, pullLatest: true });
    const branchToggle = screen.getByRole("switch", {
      name: /branch new benches from the default branch/i,
    });
    const pullToggle = screen.getByRole("switch", {
      name: /pull latest before workspace setup/i,
    });
    expect(branchToggle).not.toBeChecked();
    expect(pullToggle).toBeChecked();
  });

  it("calls onChange when branchFromDefault toggle is flipped", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderTile({ branchFromDefault: true, pullLatest: true }, defaultWorktreeSource, onChange);
    await act(() =>
      user.click(
        screen.getByRole("switch", {
          name: /branch new benches from the default branch/i,
        }),
      ),
    );
    expect(onChange).toHaveBeenCalledWith({
      branchFromDefault: false,
      pullLatest: true,
    });
  });

  it("calls onChange when pullLatest toggle is flipped", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderTile({ branchFromDefault: true, pullLatest: true }, defaultWorktreeSource, onChange);
    await act(() =>
      user.click(
        screen.getByRole("switch", {
          name: /pull latest before workspace setup/i,
        }),
      ),
    );
    expect(onChange).toHaveBeenCalledWith({
      branchFromDefault: true,
      pullLatest: false,
    });
  });

  it("shows Editing badge when draft differs from original", () => {
    renderTile(
      { branchFromDefault: false, pullLatest: true },
      { branchFromDefault: true, pullLatest: true },
    );
    expect(screen.getByText("Editing")).toBeInTheDocument();
  });

  it("does not show Editing badge when draft matches original", () => {
    renderTile(defaultWorktreeSource, defaultWorktreeSource);
    expect(screen.queryByText("Editing")).not.toBeInTheDocument();
  });

  it("shows branchFromDefault git preview when toggle is on", () => {
    renderTile({ branchFromDefault: true, pullLatest: false });
    expect(screen.getByText(/git worktree add/)).toBeInTheDocument();
  });

  it("does not show branchFromDefault git preview when toggle is off", () => {
    renderTile({ branchFromDefault: false, pullLatest: false });
    expect(screen.queryByText(/git worktree add/)).not.toBeInTheDocument();
  });

  it("shows defaultBranch in the branchFromDefault preview", () => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings({
        settings: {
          worktreeSource: defaultWorktreeSource,
          defaultBranch: "main",
          defaultBranchError: undefined,
        },
      }) as unknown as ReturnType<typeof useProjectSettings>,
    );
    renderTile({ branchFromDefault: true, pullLatest: false });
    expect(screen.getAllByText(/main/).length).toBeGreaterThan(0);
  });

  it("shows defaultBranchError when branchFromDefault is on", () => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings({
        settings: {
          worktreeSource: defaultWorktreeSource,
          defaultBranch: undefined,
          defaultBranchError: "Could not detect default branch.",
        },
      }) as unknown as ReturnType<typeof useProjectSettings>,
    );
    renderTile({ branchFromDefault: true, pullLatest: false });
    expect(screen.getByText("Could not detect default branch.")).toBeInTheDocument();
  });

  it("shows pullLatest git preview when pullLatest is on", () => {
    renderTile({ branchFromDefault: false, pullLatest: true });
    expect(screen.getByText(/git fetch origin/)).toBeInTheDocument();
  });

  it("shows currentBranch placeholder in pullLatest preview when branchFromDefault is off", () => {
    renderTile({ branchFromDefault: false, pullLatest: true });
    expect(screen.getByText(/git fetch origin <currentBranch>/)).toBeInTheDocument();
  });

  it("shows defaultBranch in pullLatest preview when branchFromDefault is on", () => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings({
        settings: {
          worktreeSource: defaultWorktreeSource,
          defaultBranch: "main",
          defaultBranchError: undefined,
        },
      }) as unknown as ReturnType<typeof useProjectSettings>,
    );
    renderTile({ branchFromDefault: true, pullLatest: true });
    expect(
      screen.getByText(/git fetch origin main && git merge --ff-only origin\/main/),
    ).toBeInTheDocument();
  });

  it("shows Default branch label with value when defaultBranch is resolved", () => {
    mockedUseProjectSettings.mockReturnValue(
      makeSettings({
        settings: {
          worktreeSource: defaultWorktreeSource,
          defaultBranch: "develop",
          defaultBranchError: undefined,
        },
      }) as unknown as ReturnType<typeof useProjectSettings>,
    );
    renderTile({ branchFromDefault: true, pullLatest: false });
    expect(screen.getByText("Default branch:")).toBeInTheDocument();
    expect(screen.getByText("develop")).toBeInTheDocument();
  });
});
