// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import IssuePickerModal from "./IssuePickerModal";
import type { RouboConfig, Bench, GitHubProjectItem } from "@roubo/shared";

vi.mock("../hooks/useProjectItems");
import { useProjectItems } from "../hooks/useProjectItems";

const mockUseProjectItems = vi.mocked(useProjectItems);

const projectConfig: RouboConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
    type: "web",
    repo: "org/repo",
    github: { project: 42 },
  },
  layout: { type: "single-repo" },
  components: {},
  benches: { max: 3 },
  ports: {},
} as unknown as RouboConfig;

const makeItem = (number: number, title: string): GitHubProjectItem => ({
  issue: {
    number,
    title,
    body: null,
    state: "open",
    labels: [],
    commentsCount: 0,
    htmlUrl: `https://github.com/org/repo/issues/${number}`,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    assignee: undefined,
  },
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("IssuePickerModal", () => {
  it("does not render when closed", () => {
    mockUseProjectItems.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen={false}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.queryByRole("heading", { name: /pick an issue/i })).not.toBeInTheDocument();
  });

  it("renders the dialog when open", () => {
    mockUseProjectItems.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.getByRole("heading", { name: /pick an issue/i })).toBeInTheDocument();
  });

  it("shows loading spinner while fetching", () => {
    mockUseProjectItems.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it('shows "No GitHub project configured" when no project number', () => {
    const configNoProject = {
      ...projectConfig,
      project: { ...projectConfig.project, github: undefined },
    };
    mockUseProjectItems.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={configNoProject as RouboConfig}
        benches={[]}
      />,
    );
    expect(screen.getByText(/no github project configured/i)).toBeInTheDocument();
  });

  it("renders issue list", () => {
    const items = [makeItem(1, "Fix bug"), makeItem(2, "Add feature")];
    mockUseProjectItems.mockReturnValue({
      data: { items },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.getByText("Fix bug")).toBeInTheDocument();
    expect(screen.getByText("Add feature")).toBeInTheDocument();
  });

  it("calls onSelect when an issue is clicked", async () => {
    const onSelect = vi.fn();
    const items = [makeItem(5, "My issue")];
    mockUseProjectItems.mockReturnValue({
      data: { items },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    await userEvent.click(screen.getByText("My issue"));
    expect(onSelect).toHaveBeenCalledWith(5, "My issue");
  });

  it("filters out issues already assigned to benches", () => {
    const items = [makeItem(1, "Assigned issue"), makeItem(2, "Free issue")];
    const bench: Bench = {
      id: 1,
      projectId: "p1",
      branch: "main",
      assignedIssue: { number: 1, title: "Assigned issue" },
    } as unknown as Bench;
    mockUseProjectItems.mockReturnValue({
      data: { items },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[bench]}
      />,
    );
    expect(screen.queryByText("Assigned issue")).not.toBeInTheDocument();
    expect(screen.getByText("Free issue")).toBeInTheDocument();
  });

  it('shows "No open issues" when items is empty', () => {
    mockUseProjectItems.mockReturnValue({
      data: { items: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.getByText(/no open issues/i)).toBeInTheDocument();
  });

  it("renders milestone and type when present", () => {
    const item: GitHubProjectItem = {
      ...makeItem(10, "Issue with metadata"),
      issue: { ...makeItem(10, "Issue with metadata").issue, milestone: "v2.0", type: "Feature" },
    };
    mockUseProjectItems.mockReturnValue({
      data: { items: [item] },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.getByText("v2.0")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
  });

  it("renders an amber 'Blocked by' banner with a link to the blocker for blocked issues", () => {
    const item: GitHubProjectItem = {
      ...makeItem(7, "Blocked issue"),
      issue: {
        ...makeItem(7, "Blocked issue").issue,
        blockedBy: [{ number: 3, title: "Blocker" }],
      },
    };
    mockUseProjectItems.mockReturnValue({
      data: { items: [item] },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    const banner = screen.getByTestId("blocked-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.className).toMatch(/amber/);
    expect(banner).toHaveTextContent(/blocked by/i);
    expect(screen.getByRole("link", { name: "#3" })).toBeInTheDocument();
  });

  it("calls onSelect when a blocked issue row is clicked (soft-block, TC-034)", async () => {
    const onSelect = vi.fn();
    const item: GitHubProjectItem = {
      ...makeItem(200, "Add billing dashboard"),
      issue: {
        ...makeItem(200, "Add billing dashboard").issue,
        blockedBy: [{ number: 100, title: "Set up Stripe" }],
      },
    };
    mockUseProjectItems.mockReturnValue({
      data: { items: [item] },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    // Banner names the open blocker.
    expect(screen.getByTestId("blocked-banner")).toHaveTextContent("#100");
    // Row remains interactive: clicking the title fires onSelect.
    await userEvent.click(screen.getByRole("button", { name: /add billing dashboard/i }));
    expect(onSelect).toHaveBeenCalledWith(200, "Add billing dashboard");
  });

  it("renders issues normally when blockedBy is absent (enforcement disabled)", () => {
    const onSelect = vi.fn();
    const items = [makeItem(1, "Normal issue")];
    mockUseProjectItems.mockReturnValue({
      data: { items },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectItems>);
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        projectId="p1"
        projectConfig={projectConfig}
        benches={[]}
      />,
    );
    expect(screen.queryByText(/blocked by/i)).not.toBeInTheDocument();
    // The issue row should be an interactive button
    expect(screen.getByRole("button", { name: /normal issue/i })).toBeInTheDocument();
  });
});
