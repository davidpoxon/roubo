// @vitest-environment jsdom
//
// #524: useElementWidth observes a ref'd element and returns its content-box
// width in px. jsdom has no layout (clientWidth is 0), so these tests stub
// clientWidth to assert the hook reads it on mount and re-reads on resize.

import { describe, it, expect, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, screen, act } from "@testing-library/react";
import { useElementWidth } from "./useElementWidth";

// Capture ResizeObserver instances so a test can drive a resize callback.
const observers: Array<{ cb: ResizeObserverCallback; el?: Element }> = [];

class TestResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    observers.push(this);
  }
  observe(el: Element) {
    (observers.find((o) => o.cb === this.cb) as { el?: Element }).el = el;
  }
  unobserve() {}
  disconnect() {}
}

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  return (
    <div ref={ref} data-testid="probe">
      {width}
    </div>
  );
}

afterEach(() => {
  observers.length = 0;
  vi.restoreAllMocks();
});

describe("useElementWidth", () => {
  it("reads the element width on mount", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(512);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("512");
  });

  it("re-reads the width when the observer fires", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    try {
      render(<Probe />);
      expect(screen.getByTestId("probe")).toHaveTextContent("300");

      spy.mockReturnValue(700);
      act(() => {
        observers[0].cb([], observers[0] as unknown as ResizeObserver);
      });
      expect(screen.getByTestId("probe")).toHaveTextContent("700");
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });
});
