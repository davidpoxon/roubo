import type { CaseStatus } from "@roubo/shared/testbench-contracts";

// Per-case status labels, shared by StatusIndicator and StatusOverrideControl.
// Kept out of StatusIndicator.tsx so that file only exports a component (fast refresh).
export const STATUS_LABEL: Record<CaseStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
};
