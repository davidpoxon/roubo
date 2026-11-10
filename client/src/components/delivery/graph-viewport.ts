// The view of the delivery graph (#1656): which part of the graph its viewport
// shows, and at what zoom. Pure, so the pan and zoom rules can be tested
// without a browser.
//
// A view maps graph space to the viewport: a graph point p shows at
// `p * k + (x, y)` in viewport pixels. It is kept in graph space, not canvas
// space, so a layout that moves the canvas origin (a node drag can) does not
// move what the operator sees.

export interface GraphView {
  k: number;
  x: number;
  y: number;
}

export interface GraphBounds {
  // The top left of the graph in graph space, and its size.
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
// Below this zoom a node's text cannot be read, so the first view of a large
// graph shows the live unit at this zoom instead of the whole graph.
export const READABLE_ZOOM = 0.6;
// The factor one press of zoom in or zoom out applies.
export const ZOOM_STEP = 1.25;
// The space a fit leaves around the graph.
const FIT_PADDING = 16;
// How much of the graph a pan always leaves in the viewport.
const PAN_MARGIN = 64;
// How far a node that takes the focus stays from the viewport's edge.
const REVEAL_MARGIN = 24;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

// The whole graph in the viewport, centred, at no more than 100%.
export function fitView(bounds: GraphBounds, viewport: ViewportSize): GraphView {
  const room = {
    width: Math.max(1, viewport.width - 2 * FIT_PADDING),
    height: Math.max(1, viewport.height - 2 * FIT_PADDING),
  };
  const k = clampZoom(
    Math.min(1, room.width / Math.max(1, bounds.width), room.height / Math.max(1, bounds.height)),
  );
  return {
    k,
    x: (viewport.width - bounds.width * k) / 2 - bounds.x * k,
    y: (viewport.height - bounds.height * k) / 2 - bounds.y * k,
  };
}

// A graph point at the middle of the viewport, at zoom k.
export function centreOn(
  point: { x: number; y: number },
  k: number,
  viewport: ViewportSize,
): GraphView {
  return { k, x: viewport.width / 2 - point.x * k, y: viewport.height / 2 - point.y * k };
}

// The view the map opens on: the whole graph, or, when the whole graph fits
// only below the readable zoom, the live unit (else the middle of the graph)
// at the readable zoom.
export function initialView(
  bounds: GraphBounds,
  viewport: ViewportSize,
  focus: { x: number; y: number } | null,
): GraphView {
  const fit = fitView(bounds, viewport);
  if (fit.k >= READABLE_ZOOM) return fit;
  const point = focus ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return clampPan(centreOn(point, READABLE_ZOOM, viewport), bounds, viewport);
}

// Keeps at least a margin of the graph in the viewport on each axis.
export function clampPan(view: GraphView, bounds: GraphBounds, viewport: ViewportSize): GraphView {
  const clampAxis = (offset: number, start: number, size: number, room: number) => {
    const left = start * view.k + offset;
    const right = left + size * view.k;
    const margin = Math.min(PAN_MARGIN, (size * view.k) / 2, room / 2);
    if (right < margin) return offset + (margin - right);
    if (left > room - margin) return offset - (left - (room - margin));
    return offset;
  };
  return {
    k: view.k,
    x: clampAxis(view.x, bounds.x, bounds.width, viewport.width),
    y: clampAxis(view.y, bounds.y, bounds.height, viewport.height),
  };
}

// A pan by the wheel, which moves the graph as a scroll moves a page: only on
// an axis where the graph is larger than the viewport, and no further than
// its edge (with the fit padding) on that side. A view that is already past
// that edge, after a drag, is not pulled back.
export function clampScroll(
  next: GraphView,
  current: GraphView,
  bounds: GraphBounds,
  viewport: ViewportSize,
): GraphView {
  const axis = (wanted: number, offset: number, start: number, size: number, room: number) => {
    if (size * current.k + 2 * FIT_PADDING <= room) return offset;
    const low = room - FIT_PADDING - (start + size) * current.k;
    const high = FIT_PADDING - start * current.k;
    return Math.min(Math.max(wanted, Math.min(low, offset)), Math.max(high, offset));
  };
  return {
    k: current.k,
    x: axis(next.x, current.x, bounds.x, bounds.width, viewport.width),
    y: axis(next.y, current.y, bounds.y, bounds.height, viewport.height),
  };
}

// Zooms by a factor about a viewport point, which stays where it is.
export function zoomAt(
  view: GraphView,
  factor: number,
  point: { x: number; y: number },
): GraphView {
  const k = clampZoom(view.k * factor);
  const scale = k / view.k;
  return { k, x: point.x - (point.x - view.x) * scale, y: point.y - (point.y - view.y) * scale };
}

export function panBy(view: GraphView, dx: number, dy: number): GraphView {
  return { k: view.k, x: view.x + dx, y: view.y + dy };
}

// The least pan that brings a graph-space box into the viewport, inside a
// margin. A box larger than the viewport shows its top left.
export function revealBox(view: GraphView, box: GraphBounds, viewport: ViewportSize): GraphView {
  const axis = (offset: number, start: number, size: number, room: number) => {
    const near = start * view.k + offset;
    const far = near + size * view.k;
    if (near < REVEAL_MARGIN) return offset + (REVEAL_MARGIN - near);
    if (far > room - REVEAL_MARGIN) {
      return offset - Math.min(far - (room - REVEAL_MARGIN), near - REVEAL_MARGIN);
    }
    return offset;
  };
  return {
    k: view.k,
    x: axis(view.x, box.x, box.width, viewport.width),
    y: axis(view.y, box.y, box.height, viewport.height),
  };
}

export function sameView(a: GraphView, b: GraphView): boolean {
  return Math.abs(a.k - b.k) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}
