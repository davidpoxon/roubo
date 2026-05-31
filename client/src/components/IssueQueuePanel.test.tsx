// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import IssueQueuePanel from "./IssueQueuePanel";
import { ApiError } from "../lib/api";
import type { Bench, NormalizedIssue, RouboConfig } from "@roubo/shared";

vi.mock("../hooks/useIssues", () => ({
  useIssues: vi.fn(),
  useRefreshIssues: vi.fn(() => vi.fn()),
}));
vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(() => ({ data: undefined })),
}));
vi.mock("../hooks/usePlugins", () => ({
  usePlugins: vi.fn(() => ({ data: undefined })),
  useOpportunisticRecheckOnMount: vi.fn(),
}));
vi.mock("../hooks/useCutListFacets", () => ({
  useFilterFacets: vi.fn(() => ({
    data: [
      { id: "type", label: "Type", type: "enum" },
      { id: "labels", label: "Labels", type: "enum" },
      { id: "milestone", label: "Milestone", type: "enum-async" },
    ],
  })),
  useFacetOptions: vi.fn(() => ({ data: [], isLoading: false, isError: false })),
  usePrefetchFacetOptions: vi.fn(),
}));
vi.mock("./PluginConfigureDialog", () => ({
  default: ({ pluginId, plugin }: { pluginId?: string; plugin?: { id: string } }) => (
    <div data-testid="plugin-configure-dialog" data-plugin-id={pluginId ?? plugin?.id} />
  ),
}));
vi.mock("./DraggableIssueCard", () => ({
  default: ({ issue }: { issue: NormalizedIssue }) => (
    <div data-testid="issue-card">{issue.externalId}</div>
  ),
}));
vi.mock("./CutListFilterBar", () => ({
  default: ({
    onFiltersChange,
  }: {
    onFiltersChange: (f: {
      search: string;
      facetValues: Record<string, Set<string>>;
      includeHiddenStatuses: boolean;
    }) => void;
  }) => (
    <div data-testid="filter-bar">
      <button
        onClick={() =>
          onFiltersChange({
            search: "",
            facetValues: { type: new Set(["Bug"]) },
            includeHiddenStatuses: false,
          })
        }
      >
        Filter by Bug
      </button>
    </div>
  ),
}));
vi.mock("./CutListGroupByControl", () => ({
  default: ({ onGroupingChange }: { onGroupingChange: (g: { groupBy: string }) => void }) => (
    <div data-testid="group-by-control">
      <button onClick={() => onGroupingChange({ groupBy: "type" })}>Group by type</button>
      <button onClick={() => onGroupingChange({ groupBy: "labels" })}>Group by labels</button>
      <button onClick={() => onGroupingChange({ groupBy: "none" })}>Clear grouping</button>
    </div>
  ),
}));

import { useIssues } from "../hooks/useIssues";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { usePlugins, useOpportunisticRecheckOnMount } from "../hooks/usePlugins";
import { usePrefetchFacetOptions } from "../hooks/useCutListFacets";
const mockedUseIssues = vi.mocked(useIssues);
const mockedUseProjectIntegration = vi.mocked(useProjectIntegration);
const mockedUsePlugins = vi.mocked(usePlugins);
const mockedRecheck = vi.mocked(useOpportunisticRecheckOnMount);
const mockedPrefetch = vi.mocked(usePrefetchFacetOptions);

function defaultResult(overrides: Partial<ReturnType<typeof useIssues>> = {}) {
  return {
    issues: [] as NormalizedIssue[],
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    error: null,
    stalled: false,
    stale: false,
    snapshotCapturedAt: null,
    ...overrides,
  };
}

function integrationWithPlugin(pluginName = "GitHub.com") {
  return {
    data: {
      plugin: {
        id: "github-com",
        installed: true,
        status: null,
        manifest: { name: pluginName, configSchema: { properties: {} } },
      },
      effective: { plugin: "github-com" },
      committed: { plugin: "github-com" },
      override: null,
      captionKey: "yaml-only",
    },
  } as unknown as ReturnType<typeof useProjectIntegration>;
}

