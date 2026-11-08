import type { ProvisionalCase } from "@roubo/shared/delivery-observation-contract";
import Button from "../ui/Button";
import type { ProvisionalMarkReading } from "./provisional-mark-model";

// The Provisional mark of DESIGN.md (SB-FR-038, SB-US-014): the agent's
// unconfirmed mark on one gate case, on the inset `bg-base` ground. Its head
// holds the mono case id, a badge that reads the mark and the word provisional,
// and the mono author; the evidence follows as plain text. The badge is neutral
// on purpose: green and red belong to a mark the operator made. In a sitting it
// carries one Confirm control, and the case's own mark controls change it. Once
// the operator acted, the badge reads what the case now holds and confirmed or
// changed, and takes the set of the mark it holds, `success-*` for Met and
// `danger-*` for Not met; a status that is no mark (blocked, in progress, not
// started) keeps it neutral. On a gate's review card the control is omitted.

function badgeClass(reading: ProvisionalMarkReading): string {
  if (reading.state !== "provisional" && reading.mark === "met") {
    return "bg-success-surface text-success-text";
  }
  if (reading.state !== "provisional" && reading.mark === "not_met") {
    return "bg-danger-surface text-danger-text";
  }
  return "bg-bg-hover text-text-secondary";
}

export default function ProvisionalMarkCard({
  entry,
  reading,
  onConfirm,
  isConfirming = false,
}: {
  entry: ProvisionalCase;
  reading: ProvisionalMarkReading;
  // The Confirm control, in a sitting only. Absent on a review card.
  onConfirm?: (() => void) | undefined;
  isConfirming?: boolean;
}) {
  return (
    <div
      data-testid={`provisional-mark-${entry.case}`}
      data-state={reading.state}
      className="space-y-1 rounded-control border border-border bg-bg-base p-2"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-12 font-medium text-text-body">{entry.case}</span>
        <span
          data-testid={`provisional-mark-badge-${entry.case}`}
          data-mark={reading.mark ?? undefined}
          className={`rounded-chip px-1.5 py-0.5 text-11 font-medium ${badgeClass(reading)}`}
        >
          {reading.words} · {reading.state}
        </span>
        <span
          data-testid={`provisional-mark-author-${entry.case}`}
          className="font-mono text-11 text-text-secondary"
        >
          {reading.author}
        </span>
      </p>
      <p
        data-testid={`provisional-mark-evidence-${entry.case}`}
        className="whitespace-pre-wrap break-words text-13 text-text-body"
      >
        {entry.evidence}
      </p>
      {onConfirm !== undefined && reading.state === "provisional" && (
        <Button aria-label={`Confirm ${entry.case}`} onPress={onConfirm} isDisabled={isConfirming}>
          Confirm
        </Button>
      )}
    </div>
  );
}
