// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../hooks/useGlobalCap", () => ({
  useGlobalCap: vi.fn(),
}));

import GlobalBenchMeter from "./GlobalBenchMeter";
import { useGlobalCap } from "../hooks/useGlobalCap";
import type { GlobalCapState } from "../hooks/useGlobalCap";

const mockUseGlobalCap = vi.mocked(useGlobalCap);

function capState(current: number, max: number | null): GlobalCapState {
  const isCapped = max !== null;
  return {
    current,
    max,
    isCapped,
    isAtCap: isCapped && current >= max,
    isOverCap: isCapped && current > max,
  };
}

beforeEach(() => {
  mockUseGlobalCap.mockReset();
});

/** Returns the inner fill bar (the element carrying the width style). */
function fillBar(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[style*="width"]');
  if (!el) throw new Error("fill bar not found");
  return el as HTMLElement;
}

describe("GlobalBenchMeter", () => {
  it("renders nothing when no global cap is set", () => {
    mockUseGlobalCap.mockReturnValue(capState(0, null));
    const { container } = render(<GlobalBenchMeter />);
    expect(container.firstChild).toBeNull();
  });

  it("exposes the exact aria-label and visible count when capped", () => {
    mockUseGlobalCap.mockReturnValue(capState(3, 5));
    render(<GlobalBenchMeter />);
    expect(screen.getByLabelText("Global benches: 3 of 5")).toBeInTheDocument();
    expect(screen.getByText("3 / 5")).toBeInTheDocument();
  });

  it("uses neutral stone below 80% of the cap", () => {
    mockUseGlobalCap.mockReturnValue(capState(7, 10));
    const { container } = render(<GlobalBenchMeter />);
    expect(fillBar(container).className).toContain("bg-stone-400");
  });

  it("uses amber at >= 80% of the cap", () => {
    mockUseGlobalCap.mockReturnValue(capState(8, 10));
    const { container } = render(<GlobalBenchMeter />);
    expect(fillBar(container).className).toContain("bg-amber-500");
  });

  it("uses red at 100% of the cap", () => {
    mockUseGlobalCap.mockReturnValue(capState(10, 10));
    const { container } = render(<GlobalBenchMeter />);
    expect(fillBar(container).className).toContain("bg-red-500");
  });

  it("stays red and clamps fill width at 100% when over the cap", () => {
    mockUseGlobalCap.mockReturnValue(capState(12, 10));
    const { container } = render(<GlobalBenchMeter />);
    const bar = fillBar(container);
    expect(bar.className).toContain("bg-red-500");
    expect(bar.style.width).toBe("100%");
    expect(screen.getByText("12 / 10")).toBeInTheDocument();
    expect(screen.getByLabelText("Global benches: 12 of 10")).toBeInTheDocument();
  });
});
