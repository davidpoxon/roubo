// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
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
    onFiltersChange: (f: { search: string; facetValues: Record<string, Set<string>> }) => void;
  }) => (
    <div data-testid="filter-bar">
      <button
        onClick={() =>
          onFiltersChange({
            search: "",
            facetValues: { type: new Set(["Bug"]) },
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

import { useIssues, useRefreshIssues } from "../hooks/useIssues";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { usePlugins, useOpportunisticRecheckOnMount } from "../hooks/usePlugins";
import { usePrefetchFacetOptions } from "../hooks/useCutListFacets";
const mockedUseIssues = vi.mocked(useIssues);
const mockedUseRefreshIssues = vi.mocked(useRefreshIssues);
const mockedUseProjectIntegration = vi.mocked(useProjectIntegration);
const mockedUsePlugins = vi.mocked(usePlugins);
const mockedRecheck = vi.mocked(useOpportunisticRecheckOnMount);
const mockedPrefetch = vi.mocked(usePrefetchFacetOptions);

function defaultResult(overrides: Partial<ReturnType<typeof useIssues>> = {}) {
  return {
    issues: [] as NormalizedIssue[],
    isLoading: false,
    nextCursor: null,
    error: null,
    stalled: false,
    stale: false,
    snapshotCapturedAt: null,
    excludedCount: 0,
    isRefetching: false,
    dataUpdatedAt: 0,
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
  mockedUseRefreshIssues.mockReturnValue(vi.fn());
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

  it("shows the excluded-count note when issues were filtered out in-query (#358)", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ excludedCount: 3 }));
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.getByTestId("excluded-count-note")).toHaveTextContent("3 filtered out by status");
  });

  it("hides the excluded-count note when nothing was filtered out (#358)", () => {
    mockedUseIssues.mockReturnValue(defaultResult({ excludedCount: 0 }));
    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
    );
    expect(screen.queryByTestId("excluded-count-note")).toBeNull();
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

  describe("FR-007/FR-008: Prev/Next pagination", () => {
    // Drive the mocked useIssues from the cursor argument the panel passes as its
    // 4th positional arg, simulating a forward-only paged plugin. page1 -> "c1"
    // -> "c2" (last). Each page renders one identifying card.
    type Page = { items: NormalizedIssue[]; nextCursor: string | null };
    function pagedByCursor(pages: Record<string, Page>) {
      mockedUseIssues.mockImplementation((_projectId, _filters, _pageSize, cursor) => {
        const page = pages[cursor ?? "page1"];
        return defaultResult({
          issues: page.items,
          nextCursor: page.nextCursor,
        }) as ReturnType<typeof useIssues>;
      });
    }

    const threePages: Record<string, Page> = {
      page1: { items: [makeIssue("a1")], nextCursor: "c1" },
      c1: { items: [makeIssue("b1")], nextCursor: "c2" },
      c2: { items: [makeIssue("c1card")], nextCursor: null },
    };

    it("Next advances to page 2 and the indicator updates (TC-022)", async () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 1");
      expect(screen.getByText("a1")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Next page" }));

      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 2");
      expect(screen.getByText("b1")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
    });

    it("Prev is disabled on page 1 (TC-023)", () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 1");
    });

    it("Prev returns to the prior page via the retained cursor (TC-024)", async () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 3");
      expect(screen.getByText("c1card")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 2");
      expect(screen.getByText("b1")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 1");
      expect(screen.getByText("a1")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    });

    it("Next is disabled on the last page (TC-025)", async () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 3");
      expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    });

    it("changing the filter resets to page 1 and discards cursor history (TC-026)", async () => {
      // page 1 carries one Bug and one Feature so the filter leaves a result.
      mockedUseIssues.mockImplementation(
        (_projectId, _filters, _pageSize, cursor) =>
          defaultResult(
            cursor
              ? { issues: [makeIssue("b1", { issueType: "Bug" })], nextCursor: "c2" }
              : {
                  issues: [
                    makeIssue("a1", { issueType: "Bug" }),
                    makeIssue("a2", { issueType: "Feature" }),
                  ],
                  nextCursor: "c1",
                },
          ) as ReturnType<typeof useIssues>,
      );
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 2");

      await userEvent.click(screen.getByRole("button", { name: "Filter by Bug" }));

      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 1");
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    });

    it("hides the pager when the result set is empty (TC-027)", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ issues: [], nextCursor: null }));
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.queryByTestId("cut-list-pager")).toBeNull();
    });

    it("pager controls are keyboard operable (Enter advances) (TC-029)", async () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      const next = screen.getByRole("button", { name: "Next page" });
      act(() => {
        next.focus();
      });
      expect(next).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("Page 2");
    });

    it("announces the new page via the polite live region (TC-030)", async () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      const live = screen.getByTestId("cut-list-page-live");
      expect(live).toHaveAttribute("aria-live", "polite");

      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(live).toHaveTextContent("Page 2");

      await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(live).toHaveTextContent("Page 1");
    });

    it("does not render an infinite-scroll sentinel (TC-031)", () => {
      pagedByCursor(threePages);
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.queryByTestId("queue-load-more-sentinel")).toBeNull();
      expect(screen.getByTestId("cut-list-pager")).toBeInTheDocument();
    });

    it("the page indicator shows the current page's item count", () => {
      mockedUseIssues.mockReturnValue(
        defaultResult({ issues: [makeIssue("1"), makeIssue("2"), makeIssue("3")] }),
      );
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.getByTestId("cut-list-page-indicator")).toHaveTextContent("3 items");
    });

    it("keeps the pager (Next reachable) when the page is filtered empty but more pages exist", async () => {
      // The page holds only a Feature issue; filtering by Bug empties the
      // client-filtered list while nextCursor stays non-null. The pager must
      // remain so Next can reach the following page (it must not be tied to the
      // filtered count, which would strand the user on a non-last page).
      mockedUseIssues.mockReturnValue(
        defaultResult({ issues: [makeIssue("a1", { issueType: "Feature" })], nextCursor: "c1" }),
      );
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Filter by Bug" }));

      expect(screen.getByText("No cuts match the active filters")).toBeInTheDocument();
      expect(screen.getByTestId("cut-list-pager")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    });

    it("hides the pager only when there are no items and no other page", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ issues: [], nextCursor: null }));
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      expect(screen.queryByTestId("cut-list-pager")).toBeNull();
    });

    it("announces the jump back to page 1 when an input change resets paging (NFR-007)", async () => {
      mockedUseIssues.mockImplementation((_projectId, _filters, _pageSize, cursor) => {
        const page = threePages[cursor ?? "page1"];
        return defaultResult({
          issues: page.items,
          nextCursor: page.nextCursor,
        }) as ReturnType<typeof useIssues>;
      });
      renderWithProviders(
        <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      const live = screen.getByTestId("cut-list-page-live");
      expect(live).toHaveTextContent("Page 2");

      await userEvent.click(screen.getByRole("button", { name: "Filter by Bug" }));
      expect(live).toHaveTextContent("Page 1");
    });
  });

  describe("refresh feedback (issue #557)", () => {
    function renderPanel() {
      return renderWithProviders(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
    }

    it("spins the refresh icon and disables the control while refetching (CLI-TC-015)", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ isRefetching: true }));
      renderPanel();

      const button = screen.getByRole("button", { name: "Refresh cut list" });
      expect(button).toBeDisabled();
      // The icon spins while a refresh is in flight.
      expect(button.querySelector(".animate-spin")).not.toBeNull();
      // The indicator reads "refreshing...", not a stale timestamp.
      expect(screen.getByTestId("cut-list-last-updated")).toHaveTextContent("refreshing...");
    });

    it("does not spin and is enabled in the settled state (CLI-TC-016)", () => {
      mockedUseIssues.mockReturnValue(
        defaultResult({ isRefetching: false, dataUpdatedAt: Date.now() }),
      );
      renderPanel();

      const button = screen.getByRole("button", { name: "Refresh cut list" });
      expect(button).not.toBeDisabled();
      expect(button.querySelector(".animate-spin")).toBeNull();
      expect(screen.getByTestId("cut-list-last-updated")).toHaveTextContent("updated just now");
    });

    it("shows a relative last-updated timestamp from dataUpdatedAt (CLI-TC-016)", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ dataUpdatedAt: Date.now() - 2 * 60_000 }));
      renderPanel();

      const indicator = screen.getByTestId("cut-list-last-updated");
      expect(indicator).toHaveTextContent("updated 2m ago");
      expect(indicator).toHaveAttribute("data-state", "fresh");
    });

    it("advances the last-updated indicator as dataUpdatedAt moves forward (CLI-TC-021)", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ dataUpdatedAt: Date.now() - 5 * 60_000 }));
      const { rerender } = renderPanel();
      expect(screen.getByTestId("cut-list-last-updated")).toHaveTextContent("updated 5m ago");

      // A successful refresh advances dataUpdatedAt; the indicator moves forward
      // (more recent), never backward.
      mockedUseIssues.mockReturnValue(defaultResult({ dataUpdatedAt: Date.now() }));
      rerender(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId("cut-list-last-updated")).toHaveTextContent("updated just now");
    });

    it("renders the stale snapshot indicator distinctly from the warm state (CLI-TC-018)", () => {
      mockedUseProjectIntegration.mockReturnValue(integrationWithPlugin());
      mockedUseIssues.mockReturnValue(
        defaultResult({
          stale: true,
          snapshotCapturedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
        }),
      );
      renderPanel();

      const indicator = screen.getByTestId("cut-list-last-updated");
      // Distinct wording ("snapshot N ago", not "updated N ago") ...
      expect(indicator).toHaveTextContent("snapshot 14m ago");
      expect(indicator).not.toHaveTextContent("updated");
      // ... and a distinct state marker driving the distinct colour.
      expect(indicator).toHaveAttribute("data-state", "stale");
      // The stale banner is shown alongside it.
      expect(screen.getByTestId("stale-snapshot-banner")).toBeInTheDocument();
    });

    it("announces refresh start and completion via a polite live region (CLI-TC-020)", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ isRefetching: false }));
      const { rerender } = renderPanel();

      const liveRegion = screen.getByTestId("cut-list-refresh-status");
      expect(liveRegion).toHaveAttribute("aria-live", "polite");
      expect(liveRegion).toHaveTextContent("");

      // Refetch begins.
      mockedUseIssues.mockReturnValue(defaultResult({ isRefetching: true }));
      rerender(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId("cut-list-refresh-status")).toHaveTextContent(
        "Refreshing cut list",
      );

      // Refetch completes.
      mockedUseIssues.mockReturnValue(
        defaultResult({ isRefetching: false, dataUpdatedAt: Date.now() }),
      );
      rerender(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId("cut-list-refresh-status")).toHaveTextContent("Cut list updated");
    });

    it("announces a failure, not success, when a refetch errors (CLI-TC-020)", () => {
      mockedUseIssues.mockReturnValue(defaultResult({ isRefetching: false }));
      const { rerender } = renderPanel();

      // Refetch begins.
      mockedUseIssues.mockReturnValue(defaultResult({ isRefetching: true }));
      rerender(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId("cut-list-refresh-status")).toHaveTextContent(
        "Refreshing cut list",
      );

      // Refetch settles with an error (isRefetching clears to false the same way
      // a success does); the announcement must not claim the cut list updated.
      mockedUseIssues.mockReturnValue(
        defaultResult({ isRefetching: false, error: new Error("network down") }),
      );
      rerender(
        <MemoryRouter>
          <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={config} />
        </MemoryRouter>,
      );
      const liveRegion = screen.getByTestId("cut-list-refresh-status");
      expect(liveRegion).toHaveTextContent("Cut list refresh failed");
      expect(liveRegion).not.toHaveTextContent("Cut list updated");
    });

    it("keeps the refresh control keyboard-operable and labelled (CLI-TC-020)", async () => {
      const user = userEvent.setup();
      const refreshFn = vi.fn();
      mockedUseRefreshIssues.mockReturnValue(refreshFn);
      renderPanel();

      const button = screen.getByRole("button", { name: "Refresh cut list" });
      // The label is exposed to assistive tech regardless of state.
      expect(button).toHaveAttribute("aria-label", "Refresh cut list");
      // The control is operable from the keyboard: focus it via Tab order, then
      // activate with Enter.
      await user.tab();
      await user.keyboard("{Enter}");
      expect(button).toHaveFocus();
      expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    it("does not start a second refresh while one is in progress (CLI-TC-019)", async () => {
      const user = userEvent.setup();
      const refreshFn = vi.fn();
      mockedUseRefreshIssues.mockReturnValue(refreshFn);
      mockedUseIssues.mockReturnValue(defaultResult({ isRefetching: true }));
      renderPanel();

      const button = screen.getByRole("button", { name: "Refresh cut list" });
      expect(button).toBeDisabled();
      await user.click(button);
      expect(refreshFn).not.toHaveBeenCalled();
    });
  });
});
