import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  ZOOM_STEP,
  clampPan,
  clampScroll,
  fitView,
  initialView,
  panBy,
  revealBox,
  sameView,
  zoomAt,
  type GraphBounds,
  type GraphView,
  type ViewportSize,
} from "../components/delivery/graph-viewport";

// Pan and zoom for the delivery graph's viewport (#1656), in the manner of a
// design tool:
// - a drag on the empty canvas pans, and so does a plain wheel or two-finger
//   scroll, which moves the graph as a scroll moves a page: a scroll the
//   graph cannot follow (it fits the viewport that way, or is already at its
//   edge) is left to the page;
// - Ctrl or Cmd with the wheel, and a trackpad pinch (which arrives as a
//   wheel event with ctrlKey), zoom about the pointer;
// - `+` and `-` zoom about the middle and `0` fits the whole graph, while the
//   focus is anywhere in the viewport; the arrow keys pan while the viewport
//   itself has the focus.
//
// Until the operator moves the view, it follows the layout and the viewport's
// size: the whole graph, or the live unit at a readable zoom when the whole
// graph would be too small to read (see initialView). Once they move it, it
// stays as they left it.

const KEY_PAN = 48;

// The wheel delta as a zoom exponent, as d3-zoom reads it.
function wheelZoomDelta(event: WheelEvent): number {
  const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode === 2 ? 1 : 0.002;
  return -event.deltaY * unit * (event.ctrlKey ? 10 : 1);
}

function wheelPixels(event: WheelEvent, delta: number): number {
  return event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * 400 : delta;
}

export interface GraphViewport {
  view: GraphView;
  size: ViewportSize;
  panning: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  // Pans the least amount that brings a graph-space box into view.
  reveal: (box: GraphBounds) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useGraphViewport(
  ref: RefObject<HTMLElement | null>,
  bounds: GraphBounds,
  focus: { x: number; y: number } | null,
  onResize?: (size: ViewportSize) => void,
): GraphViewport {
  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  // The view the operator set, or null while the view follows the layout.
  const [moved, setMoved] = useState<GraphView | null>(null);
  const [panning, setPanning] = useState(false);
  const view = moved ?? initialView(bounds, size, focus);

  // What the native wheel listener and the pointer handlers read: the view,
  // the bounds and the size as of the last render.
  const latest = useRef({ view, bounds, size });
  useLayoutEffect(() => {
    latest.current = { view, bounds, size };
  });
  const drag = useRef<{ id: number; x: number; y: number; view: GraphView } | null>(null);
  const resized = useRef(onResize);
  useLayoutEffect(() => {
    resized.current = onResize;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const sync = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSize((last) => (last.width === next.width && last.height === next.height ? last : next));
      resized.current?.(next);
    };
    sync();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : undefined;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [ref]);

  const apply = useCallback((next: GraphView) => {
    const current = latest.current;
    const clamped = clampPan(next, current.bounds, current.size);
    if (!sameView(clamped, current.view)) setMoved(clamped);
    return clamped;
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const box = element.getBoundingClientRect();
        apply(
          zoomAt(current.view, 2 ** wheelZoomDelta(event), {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          }),
        );
        return;
      }
      const dx = wheelPixels(
        event,
        event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX,
      );
      const dy = event.shiftKey && event.deltaX === 0 ? 0 : wheelPixels(event, event.deltaY);
      const next = clampScroll(
        panBy(current.view, -dx, -dy),
        current.view,
        current.bounds,
        current.size,
      );
      // A scroll the graph cannot follow goes to the page.
      if (sameView(next, current.view)) return;
      event.preventDefault();
      setMoved(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, apply]);

  const zoomBy = useCallback(
    (factor: number) => {
      const { view: current, size: viewport } = latest.current;
      apply(zoomAt(current, factor, { x: viewport.width / 2, y: viewport.height / 2 }));
    },
    [apply],
  );
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const fit = useCallback(() => {
    const current = latest.current;
    setMoved(fitView(current.bounds, current.size));
  }, []);
  const reveal = useCallback((box: GraphBounds) => {
    const current = latest.current;
    if (current.size.width === 0 || current.size.height === 0) return;
    const next = revealBox(current.view, box, current.size);
    if (!sameView(next, current.view)) setMoved(next);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // A press on a node, a gate or a control is theirs, not a pan.
    if (event.target instanceof Element && event.target.closest("button, a") !== null) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: latest.current.view,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanning(true);
  }, []);
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = drag.current;
      if (start === null || start.id !== event.pointerId) return;
      apply(panBy(start.view, event.clientX - start.x, event.clientY - start.y));
    },
    [apply],
  );
  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (start === null || start.id !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setPanning(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomIn();
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomOut();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        fit();
        return;
      }
      if (event.target !== event.currentTarget) return;
      const pans: Record<string, [number, number]> = {
        ArrowLeft: [KEY_PAN, 0],
        ArrowRight: [-KEY_PAN, 0],
        ArrowUp: [0, KEY_PAN],
        ArrowDown: [0, -KEY_PAN],
      };
      const pan = Object.hasOwn(pans, event.key) ? pans[event.key] : undefined;
      if (pan === undefined) return;
      event.preventDefault();
      apply(panBy(latest.current.view, pan[0], pan[1]));
    },
    [apply, fit, zoomIn, zoomOut],
  );

  return {
    view,
    size,
    panning,
    zoomIn,
    zoomOut,
    fit,
    reveal,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
  };
}
