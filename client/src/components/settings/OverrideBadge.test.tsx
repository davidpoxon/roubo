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
    expect(chip.className).toContain("bg-amber-500/15");
    expect(chip.className).toContain("text-amber-600");
  });

  it("includes an amber dot indicator", () => {
    const { container } = render(<OverrideBadge />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
    expect(dot?.className).toContain("bg-amber-500");
    expect(dot?.className).toContain("rounded-full");
  });
});
