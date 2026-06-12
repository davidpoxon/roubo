import { useLayoutEffect, useState, type RefObject } from "react";

// Measure a ref'd element's content-box width in px via ResizeObserver (#524).
//
// Layout decisions in the TestBench detail pane (inline notes rail vs bottom
// drawer) must key on the space actually available to that pane, not the global
// viewport: a wide laptop viewport can still leave the case-detail container
// narrow once the projects sidebar and the case list have taken their share. A
// viewport breakpoint (`lg:`) cannot see that, so we observe the element itself.
//
// Hand-rolled on ResizeObserver rather than pulling in a dependency, mirroring
// the observer block in useWindowedRows.ts (the repo has no container-query
// plugin and pins deps). Guards `typeof ResizeObserver` for SSR/jsdom; jsdom has
// no layout, so the width stays 0 there unless a test drives it explicitly.
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setWidth(el.clientWidth || el.offsetWidth || 0);
    sync();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : undefined;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [ref]);

  return width;
}
