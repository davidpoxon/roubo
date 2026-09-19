import { Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";

// The DESIGN.md "Attention banner": accent-muted background, accent-border
// border, accent-text message, with a Reconcile action (2px focus-ring, hover
// bg-surface, active bg-pressed). The accent signals "needs attention",
// consistent with the system's accent-for-active-states.
//
// Renders only when the source plan's canonical hash changed (FR-016). Staleness
// is computed server-side; this component never decides it, it only renders the
// `stale` flag it is handed. A whitespace/format-only source edit never sets
// `stale`, so the banner stays hidden for cosmetic changes (AC5).
const STRINGS = {
  message: "The source plan changed since these results were recorded.",
  reconcile: "Reconcile",
};

export default function StalenessBanner({
  stale,
  onReconcile,
}: {
  stale: boolean;
  onReconcile: () => void;
}) {
  if (!stale) return null;

  return (
    <div
      role="status"
      data-testid="staleness-banner"
      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-accent-border bg-accent-muted"
    >
      <AlertTriangle size={16} className="text-accent-text shrink-0" aria-hidden />
      <p className="flex-1 min-w-0 text-13 text-accent-text">{STRINGS.message}</p>
      <Button
        onPress={onReconcile}
        data-testid="staleness-banner-reconcile"
        className="shrink-0 px-3 py-1.5 text-13 font-medium rounded-control text-accent-text hover:bg-bg-surface active:bg-bg-pressed disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {STRINGS.reconcile}
      </Button>
    </div>
  );
}
