// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../../test/renderWithProviders";
import { IssueTypeMappingsSection } from "./IssueTypeMappingsSection";

vi.mock("../../hooks/useIssueTypes");
vi.mock("../../hooks/useBlueprints");

import { useIssueTypes } from "../../hooks/useIssueTypes";
import { useBlueprints } from "../../hooks/useBlueprints";

const mockedUseIssueTypes = vi.mocked(useIssueTypes);
const mockedUseBlueprints = vi.mocked(useBlueprints);

function renderSection(draft: Record<string, string>, onChange = vi.fn()) {
  return {
    onChange,
    ...renderWithProviders(
      <MemoryRouter>
        <IssueTypeMappingsSection projectId="my-app" draft={draft} onChange={onChange} />
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseBlueprints.mockReturnValue({
    data: [
      { id: "bp-bug", name: "Bug fix", description: "", icon: "bug" },
      { id: "bp-feat", name: "Feature dev", description: "", icon: "zap" },
    ],
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useBlueprints>);
});

describe("IssueTypeMappingsSection", () => {
  it("shows type rows when types loaded but blueprints still loading", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: {
        configured: true,
        types: [{ id: "1", name: "Bug", color: "ef4444" }],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    mockedUseBlueprints.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useBlueprints>);
    renderSection({});
    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("shows loading spinner while issue types are loading", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    renderSection({});
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows generic error copy on error", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useIssueTypes>);
    renderSection({});
    expect(screen.getByText(/could not load issue types/i)).toBeInTheDocument();
  });

  it("shows none-defined message", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: { configured: false, reason: "none-defined", types: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    renderSection({});
    expect(screen.getByText(/no issue types are enabled/i)).toBeInTheDocument();
  });

  it("shows not-connected message with link to settings", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: { configured: false, reason: "not-connected", types: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    renderSection({});
    expect(screen.getByText(/connect your github account/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /settings.*integrations/i });
    expect(link).toHaveAttribute("href", "/settings");
  });

  it("shows empty-state copy when configured with zero types", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: { configured: true, types: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    renderSection({});
    expect(screen.getByText(/no issue types defined/i)).toBeInTheDocument();
  });

  it("renders one row per issue type with current draft selection", () => {
    mockedUseIssueTypes.mockReturnValue({
      data: {
        configured: true,
        types: [
          { id: "1", name: "Bug", color: "ef4444" },
          { id: "2", name: "Feature", color: "3b82f6" },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    renderSection({ Bug: "bp-bug" });
    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    // Bug row's trigger button should show the mapped blueprint label
    expect(screen.getByRole("button", { name: /bug fix/i })).toBeInTheDocument();
  });

  it("calls onChange with new value when a non-default option is picked", async () => {
    mockedUseIssueTypes.mockReturnValue({
      data: {
        configured: true,
        types: [{ id: "1", name: "Bug", color: "ef4444" }],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    const onChange = vi.fn();
    renderSection({}, onChange);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /use default/i }));
    await user.click(screen.getByRole("option", { name: "Feature dev" }));

    expect(onChange).toHaveBeenCalledWith({ Bug: "bp-feat" });
  });

  it("removes mapping entry when 'Use default' is picked", async () => {
    mockedUseIssueTypes.mockReturnValue({
      data: {
        configured: true,
        types: [{ id: "1", name: "Bug", color: "ef4444" }],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);
    const onChange = vi.fn();
    renderSection({ Bug: "bp-bug" }, onChange);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /bug fix/i }));
    await user.click(screen.getByRole("option", { name: "Use default" }));

    expect(onChange).toHaveBeenCalledWith({});
  });
});
