import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  Popover as AriaPopover,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type PopoverProps as AriaPopoverProps,
} from "react-aria-components";
import { focusRing } from "./focus-ring";

export { MenuTrigger, SubmenuTrigger } from "react-aria-components";

// DESIGN.md Menu: a floating surface at elevation.0 with a hairline border (a
// shadow is nearly invisible in dark mode). Items take a wash, never a border:
// bg-hover on hover and focus, bg-pressed on press.
export const MENU_POPOVER_CLASS =
  "animate-rise-in min-w-40 rounded-control border border-border bg-bg-surface p-1 shadow-elevation-0 outline-none";

export const MENU_CLASS = "flex flex-col gap-px outline-none max-h-[inherit] overflow-auto";

export const MENU_ITEM_CLASS = `flex items-center gap-2 rounded-chip px-3 py-1.5 text-13 text-text-body cursor-pointer transition-colors data-[hovered]:bg-bg-hover data-[focused]:bg-bg-hover data-[pressed]:bg-bg-pressed data-[disabled]:opacity-40 data-[disabled]:cursor-default ${focusRing} data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring`;

function join(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function MenuPopover({
  className,
  ...props
}: Omit<AriaPopoverProps, "className"> & { className?: string }) {
  return <AriaPopover {...props} className={join(MENU_POPOVER_CLASS, className)} />;
}

export function Menu<T extends object>({
  className,
  ...props
}: Omit<AriaMenuProps<T>, "className"> & { className?: string }) {
  return <AriaMenu {...props} className={join(MENU_CLASS, className)} />;
}

export function MenuItem<T extends object>({
  className,
  ...props
}: Omit<AriaMenuItemProps<T>, "className"> & { className?: string }) {
  return <AriaMenuItem {...props} className={join(MENU_ITEM_CLASS, className)} />;
}
