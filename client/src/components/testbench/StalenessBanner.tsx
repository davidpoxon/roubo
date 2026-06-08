import { Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";

// The DESIGN.md "Attention banner": amber-50 background, amber-200 border,
// amber-800 message, with a Reconcile action (focus 2px amber-500 ring, hover
// amber-100, active amber-200). Amber signals "needs attention", consistent with
// the system's amber-for-active-states.
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
      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-200 bg-amber-50"
    >
      <AlertTriangle size={16} className="text-amber-500 shrink-0" aria-hidden />
      <p className="flex-1 min-w-0 text-sm text-amber-800">{STRINGS.message}</p>
      <Button
        onPress={onReconcile}
        data-testid="staleness-banner-reconcile"
        className="shrink-0 px-3 py-1.5 text-sm font-medium rounded-md text-amber-800 hover:bg-amber-100 active:bg-amber-200 disabled:opacity-30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-50"
      >
        {STRINGS.reconcile}
      </Button>
    </div>
  );
}
