import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Focusable,
  TooltipTrigger,
  type ButtonProps as AriaButtonProps,
} from "react-aria-components";
import Tooltip from "./Tooltip";
import { focusRingOffset } from "./focus-ring";

export type IconButtonTone = "default" | "danger" | "primary";

const BASE_CLASSES = `inline-flex items-center justify-center rounded-control p-1.5 transition-colors ${focusRingOffset}`;

// A hover wash behind the icon, deepening on press (DESIGN.md Ghost icon
// button). The danger tone only moves the icon to danger-text on hover, so a
// destructive row action reads as such before its confirming dialog opens. The
// primary tone is the icon-only form of the Primary button, for the one
// call-to-action in a view.
const TONE_CLASSES: Record<IconButtonTone, string> = {
  default:
    "text-text-secondary data-[hovered]:bg-bg-hover data-[hovered]:text-text-primary data-[pressed]:bg-bg-pressed",
  danger:
    "text-text-secondary data-[hovered]:bg-bg-hover data-[hovered]:text-danger-text data-[pressed]:bg-bg-pressed",
  primary:
    "bg-accent text-on-accent data-[hovered]:bg-accent-hover data-[pressed]:bg-accent-active",
};

const DISABLED_TONE_CLASSES: Record<IconButtonTone, string> = {
  default: "text-text-secondary",
  danger: "text-text-secondary",
  primary: "bg-accent text-on-accent",
};

const DISABLED_CLASSES = "opacity-40 cursor-default";

export interface IconButtonProps extends Omit<
  AriaButtonProps,
  "className" | "children" | "aria-label"
> {
  /** The accessible name, and the tooltip text unless `tooltip` is given. */
  label: string;
  /** Tooltip content when it should differ from `label`, such as a disabled reason. */
  tooltip?: ReactNode;
  /** The icon. */
  children: ReactNode;
  tone?: IconButtonTone;
  /** Layout-only additions (size, margin). */
  className?: string;
  /** Tooltip open delay in ms. */
  delay?: number;
  placement?: "top" | "bottom" | "left" | "right";
  "data-testid"?: string;
}

/**
 * DESIGN.md Ghost icon button: unpainted until hover, always with a tooltip.
 *
 * The tooltip must still appear when the button is disabled, because it is how
 * the reason gets read. React Aria fires no hover or focus on a disabled
 * `<button>`, so the disabled state renders a focusable `aria-disabled` button
 * that ignores press instead of a natively disabled one.
 */
export default function IconButton({
  label,
  tooltip,
  children,
  tone = "default",
  className,
  delay = 500,
  placement,
  isDisabled,
  "data-testid": testId,
  ...props
}: IconButtonProps) {
  const classes = [BASE_CLASSES, className].filter(Boolean).join(" ");
  const trigger = isDisabled ? (
    <Focusable>
      <button
        type="button"
        aria-label={label}
        aria-disabled="true"
        data-disabled="true"
        data-testid={testId}
        className={`${classes} ${DISABLED_TONE_CLASSES[tone]} ${DISABLED_CLASSES}`}
      >
        {children}
      </button>
    </Focusable>
  ) : (
    <AriaButton
      {...props}
      aria-label={label}
      data-testid={testId}
      className={`${classes} ${TONE_CLASSES[tone]}`}
    >
      {children}
    </AriaButton>
  );

  return (
    <TooltipTrigger delay={delay}>
      {trigger}
      <Tooltip placement={placement}>{tooltip ?? label}</Tooltip>
    </TooltipTrigger>
  );
}
