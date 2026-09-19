import {
  Tooltip as AriaTooltip,
  type TooltipProps as AriaTooltipProps,
} from "react-aria-components";

export const TOOLTIP_CLASS =
  "bg-bg-inverse text-text-on-inverse text-12 px-3 py-1.5 rounded-control shadow-elevation-0 max-w-xs";

export interface TooltipProps extends Omit<AriaTooltipProps, "className"> {
  /** Layout-only additions. The surface comes from the spec. */
  className?: string;
}

/**
 * DESIGN.md Tooltip: the inverse surface at `elevation.0`. Place it inside a
 * React Aria `TooltipTrigger`; `IconButton` wires one up for icon-only
 * controls, including disabled ones.
 */
export default function Tooltip({ className, offset = 6, ...props }: TooltipProps) {
  return (
    <AriaTooltip
      {...props}
      offset={offset}
      className={className ? `${TOOLTIP_CLASS} ${className}` : TOOLTIP_CLASS}
    />
  );
}
