import { Focusable, TooltipTrigger } from "react-aria-components";
import Tooltip from "./ui/Tooltip";

export const STALE_BENCH_MARKER_LABEL = "stale · Set up with an older roubo.yaml";

export const STALE_BENCH_MARKER_TOOLTIP =
  "This bench keeps the component definitions it was set up with. Restart to apply the current roubo.yaml.";

export const SWAP_STALE_BENCH_MARKER_LABEL = "stale · A plugin swap left it unbound";

export const SWAP_STALE_BENCH_MARKER_TOOLTIP =
  "A plugin this bench uses was replaced, and a resource of this bench did not re-bind to the new plugin process. The resources are still running. Restart the bench, or the plugin, to bind them again.";

export const RESTART_WITH_CONFIG_LABEL = "Restart with new config";

export const RESTART_WITH_CONFIG_TOOLTIP =
  "Stop all components, apply the current roubo.yaml, and start them again";

interface Props {
  /**
   * True when a plugin swap left the bench stale (HR-FR-009), rather than only
   * a roubo.yaml change: the marker then names the swap.
   */
  fromSwap?: boolean;
}

// DESIGN.md Bench card, head: a bench whose roubo.yaml changed since it was set
// up, or that a plugin swap left unbound, names itself stale beside its status
// label. The chip is focusable so the tooltip that explains it is reachable by
// keyboard as well as hover.
export default function StaleBenchMarker({ fromSwap = false }: Props) {
  const label = fromSwap ? SWAP_STALE_BENCH_MARKER_LABEL : STALE_BENCH_MARKER_LABEL;
  const tooltip = fromSwap ? SWAP_STALE_BENCH_MARKER_TOOLTIP : STALE_BENCH_MARKER_TOOLTIP;
  return (
    <TooltipTrigger delay={500}>
      <Focusable>
        <span
          role="note"
          tabIndex={0}
          aria-description={tooltip}
          data-testid="bench-card-stale-marker"
          className="inline-flex items-center px-1.5 py-0.5 rounded-chip text-11 font-medium bg-accent-muted text-accent-text truncate min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {label}
        </span>
      </Focusable>
      <Tooltip data-testid="bench-card-stale-tooltip">{tooltip}</Tooltip>
    </TooltipTrigger>
  );
}