function makeIssue(externalId: string, overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/org/repo/issues/${externalId}`,
    title: `Issue ${externalId}`,
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: null,
    ...overrides,
  };
}

const config: RouboConfig = {
  project: {
    name: "app",
    displayName: "App",
    repo: "org/repo",
  },
  layout: { type: "monorepo" },
  components: {},
  ports: {},
  benches: { max: 3 },
} as unknown as RouboConfig;

const noBenches: Bench[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  mockedUseIssues.mockReturnValue(defaultResult());
  mockedUseProjectIntegration.mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useProjectIntegration>);
  mockedUsePlugins.mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof usePlugins>);
});

describe("IssueQueuePanel", () => {
  it('renders the "Cut List" header in idle state', () => {
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByText("Cut List")).toBeInTheDocument();
  });

  it('renders "No open cuts available" when the issue list is empty', () => {
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByText("No open cuts available")).toBeInTheDocument();
  });

  it("renders all issues when none are assigned or pending", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ issues: [makeIssue("1"), makeIssue("2")] }));
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
  });

  it("excludes issues already assigned to a bench (by externalId)", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ issues: [makeIssue("1"), makeIssue("2")] }));
    const benches: Bench[] = [
      {
        id: 1,
        projectId: "proj-1",
        assignedIssue: {
          number: 1,
          integrationId: "github-com",
          externalId: "1",
          title: "Issue 1",
        },
      } as unknown as Bench,
    ];
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={benches} projectConfig={config} />,
    );
    const cards = screen.getAllByTestId("issue-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("2");
  });

  it("excludes issues whose externalId is in pendingIssueExternalIds", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ issues: [makeIssue("1"), makeIssue("2")] }));
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={config}
        pendingIssueExternalIds={new Set(["2"])}
      />,
    );
    const cards = screen.getAllByTestId("issue-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("1");
  });

  it("shows an error banner when useIssues returns an Error", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ error: new Error("API rate limit exceeded") }));
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByText("API rate limit exceeded")).toBeInTheDocument();
  });

  it("surfaces the stalled inline note when any page is stalled (TC-071)", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ stalled: true }));
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByTestId("stalled-note")).toHaveTextContent(/plugin paging appears stuck/i);
  });

  describe("FR-014 / TC-016: stale-snapshot banner", () => {
    it("renders the banner with the plugin name when useIssues returns stale: true", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ stale: true }));
      mockedUseProjectIntegration.mockReturnValue(integrationWithPlugin("GitHub.com"));
      renderWithProviders(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      const banner = screen.getByTestId("stale-snapshot-banner");
      expect(banner.textContent).toContain(
        "Showing the last successful issue snapshot from GitHub.com. The plugin is currently unavailable.",
      );
    });

    it("does not render the banner when stale is false", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ stale: false }));
      mockedUseProjectIntegration.mockReturnValue(integrationWithPlugin("GitHub.com"));
      renderWithProviders(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      expect(screen.queryByTestId("stale-snapshot-banner")).toBeNull();
    });

    it("skips the banner when stale is true but no plugin manifest is available", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ stale: true }));
      // integration query returns undefined data, so no manifest name is known
      renderWithProviders(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      expect(screen.queryByTestId("stale-snapshot-banner")).toBeNull();
    });
  });

  it("renders the filter bar in loaded state", () => {
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByTestId("filter-bar")).toBeInTheDocument();
  });

  it("filtering by type narrows the rendered cards", async () => {
    mockedUseIssues.mockReturnValue(
      defaultResult({
        issues: [makeIssue("1", { issueType: "Bug" }), makeIssue("2", { issueType: "Feature" })],
      }),
    );
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Filter by Bug" }));
    const remaining = screen.getAllByTestId("issue-card");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveTextContent("1");
  });

  it("calls onFiltersChange with the projectId when filters change", async () => {
    const onFiltersChange = vi.fn();
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={config}
        onFiltersChange={onFiltersChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filter by Bug" }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ facetValues: { type: new Set(["Bug"]) } }),
    );
  });

  it("renders the group-by control stub in loaded state", () => {
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByTestId("group-by-control")).toBeInTheDocument();
  });

  it("renders collapsible section headers when grouping by type", async () => {
    mockedUseIssues.mockReturnValue(
      defaultResult({
        issues: [makeIssue("1", { issueType: "Alpha" }), makeIssue("2", { issueType: "Beta" })],
      }),
    );
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Group by type" }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
  });

  it("calls onGroupingChange with the projectId when grouping changes", async () => {
    const onGroupingChange = vi.fn();
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={config}
        onGroupingChange={onGroupingChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Group by labels" }));
    expect(onGroupingChange).toHaveBeenCalledWith("proj-1", { groupBy: "labels" });
  });

  it("initializes grouping from initialGrouping prop", () => {
    mockedUseIssues.mockReturnValue(
      defaultResult({ issues: [makeIssue("1", { issueType: "Alpha" })] }),
    );
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={config}
        initialGrouping={{ groupBy: "type" }}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("prefetches async facet options on load", () => {
    mockedUseProjectIntegration.mockReturnValue(integrationWithPlugin("GitHub.com"));
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(mockedPrefetch).toHaveBeenCalledWith("proj-1", "github-com", expect.any(Array));
  });

  it("groups issues by milestone", () => {
    mockedUseIssues.mockReturnValue(
      defaultResult({
        issues: [
          makeIssue("1", { facetValues: { milestone: "v1.0" } }),
          makeIssue("2", { facetValues: { milestone: "v2.0" } }),
        ],
      }),
    );
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={config}
        initialGrouping={{ groupBy: "milestone" }}
      />,
    );
    expect(screen.getByText("v1.0")).toBeInTheDocument();
    expect(screen.getByText("v2.0")).toBeInTheDocument();
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
  });

  it("scroll container has overflow-x-hidden to prevent drag-induced layout shift", () => {
    const { container } = renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(container.querySelector(".overflow-x-hidden")).toBeInTheDocument();
  });

  describe("GitHub reconnect", () => {
    function setupErrorWithGithubPlugin() {
      mockedUseIssues.mockReturnValue(
        defaultResult({
          error: new ApiError("GitHub not connected", 401, "NOT_CONNECTED"),
        }),
      );
      mockedUseProjectIntegration.mockReturnValue({
        data: {
          plugin: {
            id: "github-com",
            installed: true,
            status: null,
            manifest: { name: "GitHub.com", configSchema: { properties: {} } },
          },
          effective: { plugin: "github-com" },
          committed: { plugin: "github-com" },
          override: null,
          captionKey: "yaml-only",
        },
      } as unknown as ReturnType<typeof useProjectIntegration>);
    }

    it("renders a Connect button when GitHub is disconnected and the github-com plugin is installed", () => {
      setupErrorWithGithubPlugin();
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.getByRole("button", { name: /connect github/i })).toBeInTheDocument();
    });

    it("clicking Connect opens the project-scoped github-com Configure dialog", async () => {
      setupErrorWithGithubPlugin();
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /connect github/i }));
      const dialog = await screen.findByTestId("plugin-configure-dialog");
      expect(dialog.getAttribute("data-plugin-id")).toBe("github-com");
    });

    it("hides the Connect button when the active integration plugin is not github-com", () => {
      mockedUseIssues.mockReturnValue(
        defaultResult({
          error: new ApiError("GitHub not connected", 401, "NOT_CONNECTED"),
        }),
      );
      mockedUseProjectIntegration.mockReturnValue({
        data: {
          plugin: {
            id: "jira-self-hosted",
            installed: true,
            status: null,
            manifest: { name: "Jira", configSchema: { properties: {} } },
          },
          effective: { plugin: "jira-self-hosted" },
          committed: { plugin: "jira-self-hosted" },
          override: null,
          captionKey: "yaml-only",
        },
      } as unknown as ReturnType<typeof useProjectIntegration>);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.queryByRole("button", { name: /connect github/i })).toBeNull();
    });
  });

  describe("WU-050: opportunistic connection-status re-check on cut-list load", () => {
    it("fires for every enabled plugin and skips disabled ones", () => {
      mockedUsePlugins.mockReturnValue({
        data: {
          hostApiVersion: "1.1.0",
          plugins: [
            { id: "github-com", source: "bundled", status: "enabled" },
            { id: "jira", source: "user", status: "enabled" },
            { id: "ghe", source: "user", status: "disabled" },
            { id: "broken", source: "user", status: "errored" },
          ],
        },
      } as unknown as ReturnType<typeof usePlugins>);

      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );

      expect(mockedRecheck).toHaveBeenCalledWith(["github-com", "jira"]);
    });

    it("passes an empty list while the plugin query is still loading", () => {
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(mockedRecheck).toHaveBeenCalledWith([]);
    });
  });
});
