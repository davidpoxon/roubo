import {
  AGENT_AUTHOR,
  type ProvisionalCase,
  type ProvisionalMark,
} from "@roubo/shared/delivery-observation-contract";
import type { CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";

// Where an agent's provisional mark on a gate case stands (SB-FR-038,
// SB-US-014), read from the case's result: provisional until the operator acts,
// then confirmed or changed. Pure, so the Provisional mark stays thin.

export type ProvisionalMarkState = "provisional" | "confirmed" | "changed";

export const MARK_WORDS: Record<ProvisionalMark, string> = { met: "Met", not_met: "Not met" };

// The case status a mark writes through the results writer: Met is passed and
// Not met is failed, as the TestBench case status control writes them.
const MARK_STATUSES: Record<ProvisionalMark, CaseStatus> = { met: "passed", not_met: "failed" };

export function provisionalMarkStatus(mark: ProvisionalMark): CaseStatus {
  return MARK_STATUSES[mark];
}

function markOfStatus(status: CaseStatus): ProvisionalMark | undefined {
  if (status === "passed") return "met";
  if (status === "failed") return "not_met";
  return undefined;
}

function timeOf(ts: string): number | undefined {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface ProvisionalMarkReading {
  state: ProvisionalMarkState;
  // The mark the case holds now: the agent's while provisional, else the
  // operator's.
  mark: ProvisionalMark;
  // Who made the mark the case holds now: `agent`, or the operator.
  author: string;
}

// A mark as the record carries it, with no result to read: a gate's review card
// shows it so.
export function recordedProvisionalMark(entry: ProvisionalCase): ProvisionalMarkReading {
  return {
    state: entry.confirmed ? "confirmed" : "provisional",
    mark: entry.mark,
    author: AGENT_AUTHOR,
  };
}

// Where a provisional mark stands. The operator acted on it when the case
// carries a status override written since the gate became provisional (`since`;
// any override when it is null): an override of the same mark confirms it, any
// other changes it. With no such override, a mark the record carries as
// confirmed reads confirmed, and every other mark reads provisional.
export function readProvisionalMark(
  entry: ProvisionalCase,
  result: CaseResult | undefined,
  since: string | null,
): ProvisionalMarkReading {
  const override = result?.statusOverride;
  if (override !== undefined) {
    const sinceMs = since === null ? undefined : timeOf(since);
    const atMs = timeOf(override.timestamp);
    const acted = sinceMs === undefined || atMs === undefined || atMs >= sinceMs;
    if (acted) {
      const held = markOfStatus(override.status);
      // An optimistic write has no author yet: the server stamps the operator.
      const author = override.author.name.length > 0 ? override.author.name : "you";
      if (held === entry.mark) return { state: "confirmed", mark: held, author };
      return { state: "changed", mark: held ?? entry.mark, author };
    }
  }
  return recordedProvisionalMark(entry);
}
