import { Focusable, TooltipTrigger } from "react-aria-components";
import Tooltip from "./ui/Tooltip";

export const STALE_BENCH_MARKER_LABEL = "stale · Set up with an older roubo.yaml";

export const STALE_BENCH_MARKER_TOOLTIP =
  "This bench keeps the component definitions it was set up with. Restart to apply the current roubo.yaml.";

export const RESTART_WITH_CONFIG_LABEL = "Restart with new config";

export const RESTART_WITH_CONFIG_TOOLTIP =
  "Stop all components, apply the current roubo.yaml, and start them again";

// DESIGN.md Bench card, head: a bench whose roubo.yaml changed since it was set
// up names itself stale beside its status label. The chip is focusable so the
// tooltip that explains it is reachable by keyboard as well as hover.
export default function StaleBenchMarker() {
  return (
    <TooltipTrigger delay={500}>
      <Focusable>
        <span
          role="note"
          tabIndex={0}
          aria-description={STALE_BENCH_MARKER_TOOLTIP}
          data-testid="bench-card-stale-marker"
          className="inline-flex items-center px-1.5 py-0.5 rounded-chip text-11 font-medium bg-accent-muted text-accent-text truncate min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {STALE_BENCH_MARKER_LABEL}
        </span>
      </Focusable>
      <Tooltip data-testid="bench-card-stale-tooltip">{STALE_BENCH_MARKER_TOOLTIP}</Tooltip>
    </TooltipTrigger>
  );
}
