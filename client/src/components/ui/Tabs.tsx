import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  type TabListProps as AriaTabListProps,
  type TabPanelProps as AriaTabPanelProps,
  type TabProps as AriaTabProps,
} from "react-aria-components";
import { focusRing } from "./focus-ring";

export { Tabs } from "react-aria-components";

// DESIGN.md Tabs. The selected tab is primary text over a 2px accent indicator;
// the rest are secondary text that steps up to primary on hover. A pressed tab
// takes a bg-hover wash. The ring sits tight to the tab.
export const TAB_LIST_CLASS = "flex items-end gap-4 border-b border-border";

export const TAB_CLASS = `-mb-px px-3 py-1.5 rounded-t-chip border-b-2 border-transparent text-13 font-medium text-text-secondary cursor-pointer transition-colors data-[hovered]:text-text-primary data-[pressed]:bg-bg-hover data-[selected]:border-accent data-[selected]:text-text-primary data-[disabled]:opacity-40 data-[disabled]:cursor-default ${focusRing}`;

/** Entering tab content uses motion.rise-in. */
export const TAB_PANEL_CLASS = `animate-rise-in ${focusRing}`;

function join(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function TabList<T extends object>({
  className,
  ...props
}: Omit<AriaTabListProps<T>, "className"> & { className?: string }) {
  return <AriaTabList {...props} className={join(TAB_LIST_CLASS, className)} />;
}

export function Tab({
  className,
  ...props
}: Omit<AriaTabProps, "className"> & { className?: string }) {
  return <AriaTab {...props} className={join(TAB_CLASS, className)} />;
}

export function TabPanel({
  className,
  ...props
}: Omit<AriaTabPanelProps, "className"> & { className?: string }) {
  return <AriaTabPanel {...props} className={join(TAB_PANEL_CLASS, className)} />;
}
