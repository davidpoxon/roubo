import { DONE_STATUSES } from "@roubo/shared";

// Maps GitHub project status field values to the DESIGN.md project-status
// tokens (blue, fuchsia, cyan), which avoid the component status hues and are
// tuned per theme. The hue is for dots only: a categorical hue never carries
// text, so `text` is the secondary text tone for every status.

interface StatusColors {
  dot: string;
  text: string;
  activeBg: string;
  activeBorder: string;
}

const STATUS_MAP: Record<string, StatusColors> = {
  "in progress": {
    dot: "bg-project-status-in-progress",
    text: "text-text-secondary",
    activeBg: "bg-project-status-in-progress/10",
    activeBorder: "border-project-status-in-progress/30",
  },
  ready: {
    dot: "bg-project-status-ready",
    text: "text-text-secondary",
    activeBg: "bg-project-status-ready/10",
    activeBorder: "border-project-status-ready/30",
  },
  todo: {
    dot: "bg-project-status-todo",
    text: "text-text-secondary",
    activeBg: "bg-project-status-todo/10",
    activeBorder: "border-project-status-todo/30",
  },
  done: {
    dot: "bg-status-idle",
    text: "text-text-secondary",
    activeBg: "bg-status-idle/10",
    activeBorder: "border-status-idle/30",
  },
};

const DEFAULT_COLORS: StatusColors = {
  dot: "bg-status-idle",
  text: "text-text-secondary",
  activeBg: "bg-status-idle/10",
  activeBorder: "border-status-idle/30",
};
export function statusColor(status: string): StatusColors {
  return STATUS_MAP[status.toLowerCase()] ?? DEFAULT_COLORS;
}

export function isHiddenByDefault(status: string): boolean {
  return DONE_STATUSES.has(status.toLowerCase());
}
