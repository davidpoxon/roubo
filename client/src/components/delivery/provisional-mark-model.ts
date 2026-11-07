import {
  AGENT_AUTHOR,
  type ProvisionalCase,
  type ProvisionalMark,
} from "@roubo/shared/delivery-observation-contract";
import type { CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";
import { STATUS_LABEL } from "../testbench/statusLabels";

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

function markOfStatus(status: CaseStatus): ProvisionalMark | null {
  if (status === "passed") return "met";
  if (status === "failed") return "not_met";
  return null;
}

export interface ProvisionalMarkReading {
  state: ProvisionalMarkState;
  // The mark the case holds now: the agent's while provisional, else the
  // operator's. Null when the operator set a status that is no mark (blocked,
  // in progress or not started).
  mark: ProvisionalMark | null;
  // The words of what the case holds now: the mark's words, or the status's
  // label when it holds no mark.
  words: string;
  // Who made what the case holds now: `agent`, or the operator.
  author: string;
}

// A mark as the record carries it, with no result to read: a gate's review card
// shows it so.
export function recordedProvisionalMark(entry: ProvisionalCase): ProvisionalMarkReading {
  return {
    state: entry.confirmed ? "confirmed" : "provisional",
    mark: entry.mark,
    words: MARK_WORDS[entry.mark],
    author: AGENT_AUTHOR,
  };
}

// Where a provisional mark stands. The operator acted on it when the case
// carries a status override that the agent did not write: an override of the
// same mark confirms it, any other status changes it. No time cutoff applies:
// the gate's provisional time is re-dated on every record load, and a gate
// judges no case the operator had already decided, so an operator override on
// a provisional case is the operator's act on that mark. With no such override,
// a mark the record carries as confirmed reads confirmed, and every other mark
// reads provisional.
export function readProvisionalMark(
  entry: ProvisionalCase,
  result: CaseResult | undefined,
): ProvisionalMarkReading {
  const override = result?.statusOverride;
  if (override === undefined || override.author.name === AGENT_AUTHOR) {
    return recordedProvisionalMark(entry);
  }
  const held = markOfStatus(override.status);
  // An optimistic write has no author yet: the server stamps the operator.
  const author = override.author.name.length > 0 ? override.author.name : "you";
  const words = held === null ? STATUS_LABEL[override.status] : MARK_WORDS[held];
  return { state: held === entry.mark ? "confirmed" : "changed", mark: held, words, author };
}
