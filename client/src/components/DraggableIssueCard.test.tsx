// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DraggableIssueCard from "./DraggableIssueCard";
import type { NormalizedIssue } from "@roubo/shared";

const mockUseDraggable = vi.fn((_args?: unknown) => ({
  attributes: {},
  listeners: {},
  setNodeRef: vi.fn(),
  isDragging: false,
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (args: unknown) => mockUseDraggable(args),
}));

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "42",
    externalUrl: "https://github.com/org/repo/issues/42",
    title: "Fix the bug",
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-02T00:00:00Z",
    raw: null,
    ...overrides,
  };
}

describe("DraggableIssueCard", () => {
  it("renders externalId and title", () => {
    render(<DraggableIssueCard issue={makeIssue()} />);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("renders labels", () => {
    render(<DraggableIssueCard issue={makeIssue({ labels: ["bug", "help wanted"] })} />);
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("help wanted")).toBeInTheDocument();
  });

  it("renders the primary assignee's display name", () => {
    render(
      <DraggableIssueCard
        issue={makeIssue({ assignees: [{ externalId: "alice", displayName: "Alice" }] })}
      />,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it('shows "Bench X" badge when assigned', () => {
    render(<DraggableIssueCard issue={makeIssue()} assignedBenchId={3} />);
    expect(screen.getByText("Bench 3")).toBeInTheDocument();
  });

  it("does not show bench badge when not assigned", () => {
    render(<DraggableIssueCard issue={makeIssue()} />);
    expect(screen.queryByText(/bench/i)).not.toBeInTheDocument();
  });

  it("renders the external link button", () => {
    render(<DraggableIssueCard issue={makeIssue()} />);
    expect(screen.getByRole("button", { name: /open 42/i })).toBeInTheDocument();
  });

  it("renders issueType when present", () => {
    render(<DraggableIssueCard issue={makeIssue({ issueType: "Bug" })} />);
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });

  it("renders currentState", () => {
    render(<DraggableIssueCard issue={makeIssue({ currentState: "in-review" })} />);
    expect(screen.getByText("in-review")).toBeInTheDocument();
  });

  it('renders "Blocked by" label when issue is blocked', () => {
    render(<DraggableIssueCard issue={makeIssue({ blockedBy: ["org/repo#10"] })} />);
    expect(screen.getByText(/blocked by/i)).toBeInTheDocument();
    expect(screen.getByText(/org\/repo#10/)).toBeInTheDocument();
  });

  it("collapses to a red Status chip labelled 'Blocked' when blocked", () => {
    const { container } = render(
      <DraggableIssueCard issue={makeIssue({ blockedBy: ["org/repo#10"] })} />,
    );
    const statusChip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
    expect(statusChip).not.toBeNull();
    expect(statusChip.textContent).toContain("Blocked");
    expect(statusChip.className).toMatch(/red-/);
    expect(statusChip.className).toContain("rounded-full");
  });

  it("renders the issue-type chip in violet with leading icon", () => {
    const { container } = render(<DraggableIssueCard issue={makeIssue({ issueType: "bug" })} />);
    const typeChip = container.querySelector('[data-chip-category="issue-type"]') as HTMLElement;
    expect(typeChip).not.toBeNull();
    expect(typeChip.className).toMatch(/violet-/);
    expect(typeChip.querySelector("svg")).not.toBeNull();
  });

  it("renders CodeQL and Dependabot issue-types with their distinguishing icons (TC-136)", () => {
    const { container: codeqlContainer } = render(
      <DraggableIssueCard issue={makeIssue({ issueType: "CodeQL" })} />,
    );
    const codeqlChip = codeqlContainer.querySelector(
      '[data-chip-category="issue-type"]',
    ) as HTMLElement;
    expect(codeqlChip.querySelector("svg")).not.toBeNull();
    expect(codeqlChip.className).toMatch(/violet-/);

    const { container: depContainer } = render(
      <DraggableIssueCard issue={makeIssue({ issueType: "dependabot" })} />,
    );
    const depChip = depContainer.querySelector('[data-chip-category="issue-type"]') as HTMLElement;
    expect(depChip.querySelector("svg")).not.toBeNull();
    expect(depChip.className).toMatch(/violet-/);
  });

  it("renders labels as cyan border-only chips with rounded-sm shape", () => {
    const { container } = render(<DraggableIssueCard issue={makeIssue({ labels: ["bug"] })} />);
    const labelChip = container.querySelector('[data-chip-category="label"]') as HTMLElement;
    expect(labelChip).not.toBeNull();
    expect(labelChip.className).toContain("rounded-sm");
    expect(labelChip.className).toMatch(/border-cyan/);
  });

  it("truncates to <=6 chips and renders a +N more chip when row overflows", () => {
    const { container, getByText } = render(
      <DraggableIssueCard
        issue={makeIssue({
          issueType: "bug",
          labels: ["a", "b", "c", "d", "e", "f", "g", "h"],
        })}
      />,
    );
    const chips = container.querySelectorAll("[data-chip-category]");
    expect(chips.length).toBeLessThanOrEqual(6);
    expect(getByText(/^\+\d+ more$/)).toBeInTheDocument();
  });

  it("renders with cursor-not-allowed style when issue is blocked", () => {
    const { container } = render(
      <DraggableIssueCard issue={makeIssue({ blockedBy: ["other#99"] })} />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("cursor-not-allowed");
  });

  it("does not render blocked label when blockedBy is empty", () => {
    render(<DraggableIssueCard issue={makeIssue({ blockedBy: [] })} />);
    expect(screen.queryByText(/blocked by/i)).not.toBeInTheDocument();
  });

  it("calls useDraggable with disabled:true when issue is blocked", () => {
    render(<DraggableIssueCard issue={makeIssue({ blockedBy: ["other#5"] })} />);
    expect(mockUseDraggable).toHaveBeenCalledWith(expect.objectContaining({ disabled: true }));
  });

  it('uses "issue-{externalId}" as drag id when no dragIdSuffix provided', () => {
    render(<DraggableIssueCard issue={makeIssue()} />);
    expect(mockUseDraggable).toHaveBeenCalledWith(expect.objectContaining({ id: "issue-42" }));
  });

  it("appends dragIdSuffix to drag id when provided", () => {
    render(<DraggableIssueCard issue={makeIssue()} dragIdSuffix="backend" />);
    expect(mockUseDraggable).toHaveBeenCalledWith(
      expect.objectContaining({ id: "issue-42-backend" }),
    );
  });

  it('shows "Blocks N issues" when blocks.length > 1', () => {
    render(<DraggableIssueCard issue={makeIssue({ blocks: ["a", "b", "c"] })} />);
    expect(screen.getByText("Blocks 3 issues")).toBeInTheDocument();
  });

  it('shows "Blocks 1 issue" (singular) when blocks has one entry', () => {
    render(<DraggableIssueCard issue={makeIssue({ blocks: ["a"] })} />);
    expect(screen.getByText("Blocks 1 issue")).toBeInTheDocument();
  });

  it("does not show blocking indicator when blocks is empty", () => {
    render(<DraggableIssueCard issue={makeIssue({ blocks: [] })} />);
    expect(screen.queryByText(/blocks/i)).not.toBeInTheDocument();
  });
});
