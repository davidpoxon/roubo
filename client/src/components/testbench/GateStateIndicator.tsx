import type { GateStatus } from "../../lib/api";

// Gate status indicator (#702, FR-012). A coloured dot plus an always-present
// text label, in the StatusIndicator mold (DESIGN.md "Status indicator"): colour
// is never the sole carrier of meaning (WCAG 2.1 AA, NFR-004). Gate statuses are
// passed / failed / pending / stale, distinct from per-case CaseStatus, so this
// keeps its own four-way token map reusing the same DESIGN.md palette:
//   passed  -> green-500   (the per-case "passed" green)
//   failed  -> red-500     (the per-case "failed" red)
//   pending -> amber-500   (the in-progress amber: work still outstanding)
//   stale   -> stone-700   (the "blocked"/neutral stone: must be re-verified)

const GATE_LABEL: Record<GateStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Pending",
  stale: "Stale",
};

const GATE_DOT: Record<GateStatus, string> = {
  passed: "bg-green-500",
  failed: "bg-red-500",
  pending: "bg-amber-500",
  stale: "bg-stone-700 dark:bg-stone-400",
};

const GATE_TEXT: Record<GateStatus, string> = {
  passed: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  pending: "text-amber-600 dark:text-amber-400",
  stale: "text-stone-700 dark:text-stone-300",
};

export default function GateStateIndicator({ status }: { status: GateStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${GATE_DOT[status]}`} />
      <span className={`text-xs font-medium ${GATE_TEXT[status]}`}>{GATE_LABEL[status]}</span>
    </span>
  );
}

export { GATE_LABEL };
