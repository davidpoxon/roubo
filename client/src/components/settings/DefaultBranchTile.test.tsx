// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import DefaultBranchTile from "./DefaultBranchTile";

vi.mock("../../hooks/useProjectSettings", () => ({
  useProjectSettings: vi.fn(),
}));

import { useProjectSettings } from "../../hooks/useProjectSettings";

type SettingsReturn = ReturnType<typeof useProjectSettings>;

function mockSettings(overrides: Partial<SettingsReturn> = {}) {
  vi.mocked(useProjectSettings).mockReturnValue({
    settings: undefined,
    isLoading: false,
    updateSettings: vi.fn(),
    isError: false,
    error: null,
    isFetchError: false,
    fetchError: null,
    ...overrides,
  } as SettingsReturn);
}

describe("DefaultBranchTile", () => {
  beforeEach(() => {
    mockSettings({
      settings: {
        worktreeSource: { branchFromDefault: true, pullLatest: true },
        defaultBranch: "main",
      },
    });
  });

  it("renders the branch name in mono when present", () => {
    render(<DefaultBranchTile projectId="proj-1" />);
    expect(screen.getByText("main")).toBeInTheDocument();
  });

  it("shows the origin/HEAD detection notice when branch is present", () => {
    render(<DefaultBranchTile projectId="proj-1" />);
    expect(screen.getByText("origin/HEAD")).toBeInTheDocument();
  });

  it("renders loading skeleton while loading", () => {
    mockSettings({ isLoading: true });
    render(<DefaultBranchTile projectId="proj-1" />);
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.getByText("Detecting default branch…")).toBeInTheDocument();
  });

  it("renders error alert when defaultBranchError is present", () => {
    mockSettings({
      settings: {
        worktreeSource: { branchFromDefault: true, pullLatest: true },
        defaultBranchError: "not a git repository",
      },
    });
    render(<DefaultBranchTile projectId="proj-1" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Unable to detect")).toBeInTheDocument();
    expect(screen.getByText("not a git repository")).toBeInTheDocument();
  });

  it("renders dash fallback when neither branch nor error is present", () => {
    mockSettings({
      settings: {
        worktreeSource: { branchFromDefault: true, pullLatest: true },
      },
    });
    render(<DefaultBranchTile projectId="proj-1" />);
    expect(screen.getByLabelText("No default branch detected")).toBeInTheDocument();
  });
});
