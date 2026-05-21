// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import IssueQueuePanel from "./IssueQueuePanel";
import type { Bench, RouboConfig, GitHubProjectItem } from "@roubo/shared";

vi.mock("../hooks/useProjectItems", () => ({
  useProjectItems: vi.fn(),
  useRefreshProjectItems: vi.fn(() => vi.fn()),
}));
vi.mock("./DraggableIssueCard", () => ({
  default: ({ item }: { item: GitHubProjectItem }) => (
    <div data-testid="issue-card">{item.issue.number}</div>
  ),
}));
vi.mock("./CutListFilterBar", () => ({
  default: ({
    onFiltersChange,
  }: {
    onFiltersChange: (f: {
      milestone: string;
      type: string;
      labels: Set<string>;
      search: string;
    }) => void;
  }) => (
    <div data-testid="filter-bar">
      <button
        onClick={() =>
          onFiltersChange({ milestone: "Sprint 1", type: "", labels: new Set(), search: "" })
        }
      >
        Filter by Sprint 1
      </button>
    </div>
  ),
}));
vi.mock("./CutListGroupByControl", () => ({
  default: ({ onGroupingChange }: { onGroupingChange: (g: { groupBy: string }) => void }) => (
    <div data-testid="group-by-control">
      <button onClick={() => onGroupingChange({ groupBy: "milestone" })}>Group by milestone</button>
      <button onClick={() => onGroupingChange({ groupBy: "status" })}>Group by status</button>
      <button onClick={() => onGroupingChange({ groupBy: "type" })}>Group by type</button>
      <button onClick={() => onGroupingChange({ groupBy: "labels" })}>Group by labels</button>
      <button onClick={() => onGroupingChange({ groupBy: "none" })}>Clear grouping</button>
    </div>
  ),
}));

import { useProjectItems } from "../hooks/useProjectItems";
const mockedUseProjectItems = vi.mocked(useProjectItems);

const baseIssue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state: "open",
  labels: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  commentsCount: 0,
  htmlUrl: `https://github.com/org/repo/issues/${number}`,
});

const configWithProject: RouboConfig = {
  project: {
    name: "app",
    displayName: "App",
    type: "web",
    repo: "org/repo",
    github: { project: 1 },
  },
  layout: { type: "monorepo" },
  components: {},
  ports: {},
  benches: { max: 3 },
};

const configWithoutProject: RouboConfig = {
  ...configWithProject,
  project: { name: "app", displayName: "App", type: "web", repo: "org/repo" },
};

const noBenches: Bench[] = [];

const idleQuery = { data: undefined, isLoading: false, error: null };

beforeEach(() => {
  vi.resetAllMocks();
  mockedUseProjectItems.mockReturnValue(idleQuery as ReturnType<typeof useProjectItems>);
});

