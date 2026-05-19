// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../../test/renderWithProviders";
import { EnforceIssueDependenciesOverrideTile } from "./EnforceIssueDependenciesOverrideTile";
import { DEFAULT_BENCH_SETTINGS } from "@roubo/shared";
import { useSettings } from "../../hooks/useSettings";

vi.mock("../../hooks/useSettings", () => ({
  useSettings: vi.fn(),
}));

const mockedUseSettings = vi.mocked(useSettings);

function renderTile(draft: boolean | null = null, onChange = vi.fn()) {
  return renderWithProviders(
    <MemoryRouter>
      <EnforceIssueDependenciesOverrideTile draft={draft} onChange={onChange} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseSettings.mockReturnValue({
    settings: { benches: { enforceIssueDependencies: true } },
    isLoading: false,
    updateSettings: vi.fn(),
  } as unknown as ReturnType<typeof useSettings>);
});

describe("EnforceIssueDependenciesOverrideTile", () => {
  it("renders all three radio options", () => {
    renderTile();
    expect(screen.getByText("Use app default")).toBeInTheDocument();
    expect(screen.getByText("Force on")).toBeInTheDocument();
    expect(screen.getByText("Force off")).toBeInTheDocument();
  });

  it("selects Use app default when draft is null", () => {
    renderTile(null);
    expect(screen.getByRole("radio", { name: /use app default/i })).toBeChecked();
  });

  it("selects Force on when draft is true", () => {
    renderTile(true);
    expect(screen.getByRole("radio", { name: /force on/i })).toBeChecked();
  });

  it("selects Force off when draft is false", () => {
    renderTile(false);
    expect(screen.getByRole("radio", { name: /force off/i })).toBeChecked();
  });

  it("shows App default: on when app default is true", () => {
    renderTile();
    expect(screen.getByText("App default: on")).toBeInTheDocument();
  });

  it("shows App default: off when app default is false", () => {
    mockedUseSettings.mockReturnValue({
      settings: { benches: { enforceIssueDependencies: false } },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    renderTile();
    expect(screen.getByText("App default: off")).toBeInTheDocument();
  });

  it("uses DEFAULT_BENCH_SETTINGS.enforceIssueDependencies when settings are unavailable", () => {
    mockedUseSettings.mockReturnValue({
      settings: undefined,
      isLoading: true,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    renderTile();
    const expectedHint = DEFAULT_BENCH_SETTINGS.enforceIssueDependencies
      ? "App default: on"
      : "App default: off";
    expect(screen.getByText(expectedHint)).toBeInTheDocument();
  });

  it("calls onChange with null when Use app default is clicked while overridden", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderTile(true, onChange);
    await user.click(screen.getByText("Use app default"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("calls onChange with true when Force on is selected", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderTile(null, onChange);
    await user.click(screen.getByText("Force on"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange with false when Force off is selected", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderTile(null, onChange);
    await user.click(screen.getByText("Force off"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("shows Override badge when draft is not null", () => {
    renderTile(true);
    expect(screen.getByText("Override")).toBeInTheDocument();
    expect(screen.getByText(/Project override active/)).toBeInTheDocument();
  });

  it("does not show Override badge when draft is null", () => {
    renderTile(null);
    expect(screen.queryByText("Override")).not.toBeInTheDocument();
  });

  it("shows effective value row when override is set", () => {
    renderTile(false);
    expect(screen.getByText("Effective:")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("does not show effective value row when no override", () => {
    renderTile(null);
    expect(screen.queryByText("Effective:")).not.toBeInTheDocument();
  });
});
