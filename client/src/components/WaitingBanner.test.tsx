// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import WaitingBanner from "./WaitingBanner";

describe("WaitingBanner", () => {
  it("announces the wait as a status region", () => {
    render(<WaitingBanner />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("uses the copy AP-TC-055 S003-O02 expects", () => {
    render(<WaitingBanner />);
    expect(screen.getByText("Waiting for your input")).toBeInTheDocument();
  });

  it("carries the amber action-needed dot the tab indicator uses", () => {
    const { container } = render(<WaitingBanner />);
    const dot = container.querySelector("span.rounded-full");
    expect(dot?.className).toContain("bg-amber-500");
    expect(dot?.className).toContain("animate-status-pulse");
  });

  it("names no specific AI coding agent", () => {
    const { container } = render(<WaitingBanner />);
    expect(container.textContent?.toLowerCase()).not.toMatch(/claude|codex|gemini/);
  });
});
