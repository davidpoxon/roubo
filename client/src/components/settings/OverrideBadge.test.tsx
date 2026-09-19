// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverrideBadge } from "./OverrideBadge";

describe("OverrideBadge", () => {
  it("renders the visible Override label", () => {
    render(<OverrideBadge />);
    expect(screen.getByText("Override")).toBeInTheDocument();
  });

  it("renders the sr-only accessible label", () => {
    render(<OverrideBadge />);
    expect(screen.getByText(/Project override active/)).toBeInTheDocument();
  });

  it("applies amber token classes to the chip container", () => {
    const { container } = render(<OverrideBadge />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.className).toContain("bg-accent-muted");
    expect(chip.className).toContain("text-accent-text");
  });

  it("includes an amber dot indicator", () => {
    const { container } = render(<OverrideBadge />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
    expect(dot?.className).toContain("bg-accent");
    expect(dot?.className).toContain("rounded-full");
  });
});
