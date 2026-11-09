import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

// The frame the Spec Bench views group their content in, as the Spec Bench
// design prototype draws it: a surface with a hairline border, a header with a
// mono uppercase eyebrow on the left and an optional secondary meta line on the
// right, and a body. The panel is a labelled section, so a screen reader can
// move between panels by landmark.
export function DeliveryPanel({
  testId,
  title,
  meta,
  className,
  children,
}: {
  testId?: string;
  title: string;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={`animate-rise-in min-w-0 overflow-hidden rounded-control border border-border bg-bg-surface ${className ?? ""}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <h3 className="font-mono text-11 font-medium uppercase tracking-label text-text-secondary">
          {title}
        </h3>
        {hasMeta(meta) && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5 text-11 font-medium text-text-secondary">
            {meta}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}

// A meta that React would render as nothing (absent, null, a boolean, an empty
// string or an empty list) renders no meta line.
function hasMeta(meta: ReactNode): boolean {
  return Children.toArray(meta).some((child) => child !== "");
}

// The cells of a strip: each element child, with a Fragment's children counted
// as cells of their own.
function stripCells(children: ReactNode): ReactElement[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return child.type === Fragment ? stripCells(child.props.children) : [child];
  });
}

const STRIP_COLUMNS = ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4"] as const;

// A row of Delivery stat cells (DESIGN.md) split by hairline dividers, the
// stat strip of a panel. It holds one to four cells: the column count is the
// number of element cells (a false, null, string or number child is not a
// cell), and the dividers assume a single row, so a strip shows at most four
// and warns in development when it is given more.
export function DeliveryStatStrip({ testId, children }: { testId?: string; children: ReactNode }) {
  const cells = stripCells(children);
  if (import.meta.env.DEV && cells.length > STRIP_COLUMNS.length) {
    console.warn(
      `DeliveryStatStrip shows at most ${String(STRIP_COLUMNS.length)} cells; ${String(cells.length)} were given.`,
    );
  }
  const count = Math.min(Math.max(cells.length, 1), STRIP_COLUMNS.length);
  return (
    <div
      data-testid={testId}
      className={`grid ${STRIP_COLUMNS[count - 1]} divide-x divide-border [&>*]:min-w-0`}
    >
      {cells.slice(0, STRIP_COLUMNS.length)}
    </div>
  );
}
