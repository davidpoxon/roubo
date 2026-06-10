// Pure view-model derivation for the TestBench review tab (#419, FR-005/FR-006/FR-013).
//
// Given a validated plan and this bench's results, group the plan's cases by
// level then priority, resolve each case's effective status (a status override
// wins over the derived status; a case with no recorded result is not_started),
// and roll the counts up per level and overall. Orphaned results (results whose
// case was removed from the plan) are excluded from every count (FR-013): the
// grouping iterates the plan's cases, so an orphaned result simply has no case
// to attach to and never contributes.
//
// This module is intentionally free of React and DOM concerns so it can be unit
// tested in isolation and reused by the rollup bar and the virtualised list.

import type { Case, CaseStatus, BenchResults } from "@roubo/shared/testbench-contracts";

// The status the UI shows for a case: the override if one is set, else the
// derived status, else not_started when the case has no recorded result.
export function effectiveCaseStatus(caseId: string, results: BenchResults | null): CaseStatus {
  const result = results?.caseResults[caseId];
  if (!result || result.orphaned) return "not_started";
  return result.statusOverride?.status ?? result.derivedStatus;
}

// Per-case observation progress (#508): how many of a case's observations have
// been marked, out of the total defined across its steps. Drives the per-case
// progress indicator in the detail pane, distinct from the per-level and overall
// case rollups.
export interface ObservationProgress {
  marked: number;
  total: number;
}

export function caseObservationProgress(
  testCase: Case,
  result: BenchResults["caseResults"][string] | undefined,
): ObservationProgress {
  let total = 0;
  let marked = 0;
  const marks = result?.observationMarks ?? {};
  for (const step of testCase.steps) {
    for (const observation of step.observations) {
      total += 1;
      if (marks[observation.id] !== undefined) {
        marked += 1;
      }
    }
  }
  return { marked, total };
}

// Per-group/overall tally. `total` is the number of cases counted; the five
// status buckets sum to `total`.
export interface StatusCounts {
  total: number;
  not_started: number;
  in_progress: number;
  passed: number;
  failed: number;
  blocked: number;
}

export interface CaseRowModel {
  case: Case;
  status: CaseStatus;
}

export interface PriorityGroup {
  priority: string;
  rows: CaseRowModel[];
  counts: StatusCounts;
}

export interface LevelGroup {
  level: string;
  priorities: PriorityGroup[];
  counts: StatusCounts;
}

export interface RollupModel {
  levels: LevelGroup[];
  overall: StatusCounts;
}

// Display label for cases with no `priority` (optional in the merged v1.1.0
// shape: canonical product-dev authors do not emit a priority). They are bucketed
// together under one group rather than dropped, so every case is always grouped.
export const NO_PRIORITY_LABEL = "Unprioritized";

function emptyCounts(): StatusCounts {
  return { total: 0, not_started: 0, in_progress: 0, passed: 0, failed: 0, blocked: 0 };
}

function addStatus(counts: StatusCounts, status: CaseStatus): void {
  counts.total += 1;
  counts[status] += 1;
}

// Stable, locale-aware ordering so groups render deterministically regardless of
// case order in the plan. level/priority are free-form strings.
function compareKeys(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildRollup(cases: Case[], results: BenchResults | null): RollupModel {
  // level -> priority -> rows, preserving first-seen insertion then sorted below.
  const levelMap = new Map<string, Map<string, CaseRowModel[]>>();

  for (const c of cases) {
    const status = effectiveCaseStatus(c.id, results);
    // level is an integer in the merged shape; key the group by its string form
    // so the existing numeric-aware ordering and string-keyed maps still apply.
    const levelKey = String(c.level);
    // priority is optional; cases without one share a single sentinel bucket.
    const priorityKey = c.priority ?? NO_PRIORITY_LABEL;
    let priorityMap = levelMap.get(levelKey);
    if (!priorityMap) {
      priorityMap = new Map<string, CaseRowModel[]>();
      levelMap.set(levelKey, priorityMap);
    }
    let rows = priorityMap.get(priorityKey);
    if (!rows) {
      rows = [];
      priorityMap.set(priorityKey, rows);
    }
    rows.push({ case: c, status });
  }

  const overall = emptyCounts();
  const levels: LevelGroup[] = [];

  const sortedLevels = [...levelMap.entries()].sort(([a], [b]) => compareKeys(a, b));
  for (const [level, priorityMap] of sortedLevels) {
    const levelCounts = emptyCounts();
    const priorities: PriorityGroup[] = [];

    const sortedPriorities = [...priorityMap.entries()].sort(([a], [b]) => compareKeys(a, b));
    for (const [priority, rows] of sortedPriorities) {
      const groupCounts = emptyCounts();
      for (const row of rows) {
        addStatus(groupCounts, row.status);
        addStatus(levelCounts, row.status);
        addStatus(overall, row.status);
      }
      priorities.push({ priority, rows, counts: groupCounts });
    }

    levels.push({ level, priorities, counts: levelCounts });
  }

  return { levels, overall };
}

// Flatten the grouped model into a single windowed list for the virtualiser: a
// level-header row, a priority-subheader row, then one row per case. Each entry
// carries a stable key so react-virtual can measure and key rows.
export type FlatRow =
  | { kind: "level"; key: string; level: string; counts: StatusCounts }
  | { kind: "priority"; key: string; level: string; priority: string; counts: StatusCounts }
  // `level` is carried on the case row too so a collapsed-level filter can hide
  // its cases without re-deriving the grouping (#508).
  | { kind: "case"; key: string; level: string; row: CaseRowModel };

export function flattenRollup(model: RollupModel): FlatRow[] {
  const flat: FlatRow[] = [];
  for (const level of model.levels) {
    flat.push({
      kind: "level",
      key: `level:${level.level}`,
      level: level.level,
      counts: level.counts,
    });
    for (const priority of level.priorities) {
      flat.push({
        kind: "priority",
        key: `priority:${level.level}:${priority.priority}`,
        level: level.level,
        priority: priority.priority,
        counts: priority.counts,
      });
      for (const row of priority.rows) {
        flat.push({ kind: "case", key: `case:${row.case.id}`, level: level.level, row });
      }
    }
  }
  return flat;
}
