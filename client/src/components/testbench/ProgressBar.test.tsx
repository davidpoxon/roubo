// @vitest-environment jsdom
//
// #419 FR-006/NFR-004: the progress bar renders passed/failed/in-progress
// segments with a mono count, an accessible text summary (never colour alone),
// and a dimmed empty state.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ProgressBar from "./ProgressBar";
import type { StatusCounts } from "./rollup";

function counts(partial: Partial<StatusCounts>): StatusCounts {
  return {
    total: 0,
    not_started: 0,
    in_progress: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    ...partial,
  };
}

describe("ProgressBar", () => {
  it("renders an accessible summary of every bucket", () => {
    render(
      <ProgressBar
        counts={counts({ total: 4, passed: 1, failed: 1, in_progress: 1, not_started: 1 })}
        label="Overall"
      />,
    );
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toBe(
      "Overall: 1 passed, 1 failed, 1 in progress, 1 remaining of 4",
    );
  });

  it("shows the passed/total ratio as a mono count label", () => {
    render(<ProgressBar counts={counts({ total: 4, passed: 3 })} label="e2e" />);
    expect(screen.getByText("3/4")).toBeTruthy();
  });

  it("renders segments for each non-zero bucket", () => {
    const { container } = render(
      <ProgressBar counts={counts({ total: 3, passed: 1, failed: 1, in_progress: 1 })} label="x" />,
    );
    expect(container.querySelector(".bg-green-500")).toBeTruthy();
    expect(container.querySelector(".bg-red-500")).toBeTruthy();
    expect(container.querySelector(".bg-amber-500")).toBeTruthy();
  });

  it("dims to the empty state when the group has no cases", () => {
    const { container } = render(<ProgressBar counts={counts({ total: 0 })} label="empty" />);
    expect(container.querySelector(".opacity-30")).toBeTruthy();
    expect(screen.getByText("0/0")).toBeTruthy();
    // No coloured segments when there are no cases.
    expect(container.querySelector(".bg-green-500")).toBeNull();
  });
});
