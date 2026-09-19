import type { ReactNode } from "react";

interface TileProps {
  icon: ReactNode;
  title: string;
  secondary?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
  ariaLabel?: string;
  isOverridden?: boolean;
  isDirty?: boolean;
}

export default function Tile({
  icon,
  title,
  secondary,
  headerAction,
  children,
  className,
  "data-testid": testId,
  ariaLabel,
  isOverridden = false,
  isDirty = false,
}: TileProps) {
  const borderClass = isDirty
    ? "border-accent-border bg-accent-muted"
    : isOverridden
      ? "border-accent-border bg-bg-surface"
      : "border-border bg-bg-surface";

  const iconBgClass =
    isOverridden || isDirty
      ? "bg-accent-muted text-accent-text"
      : "bg-bg-hover text-text-secondary";

  return (
    <section
      aria-label={ariaLabel ?? title}
      data-testid={testId}
      className={`rounded-lg border p-5 transition-colors ${borderClass}${className ? ` ${className}` : ""}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors duration-150 ${iconBgClass}`}
          >
            {icon}
          </div>
          <div>
            <div className="text-13 font-medium text-text-primary">{title}</div>
            {secondary && <div className="text-11 text-text-secondary mt-0.5">{secondary}</div>}
          </div>
        </div>
        {(isDirty || headerAction) && (
          <div className="ml-2 shrink-0 flex items-center gap-2">
            {isDirty && (
              <span className="text-11 uppercase tracking-label text-accent-text font-medium">
                Editing
              </span>
            )}
            {headerAction}
          </div>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
