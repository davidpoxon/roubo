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
//
// A read-only TestBench (a Spec Bench outside a gate sitting) passes no
// onReconcile: the banner still says that the plan changed, but it offers no
// Reconcile action, because the server refuses the write.
//
// `staleCaseIds` names the live cases whose result was judged against an earlier
// version of the case (#1696). Staleness is per case, so a Reconcile keeps a
// changed case stale until it is marked again: the banner then says which cases
// hold it, rather than repeating that the plan changed.
const STRINGS = {
  message: "The source plan changed since these results were recorded.",
  reconcile: "Reconcile",
};

// The most case ids the banner names before it counts the rest.
const NAMED_CASE_LIMIT = 5;

function staleCasesSentence(ids: readonly string[]): string {
  const named = ids.slice(0, NAMED_CASE_LIMIT).join(", ");
  const rest = ids.length - NAMED_CASE_LIMIT;
  const list = rest > 0 ? `${named} and ${rest} more` : named;
  const count = ids.length === 1 ? "1 case has" : `${ids.length} cases have`;
  const them = ids.length === 1 ? "it" : "them";
  return `${count} results recorded against an earlier version: ${list}. Mark ${them} again to update ${them}.`;
}

export default function StalenessBanner({
  stale,
  staleCaseIds,
  onReconcile,
}: {
  stale: boolean;
  staleCaseIds?: readonly string[];
  onReconcile?: () => void;
}) {
  if (!stale) return null;
  const detail =
    staleCaseIds !== undefined && staleCaseIds.length > 0 ? staleCasesSentence(staleCaseIds) : null;

  return (
    <div
      role="status"
      data-testid="staleness-banner"
      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-accent-border bg-accent-muted"
    >
      <AlertTriangle size={16} className="text-accent-text shrink-0" aria-hidden />
      <p className="flex-1 min-w-0 text-13 text-accent-text">
        {STRINGS.message}
        {detail !== null && <> {detail}</>}
      </p>
      {onReconcile !== undefined && (
        <Button
          onPress={onReconcile}
          data-testid="staleness-banner-reconcile"
          className="shrink-0 px-3 py-1.5 text-13 font-medium rounded-control text-accent-text hover:bg-bg-surface active:bg-bg-pressed disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {STRINGS.reconcile}
        </Button>
      )}
    </div>
  );
}
