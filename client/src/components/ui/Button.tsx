import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { buttonClass, type ButtonVariant } from "./styles";

export interface ButtonProps extends Omit<AriaButtonProps, "className"> {
  /** Defaults to `secondary`, the default action style. */
  variant?: ButtonVariant;
  /** Layout-only additions (width, margin). Colour comes from the variant. */
  className?: string;
}

/**
 * The shared text button. `primary` is at most one per view; `danger` belongs
 * only inside a confirming dialog.
 */
export default function Button({ variant = "secondary", className, ...props }: ButtonProps) {
  return <AriaButton {...props} className={buttonClass(variant, className)} />;
}
