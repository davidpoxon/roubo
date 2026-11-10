import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  READABLE_ZOOM,
  clampPan,
  clampScroll,
  fitView,
  initialView,
  revealBox,
  zoomAt,
  type GraphBounds,
  type GraphView,
} from "./graph-viewport";

const viewport = { width: 800, height: 600 };

function toScreen(view: GraphView, point: { x: number; y: number }) {
  return { x: point.x * view.k + view.x, y: point.y * view.k + view.y };
}

describe("graph viewport", () => {
  it("fits a small graph at 100%, centred", () => {
    const bounds: GraphBounds = { x: -100, y: 50, width: 200, height: 100 };
    const view = fitView(bounds, viewport);
    expect(view.k).toBe(1);
    expect(toScreen(view, { x: 0, y: 100 })).toEqual({ x: 400, y: 300 });
  });

  it("fits a large graph by its tighter axis, and never below the least zoom", () => {
    expect(fitView({ x: 0, y: 0, width: 1536, height: 100 }, viewport).k).toBeCloseTo(0.5);
    expect(fitView({ x: 0, y: 0, width: 100_000, height: 100 }, viewport).k).toBe(MIN_ZOOM);
  });

  it("opens on the focus at the readable zoom when a fit is too small to read", () => {
    const bounds: GraphBounds = { x: 0, y: 0, width: 4000, height: 3000 };
    const view = initialView(bounds, viewport, { x: 2000, y: 1000 });
    expect(view.k).toBe(READABLE_ZOOM);
    expect(toScreen(view, { x: 2000, y: 1000 })).toEqual({ x: 400, y: 300 });
    // Without a focus, the middle of the graph.
    const middle = initialView(bounds, viewport, null);
    expect(toScreen(middle, { x: 2000, y: 1500 })).toEqual({ x: 400, y: 300 });
  });

  it("zooms about a point, which stays where it is, within the zoom range", () => {
    const view = { k: 1, x: 10, y: 20 };
    const point = { x: 300, y: 200 };
    const zoomed = zoomAt(view, 1.5, point);
    expect(zoomed.k).toBe(1.5);
    const graphPoint = { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k };
    expect(toScreen(zoomed, graphPoint).x).toBeCloseTo(300);
    expect(toScreen(zoomed, graphPoint).y).toBeCloseTo(200);
    expect(zoomAt(view, 100, point).k).toBe(MAX_ZOOM);
    expect(zoomAt(view, 0.001, point).k).toBe(MIN_ZOOM);
  });

  it("keeps some of the graph in view however far a drag pans", () => {
    const bounds: GraphBounds = { x: 0, y: 0, width: 1000, height: 1000 };
    const away = clampPan({ k: 1, x: 5000, y: -5000 }, bounds, viewport);
    expect(away.x).toBeLessThanOrEqual(viewport.width - 64);
    expect(away.y + 1000).toBeGreaterThanOrEqual(64);
  });

  it("scrolls by the wheel only where the graph is larger than the viewport, up to its edge", () => {
    const wide: GraphBounds = { x: 0, y: 0, width: 2000, height: 200 };
    const view = fitView({ x: 0, y: 0, width: 600, height: 200 }, viewport);
    const at = { ...view, k: 1 };
    // Down: the graph fits vertically, so the view does not move.
    expect(clampScroll({ ...at, y: at.y - 50 }, at, wide, viewport).y).toBe(at.y);
    // Right: up to the graph's right edge, plus the padding.
    const far = clampScroll({ ...at, x: -10_000 }, at, wide, viewport);
    expect(far.x + 2000).toBe(viewport.width - 16);
  });

  it("does not pull back a view a drag left past the graph's edge", () => {
    const bounds: GraphBounds = { x: 0, y: 0, width: 2000, height: 2000 };
    const past = { k: 1, x: 300, y: 0 };
    expect(clampScroll({ ...past, x: 290 }, past, bounds, viewport).x).toBe(290);
    expect(clampScroll({ ...past, x: 320 }, past, bounds, viewport).x).toBe(300);
  });

  it("reveals a box by the least pan, inside a margin", () => {
    const view = { k: 1, x: 0, y: 0 };
    expect(revealBox(view, { x: 100, y: 100, width: 50, height: 50 }, viewport)).toEqual(view);
    const right = revealBox(view, { x: 900, y: 100, width: 100, height: 50 }, viewport);
    expect(right).toEqual({ k: 1, x: -(1000 - (800 - 24)), y: 0 });
    const above = revealBox(view, { x: 100, y: -200, width: 50, height: 50 }, viewport);
    expect(above).toEqual({ k: 1, x: 0, y: 224 });
  });
});
