// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import SwitchIntegrationDialog from "./SwitchIntegrationDialog";
import { useInstalledPlugins } from "../hooks/useInstalledPlugins";
import { useSwitchProjectIntegration } from "../hooks/useProjectIntegration";

vi.mock("../hooks/useInstalledPlugins", () => ({
  useInstalledPlugins: vi.fn(),
}));

vi.mock("../hooks/useProjectIntegration", () => ({
  useSwitchProjectIntegration: vi.fn(),
}));

const mockedUseInstalledPlugins = vi.mocked(useInstalledPlugins);
const mockedUseSwitchProjectIntegration = vi.mocked(useSwitchProjectIntegration);

const mutateAsync = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue(undefined);
  mockedUseSwitchProjectIntegration.mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useSwitchProjectIntegration>);
  mockedUseInstalledPlugins.mockReturnValue({
    data: [
      { id: "github-com", name: "GitHub.com", status: "enabled" },
      { id: "jira-self-hosted", name: "Jira", status: "enabled" },
    ],
    isLoading: false,
  } as unknown as ReturnType<typeof useInstalledPlugins>);
});

describe("SwitchIntegrationDialog", () => {
  it("shows the bench-survival explanation when a current plugin is set", () => {
    renderWithProviders(
      <SwitchIntegrationDialog projectId="demo" currentPluginId="github-com" onClose={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: /Switch integration/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Active benches will keep working against their stored issue snapshot/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /show an "Issue from previous integration" badge and their source-sync controls will be disabled/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders 'Choose integration' title and hides bench-survival copy when no current plugin", () => {
    renderWithProviders(
      <SwitchIntegrationDialog projectId="demo" currentPluginId={null} onClose={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: /Choose integration/i })).toBeInTheDocument();
    expect(screen.queryByText(/Active benches will keep working/i)).not.toBeInTheDocument();
  });

  it("primary button is disabled until a different plugin is selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SwitchIntegrationDialog projectId="demo" currentPluginId="github-com" onClose={vi.fn()} />,
    );

    const primary = screen.getByRole("button", { name: /Switch integration/i });
    expect(primary).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    expect(primary).toBeEnabled();
  });

  it("calls mutateAsync with the chosen plugin id on confirm and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <SwitchIntegrationDialog projectId="demo" currentPluginId="github-com" onClose={onClose} />,
    );

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    await user.click(screen.getByRole("button", { name: /Switch integration/i }));

    expect(mutateAsync).toHaveBeenCalledWith("jira-self-hosted");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables radios for errored or incompatible plugins", () => {
    mockedUseInstalledPlugins.mockReturnValue({
      data: [
        { id: "github-com", name: "GitHub.com", status: "enabled" },
        { id: "broken", name: "Broken", status: "errored", lastError: "boom" },
        { id: "old", name: "Old", status: "incompatible" },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useInstalledPlugins>);

    renderWithProviders(
      <SwitchIntegrationDialog projectId="demo" currentPluginId="github-com" onClose={vi.fn()} />,
    );

    expect(screen.getByRole("radio", { name: /Broken/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Old/i })).toBeDisabled();
  });
});
