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
    ? "border-amber-500/40 bg-stone-900/50 dark:bg-stone-900/50"
    : isOverridden
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30";

  const iconBgClass =
    isOverridden || isDirty
      ? "bg-amber-500/20 text-amber-500 dark:text-amber-400"
      : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400";

  return (
    <section
      aria-label={ariaLabel ?? title}
      data-testid={testId}
      className={`rounded-lg border p-5 transition-all duration-150 ${borderClass}${className ? ` ${className}` : ""}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors duration-150 ${iconBgClass}`}
          >
            {icon}
          </div>
          <div>
            <div className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
              {title}
            </div>
            {secondary && (
              <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
                {secondary}
              </div>
            )}
          </div>
        </div>
        {(isDirty || headerAction) && (
          <div className="ml-2 shrink-0 flex items-center gap-2">
            {isDirty && (
              <span className="text-[10px] uppercase tracking-wider text-amber-500 dark:text-amber-400 font-medium">
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
