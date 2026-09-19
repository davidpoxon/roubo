import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { navItemClass } from "./styles";

export interface NavItemProps extends Omit<AriaButtonProps, "className"> {
  /** Whether this row is the current destination. Sets `aria-current="page"`. */
  isSelected?: boolean;
  /** Layout-only additions (width, gap, indent). */
  className?: string;
}

/** A sidebar destination. */
export default function NavItem({ isSelected = false, className, ...props }: NavItemProps) {
  return (
    <AriaButton
      {...props}
      aria-current={isSelected ? "page" : undefined}
      className={navItemClass(isSelected, className)}
    />
  );
}
