import type { GateStatus } from "../../lib/api";

// Gate status indicator (#726, VG-FR-012). A coloured dot plus an always-present
// text label, in the StatusIndicator mold (DESIGN.md "Status indicator"): colour
// is never the sole carrier of meaning (WCAG 2.1 AA, VG-NFR-004). Gate statuses are
// passed / failed / pending / stale, distinct from per-case CaseStatus, so this
// keeps its own token map reusing the same DESIGN.md status roles:
//   passed          -> status-active     (the per-case "passed" role)
//   failed          -> status-error      (the per-case "failed" role)
//   pending         -> status-preparing  (the in-progress role: work still outstanding)
//   stale           -> text-body         (the "blocked" strong neutral: must be re-verified)
//   no_gating_cases -> text-body         (strong neutral, reused from stale: it is NOT a
//                                          pass, just a structural "nothing to gate on")

const GATE_LABEL: Record<GateStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Pending",
  stale: "Stale",
  no_gating_cases: "No gating cases",
};

const GATE_DOT: Record<GateStatus, string> = {
  passed: "bg-status-active",
  failed: "bg-status-error",
  pending: "bg-status-preparing",
  stale: "bg-text-body",
  no_gating_cases: "bg-text-body",
};

const GATE_TEXT: Record<GateStatus, string> = {
  passed: "text-success-text",
  failed: "text-danger-text",
  pending: "text-accent-text",
  stale: "text-text-body",
  no_gating_cases: "text-text-body",
};

export default function GateStateIndicator({ status }: { status: GateStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${GATE_DOT[status]}`} />
      <span className={`text-12 font-medium ${GATE_TEXT[status]}`}>{GATE_LABEL[status]}</span>
    </span>
  );
}

export { GATE_LABEL };
