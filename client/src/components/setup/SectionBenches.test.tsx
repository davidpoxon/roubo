// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionBenches from "./SectionBenches";
import type { PortConfig } from "@roubo/shared";

describe("SectionBenches", () => {
  const ports: Record<string, PortConfig> = {
    frontend: { base: 3000 },
    backend: { base: 4000 },
  };

  it("renders the max benches input", () => {
    render(<SectionBenches benches={{}} ports={{}} dispatch={vi.fn()} />);
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
  });

  it("renders the setup command input", () => {
    render(<SectionBenches benches={{}} ports={{}} dispatch={vi.fn()} />);
    expect(screen.getByPlaceholderText(/e\.g\. cd app && npm ci/i)).toBeInTheDocument();
  });

  it("shows port ranges when max > 0", () => {
    render(<SectionBenches benches={{ max: 3 }} ports={ports} dispatch={vi.fn()} />);
    expect(screen.getByText("frontend")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
    // base 3000 with max 3 → 3000 – 3002
    expect(screen.getByText("3000 – 3002")).toBeInTheDocument();
    expect(screen.getByText("4000 – 4002")).toBeInTheDocument();
  });

  it("hides port ranges when max is 0", () => {
    render(<SectionBenches benches={{ max: 0 }} ports={ports} dispatch={vi.fn()} />);
    expect(screen.queryByText("frontend")).not.toBeInTheDocument();
  });

  it("shows validation error for out-of-range max", () => {
    render(<SectionBenches benches={{ max: 100 }} ports={{}} dispatch={vi.fn()} />);
    expect(screen.getByText(/must be between 1 and 99/i)).toBeInTheDocument();
  });

  it("dispatches UPDATE_BENCHES when setup command changes", async () => {
    const dispatch = vi.fn();
    render(<SectionBenches benches={{ max: 3 }} ports={{}} dispatch={dispatch} />);
    const input = screen.getByPlaceholderText(/e\.g\. cd app && npm ci/i);
    await userEvent.type(input, "npm ci");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_BENCHES" }));
  });
});
