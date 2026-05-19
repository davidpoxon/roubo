// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockUseDroppable = vi.hoisted(() =>
  vi.fn((_opts: unknown) => ({ isOver: false, setNodeRef: vi.fn() })),
);

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDroppable: mockUseDroppable,
  };
});

import EmptyBenchCard from "./EmptyBenchCard";

describe("EmptyBenchCard", () => {
  it("renders bench position", () => {
    render(<EmptyBenchCard position={2} onCreateBlank={vi.fn()} onPickIssue={vi.fn()} />);
    expect(screen.getByText("Bench 2")).toBeInTheDocument();
  });

  it("renders Available label", () => {
    render(<EmptyBenchCard position={1} onCreateBlank={vi.fn()} onPickIssue={vi.fn()} />);
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("opens popover with both options on click", async () => {
    render(<EmptyBenchCard position={1} onCreateBlank={vi.fn()} onPickIssue={vi.fn()} />);
    await userEvent.click(screen.getByText("Bench 1").closest("button") as HTMLElement);
    expect(screen.getByText("Set up blank bench")).toBeInTheDocument();
    expect(screen.getByText("Pick an issue")).toBeInTheDocument();
  });

  it("calls onCreateBlank when Set up blank bench is pressed", async () => {
    const onCreateBlank = vi.fn();
    render(<EmptyBenchCard position={1} onCreateBlank={onCreateBlank} onPickIssue={vi.fn()} />);
    await userEvent.click(screen.getByText("Bench 1").closest("button") as HTMLElement);
    await userEvent.click(screen.getByText("Set up blank bench"));
    expect(onCreateBlank).toHaveBeenCalledTimes(1);
  });

  it("calls onPickIssue when Pick an issue is pressed", async () => {
    const onPickIssue = vi.fn();
    render(<EmptyBenchCard position={1} onCreateBlank={vi.fn()} onPickIssue={onPickIssue} />);
    await userEvent.click(screen.getByText("Bench 1").closest("button") as HTMLElement);
    await userEvent.click(screen.getByText("Pick an issue"));
    expect(onPickIssue).toHaveBeenCalledTimes(1);
  });

  it("applies drag-over styles when isOver is true", () => {
    mockUseDroppable.mockReturnValueOnce({ isOver: true, setNodeRef: vi.fn() });
    render(<EmptyBenchCard position={1} onCreateBlank={vi.fn()} onPickIssue={vi.fn()} />);
    const button = screen.getByText("Bench 1").closest("button") as HTMLElement;
    expect(button.className).toContain("border-stone-400");
    expect(button.className).toContain("scale-[1.02]");
  });
});
