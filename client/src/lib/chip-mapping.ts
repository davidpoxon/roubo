import {
  Bug,
  CheckSquare,
  KeyRound,
  Link2,
  Package,
  Shield,
  Sparkles,
  Tag,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { NormalizedIssue } from "@roubo/shared";

export type StatusTone = "open" | "in-progress" | "blocked" | "done" | "neutral" | "warning";

export type ChipCategory = "status" | "issue-type" | "label" | "metadata";

export interface ChipItem {
  category: ChipCategory;
  key: string;
  label: string;
  icon?: LucideIcon;
  tone?: StatusTone;
  ariaDescription?: string;
  tooltip?: string;
}

const IN_PROGRESS_STATES = new Set(["in progress", "in-progress", "in_progress", "doing"]);
const OPEN_STATES = new Set(["open", "opened", "todo", "to do", "to-do", "ready", "backlog"]);
const DONE_STATES = new Set([
  "done",
  "closed",
  "completed",
  "complete",
  "merged",
  "archived",
  "cancelled",
  "canceled",
]);

export function statusTone(currentState: string, isBlocked: boolean): StatusTone {
  if (isBlocked) return "blocked";
  const normalized = currentState.trim().toLowerCase();
  if (IN_PROGRESS_STATES.has(normalized)) return "in-progress";
  if (OPEN_STATES.has(normalized)) return "open";
  if (DONE_STATES.has(normalized)) return "done";
  return "neutral";
}

export interface IssueTypeChip {
  label: string;
  icon: LucideIcon;
}

export function issueTypeChip(type: string | null | undefined): IssueTypeChip | null {
  if (!type) return null;
  const trimmed = type.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/[_\s]+/g, "-");
  const entry = ISSUE_TYPE_ENTRIES[normalized];
  const icon = entry?.icon ?? Tag;
  const label = entry?.label ?? trimmed;
  return { label, icon };
}

interface IssueTypeEntry {
  icon: LucideIcon;
  label?: string;
}

// FR-075: alerts render with the friendly chip labels "CodeQL",
// "Secret scanning", and "Dependabot". The github plugin mapper emits the
// `security-*` keys (plugins/_shared-github/src/mapper.ts).
const ISSUE_TYPE_ENTRIES: Record<string, IssueTypeEntry> = {
  bug: { icon: Bug },
  feature: { icon: Sparkles },
  enhancement: { icon: Sparkles },
  chore: { icon: Wrench },
  task: { icon: CheckSquare },
  "security-code-scanning": { icon: Shield, label: "CodeQL" },
  "security-secret-scanning": { icon: KeyRound, label: "Secret scanning" },
  "security-dependabot": { icon: Package, label: "Dependabot" },
};

// FR-043: alert severity (and the closest secret-scanning analogue) lives on
// the opaque plugin `raw` payload. Narrow defensively rather than importing
// the plugin types across the client/plugin boundary.
export function alertSeverityTooltip(issue: NormalizedIssue): string | null {
  const raw = issue.raw;
  if (!isRecord(raw)) return null;

  switch (issue.issueType) {
    case "security-code-scanning": {
      const rule = isRecord(raw.rule) ? raw.rule : null;
      const value = stringFrom(rule?.security_severity_level) ?? stringFrom(rule?.severity);
      return value ? `Severity: ${titleCase(value)}` : null;
    }
    case "security-dependabot": {
      const advisory = isRecord(raw.security_advisory) ? raw.security_advisory : null;
      const value = stringFrom(advisory?.severity);
      return value ? `Severity: ${titleCase(value)}` : null;
    }
    case "security-secret-scanning": {
      return stringFrom(raw.secret_type_display_name);
    }
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const METADATA_ICONS = {
  assignee: User,
  blocks: Link2,
  bench: Wrench,
} satisfies Record<string, LucideIcon>;

export interface TruncationResult {
  visible: ChipItem[];
  overflowCount: number;
}

const DROP_ORDER: ChipCategory[] = ["label", "metadata", "issue-type"];

export function truncateChips(items: ChipItem[], max = 6): TruncationResult {
  if (items.length <= max) {
    return { visible: items, overflowCount: 0 };
  }

  const kept = [...items];
  let overflow = 0;

  for (const category of DROP_ORDER) {
    while (kept.length > max - (overflow > 0 ? 1 : 0)) {
      const indexFromEnd = findLastIndex(kept, (chip) => chip.category === category);
      if (indexFromEnd === -1) break;
      kept.splice(indexFromEnd, 1);
      overflow += 1;
    }
    if (kept.length <= max - (overflow > 0 ? 1 : 0)) break;
  }

  return { visible: kept, overflowCount: overflow };
}

function findLastIndex<T>(arr: T[], predicate: (value: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
