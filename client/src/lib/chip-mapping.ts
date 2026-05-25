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

export type StatusTone = "open" | "in-progress" | "blocked" | "done" | "neutral";

export type ChipCategory = "status" | "issue-type" | "label" | "metadata";

export interface ChipItem {
  category: ChipCategory;
  key: string;
  label: string;
  icon?: LucideIcon;
  tone?: StatusTone;
  ariaDescription?: string;
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
  const icon = ISSUE_TYPE_ICONS[normalized] ?? Tag;
  return { label: trimmed, icon };
}

const ISSUE_TYPE_ICONS: Record<string, LucideIcon> = {
  bug: Bug,
  feature: Sparkles,
  enhancement: Sparkles,
  chore: Wrench,
  task: CheckSquare,
  codeql: Shield,
  "secret-scanning": KeyRound,
  dependabot: Package,
};

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
