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
    wrap: "bg-success-surface border-success-border text-success-text",
    dot: "bg-status-active",
  },
  disabled: {
    wrap: "bg-bg-hover border-border-strong text-text-secondary",
    dot: "bg-status-idle",
  },
  errored: {
    wrap: "bg-danger-surface border-danger-border text-danger-text",
    dot: "bg-status-error",
  },
  incompatible: {
    wrap: "bg-accent-muted border-accent-border text-accent-text",
    dot: "bg-current",
  },
  invalid: {
    wrap: "bg-danger-surface border-danger-border text-danger-text",
    dot: "bg-status-error",
  },
};

export default function StatusPill({ status }: { status: PluginStatus }) {
  const style = STYLES[status];
  return (
    <span
      data-testid="plugin-status-pill"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-11 font-medium leading-none ${style.wrap}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {LABELS[status]}
    </span>
  );
}
