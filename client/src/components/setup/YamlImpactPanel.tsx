import type { ImpactResult } from "./computeImpact";

interface Props {
  impact: ImpactResult | null;
  totalBenches?: number;
}

export default function YamlImpactPanel({ impact, totalBenches }: Props) {
  const activeCount = impact ? impact.affected.length + impact.unaffectedActive.length : 0;
  const idleCount = impact?.idleCount ?? totalBenches ?? 0;

  return (
    <div className="rounded-xl border border-border bg-bg-base p-4">
      <div className="text-11 font-semibold uppercase tracking-label text-text-secondary mb-3">
        Impact on benches
      </div>

      <p className="text-11 text-text-secondary leading-relaxed mb-2">
        Saving will reload <span className="font-mono text-text-secondary">.roubo/roubo.yaml</span>{" "}
        for this project. Existing benches keep their current state.
      </p>

      {impact?.changed && impact.affected.length > 0 && (
        <div className="mb-2">
          <div className="text-11 font-semibold uppercase tracking-label text-accent-text mb-1.5">
            Affected
          </div>
          <div className="space-y-1.5">
            {impact.affected.map((bench) => (
              <div key={bench.id}>
                <div className="text-11 font-mono text-text-body">{bench.displayName}</div>
                <div className="text-11 text-text-secondary ml-1">
                  {bench.reasons.slice(0, 3).join(", ")}
                  {bench.reasons.length > 3 && ` +${bench.reasons.length - 3} more`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-11 font-mono text-text-secondary">
        {activeCount} active · {idleCount} idle
      </div>
    </div>
  );
}
