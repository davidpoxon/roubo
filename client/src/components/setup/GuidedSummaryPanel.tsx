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
      <span className="text-[12px] text-stone-500 dark:text-stone-500">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-stone-600 dark:text-stone-400">
        {value}
      </span>
    </div>
  );
}

export default function GuidedSummaryPanel({ config }: Props) {
  const componentCount = Object.keys(config.components ?? {}).length;

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/30 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-3">
        Summary
      </div>

      <div className="space-y-1.5">
        <StatRow label="Type" value={config.layout?.type ?? "–"} />
        <StatRow label="Components" value={String(componentCount)} />
        <StatRow label="Bench cap" value={config.benches?.max ? String(config.benches.max) : "–"} />
        <StatRow label="Tools" value={String(config.tools?.length ?? 0)} />
        <StatRow label="Inspections" value={config.inspection ? "1" : "0"} />
      </div>
    </div>
  );
}
