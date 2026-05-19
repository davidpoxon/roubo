import { useRef, useLayoutEffect, useState, type ReactNode } from "react";

interface WrapCodeProps {
  children: string;
  className?: string;
}

export default function WrapCode({ children: text, className }: WrapCodeProps) {
  const codeRef = useRef<HTMLElement>(null);
  const [cols, setCols] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = codeRef.current;
    if (!el) return;

    function measure() {
      const el = codeRef.current;
      if (!el) return;

      const probe = document.createElement("span");
      probe.style.visibility = "hidden";
      probe.style.position = "absolute";
      probe.style.whiteSpace = "pre";
      probe.textContent = "X";
      el.appendChild(probe);
      const charWidth = probe.getBoundingClientRect().width;
      el.removeChild(probe);

      if (charWidth === 0) return;

      const cs = getComputedStyle(el);
      const innerWidth = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

      setCols(Math.max(1, Math.floor(innerWidth / charWidth)));
    }

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wraps = cols !== null && text.length > cols;

  let content: ReactNode;
  if (!wraps) {
    content = text;
  } else {
    const usable = Math.max(1, cols - 1);
    const lines: ReactNode[] = [];
    let offset = 0;

    while (offset < text.length) {
      const isLast = offset + cols >= text.length;
      const chunk = isLast
        ? text.slice(offset, offset + cols)
        : text.slice(offset, offset + usable);

      lines.push(
        <span key={offset} className="block whitespace-pre">
          {chunk}
          {!isLast && (
            <span className="text-stone-600 select-none" aria-hidden="true">
              ↩
            </span>
          )}
        </span>,
      );

      offset += isLast ? cols : usable;
    }

    content = lines;
  }

  return (
    <code
      ref={codeRef}
      className={`text-[12px] font-mono text-stone-700 dark:text-stone-300 bg-stone-100 dark:bg-stone-800/50 px-2 py-1 rounded min-w-0 ${
        wraps ? "block overflow-hidden" : "break-all"
      } ${className ?? ""}`}
    >
      {content}
    </code>
  );
}
