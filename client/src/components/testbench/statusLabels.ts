import type { CaseStatus } from "@roubo/shared/testbench-contracts";

// Per-case status labels, shared by StatusIndicator and StatusOverrideControl,
// and the status dot colours, shared by StatusIndicator, NotesRail and the
// Spec Bench sitting's Cases list.
// Kept out of StatusIndicator.tsx so that file only exports a component (fast refresh).
export const STATUS_LABEL: Record<CaseStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
};

// Dot colour token per status. blocked takes the strong neutral text-body tone so
// it stays distinct from not_started's status-idle without reusing
// status-error (reserved for failed).
export const STATUS_DOT: Record<CaseStatus, string> = {
  not_started: "bg-status-idle",
  in_progress: "bg-status-preparing",
  passed: "bg-status-active",
  failed: "bg-status-error",
  blocked: "bg-text-body",
};
