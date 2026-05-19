// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DraggableIssueCard from "./DraggableIssueCard";
import type { GitHubProjectItem } from "@roubo/shared";

const mockUseDraggable = vi.fn((_args?: unknown) => ({
  attributes: {},
  listeners: {},
  setNodeRef: vi.fn(),
  isDragging: false,
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (args: unknown) => mockUseDraggable(args),
}));

const makeItem = (overrides: Partial<GitHubProjectItem["issue"]> = {}): GitHubProjectItem => ({
  issue: {
    number: 42,
    title: "Fix the bug",
    body: null,
    state: "open",
    labels: [],
    commentsCount: 0,
    htmlUrl: "https://github.com/org/repo/issues/42",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    ...overrides,
  },
});

describe("DraggableIssueCard", () => {
  it("renders issue number and title", () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("renders labels", () => {
    render(<DraggableIssueCard item={makeItem({ labels: ["bug", "help wanted"] })} />);
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("help wanted")).toBeInTheDocument();
  });

  it("renders comment count when > 0", () => {
    render(<DraggableIssueCard item={makeItem({ commentsCount: 5 })} />);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("does not render comment count when 0", () => {
    render(<DraggableIssueCard item={makeItem({ commentsCount: 0 })} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders assignee when present", () => {
    render(<DraggableIssueCard item={makeItem({ assignee: "alice" })} />);
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it('shows "Bench X" badge when assigned', () => {
    render(<DraggableIssueCard item={makeItem()} assignedBenchId={3} />);
    expect(screen.getByText("Bench 3")).toBeInTheDocument();
  });

  it("does not show bench badge when not assigned", () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(screen.queryByText(/bench/i)).not.toBeInTheDocument();
  });

  it("renders the status dot when status is provided", () => {
    const item: GitHubProjectItem = { ...makeItem(), status: "in progress" };
    const { container } = render(<DraggableIssueCard item={item} />);
    const dot = container.querySelector('[title="in progress"]');
    expect(dot).toBeInTheDocument();
  });

  it("renders the external link button", () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(screen.getByRole("button", { name: /open issue #42/i })).toBeInTheDocument();
  });

  it("renders milestone when present", () => {
    render(<DraggableIssueCard item={makeItem({ milestone: "v1.0" })} />);
    expect(screen.getByText("v1.0")).toBeInTheDocument();
  });

  it("renders type when present", () => {
    render(<DraggableIssueCard item={makeItem({ type: "Bug" })} />);
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  it("does not render milestone or type when absent", () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(screen.queryByText("v1.0")).not.toBeInTheDocument();
    expect(screen.queryByText("Bug")).not.toBeInTheDocument();
  });

  it("does not apply a transform style during drag to avoid layout shift", () => {
    mockUseDraggable.mockReturnValueOnce({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      isDragging: true,
    });
    const { container } = render(<DraggableIssueCard item={makeItem()} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.transform).toBe("");
  });

  it('renders "Blocked by" label with blocker numbers when issue is blocked', () => {
    render(
      <DraggableIssueCard item={makeItem({ blockedBy: [{ number: 10, title: "Blocker" }] })} />,
    );
    expect(screen.getByText(/blocked by/i)).toBeInTheDocument();
    expect(screen.getByText("#10")).toBeInTheDocument();
  });

  it("renders multiple blocker links when blocked by several issues", () => {
    render(
      <DraggableIssueCard
        item={makeItem({
          blockedBy: [
            { number: 10, title: "First blocker" },
            { number: 20, title: "Second blocker" },
          ],
        })}
      />,
    );
    expect(screen.getByText("#10")).toBeInTheDocument();
    expect(screen.getByText("#20")).toBeInTheDocument();
  });

  it("renders with cursor-not-allowed style when issue is blocked", () => {
    const { container } = render(
      <DraggableIssueCard item={makeItem({ blockedBy: [{ number: 99, title: "Blocker" }] })} />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("cursor-not-allowed");
  });

  it("does not render blocked label when blockedBy is empty", () => {
    render(<DraggableIssueCard item={makeItem({ blockedBy: [] })} />);
    expect(screen.queryByText(/blocked by/i)).not.toBeInTheDocument();
  });

  it("does not render blocked label when blockedBy is absent", () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(screen.queryByText(/blocked by/i)).not.toBeInTheDocument();
  });

  it("calls useDraggable with disabled:true when issue is blocked", () => {
    render(
      <DraggableIssueCard item={makeItem({ blockedBy: [{ number: 5, title: "Blocker" }] })} />,
    );
    expect(mockUseDraggable).toHaveBeenCalledWith(expect.objectContaining({ disabled: true }));
  });

  it('uses "issue-{number}" as drag id when no dragIdSuffix provided', () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(mockUseDraggable).toHaveBeenCalledWith(expect.objectContaining({ id: "issue-42" }));
  });

  it("appends dragIdSuffix to drag id when provided", () => {
    render(<DraggableIssueCard item={makeItem()} dragIdSuffix="backend" />);
    expect(mockUseDraggable).toHaveBeenCalledWith(
      expect.objectContaining({ id: "issue-42-backend" }),
    );
  });

  it('shows "Blocks N issues" when blockingCount > 1', () => {
    render(<DraggableIssueCard item={makeItem({ blockingCount: 3 })} />);
    expect(screen.getByText("Blocks 3 issues")).toBeInTheDocument();
  });

  it('shows "Blocks 1 issue" (singular) when blockingCount is 1', () => {
    render(<DraggableIssueCard item={makeItem({ blockingCount: 1 })} />);
    expect(screen.getByText("Blocks 1 issue")).toBeInTheDocument();
  });

  it("does not show blocking indicator when blockingCount is 0", () => {
    render(<DraggableIssueCard item={makeItem({ blockingCount: 0 })} />);
    expect(screen.queryByText(/blocks/i)).not.toBeInTheDocument();
  });

  it("does not show blocking indicator when blockingCount is undefined", () => {
    render(<DraggableIssueCard item={makeItem()} />);
    expect(screen.queryByText(/blocks/i)).not.toBeInTheDocument();
  });
});
