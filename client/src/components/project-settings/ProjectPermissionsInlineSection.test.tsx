// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ProjectPermissionsInlineSection } from "./ProjectPermissionsInlineSection";
import { useProjectPermissions } from "../../hooks/useProjectPermissions";

vi.mock("../../hooks/useProjectPermissions", () => ({
  useProjectPermissions: vi.fn(),
}));

const mockedUseProjectPermissions = vi.mocked(useProjectPermissions);

function makeDefaultHook(overrides = {}) {
  return {
    permissions: { allow: [], deny: [], ask: [] },
    isLoading: false,
    updatePermissions: vi.fn(),
    isError: false,
    error: null,
    resyncBenches: vi.fn(),
    isResyncing: false,
    ...overrides,
  };
}

function renderSection(projectId = "my-app") {
  return renderWithProviders(
    <MemoryRouter>
      <ProjectPermissionsInlineSection projectId={projectId} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseProjectPermissions.mockReturnValue(makeDefaultHook());
});

describe("ProjectPermissionsInlineSection", () => {
  it("shows empty state when there are no rules", () => {
    renderSection();
    expect(screen.getByText(/No permissions saved/)).toBeInTheDocument();
  });

  it("shows loading spinner while loading", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({ permissions: undefined, isLoading: true }),
    );
    renderSection();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("renders all allow rules", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: {
          allow: ["Bash(npm test:*)", "Bash(git push:*)"],
          deny: [],
          ask: [],
        },
      }),
    );
    renderSection();
    expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    expect(screen.getByText("Bash(git push:*)")).toBeInTheDocument();
  });

  it("renders all deny rules alongside allow rules", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: {
          allow: ["Bash(npm test:*)"],
          deny: ["Bash(rm:*)"],
          ask: [],
        },
      }),
    );
    renderSection();
    expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    expect(screen.getByText("Bash(rm:*)")).toBeInTheDocument();
  });

  it("renders ask rules", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: {
          allow: [],
          deny: [],
          ask: ["Edit(.env*)"],
        },
      }),
    );
    renderSection();
    expect(screen.getByText("Edit(.env*)")).toBeInTheDocument();
    expect(screen.getByText("ask")).toBeInTheDocument();
  });

  it("shows error message when fetch fails instead of empty state", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: undefined,
        isLoading: false,
        isError: true,
        error: new Error("Network error"),
      }),
    );
    renderSection();
    expect(screen.getByText("Could not load permissions.")).toBeInTheDocument();
    expect(screen.queryByText(/No permissions saved/)).not.toBeInTheDocument();
  });

  it("shows deny chip when only deny rules exist", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] },
      }),
    );
    renderSection();
    expect(screen.getByText("Bash(rm:*)")).toBeInTheDocument();
    expect(screen.queryByText(/No permissions saved/)).not.toBeInTheDocument();
  });

  it("does not show empty state when rules exist", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: { allow: ["Bash(npm test:*)"], deny: [], ask: [] },
      }),
    );
    renderSection();
    expect(screen.queryByText(/No permissions saved/)).not.toBeInTheDocument();
  });

  it("paginates when there are more than 10 rules", () => {
    const allow = Array.from({ length: 11 }, (_, i) => `Bash(tool-${i}:*)`);
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({ permissions: { allow, deny: [], ask: [] } }),
    );
    renderSection();
    expect(screen.getByText("Bash(tool-0:*)")).toBeInTheDocument();
    expect(screen.queryByText("Bash(tool-10:*)")).not.toBeInTheDocument();
    const nextButton = screen.getByRole("button", { name: /next page/i });
    fireEvent.click(nextButton);
    expect(screen.getByText("Bash(tool-10:*)")).toBeInTheDocument();
    expect(screen.queryByText("Bash(tool-0:*)")).not.toBeInTheDocument();
  });

  it("shows type filter pills and filters by type", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: {
          allow: ["Bash(npm test:*)"],
          deny: ["Bash(rm:*)"],
          ask: ["Edit(.env*)"],
        },
      }),
    );
    renderSection();
    expect(screen.getByRole("button", { name: /^All \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^allow \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^deny \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^ask \(1\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^deny \(1\)/ }));
    expect(screen.queryByText("Bash(npm test:*)")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit(.env*)")).not.toBeInTheDocument();
    expect(screen.getByText("Bash(rm:*)")).toBeInTheDocument();
  });

  it("shows rule count summary when rules exist", () => {
    mockedUseProjectPermissions.mockReturnValue(
      makeDefaultHook({
        permissions: {
          allow: ["Bash(npm test:*)"],
          deny: ["Bash(rm:*)"],
          ask: ["Edit(.env*)"],
        },
      }),
    );
    renderSection();
    expect(screen.getByText(/3 rules/)).toBeInTheDocument();
    expect(screen.getByText(/1 allow/)).toBeInTheDocument();
    expect(screen.getByText(/1 deny/)).toBeInTheDocument();
    expect(screen.getByText(/1 ask/)).toBeInTheDocument();
  });
});
