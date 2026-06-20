// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import IssuePickerModal from "./IssuePickerModal";
import type { Bench, NormalizedIssue } from "@roubo/shared";

vi.mock("../hooks/useIssues");
import { useIssues } from "../hooks/useIssues";

const mockUseIssues = vi.mocked(useIssues);

function defaultResult(overrides: Partial<ReturnType<typeof useIssues>> = {}) {
  return {
    issues: [],
    isLoading: false,
    nextCursor: null,
    error: null,
    stalled: false,
    stale: false,
    snapshotCapturedAt: null,
    excludedCount: 0,
    isRefetching: false,
    dataUpdatedAt: 0,
    cacheStatus: null,
    ...overrides,
  };
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

beforeEach(() => {
  vi.resetAllMocks();
});

describe("IssuePickerModal", () => {
  it("does not render when closed", () => {
    mockUseIssues.mockReturnValue(defaultResult());
    render(
      <IssuePickerModal
        isOpen={false}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        benches={[]}
      />,
    );
    expect(screen.queryByRole("heading", { name: /pick an issue/i })).not.toBeInTheDocument();
  });

  it("renders the dialog when open", () => {
    mockUseIssues.mockReturnValue(defaultResult({ isLoading: true }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.getByRole("heading", { name: /pick an issue/i })).toBeInTheDocument();
  });

  it("shows loading spinner while fetching", () => {
    mockUseIssues.mockReturnValue(defaultResult({ isLoading: true }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders an issue list backed by useIssues", () => {
    const issues = [makeIssue("1", { title: "Fix bug" }), makeIssue("2", { title: "Add feature" })];
    mockUseIssues.mockReturnValue(defaultResult({ issues }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.getByText("Fix bug")).toBeInTheDocument();
    expect(screen.getByText("Add feature")).toBeInTheDocument();
  });

  it("calls onSelect with the externalId when a github-style row is clicked", async () => {
    const onSelect = vi.fn();
    mockUseIssues.mockReturnValue(
      defaultResult({ issues: [makeIssue("org/repo#5", { title: "My issue" })] }),
    );
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={onSelect} projectId="p1" benches={[]} />,
    );
    await userEvent.click(screen.getByText("My issue"));
    expect(onSelect).toHaveBeenCalledWith("org/repo#5", "My issue");
  });

  it("calls onSelect with the externalId when a Jira-key row is clicked", async () => {
    const onSelect = vi.fn();
    mockUseIssues.mockReturnValue(
      defaultResult({
        issues: [
          makeIssue("PLNRPTGOOG-3782", { title: "Jira issue", integrationId: "jira-self-hosted" }),
        ],
      }),
    );
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={onSelect} projectId="p1" benches={[]} />,
    );
    await userEvent.click(screen.getByText("Jira issue"));
    expect(onSelect).toHaveBeenCalledWith("PLNRPTGOOG-3782", "Jira issue");
  });

  it("filters out issues already assigned to benches (by externalId)", () => {
    const issues = [
      makeIssue("1", { title: "Assigned issue" }),
      makeIssue("2", { title: "Free issue" }),
    ];
    const bench: Bench = {
      id: 1,
      projectId: "p1",
      branch: "main",
      assignedIssue: {
        number: 1,
        externalId: "1",
        title: "Assigned issue",
        integrationId: "github-com",
      },
    } as unknown as Bench;
    mockUseIssues.mockReturnValue(defaultResult({ issues }));
    render(
      <IssuePickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        projectId="p1"
        benches={[bench]}
      />,
    );
    expect(screen.queryByText("Assigned issue")).not.toBeInTheDocument();
    expect(screen.getByText("Free issue")).toBeInTheDocument();
  });

  it('shows "No open issues" when the issue list is empty', () => {
    mockUseIssues.mockReturnValue(defaultResult());
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.getByText(/no open issues/i)).toBeInTheDocument();
  });

  it("renders issueType and currentState when present", () => {
    const issue = makeIssue("10", {
      title: "Issue with metadata",
      issueType: "Feature",
      currentState: "in-progress",
    });
    mockUseIssues.mockReturnValue(defaultResult({ issues: [issue] }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText("in-progress")).toBeInTheDocument();
  });

  it("shows the blocked banner when blockedBy is non-empty", () => {
    const issue = makeIssue("7", { title: "Blocked issue", blockedBy: ["org/repo#3"] });
    mockUseIssues.mockReturnValue(defaultResult({ issues: [issue] }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    const banner = screen.getByTestId("blocked-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/blocked by/i);
    expect(banner).toHaveTextContent("org/repo#3");
  });

  it("calls onSelect when a blocked issue row is clicked (soft-block, TC-034)", async () => {
    const onSelect = vi.fn();
    const issue = makeIssue("200", {
      title: "Add billing dashboard",
      blockedBy: ["org/repo#100"],
    });
    mockUseIssues.mockReturnValue(defaultResult({ issues: [issue] }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={onSelect} projectId="p1" benches={[]} />,
    );
    expect(screen.getByTestId("blocked-banner")).toHaveTextContent("org/repo#100");
    await userEvent.click(screen.getByText("Add billing dashboard"));
    expect(onSelect).toHaveBeenCalledWith("200", "Add billing dashboard");
  });

  it("renders the security-category chip inline-left of the title for alert issues (WU-033)", () => {
    const issue = makeIssue("org/repo#code-scanning-7", {
      title: "SQL injection in handler",
      issueType: "security-code-scanning",
    });
    mockUseIssues.mockReturnValue(defaultResult({ issues: [issue] }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    const chip = screen.getByTestId("security-category-chip");
    expect(chip.className).toMatch(/slate-/);
    expect(chip.textContent).toContain("CodeQL");
    // Raw issueType pill in the metadata row is suppressed for security rows.
    expect(screen.queryByText("security-code-scanning")).not.toBeInTheDocument();
  });

  it("does not render a security-category chip for regular issueTypes (WU-033)", () => {
    const issue = makeIssue("11", { title: "Plain bug", issueType: "bug" });
    mockUseIssues.mockReturnValue(defaultResult({ issues: [issue] }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.queryByTestId("security-category-chip")).not.toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
  });

  it("surfaces the stalled note when useIssues reports stalled (TC-071)", () => {
    mockUseIssues.mockReturnValue(defaultResult({ stalled: true }));
    render(
      <IssuePickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} projectId="p1" benches={[]} />,
    );
    expect(screen.getByTestId("stalled-note")).toHaveTextContent(/plugin paging appears stuck/i);
  });

  describe("FR-007/FR-008: Prev/Next pagination", () => {
    // Drive the mocked useIssues from the cursor the modal passes as its 4th
    // positional arg, simulating a forward-only paged plugin.
    type Page = { items: NormalizedIssue[]; nextCursor: string | null };
    function pagedByCursor(pages: Record<string, Page>) {
      mockUseIssues.mockImplementation((_projectId, _filters, _pageSize, cursor) => {
        const page = pages[cursor ?? "page1"];
        return defaultResult({
          issues: page.items,
          nextCursor: page.nextCursor,
        }) as ReturnType<typeof useIssues>;
      });
    }

    const twoPages: Record<string, Page> = {
      page1: { items: [makeIssue("a1", { title: "Alpha" })], nextCursor: "c1" },
      c1: { items: [makeIssue("b1", { title: "Bravo" })], nextCursor: null },
    };

    it("Next advances; Prev disabled on page 1, Next disabled on the last page", async () => {
      pagedByCursor(twoPages);
      render(
        <IssuePickerModal
          isOpen
          onClose={vi.fn()}
          onSelect={vi.fn()}
          projectId="p1"
          benches={[]}
        />,
      );
      expect(screen.getByTestId("picker-page-indicator")).toHaveTextContent("Page 1");
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByTestId("picker-page-indicator")).toHaveTextContent("Page 2");
      expect(screen.getByText("Bravo")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
    });

    it("Prev replays the retained cursor back to the prior page", async () => {
      pagedByCursor(twoPages);
      render(
        <IssuePickerModal
          isOpen
          onClose={vi.fn()}
          onSelect={vi.fn()}
          projectId="p1"
          benches={[]}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByTestId("picker-page-indicator")).toHaveTextContent("Page 2");

      await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(screen.getByTestId("picker-page-indicator")).toHaveTextContent("Page 1");
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    });

    it("announces the new page via the polite live region (NFR-007)", async () => {
      pagedByCursor(twoPages);
      render(
        <IssuePickerModal
          isOpen
          onClose={vi.fn()}
          onSelect={vi.fn()}
          projectId="p1"
          benches={[]}
        />,
      );
      const live = screen.getByTestId("picker-page-live");
      expect(live).toHaveAttribute("aria-live", "polite");

      await userEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(live).toHaveTextContent("Page 2");
    });

    it("keeps the pager (Next reachable) when the page is all assigned but more pages exist", () => {
      // The only issue on this page is assigned to a bench, so items is empty,
      // but nextCursor stays non-null: the pager must remain so Next can reach
      // the following page rather than stranding the user on a non-last page.
      mockUseIssues.mockReturnValue(
        defaultResult({ issues: [makeIssue("1", { title: "Assigned" })], nextCursor: "c1" }),
      );
      const bench: Bench = {
        id: 1,
        projectId: "p1",
        branch: "main",
        assignedIssue: {
          number: 1,
          externalId: "1",
          title: "Assigned",
          integrationId: "github-com",
        },
      } as unknown as Bench;
      render(
        <IssuePickerModal
          isOpen
          onClose={vi.fn()}
          onSelect={vi.fn()}
          projectId="p1"
          benches={[bench]}
        />,
      );
      expect(screen.getByText(/no open issues/i)).toBeInTheDocument();
      expect(screen.getByTestId("picker-pager")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    });

    it("hides the pager when there are no items and no other page", () => {
      mockUseIssues.mockReturnValue(defaultResult({ issues: [], nextCursor: null }));
      render(
        <IssuePickerModal
          isOpen
          onClose={vi.fn()}
          onSelect={vi.fn()}
          projectId="p1"
          benches={[]}
        />,
      );
      expect(screen.queryByTestId("picker-pager")).toBeNull();
    });
  });
});
