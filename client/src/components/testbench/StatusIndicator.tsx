import type { CaseStatus } from "@roubo/shared/testbench-contracts";

// Per-case status indicator (DESIGN.md "Status indicator", lines 322-338).
//
// Anatomy is a coloured dot plus an always-present text label: colour is never
// the sole carrier of meaning (WCAG 2.1 AA, NFR-004). The dot maps to the
// DESIGN.md token palette (stone-400 / amber-500 / green-500 / red-500 /
// stone-700); the label restates the status as words so it reads identically to
// a screen reader and to a colour-blind user.

const STATUS_LABEL: Record<CaseStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
};

// Dot colour token per status. blocked uses stone-700 so it stays distinct from
// not_started's stone-400 without reusing red (reserved for failed).
const STATUS_DOT: Record<CaseStatus, string> = {
  not_started: "bg-stone-400 dark:bg-stone-600",
  in_progress: "bg-amber-500",
  passed: "bg-green-500",
  failed: "bg-red-500",
  blocked: "bg-stone-700 dark:bg-stone-400",
};

const STATUS_TEXT: Record<CaseStatus, string> = {
  not_started: "text-stone-500 dark:text-stone-400",
  in_progress: "text-amber-600 dark:text-amber-400",
  passed: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  blocked: "text-stone-700 dark:text-stone-300",
};

export default function StatusIndicator({ status }: { status: CaseStatus }) {
  const label = STATUS_LABEL[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status]}`} />
      <span className={`text-xs font-medium ${STATUS_TEXT[status]}`}>{label}</span>
    </span>
  );
}

export { STATUS_LABEL };
