import type { PluginStatus } from "@roubo/shared";

const LABELS: Record<PluginStatus, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  errored: "Errored",
  incompatible: "Incompatible",
  invalid: "Invalid",
};

const STYLES: Record<PluginStatus, { wrap: string; dot: string }> = {
  enabled: {
    wrap: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  disabled: {
    wrap: "bg-stone-100 dark:bg-stone-800 border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300",
    dot: "bg-stone-400 dark:bg-stone-500",
  },
  errored: {
    wrap: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-400",
    dot: "bg-red-500",
  },
  incompatible: {
    wrap: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  invalid: {
    wrap: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-400",
    dot: "bg-red-500",
  },
};

export default function StatusPill({ status }: { status: PluginStatus }) {
  const style = STYLES[status];
  return (
    <span
      data-testid="plugin-status-pill"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-none ${style.wrap}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {LABELS[status]}
    </span>
  );
}
