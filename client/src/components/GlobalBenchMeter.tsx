import { useGlobalCap } from "../hooks/useGlobalCap";

/**
 * Passive, always-on meter for the application-wide bench cap. Reads its count
 * and ceiling from useGlobalCap (the single source of truth from GBL-WU-003) and
 * self-gates: it renders nothing when no global cap is configured, so callers
 * can mount it unconditionally.
 */
export default function GlobalBenchMeter() {
  const { current, max, isCapped } = useGlobalCap();
  if (!isCapped || max === null) return null;

  // Integer-safe thresholds (avoid float boundary drift at exactly 80%):
  //   >= 100% of cap -> status-error (covers the over-cap state after the cap is lowered)
  //   >= 80%         -> status-preparing
  //   below 80%      -> text-secondary, a neutral mark that holds 3:1 on the
  //                     bg-pressed track in both themes (status-idle does not in dark)
  const fillColor =
    current >= max
      ? "bg-status-error"
      : current * 100 >= max * 80
        ? "bg-status-preparing"
        : "bg-text-secondary";

  // Fill clamps at 100% even when current > max; guard against a non-positive cap.
  const fillWidth = max > 0 ? Math.min(100, (current / max) * 100) : 100;

  return (
    <div className="flex items-center gap-2" aria-label={`Global benches: ${current} of ${max}`}>
      <div className="w-24 h-1 rounded-full bg-bg-pressed overflow-hidden">
        <div
          className={`h-full ${fillColor} transition-colors duration-300`}
          style={{ width: `${fillWidth}%` }}
        />
      </div>
      <span className="text-11 font-mono text-text-secondary tabular-nums">
        {current} / {max}
      </span>
    </div>
  );
}
