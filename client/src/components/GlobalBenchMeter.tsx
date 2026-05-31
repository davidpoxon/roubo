import { useGlobalCap } from "../hooks/useGlobalCap";

/**
 * Passive, always-on meter for the application-wide bench cap. Reads its count
 * and ceiling from useGlobalCap (the single source of truth from WU-003) and
 * self-gates: it renders nothing when no global cap is configured, so callers
 * can mount it unconditionally.
 */
export default function GlobalBenchMeter() {
  const { current, max, isCapped } = useGlobalCap();
  if (!isCapped || max === null) return null;

  // Integer-safe thresholds (avoid float boundary drift at exactly 80%):
  //   >= 100% of cap -> red (covers the over-cap state after the cap is lowered)
  //   >= 80%         -> amber
  //   below 80%      -> neutral stone
  const fillColor =
    current >= max ? "bg-red-500" : current * 100 >= max * 80 ? "bg-amber-500" : "bg-stone-400";

  // Fill clamps at 100% even when current > max; guard against a non-positive cap.
  const fillWidth = max > 0 ? Math.min(100, (current / max) * 100) : 100;

  return (
    <div className="flex items-center gap-2" aria-label={`Global benches: ${current} of ${max}`}>
      <div className="w-24 h-1 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
        <div
          className={`h-full ${fillColor} transition-all duration-300`}
          style={{ width: `${fillWidth}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-stone-400 dark:text-stone-500 tabular-nums">
        {current} / {max}
      </span>
    </div>
  );
}
