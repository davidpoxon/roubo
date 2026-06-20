import { Globe, Code, Terminal, Hammer, Phone, Monitor, Layout, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComponentConfig } from "@roubo/shared";

export const INPUT =
  "w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600";
export const INPUT_INNER =
  "w-full flex-1 bg-transparent p-0 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none";

export const COMPONENT_TYPE_LABELS: Record<string, string> = {
  database: "Database",
  process: "Process",
  other: "Other",
};

/**
 * Display label for a component's role. A legacy built-in component shows its
 * `type` ("Database" / "Process"); a plugin-bound component (issue #608) has no
 * `type` and is labelled by its bound plugin id instead.
 */
export function componentTypeBadge(component: ComponentConfig): string {
  if (component.type) {
    return COMPONENT_TYPE_LABELS[component.type] ?? component.type;
  }
  if (component.plugin) {
    return `Plugin: ${component.plugin.id}`;
  }
  return "Component";
}

export const TOOL_ICONS = [
  "globe",
  "code",
  "terminal",
  "hammer",
  "phone",
  "monitor",
  "layout",
  "settings",
];
export const TOOL_ICON_MAP: Record<string, LucideIcon> = {
  globe: Globe,
  code: Code,
  terminal: Terminal,
  hammer: Hammer,
  phone: Phone,
  monitor: Monitor,
  layout: Layout,
  settings: Settings,
};
