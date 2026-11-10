import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectProgress } from "@roubo/shared/delivery-selectors";
import { focusRing } from "../ui/focus-ring";

// Progress on the Delivery tab (SB-FR-011, SB-US-003): counted in test cases
// met and requirements covered, never in units done. The cases view
// (DeliveryCasesView) shows these figures over its list of cases, where each
// case opens its verify record and links the pull request of the unit that
// met it.

interface DeliveryStatProps {
  testId: string;
  eyebrow: string;
  value: number | string;
  note: string;
  // A second, quieter note line, such as the rest of a breakdown.
  detail?: string;
  // The meter's fill, from 0 to 1. Absent, the stat has no meter.
  fill?: number;
  // A stat that opens a view is a button, named by `pressLabel`.
  onPress?: () => void;
  pressLabel?: string;
}

// A Delivery stat (DESIGN.md): a mono eyebrow, set in uppercase at the section
// label tracking, a value, a note and an optional meter whose fill is the only accent on the strip. The space between the value
// and the note keeps the figure readable as one phrase ("3 of 10 cases met").
// The burn meter (DeliveryBurn) is one too.
export function DeliveryStat({
  testId,
  eyebrow,
  value,
  note,
  detail,
  fill,
  onPress,
  pressLabel,
}: DeliveryStatProps) {
  const Frame = onPress === undefined ? "div" : "button";
  return (
    <Frame
      data-testid={testId}
      {...(onPress !== undefined && {
        type: "button" as const,
        onClick: onPress,
        "aria-label": pressLabel,
      })}
      className={`flex flex-col items-start gap-1 bg-bg-surface p-3 text-left ${
        onPress === undefined
          ? ""
          : `hover:bg-bg-hover active:bg-bg-pressed ${focusRing} focus-visible:ring-inset`
      }`}
    >
      <span className="font-mono text-11 font-medium uppercase tracking-label text-text-secondary">
        {eyebrow}
      </span>
      <span className="font-mono text-16 font-semibold text-text-primary">{value}</span>{" "}
      <span className="max-w-full break-words text-11 text-text-secondary">{note}</span>
      {detail !== undefined && (
        <span className="max-w-full break-words text-11 text-text-secondary">{detail}</span>
      )}
      {fill !== undefined && (
        <span aria-hidden="true" className="block h-1 w-full rounded-full bg-bg-hover">
          <span
            className="block h-1 rounded-full bg-accent"
            style={{ width: `${Math.round(fill * 100)}%` }}
          />
        </span>
      )}
    </Frame>
  );
}

function share(met: number, total: number): number {
  return total === 0 ? 0 : met / total;
}

export function DeliveryProgressStats({ snapshot }: { snapshot: DeliverySnapshot }) {
  const { cases, requirements } = selectProgress(snapshot);
  return (
    <div data-testid="delivery-progress" className="grid grid-cols-2 gap-px">
      <DeliveryStat
        testId="delivery-stat-cases"
        eyebrow="Cases"
        value={cases.met}
        note={`of ${cases.total} cases met`}
        fill={share(cases.met, cases.total)}
      />
      <DeliveryStat
        testId="delivery-stat-requirements"
        eyebrow="Requirements"
        value={requirements.met}
        note={`of ${requirements.total} requirements covered`}
        fill={share(requirements.met, requirements.total)}
      />
    </div>
  );
}
