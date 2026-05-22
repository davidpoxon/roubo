// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ProjectIntegrationState } from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import IssueSourceTile from "./IssueSourceTile";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useInstalledPlugins } from "../hooks/useInstalledPlugins";

vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(),
  useSwitchProjectIntegration: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useTestIntegrationConnection: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useSaveIntegrationConfig: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("../hooks/useInstalledPlugins", () => ({
  useInstalledPlugins: vi.fn(() => ({ data: [], isLoading: false })),
}));

const mockedUseProjectIntegration = vi.mocked(useProjectIntegration);
const mockedUseInstalledPlugins = vi.mocked(useInstalledPlugins);

function withData(data: ProjectIntegrationState) {
  mockedUseProjectIntegration.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useProjectIntegration>);
}

function renderTile() {
  return renderWithProviders(
    <MemoryRouter>
      <IssueSourceTile projectId="demo" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseInstalledPlugins.mockReturnValue({
    data: [],
    isLoading: false,
  } as unknown as ReturnType<typeof useInstalledPlugins>);
});

describe("IssueSourceTile", () => {
  it("renders the unconfigured variant when no plugin is set", () => {
    withData({
      effective: {},
      committed: null,
      override: null,
      plugin: null,
      captionKey: "none",
    });

    renderTile();

    expect(screen.getByText(/No issue source configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Choose integration/i })).toBeInTheDocument();
  });

  it("renders the missing-plugin variant when the plugin is not installed", () => {
    withData({
      effective: { plugin: "jira-self-hosted" },
      committed: { plugin: "jira-self-hosted" },
      override: null,
      plugin: { id: "jira-self-hosted", installed: false, status: null, manifest: null },
      captionKey: "yaml-only",
    });

    renderTile();

    expect(screen.getByText(/jira-self-hosted/)).toBeInTheDocument();
    const installLink = screen.getByRole("link", { name: /Install plugin/i });
    expect(installLink).toHaveAttribute("href", "/settings/plugins");
  });

  it("renders the configured variant with title-cased source groups", () => {
    withData({
      effective: {
        plugin: "github-com",
        instance: "https://github.com",
        sources: { repos: ["org/a", "org/b"], projects: [42] },
      },
      committed: { plugin: "github-com" },
      override: null,
      plugin: {
        id: "github-com",
        installed: true,
        status: "enabled",
        manifest: { name: "GitHub.com" },
      },
      captionKey: "yaml-only",
    });

    renderTile();

    expect(screen.getByText("GitHub.com")).toBeInTheDocument();
    expect(screen.getByText("https://github.com")).toBeInTheDocument();
    expect(screen.getByText("Repos")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("org/a")).toBeInTheDocument();
    expect(screen.getByText("org/b")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders the override-only caption exactly as TC-056 mandates", () => {
    withData({
      effective: { plugin: "jira-self-hosted" },
      committed: null,
      override: { plugin: "jira-self-hosted" },
      plugin: {
        id: "jira-self-hosted",
        installed: true,
        status: "enabled",
        manifest: { name: "Jira" },
      },
      captionKey: "override-only",
    });

    renderTile();

    expect(
      screen.getByText("Configuration from your override; roubo.yaml has no integration block"),
    ).toBeInTheDocument();
  });

  it("renders the yaml-only caption", () => {
    withData({
      effective: { plugin: "github-com" },
      committed: { plugin: "github-com" },
      override: null,
      plugin: {
        id: "github-com",
        installed: true,
        status: "enabled",
        manifest: { name: "GitHub.com" },
      },
      captionKey: "yaml-only",
    });

    renderTile();

    expect(screen.getByText("Configuration from roubo.yaml")).toBeInTheDocument();
  });

  it("renders the yaml-and-override caption", () => {
    withData({
      effective: { plugin: "jira-self-hosted" },
      committed: { plugin: "github-com" },
      override: { plugin: "jira-self-hosted" },
      plugin: {
        id: "jira-self-hosted",
        installed: true,
        status: "enabled",
        manifest: { name: "Jira" },
      },
      captionKey: "yaml-and-override",
    });

    renderTile();

    expect(
      screen.getByText("Configuration merged from roubo.yaml and your override"),
    ).toBeInTheDocument();
  });

  it("enables the Configure button on the configured variant and opens the dialog", async () => {
    const user = userEvent.setup();
    withData({
      effective: { plugin: "github-com" },
      committed: { plugin: "github-com" },
      override: null,
      plugin: {
        id: "github-com",
        installed: true,
        status: "enabled",
        manifest: {
          name: "GitHub.com",
          configSchema: { type: "object", properties: { instance: { type: "string" } } },
          permissions: {
            network: { hosts: [] },
            credentials: { slots: [] },
            filesystem: { paths: [] },
            processes: false,
          },
        },
      },
      captionKey: "yaml-only",
    });

    renderTile();

    const configure = screen.getByRole("button", { name: /^Configure$/ });
    expect(configure).not.toBeDisabled();
    await user.click(configure);

    expect(screen.getByRole("dialog", { name: /Configure GitHub\.com/ })).toBeInTheDocument();
  });
});
