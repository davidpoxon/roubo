import type { ImpactResult } from "./computeImpact";

interface Props {
  impact: ImpactResult | null;
  totalBenches?: number;
}

export default function YamlImpactPanel({ impact, totalBenches }: Props) {
  const activeCount = impact ? impact.affected.length + impact.unaffectedActive.length : 0;
  const idleCount = impact?.idleCount ?? totalBenches ?? 0;

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/30 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-600 mb-3">
        Impact on benches
      </div>

      <p className="text-[11px] text-stone-500 dark:text-stone-500 leading-relaxed mb-2">
        Saving will reload{" "}
        <span className="font-mono text-stone-600 dark:text-stone-400">.roubo/roubo.yaml</span> for
        this project. Existing benches keep their current state.
      </p>

      {impact?.changed && impact.affected.length > 0 && (
        <div className="mb-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1.5">
            Affected
          </div>
          <div className="space-y-1.5">
            {impact.affected.map((bench) => (
              <div key={bench.id}>
                <div className="text-[11px] font-mono text-stone-700 dark:text-stone-300">
                  {bench.displayName}
                </div>
                <div className="text-[10px] text-stone-400 dark:text-stone-600 ml-1">
                  {bench.reasons.slice(0, 3).join(", ")}
                  {bench.reasons.length > 3 && ` +${bench.reasons.length - 3} more`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[11px] font-mono text-stone-400 dark:text-stone-500">
        {activeCount} active · {idleCount} idle
      </div>
    </div>
  );
}