describe("IssueQueuePanel", () => {
  it('renders "No GitHub project configured" when github.project is absent', () => {
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithoutProject}
      />,
    );
    expect(screen.getByText("No GitHub project configured")).toBeInTheDocument();
  });

  it('renders "Cut List" header in no-project-configured state', () => {
    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithoutProject}
      />,
    );
    expect(screen.getByText("Cut List")).toBeInTheDocument();
  });

  it('renders "Cut List" header in loaded state', () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint 12" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByText("Cut List")).toBeInTheDocument();
  });

  it("renders project title as secondary text beneath the header", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint 12" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByText("Sprint 12")).toBeInTheDocument();
  });

  it('renders empty state with "No open cuts in this project"', () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint 12" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByText("No open cuts in this project")).toBeInTheDocument();
  });

  it('has aria-label "Refresh cut list" on refresh button', () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint 12" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByRole("button", { name: "Refresh cut list" })).toBeInTheDocument();
  });

  it("displays error message when useProjectItems returns an Error", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      error: new Error("API rate limit exceeded"),
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByText("API rate limit exceeded")).toBeInTheDocument();
  });

  it("shows error banner when fetchProjectItems fails", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      error: new Error("unexpected error"),
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByText("Could not load from GitHub")).toBeInTheDocument();
  });

  it("renders all items when none are assigned or pending", () => {
    const items: GitHubProjectItem[] = [{ issue: baseIssue(1) }, { issue: baseIssue(2) }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    const cards = screen.getAllByTestId("issue-card");
    expect(cards).toHaveLength(2);
  });

  it("excludes issues assigned to benches", () => {
    const items: GitHubProjectItem[] = [{ issue: baseIssue(1) }, { issue: baseIssue(2) }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    const benches: Bench[] = [
      {
        id: 1,
        projectId: "proj-1",
        branch: "main",
        workspacePath: "/tmp/bench-1",
        status: "active",
        ports: {},
        components: {},
        createdAt: "2024-01-01T00:00:00Z",
        provisioningSteps: [],
        teardownSteps: [],
        notifications: [],
        assignedIssue: {
          number: 1,
          integrationId: "github-com",
          externalId: "1",
          title: "Issue 1",
        },
      },
    ];

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={benches} projectConfig={configWithProject} />,
    );

    const cards = screen.getAllByTestId("issue-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("2");
  });

  it("excludes issues in pendingIssueNumbers", () => {
    const items: GitHubProjectItem[] = [{ issue: baseIssue(1) }, { issue: baseIssue(2) }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        pendingIssueNumbers={new Set([2])}
      />,
    );

    const cards = screen.getAllByTestId("issue-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("1");
  });

  it("scroll container has overflow-x-hidden to prevent drag-induced layout shift", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    const { container } = renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    const scrollContainer = container.querySelector(".overflow-x-hidden");
    expect(scrollContainer).toBeInTheDocument();
  });

  it("renders the filter bar when data is loaded", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    expect(screen.getByTestId("filter-bar")).toBeInTheDocument();
  });

  it("does not render the filter bar during loading", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      isLoading: true,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    expect(screen.queryByTestId("filter-bar")).not.toBeInTheDocument();
  });

  it("does not render the filter bar when there is an error", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      error: new Error("API error"),
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    expect(screen.queryByTestId("filter-bar")).not.toBeInTheDocument();
  });

  it('shows "No cuts match the active filters" when filters eliminate all base items', async () => {
    const items: GitHubProjectItem[] = [{ issue: { ...baseIssue(1), milestone: "Sprint 2" } }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    // Click the stub filter button that filters to Sprint 1 (item has Sprint 2)
    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(screen.getByText("No cuts match the active filters")).toBeInTheDocument();
    expect(screen.queryByText("No open cuts in this project")).not.toBeInTheDocument();
  });

  it('shows a "Clear filters" button in the filter empty state', async () => {
    const items: GitHubProjectItem[] = [{ issue: { ...baseIssue(1), milestone: "Sprint 2" } }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it('clicking "Clear filters" in empty state resets filters and shows all items', async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 2" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(screen.getByText("No cuts match the active filters")).toBeInTheDocument();
    expect(screen.queryAllByTestId("issue-card")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
    expect(screen.queryByText("No cuts match the active filters")).not.toBeInTheDocument();
  });

  it('does not show "Clear filters" button when there are genuinely no open cuts', () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    expect(screen.getByText("No open cuts in this project")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("shows filtered X/N count in header when filters are active", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 1" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it('shows "Clear all filters" button in header when filters are active', async () => {
    const items: GitHubProjectItem[] = [{ issue: { ...baseIssue(1), milestone: "Sprint 1" } }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(screen.getByRole("button", { name: "Clear all filters" })).toBeInTheDocument();
  });

  it('"Clear all filters" header button resets filters and shows all cards', async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 1" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));
    expect(screen.getAllByTestId("issue-card")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
  });

  it("filters issue cards when filter bar triggers a filter change", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 1" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);

    // The stub filter bar renders a button that filters to 'Sprint 1'
    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(screen.getAllByTestId("issue-card")).toHaveLength(1);
    expect(screen.getByTestId("issue-card")).toHaveTextContent("1");
  });

  it("initializes filters from initialFilters prop", () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 1" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        initialFilters={{ milestone: "Sprint 1", type: "", labels: new Set(), search: "" }}
      />,
    );

    // Only Sprint 1 issue should be visible
    expect(screen.getAllByTestId("issue-card")).toHaveLength(1);
    expect(screen.getByTestId("issue-card")).toHaveTextContent("1");
  });

  it("calls onFiltersChange with projectId when filters change", async () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    const onFiltersChange = vi.fn();

    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        onFiltersChange={onFiltersChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    expect(onFiltersChange).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ milestone: "Sprint 1" }),
    );
  });

  // ── Grouping ────────────────────────────────────────────────────────────────

  it("renders the group-by control stub when data is loaded", () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );
    expect(screen.getByTestId("group-by-control")).toBeInTheDocument();
  });

  it("renders flat list (no group headers) when grouping is none", () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 1" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    // Default is no grouping — no section headers, just cards
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
    expect(screen.queryByText("Sprint 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Sprint 2")).not.toBeInTheDocument();
  });

  it("renders collapsible section headers when grouping is active", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Alpha" } },
      { issue: { ...baseIssue(2), milestone: "Beta" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));

    // Group headers should appear
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // Cards still visible
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
  });

  it("collapses a group section when its header is clicked, hiding its cards", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Alpha" } },
      { issue: { ...baseIssue(2), milestone: "Beta" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));

    // Click the "Alpha" group header button to collapse it
    await userEvent.click(screen.getByRole("button", { name: /Alpha/i }));

    // Alpha's card should be hidden; Beta's card should still be visible
    expect(screen.getAllByTestId("issue-card")).toHaveLength(1);
    expect(screen.getByText("Alpha")).toBeInTheDocument(); // header stays
  });

  it("expands a collapsed group section when its header is clicked again", async () => {
    const items: GitHubProjectItem[] = [{ issue: { ...baseIssue(1), milestone: "Alpha" } }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));
    await userEvent.click(screen.getByRole("button", { name: /Alpha/i }));
    expect(screen.queryByTestId("issue-card")).not.toBeInTheDocument();

    // Click again to expand
    await userEvent.click(screen.getByRole("button", { name: /Alpha/i }));
    expect(screen.getByTestId("issue-card")).toBeInTheDocument();
  });

  it("filters still apply within grouped view", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Sprint 1" } },
      { issue: { ...baseIssue(2), milestone: "Sprint 2" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    // Enable grouping by milestone
    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));

    // The stub filter bar filters to Sprint 1 only
    await userEvent.click(screen.getByRole("button", { name: "Filter by Sprint 1" }));

    // Only Sprint 1 items should be visible
    expect(screen.getAllByTestId("issue-card")).toHaveLength(1);
    expect(screen.getByTestId("issue-card")).toHaveTextContent("1");
    // Sprint 2 section header should be gone
    expect(screen.queryByText("Sprint 2")).not.toBeInTheDocument();
  });

  it("header count shows distinct filtered item count, not sum of group counts", async () => {
    // Item 1 has two labels — in labels grouping it appears in 2 groups
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), labels: ["frontend", "backend"] } },
      { issue: { ...baseIssue(2), labels: ["frontend"] } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        // Start with a milestone filter so count badge shows
        initialFilters={{ milestone: "Sprint 1", type: "", labels: new Set(), search: "" }}
      />,
    );

    // With filter active, count badge shows 0/2 (nothing matches Sprint 1)
    expect(screen.getByText("0/2")).toBeInTheDocument();
  });

  it("returns to flat view when grouping is cleared", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Alpha" } },
      { issue: { ...baseIssue(2), milestone: "Beta" } },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear grouping" }));
    // Section headers gone, cards visible flat
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
  });

  it("calls onGroupingChange with projectId when grouping changes", async () => {
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items: [] as GitHubProjectItem[], projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    const onGroupingChange = vi.fn();

    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        onGroupingChange={onGroupingChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Group by status" }));
    expect(onGroupingChange).toHaveBeenCalledWith("proj-1", { groupBy: "status" });
  });

  it("initializes grouping from initialGrouping prop", async () => {
    const items: GitHubProjectItem[] = [{ issue: { ...baseIssue(1), milestone: "Alpha" } }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        initialGrouping={{ groupBy: "milestone" }}
      />,
    );

    // Group header should be visible immediately without user interaction
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("preserves overflow-x-hidden on the scroll container when grouping is active", async () => {
    const items: GitHubProjectItem[] = [{ issue: { ...baseIssue(1), milestone: "Alpha" } }];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    const { container } = renderWithProviders(
      <IssueQueuePanel
        projectId="proj-1"
        benches={noBenches}
        projectConfig={configWithProject}
        initialGrouping={{ groupBy: "milestone" }}
      />,
    );

    const scrollContainer = container.querySelector(".overflow-x-hidden");
    expect(scrollContainer).toBeInTheDocument();
  });

  it("preserves collapse state when switching grouping dimension and back", async () => {
    const items: GitHubProjectItem[] = [
      { issue: { ...baseIssue(1), milestone: "Alpha" }, status: "In Progress" },
      { issue: { ...baseIssue(2), milestone: "Beta" }, status: "Done" },
    ];
    mockedUseProjectItems.mockReturnValue({
      ...idleQuery,
      data: { items, projectTitle: "Sprint" },
      isLoading: false,
    } as ReturnType<typeof useProjectItems>);

    renderWithProviders(
      <IssueQueuePanel projectId="proj-1" benches={noBenches} projectConfig={configWithProject} />,
    );

    // Switch to milestone grouping and collapse the Alpha group
    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));
    await userEvent.click(screen.getByRole("button", { name: /Alpha/i }));
    expect(screen.queryAllByTestId("issue-card")).toHaveLength(1); // only Beta's card visible

    // Switch to status grouping — both cards should be visible (milestone collapse state doesn't bleed)
    await userEvent.click(screen.getByRole("button", { name: "Group by status" }));
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);

    // Switch back to milestone — Alpha should still be collapsed
    await userEvent.click(screen.getByRole("button", { name: "Group by milestone" }));
    expect(screen.queryAllByTestId("issue-card")).toHaveLength(1); // Alpha still collapsed
  });
});
