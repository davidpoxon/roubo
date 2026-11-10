import type { CaseStatus } from "@roubo/shared/testbench-contracts";
import { STATUS_DOT, STATUS_LABEL } from "./statusLabels";

// Per-case status indicator (DESIGN.md "Status indicator", lines 322-338).
//
// Anatomy is a coloured dot plus an always-present text label: colour is never
// the sole carrier of meaning (WCAG 2.1 AA, NFR-004). The dot takes the DESIGN.md
// status roles (status-idle / status-preparing / status-active / status-error,
// and a strong neutral for blocked); the label restates the status as words so
// it reads identically to a screen reader and to a colour-blind user.

const STATUS_TEXT: Record<CaseStatus, string> = {
  not_started: "text-text-secondary",
  in_progress: "text-accent-text",
  passed: "text-success-text",
  failed: "text-danger-text",
  blocked: "text-text-body",
};

export default function StatusIndicator({ status }: { status: CaseStatus }) {
  const label = STATUS_LABEL[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status]}`} />
      <span className={`text-12 font-medium ${STATUS_TEXT[status]}`}>{label}</span>
    </span>
  );
}
