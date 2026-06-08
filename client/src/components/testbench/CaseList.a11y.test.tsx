// @vitest-environment jsdom
//
// #419 TC-018/TC-029/TC-037: the virtualised case list windows the DOM (a
// 500-case plan mounts far fewer than 500 case rows), is keyboard navigable with
// visible focus, and has zero axe violations.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { Case } from "@roubo/shared/testbench-contracts";
import { buildRollup, flattenRollup } from "./rollup";
import CaseList from "./CaseList";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}
expect.extend({ toHaveNoViolations });

// jsdom reports zero layout. Give the scroll container a fixed viewport height
// and a stable per-row height so @tanstack/react-virtual produces a real window
// rather than mounting every row.
const VIEWPORT = 400;
let rafSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  // The scroll container reports the viewport height; the windowing hook reads
  // clientHeight (then offsetHeight) to size its window.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "group" ? VIEWPORT : 36;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "group" ? VIEWPORT : 36;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 600,
  });
  // jsdom's scrollTop is a no-op; back it with a real store so the
  // scroll-into-view path is observable.
  const scrollStore = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return scrollStore.get(this) ?? 0;
    },
    set(v: number) {
      scrollStore.set(this, v);
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600,
    height: VIEWPORT,
    top: 0,
    left: 0,
    bottom: VIEWPORT,
    right: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // Run rAF callbacks synchronously so focus moves are observable in the test.
  rafSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
});

afterEach(() => {
  rafSpy?.mockRestore();
  vi.restoreAllMocks();
});

function makeCases(count: number): Case[] {
  const cases: Case[] = [];
  for (let i = 0; i < count; i++) {
    cases.push({
      id: `c${i}`,
      title: `Case number ${i}`,
      level: `level${i % 3}`,
      priority: `P${i % 2}`,
      steps: [],
    });
  }
  return cases;
}

function rowsFor(count: number) {
  return flattenRollup(buildRollup(makeCases(count), null));
}

describe("CaseList virtualisation", () => {
  it("windows the DOM for a 500-case plan (mounts far fewer than 500 rows)", () => {
    render(<CaseList rows={rowsFor(500)} />);
    const mounted = screen.getAllByTestId("case-row").length;
    expect(mounted).toBeGreaterThan(0);
    // The whole point of virtualisation: the mounted window is a small fraction
    // of the 500 cases.
    expect(mounted).toBeLessThan(100);
  });
});

describe("CaseList keyboard navigation", () => {
  it("exposes a single roving tab stop and moves focus with ArrowDown/ArrowUp", () => {
    render(<CaseList rows={rowsFor(20)} />);
    const list = screen.getByRole("group");
    const focusable = within(list)
      .getAllByTestId("case-row")
      .filter((el) => el.getAttribute("tabindex") === "0");
    // Exactly one row is in the tab order at a time (roving tabindex).
    expect(focusable.length).toBe(1);

    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    // After navigation there is still exactly one tab stop.
    const after = within(list)
      .getAllByTestId("case-row")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(after.length).toBe(1);
  });

  it("jumps to the last case on End and scrolls it into view", () => {
    render(<CaseList rows={rowsFor(60)} />);
    const list = screen.getByRole("group");
    fireEvent.keyDown(list, { key: "End" });
    // End scrolls the container so the final case is mounted near the bottom.
    const afterEnd = list.scrollTop;
    expect(afterEnd).toBeGreaterThan(0);

    fireEvent.keyDown(list, { key: "Home" });
    // Home scrolls back toward the top (never further down than End).
    expect(list.scrollTop).toBeLessThanOrEqual(afterEnd);
    // Exactly one row remains the tab stop after navigating.
    const focusable = within(list)
      .getAllByTestId("case-row")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(focusable.length).toBe(1);
  });

  it("lands DOM focus on the last case row on End, even when it starts outside the window", () => {
    const rows = rowsFor(60);
    render(<CaseList rows={rows} />);
    const list = screen.getByRole("group");
    const lastIndex = rows.length - 1;
    // The final flat row is a case row (the last case of the last group).
    expect(rows[lastIndex].kind).toBe("case");

    fireEvent.keyDown(list, { key: "End" });

    // Focus actually moved onto the last case row, not silently lost: the row is
    // mounted even though it began outside the scroll window, and it both holds
    // the single tab stop and is the active element.
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute("data-row-index")).toBe(String(lastIndex));
    expect(active?.getAttribute("tabindex")).toBe("0");
  });

  it("ignores keystrokes when there are no cases", () => {
    render(<CaseList rows={[]} />);
    const list = screen.getByRole("group");
    // No throw, no case rows.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "End" });
    expect(within(list).queryAllByTestId("case-row").length).toBe(0);
  });

  it("does not crash when the plan shrinks below the focused row", () => {
    const big = rowsFor(60);
    const { rerender } = render(<CaseList rows={big} />);
    const list = screen.getByRole("group");
    // Move focus deep into the list, then shrink the plan under it: the stored
    // focus index now points past the new (shorter) case list.
    fireEvent.keyDown(list, { key: "End" });
    const small = rowsFor(3);
    expect(() => rerender(<CaseList rows={small} />)).not.toThrow();
    // The tab stop is re-clamped to a row that still exists (exactly one stop).
    const focusable = within(screen.getByRole("group"))
      .getAllByTestId("case-row")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(focusable.length).toBe(1);
  });
});

describe("CaseList a11y", () => {
  it("has no axe violations", async () => {
    const { container } = render(<CaseList rows={rowsFor(30)} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
