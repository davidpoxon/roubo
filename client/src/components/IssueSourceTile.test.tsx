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

vi.mock("../hooks/useSourceCandidates", () => ({
  useSourceCandidates: vi.fn(() => ({
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
  })),
}));

vi.mock("../hooks/useSaveProjectSources", () => ({
  useSaveProjectSources: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

// WU-050: PluginConfigureDialog renders useOpportunisticRecheckOnMount, which
// would otherwise issue a real fetch when the dialog mounts in this jsdom
// suite (no MSW; api.ts uses relative URLs with no base). Mock the hook so
// the dialog stays inert here. Issue #204 wires `useConnectionStatus` into
// the tile itself; mock that one too to keep this suite hermetic.
vi.mock("../hooks/usePlugins", async () => {
  const actual = await vi.importActual<typeof import("../hooks/usePlugins")>("../hooks/usePlugins");
  return {
    ...actual,
    useOpportunisticRecheckOnMount: vi.fn(),
    useConnectionStatus: vi.fn(() => ({ data: undefined, isFetching: false })),
  };
});

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

function renderTileWithTitle(title: string) {
  return renderWithProviders(
    <MemoryRouter>
      <IssueSourceTile projectId="demo" title={title} />
    </MemoryRouter>,
  );
}

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

  it('defaults the tile title to "Source" when no title prop is supplied (FR-069 fallback)', () => {
    withData({
      effective: {},
      committed: null,
      override: null,
      plugin: null,
      captionKey: "none",
    });

    renderTile();

    expect(screen.getByRole("region", { name: "Source" })).toBeInTheDocument();
  });

  it("renders the supplied title prop as the tile heading (plugin display name)", () => {
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

    renderTileWithTitle("GitHub.com");

    expect(screen.getByRole("region", { name: "GitHub.com" })).toBeInTheDocument();
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

  it('shows "Connect" as the primary action when the plugin has no credentials yet (FR-072, TC-133)', () => {
    withData({
      // Plugin selected, but no capturedUserId and no instance: derives to
      // disconnected and the single primary button reads "Connect".
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

    expect(screen.getByRole("button", { name: /^Connect$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Configure$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Choose sources$/ })).not.toBeInTheDocument();
  });

  it('flips the primary action to "Configure" once credentials are captured and opens the same modal (FR-072, TC-133)', async () => {
    const user = userEvent.setup();
    withData({
      effective: {
        plugin: "github-com",
        capturedUserId: { externalId: "42", displayName: "Octocat" },
      },
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
    expect(screen.queryByRole("button", { name: /^Choose sources$/ })).not.toBeInTheDocument();
    await user.click(configure);

    expect(screen.getByRole("dialog", { name: /Configure GitHub\.com/ })).toBeInTheDocument();
  });

  it("GHE plugin renders the same single context-aware button behaviour (FR-073, TC-133)", () => {
    withData({
      // GHE: instance saved counts as "connected" via the helper's optimistic
      // instance-presence heuristic, mirroring github.com's connected branch.
      effective: { plugin: "ghe", instance: "https://ghe.example" },
      committed: { plugin: "ghe" },
      override: null,
      plugin: {
        id: "ghe",
        installed: true,
        status: "enabled",
        manifest: { name: "GitHub Enterprise" },
      },
      captionKey: "yaml-only",
    });

    renderTile();

    expect(screen.getByRole("button", { name: /^Configure$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Choose sources$/ })).not.toBeInTheDocument();
  });
});
