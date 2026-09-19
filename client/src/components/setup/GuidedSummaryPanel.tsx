import type { RouboConfig } from "@roubo/shared";

interface Props {
  config: Partial<RouboConfig>;
}

interface StatRowProps {
  label: string;
  value: string;
}

function StatRow({ label, value }: StatRowProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-12 text-text-secondary">{label}</span>
      <span className="font-mono text-12 tabular-nums text-text-secondary">{value}</span>
    </div>
  );
}

export default function GuidedSummaryPanel({ config }: Props) {
  const componentCount = Object.keys(config.components ?? {}).length;

  return (
    <div className="rounded-xl border border-border bg-bg-base p-4">
      <div className="text-11 font-semibold uppercase tracking-label text-text-secondary mb-3">
        Summary
      </div>

      <div className="space-y-1.5">
        <StatRow label="Type" value={config.layout?.type ?? "·"} />
        <StatRow label="Components" value={String(componentCount)} />
        <StatRow label="Bench cap" value={config.benches?.max ? String(config.benches.max) : "·"} />
        <StatRow label="Tools" value={String(config.tools?.length ?? 0)} />
        <StatRow label="Inspections" value={config.inspection ? "1" : "0"} />
      </div>
    </div>
  );
}
