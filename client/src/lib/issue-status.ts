import { DONE_STATUSES } from "@roubo/shared";

// Maps GitHub project status field values to visual colors.
// Uses blue/fuchsia/cyan to avoid clashing with component status colors (green/amber/red)
// and to ensure each status is visually distinct at small dot sizes.

interface StatusColors {
  dot: string;
  text: string;
  activeBg: string;
  activeBorder: string;
}

const STATUS_MAP: Record<string, StatusColors> = {
  "in progress": {
    dot: "bg-blue-400",
    text: "text-blue-400",
    activeBg: "bg-blue-400/10",
    activeBorder: "border-blue-400/30",
  },
  ready: {
    dot: "bg-fuchsia-400",
    text: "text-fuchsia-400",
    activeBg: "bg-fuchsia-400/10",
    activeBorder: "border-fuchsia-400/30",
  },
  todo: {
    dot: "bg-cyan-400",
    text: "text-cyan-400",
    activeBg: "bg-cyan-400/10",
    activeBorder: "border-cyan-400/30",
  },
  done: {
    dot: "bg-stone-600",
    text: "text-stone-600",
    activeBg: "bg-stone-600/10",
    activeBorder: "border-stone-600/30",
  },
};

const DEFAULT_COLORS: StatusColors = {
  dot: "bg-stone-500",
  text: "text-stone-500",
  activeBg: "bg-stone-500/10",
  activeBorder: "border-stone-500/30",
};

export function statusColor(status: string): StatusColors {
  return STATUS_MAP[status.toLowerCase()] ?? DEFAULT_COLORS;
}

export function isHiddenByDefault(status: string): boolean {
  return DONE_STATUSES.has(status.toLowerCase());
}
